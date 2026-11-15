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
 * (experiments/trusted-execution/runner.mjs, PR #42). This module adds
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
 * Diagnostic records intentionally mirror the experiments/diagnostics
 * schema (Issue #37, PR #41) field names — kind/severity/location —
 * but are produced here without importing that branch so this
 * experiment stands alone.
 */
import { createJsxRunner } from "../trusted-execution/runner.mjs";

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

/* Normalize a runner FAILED outcome into a diagnostics-shaped record.
 * Positions come ONLY from host-reported fields (runner marks them
 * hostReported) — never inferred. */
export function toDiagnostic(outcome, requestId) {
  const err = outcome && outcome.error;
  if (!err) return null;
  return {
    schema: "diagnostics/v1",
    kind: "script-exception",
    severity: "error",
    source: { assetKind: "jsx-script", requestId: requestId ?? outcome.requestId ?? null },
    message: String(err.message || ""),
    location:
      err.line != null || err.file != null
        ? {
            line: err.line ?? null,
            file: err.file ?? null,
            origin: err.hostReported === true ? "host-reported" : "unverified",
          }
        : null,
    hostError: { name: err.name ?? null },
  };
}

function blockedReport(reason) {
  return {
    iterations: [],
    diagnostics: [],
    finalSource: null,
    outcome: "BLOCKED",
    blockedReason: reason,
    stateDirty: false,
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
 *   allowDirtyRerun is explicitly set.
 * One runner instance is shared across attempts so requestId
 * single-use and UNKNOWN quarantine apply loop-wide.
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
    stateResetVerified: false,
    resetIncomplete: false,
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
        await stateReset(current, attempt);
        if (fp && fp() !== baselineFp) {
          report.outcome = "FAILED";
          report.stateDirty = true;
          report.resetIncomplete = true;
          return report;
        }
        report.stateResetVerified = true;
      } else if (!allowDirtyRerun) {
        report.outcome = "FAILED";
        report.stateDirty = true;
        return report;
      }
      pendingReset = false;
    }

    const preFp = fp ? fp() : null;
    const auth = await consentProvider(current, attempt);
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
      retry: out.retry ?? null,
    });
    if (out.outcome === "UNKNOWN") report.quarantined.push(out.requestId);

    if (out.outcome === "COMPLETED") {
      report.outcome = "COMPLETED";
      report.finalSource = current;
      return report;
    }
    if (out.outcome !== "FAILED") {
      // REFUSED/BLOCKED/UNKNOWN: stop, never silently retry.
      report.outcome = out.outcome;
      return report;
    }

    const dirty = out.mayHaveMutated === true || stateChanged === true;
    report.stateDirty = dirty ? true : report.stateDirty;
    pendingReset = dirty;

    const diag = toDiagnostic(out);
    if (diag) report.diagnostics.push(diag);
    if (!fixer) {
      report.outcome = "FAILED";
      return report;
    }
    const fixed = await fixer(diag, current, attempt);
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
 */
export async function regressionCheck({ source, transport, session, consentProvider, assumeIdempotent, stateFingerprint }) {
  if (assumeIdempotent !== true) {
    return {
      ok: false,
      skipped: "mutating-unverified",
      reason: "regression rerun requires assumeIdempotent: true; arbitrary eval may mutate",
      outcome: null,
    };
  }
  if (typeof consentProvider !== "function") {
    return { ok: false, skipped: "consent-provider-required", outcome: "BLOCKED" };
  }
  const runner = createJsxRunner({ transport });
  const fp = typeof stateFingerprint === "function" ? stateFingerprint : null;
  const beforeFp = fp ? fp() : null;
  const auth = await consentProvider(source, -1);
  const out = await runner.runScript(runInput(source, session, auth ?? {}));
  const afterFp = fp ? fp() : null;
  return {
    ok: out.outcome === "COMPLETED",
    outcome: out.outcome,
    result: out.result ?? null,
    // When a fingerprint is supplied, mutation is MEASURED, not assumed:
    // assumeIdempotent is the operator's claim; this is the evidence.
    mutationDetected: beforeFp !== null ? afterFp !== beforeFp : null,
  };
}
