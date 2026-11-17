/*
 * evidence.mjs — loop evidence serialization (Issue #150, CAP066).
 *
 * Serializes a runDevLoop report (+ optional regressionCheck result)
 * into a deterministic `ae-devtools.agent-loop-evidence/v1` document so
 * per-iteration request/result/diagnostics/regression data is recorded
 * as an artifact that a real-host run can later bind into the #21
 * conformance evidence schema.
 *
 * Honesty contract (CAP066):
 *   - `evidenceLevel` accepts ONLY "fake" today. Promoting loop success
 *     to "real-host" is the conformance pipeline's job (#21) backed by
 *     an owned-session run (CAP065) — this serializer refuses the claim.
 *   - Every diagnostics record is re-validated against
 *     ae-devtools.diagnostics/v1; an invalid record throws rather than
 *     being serialized into evidence.
 *   - Sources are recorded by sha256, not inlined — the document stays
 *     small and the bytes it describes are pinned by hash.
 *
 * Conformance mapping (documented, not automated): when a real-host
 * loop run exists, its evidence document supplies `iterations[].requestId`
 * (→ ConformanceRecord.runId/artifact refs), `iterations[].outcome` +
 * `diagnostics[]` (→ result/dimension evidence), `sources.sha256`
 * (→ artifactHashes entries) and session pin fields carried on
 * diagnostics records (→ environment.sessionRef). That binding is a
 * separate ticket; nothing here asserts verified-real-host.
 */
import { createHash } from "node:crypto";

import { validateDiagnosticsRecord } from "../diagnostics/schema.mjs";

export const LOOP_EVIDENCE_SCHEMA = "ae-devtools.agent-loop-evidence/v1";
export const LOOP_EVIDENCE_VERSION = 1;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * serializeLoopEvidence({ report, regression?, initialSource,
 *   finalSource?, evidenceLevel? })
 *
 * `report` is the object returned by runDevLoop; `regression` the object
 * returned by regressionCheck (or null when not run / skipped — the
 * skip reason is preserved verbatim).
 * `initialSource`/`finalSource` are the JSX sources; hashed, not stored.
 */
export function serializeLoopEvidence({
  report,
  regression = null,
  initialSource = null,
  finalSource = null,
  evidenceLevel = "fake",
}) {
  if (!report || typeof report !== "object") {
    throw new Error("serializeLoopEvidence: report must be a runDevLoop report object");
  }
  if (evidenceLevel !== "fake") {
    // Fail closed: fake-level loop evidence can never claim real-host.
    // Real-host promotion goes through the #21 conformance pipeline.
    throw new Error(
      `serializeLoopEvidence: evidenceLevel '${evidenceLevel}' refused — ` +
        "only 'fake' is supported; real-host binding requires the conformance pipeline",
    );
  }
  for (const diag of report.diagnostics ?? []) {
    validateDiagnosticsRecord(diag); // throws DiagnosticsSchemaError
  }

  const doc = {
    schema: LOOP_EVIDENCE_SCHEMA,
    recordVersion: LOOP_EVIDENCE_VERSION,
    evidenceLevel: "fake",
    generator: "agent-loop",
    finalOutcome: report.outcome ?? null,
    blockedReason: report.blockedReason ?? null,
    state: {
      dirty: report.stateDirty === true,
      wasDirty: report.stateWasDirty === true,
      resetVerified: report.stateResetVerified === true,
      resetTrusted: report.stateResetTrusted === true,
      resetIncomplete: report.resetIncomplete === true,
    },
    callbackError: report.callbackError ?? null,
    quarantined: [...(report.quarantined ?? [])],
    iterations: (report.iterations ?? []).map((it) => ({
      attempt: it.attempt,
      requestId: it.requestId ?? null,
      outcome: it.outcome ?? null,
      durationMs: Number.isFinite(it.durationMs) ? it.durationMs : null,
      contractOutcome: it.contractOutcome ?? null,
      mayHaveMutated: it.mayHaveMutated ?? null,
      stateChanged: it.stateChanged ?? null,
      result: it.result ?? null,
      error: it.error ?? null,
      refusal: it.refusal ?? null,
      unknownCategory: it.unknownCategory ?? null,
      retry: it.retry ?? null,
    })),
    diagnostics: report.diagnostics ?? [],
    regression: regression
      ? {
          ok: regression.ok === true,
          outcome: regression.outcome ?? null,
          skipped: regression.skipped ?? null,
          reason: regression.reason ?? null,
          mutationDetected: regression.mutationDetected ?? null,
          durationMs: Number.isFinite(regression.durationMs) ? regression.durationMs : null,
        }
      : null,
    sources: {
      initialSha256: typeof initialSource === "string" ? sha256(initialSource) : null,
      finalSha256: typeof finalSource === "string" ? sha256(finalSource) : null,
    },
    conformanceBinding: {
      status: "fake-only",
      promotable: false,
      note:
        "Fake-level loop evidence cannot satisfy ae-devtools.conformance-record/v1 " +
        "(requires verified-real-host + owned session). Real-host binding is the " +
        "CAP065/CAP066 real-host lane via the #21 conformance pipeline.",
    },
  };
  return doc;
}

/** Deterministic serialization: fixed key order, 2-space JSON + newline. */
export function serializeLoopEvidenceJson(input) {
  return JSON.stringify(serializeLoopEvidence(input), null, 2) + "\n";
}
