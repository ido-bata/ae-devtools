/*
 * loop.mjs — the fake-level agent development loop (Issue #38, CAP065).
 *
 *   run JSX -> on script error, normalize a diagnostic record with the
 *   host-reported source position -> ask the injected `fixer` for a
 *   corrected source -> rerun -> on success, rerun once more as a
 *   regression check.
 *
 * Dispatch, consent gating, reply-identity checks, outcome
 * classification, deadline handling and UNKNOWN quarantine are ALL
 * delegated to the canonical trusted-execution runner
 * (experiments/trusted-execution/runner.mjs, PR #42). This module adds
 * only the loop policy: fix budget, diagnostic normalization, and the
 * regression rerun. It does not re-implement dispatch.
 *
 * Evidence level: fake/mock only. The "host" is fake-host.mjs (a Node
 * vm sandbox), the "fixer" is injected — in tests a deterministic
 * stand-in for an agent. This proves loop mechanics and diagnostic
 * plumbing, not real AE behavior, real ExtendScript semantics, or
 * production authorization (consent-token authenticity, host-side
 * re-validation and catalog-gate integration remain unproven per
 * runner.mjs non-claims).
 *
 * Diagnostic records intentionally mirror the experiments/diagnostics
 * schema (Issue #37, PR #41) field names — kind/severity/location —
 * but are produced here without importing that branch so this
 * experiment stands alone.
 */
import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { consentScopeFor } from "../trusted-execution/permissions.mjs";

/* Fake-session defaults. A real deployment pins the actual AE session
 * identity; these exist so the consent scope has a stable target. */
export const FAKE_SESSION = {
  pin: { sessionId: "agent-loop-fake-session", aeVersion: "fake", dispatchId: "fake" },
  operationId: "op.devloop.eval",
  projectIdentity: "proj-fake",
};

function consentFor(source, session) {
  const s = session ?? FAKE_SESSION;
  return {
    scope: consentScopeFor({
      pin: s.pin,
      operationId: s.operationId,
      args: { source, dispatchArgs: null },
      projectIdentity: s.projectIdentity,
    }),
  };
}

function runInput(source, session) {
  const s = session ?? FAKE_SESSION;
  return {
    source,
    pin: s.pin,
    operationId: s.operationId,
    projectIdentity: s.projectIdentity,
    consent: consentFor(source, s),
    trustedScriptOptIn: true,
    scriptProvenance: "agent-loop-fixture",
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

/**
 * runDevLoop({source, transport, fixer, session?, maxFixes?})
 *
 * fixer(diagnostic, source, attempt) -> corrected source string, or
 * null to give up. One runner instance is shared across attempts so
 * requestId single-use and UNKNOWN quarantine apply loop-wide.
 * Returns a report; never throws for script errors.
 */
export async function runDevLoop({
  source,
  transport,
  fixer,
  session,
  maxFixes = 3,
}) {
  const runner = createJsxRunner({ transport });
  const report = {
    iterations: [],
    diagnostics: [],
    finalSource: source,
    outcome: null,
    quarantined: [],
  };
  let current = source;

  for (let attempt = 0; attempt <= maxFixes; attempt += 1) {
    const out = await runner.runScript(runInput(current, session));
    report.iterations.push({
      attempt,
      requestId: out.requestId,
      outcome: out.outcome,
      contractOutcome: out.contractOutcome ?? null,
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
 * runner contract and require COMPLETED — proves the fix did not
 * depend on transient state.
 */
export async function regressionCheck({ source, transport, session }) {
  const runner = createJsxRunner({ transport });
  const out = await runner.runScript(runInput(source, session));
  return {
    ok: out.outcome === "COMPLETED",
    outcome: out.outcome,
    result: out.result ?? null,
  };
}
