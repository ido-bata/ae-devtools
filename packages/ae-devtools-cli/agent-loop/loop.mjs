/*
 * loop.mjs — the fake-level agent development loop (Issue #38, CAP065).
 *
 *   run JSX -> on script error, normalize a diagnostic record with the
 *   host-reported source position -> ask the injected `fixer` for a
 *   corrected source -> reset dirty state if required -> rerun -> on
 *   success, an explicit idempotent regression rerun.
 *
 * Dispatch, consent gating, reply-identity checks, outcome
 * classification, deadline handling and UNKNOWN quarantine are ALL
 * delegated to the canonical trusted-execution runner
 * (packages/ae-devtools-cli/trusted-execution/runner.mjs, PR #42). This module adds
 * only the loop policy — and the loop policy now carries three safety
 * contracts added in the PR #45 re-review:
 *
 *   1. CONSENT INDEPENDENCE — the loop NEVER mints consent. Every
 *      attempt requires an injected `consentProvider(source, attempt)`
 *      returning {consent, trustedScriptOptIn, scriptProvenance}; the
 *      provider is invoked per attempt so each consent scope binds the
 *      exact source about to be dispatched. No provider -> BLOCKED
 *      before any send.
 *   2. DIRTY-STATE GATING — arbitrary eval may mutate before throwing.
 *      Every dispatch declares mayMutatePartial, so a FAILED outcome
 *      reports mayHaveMutated. A rerun after a dirty FAILED requires
 *      EITHER an injected `stateReset(source, attempt)` that restores
 *      the fixture/project state, OR the explicit operator flag
 *      `allowDirtyRerun: true`. Otherwise the loop stops FAILED with
 *      stateDirty: true — partial mutations are never assumed rolled
 *      back.
 *   3. REGRESSION SAFETY — regressionCheck only re-dispatches when the
 *      caller asserts `assumeIdempotent: true`. A possibly-mutating
 *      script is never rerun "to check"; the check is skipped with an
 *      explicit reason instead of silently duplicating mutations.
 *
 * Evidence level: fake/mock only. The "host" is fake-host.mjs (a Node
 * vm sandbox), "fixer"/"consentProvider"/"stateReset" are injected —
 * in tests deterministic stand-ins. This proves loop mechanics and
 * diagnostic plumbing, not real AE behavior, real ExtendScript
 * semantics, or production authorization (consent-token authenticity,
 * host-side re-validation, catalog-gate integration remain unproven
 * per runner.mjs non-claims).
 *
 * Diagnostic records are canonical ae-devtools.diagnostics/v1 records
 * built through packages/ae-devtools-cli/diagnostics/schema.mjs, so
 * they validate with validateDiagnosticsRecord() and resolve through
 * diagnostics/source-map.mjs like every other diagnostic source.
 */
import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { makeDiagnosticsRecord } from "../diagnostics/schema.mjs";

/* Fake-session defaults pin the consent scope's target identity. A
 * real deployment supplies the actual AE session pin via `session`. */
export const FAKE_SESSION = {
  pin: { sessionId: "agent-loop-fake-session", aeVersion: "fake", dispatchId: "fake" },
  operationId: "op.devloop.eval",
  projectIdentity: "proj-fake",
};

function runInput(source, session, auth) {
  const s = session ?? FAKE_SESSION;
  return {
    source,
    pin: s.pin,
    operationId: s.operationId,
    projectIdentity: s.projectIdentity,
    consent: auth.consent,
    trustedScriptOptIn: auth.trustedScriptOptIn,
    scriptProvenance: auth.scriptProvenance,
    // Arbitrary eval cannot prove it did not mutate before an error —
    // declare partial mutation so FAILED outcomes surface mayHaveMutated.
    mayMutatePartial: true,
  };
}

/* Normalize a runner FAILED outcome into a canonical diagnostics
 * record (ae-devtools.diagnostics/v1). Positions come ONLY from
 * host-reported fields (runner marks them hostReported) — never
 * inferred; absent position fields stay absent. */
export function toDiagnostic(outcome, requestId) {
  const err = outcome && outcome.error;
  if (!err) return null;
  const message =
    typeof err.message === "string" && err.message.length > 0
      ? err.message
      : String(err.name ?? "script error");
  const source = { assetKind: "jsx-script" };
  if (typeof err.file === "string" && err.file.length > 0) source.path = err.file;
  if (Number.isInteger(err.line) && err.line >= 1) source.line = err.line;
  if (err.hostReported === true) source.hostReported = true;
  return makeDiagnosticsRecord({
    kind: "script-exception",
    severity: "error",
    message,
    source,
    collector: "agent-loop",
    requestId: typeof requestId === "string" && requestId.length > 0
      ? requestId
      : typeof outcome?.requestId === "string" ? outcome.requestId : undefined,
    evidence: "fake",
  });
}

function blockedReport(reason) {
  return {
    iterations: [],
    diagnostics: [],
    finalSource: null,
    outcome: "BLOCKED",
    blockedReason: reason,
    stateDirty: false,
    stateWasDirty: false,
    stateResetVerified: false,
    stateResetTrusted: false,
    resetIncomplete: false,
    callbackError: null,
    quarantined: [],
  };
}

/**
 * runDevLoop({source, transport, fixer, consentProvider, session?,
 *             stateReset?, allowDirtyRerun?, maxFixes?})
 *
 * consentProvider(source, attempt) -> {consent, trustedScriptOptIn,
 *   scriptProvenance} — REQUIRED; the loop never issues consent itself.
 * fixer(diagnostic, source, attempt) -> corrected source or null.
 * stateReset(source, attempt) -> Promise — restores fixture/project
 *   state; required before rerunning after a dirty FAILED unless
 *   allowDirtyRerun is explicitly set. NOTE: the arguments describe the
 *   dispatch that is ABOUT TO RUN (the fixed source and its attempt
 *   index), not the attempt that failed — the failed attempt's source
 *   is the previous iteration's record.
 * One runner instance is shared across attempts so requestId
 * single-use and UNKNOWN quarantine apply loop-wide.
 *
 * Report flags:
 *   stateDirty         — an unreconciled mutation MAY persist right now
 *                        (set by mayHaveMutated/stateChanged evidence;
 *                        cleared only by a fingerprint-VERIFIED reset)
 *   stateWasDirty      — sticky history: some attempt dirtied state
 *   stateResetVerified — a reset was checked against the baseline
 *                        fingerprint and matched
 *   stateResetTrusted  — a reset ran with NO fingerprint to verify
 *                        against (trusted, not verified)
 *   resetIncomplete    — a reset ran but failed fingerprint
 *                        verification; the loop stopped before rerun
 */
export async function runDevLoop({
  source,
  transport,
  fixer,
  consentProvider,
  session,
  stateReset,
  stateFingerprint,
  allowDirtyRerun = false,
  maxFixes = 3,
}) {
  if (typeof consentProvider !== "function") {
    return blockedReport("CONSENT_PROVIDER_REQUIRED");
  }

  const runner = createJsxRunner({ transport });
  const fp = typeof stateFingerprint === "function" ? stateFingerprint : null;
  const baselineFp = fp ? fp() : null;
  const report = {
    iterations: [],
    diagnostics: [],
    finalSource: source,
    outcome: null,
    stateDirty: false,
    stateWasDirty: false,
    stateResetVerified: false,
    stateResetTrusted: false,
    resetIncomplete: false,
    callbackError: null,
    quarantined: [],
  };
  let current = source;
  let pendingReset = false; // a dirty FAILED awaits state reconciliation

  for (let attempt = 0; attempt <= maxFixes; attempt += 1) {
    // Dirty-state gate: a previous FAILED may have partially mutated —
    // by host flag OR by observed fingerprint change. Rerun only after
    // an explicit reset VERIFIED against the baseline fingerprint, or
    // an explicit dirty-accept. A reset that does not restore the
    // baseline stops the loop before any further dispatch.
    if (pendingReset) {
      if (typeof stateReset === "function") {
        try {
          await stateReset(current, attempt);
        } catch (err) {
          // A throwing reset may have partially applied — the safe
          // report is FAILED + dirty + resetIncomplete, never an
          // unhandled rejection that loses the evidence.
          report.outcome = "FAILED";
          report.stateDirty = true;
          report.stateWasDirty = true;
          report.resetIncomplete = true;
          report.callbackError = {
            stage: "stateReset",
            message: err instanceof Error ? err.message : String(err),
          };
          return report;
        }
        if (fp && fp() !== baselineFp) {
          report.outcome = "FAILED";
          report.stateDirty = true;
          report.stateWasDirty = true;
          report.resetIncomplete = true;
          // A failed verification revokes any earlier verified claim.
          report.stateResetVerified = false;
          return report;
        }
        if (fp) {
          // Verified against the baseline: the dirty flag clears (the
          // historical fact stays in stateWasDirty).
          report.stateResetVerified = true;
          report.stateDirty = false;
        } else {
          // No fingerprint: the reset is trusted, NOT verified.
          report.stateResetTrusted = true;
        }
      } else if (!allowDirtyRerun) {
        report.outcome = "FAILED";
        report.stateDirty = true;
        return report;
      }
      pendingReset = false;
    }

    const preFp = fp ? fp() : null;
    let auth;
    try {
      auth = await consentProvider(current, attempt);
    } catch (err) {
      // Consent infrastructure failure before dispatch: nothing was
      // sent this attempt — BLOCKED with the error surfaced.
      report.outcome = "BLOCKED";
      report.blockedReason = `CONSENT_PROVIDER_ERROR: ${err instanceof Error ? err.message : String(err)}`;
      return report;
    }
    const out = await runner.runScript(runInput(current, session, auth ?? {}));
    const postFp = fp ? fp() : null;
    const stateChanged = preFp !== null && postFp !== preFp;
    report.iterations.push({
      attempt,
      requestId: out.requestId,
      outcome: out.outcome,
      contractOutcome: out.contractOutcome ?? null,
      mayHaveMutated: out.mayHaveMutated ?? null,
      stateChanged,
      result: out.result ?? null,
      error: out.error ?? null,
      refusal: out.refusal ?? null,
      unknownCategory: out.unknownCategory ?? null,
      retry: out.retry ?? null,
    });
    if (out.outcome === "UNKNOWN") report.quarantined.push(out.requestId);

    // Mutation evidence applies to EVERY outcome, not only FAILED: an
    // UNKNOWN reply may have mutated (runner classifies it
    // mayHaveMutated), and a consumer reading stateDirty===false as
    // "state is clean" must not be lied to.
    const mutated = out.mayHaveMutated === true || stateChanged === true;
    if (mutated && out.outcome !== "COMPLETED") {
      report.stateDirty = true;
      report.stateWasDirty = true;
    }

    if (out.outcome === "COMPLETED") {
      report.outcome = "COMPLETED";
      report.finalSource = current;
      return report;
    }
    if (out.outcome !== "FAILED") {
      // REFUSED/BLOCKED/UNKNOWN: stop, never silently retry. Surface
      // the runner's reason so the report is not a bare outcome.
      report.outcome = out.outcome;
      report.blockedReason =
        out.refusal?.code ?? out.unknownCategory ?? out.blocker?.code ?? null;
      return report;
    }

    const dirty = mutated;
    pendingReset = dirty;

    const diag = toDiagnostic(out);
    if (diag) report.diagnostics.push(diag);
    if (!fixer) {
      report.outcome = "FAILED";
      return report;
    }
    let fixed;
    try {
      fixed = await fixer(diag, current, attempt);
    } catch (err) {
      report.outcome = "FAILED";
      report.callbackError = {
        stage: "fixer",
        message: err instanceof Error ? err.message : String(err),
      };
      return report;
    }
    if (typeof fixed !== "string" || fixed === current) {
      report.outcome = "FAILED";
      report.finalSource = current;
      return report;
    }
    current = fixed;
    report.finalSource = current;
  }

  report.outcome = "FAILED"; // exhausted fix budget
  return report;
}

/*
 * regressionCheck: rerun the final source once more through the same
 * runner contract and require COMPLETED — but ONLY when the caller
 * asserts the script is idempotent (assumeIdempotent: true). Arbitrary
 * eval is treated as possibly-mutating; re-dispatching it "to check"
 * could duplicate side effects, so the default is an explicit skip.
 * `ok` additionally requires that no mutation was MEASURED when a
 * stateFingerprint is supplied — a COMPLETED rerun that changed state
 * is reported ok:false with mutationDetected:true.
 */
export async function regressionCheck({ source, transport, session, consentProvider, assumeIdempotent, stateFingerprint }) {
  const empty = { ok: false, outcome: null, result: null, mutationDetected: null };
  if (assumeIdempotent !== true) {
    return {
      ...empty,
      skipped: "mutating-unverified",
      reason: "regression rerun requires assumeIdempotent: true; arbitrary eval may mutate",
    };
  }
  if (typeof consentProvider !== "function") {
    return {
      ...empty,
      skipped: "consent-provider-required",
      outcome: "BLOCKED",
      reason: "no consentProvider supplied; the loop never self-issues consent",
    };
  }
  const runner = createJsxRunner({ transport });
  const fp = typeof stateFingerprint === "function" ? stateFingerprint : null;
  const beforeFp = fp ? fp() : null;
  let auth;
  try {
    auth = await consentProvider(source, -1);
  } catch (err) {
    return {
      ...empty,
      skipped: "consent-provider-error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const out = await runner.runScript(runInput(source, session, auth ?? {}));
  const afterFp = fp ? fp() : null;
  // When a fingerprint is supplied, mutation is MEASURED, not assumed:
  // assumeIdempotent is the operator's claim; this is the evidence —
  // and measured mutation FAILS the check, it does not ride along on ok.
  const mutationDetected = beforeFp !== null ? afterFp !== beforeFp : null;
  return {
    ok: out.outcome === "COMPLETED" && mutationDetected !== true,
    outcome: out.outcome,
    result: out.result ?? null,
    mutationDetected,
  };
}
