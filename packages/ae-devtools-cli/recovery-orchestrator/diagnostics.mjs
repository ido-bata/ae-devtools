/*
 * diagnostics.mjs — recovery verdicts → canonical diagnostics records
 * (Issue #155, #55 consumer of #37).
 *
 * Maps recovery-orchestrator results onto `ae-devtools.diagnostics/v1`
 * so the dev loop's failure collection (#38) and diagnostics surfaces
 * (#20) consume ONE model. Nothing here invents positions or upgrades
 * evidence: `evidence` is "fake" unless the caller proves real-host
 * collection, and `unknown` verdicts always surface as problems —
 * never as clean.
 *
 * Verdict → action map (stop / recovery conditions):
 *
 *   await-original      info     — wait for the original request's
 *                                  result; NEVER resend it
 *   quarantined         error    — blocking window, not pressable
 *                                  (human-only / unclassified /
 *                                  mutation result unknown); STOP,
 *                                  human inspects
 *   refused             warning  — recovery declined before touching
 *                                  the screen; fix the prerequisite
 *   residue             warning  — process/windows still attributed;
 *                                  escalate, do not assume cleanup
 *   clean               info     — exit acceptance satisfied with all
 *                                  evidence channels complete
 *   crash-verified      error    — correlated crash report(s) proven
 *   crash-suspect       error    — correlated crash evidence for a
 *                                  process expected to exit cleanly
 *   crash-unconfirmed   warning  — crash expected but unproven
 *   unknown             error    — observation/evidence failed;
 *                                  never read as clean
 */
import { makeDiagnosticsRecord } from "../diagnostics/schema.mjs";

const VERDICT_KIND = {
  "await-original": "transport-outcome",
  quarantined: "transport-outcome",
  refused: "transport-outcome",
  residue: "transport-outcome",
  clean: "transport-outcome",
  "crash-verified": "native-crash",
  "crash-suspect": "native-crash",
  "crash-unconfirmed": "native-crash",
  unknown: "transport-outcome",
};

const VERDICT_SEVERITY = {
  "await-original": "info",
  clean: "info",
  refused: "warning",
  residue: "warning",
  "crash-unconfirmed": "warning",
  quarantined: "error",
  unknown: "error",
  "crash-verified": "error",
  "crash-suspect": "error",
};

const VERDICT_ACTION = {
  "await-original": "wait-for-original-result-no-resend",
  quarantined: "stop-human-inspect",
  refused: "fix-prerequisite-no-retry",
  residue: "escalate-residue",
  clean: "acceptance-satisfied",
  "crash-verified": "crash-accepted-evidence-complete",
  "crash-suspect": "escalate-unexpected-crash",
  "crash-unconfirmed": "escalate-crash-unproven",
  unknown: "stop-unknown-never-clean",
};

export const RECOVERY_VERDICTS = Object.freeze(Object.keys(VERDICT_KIND));

function base(ctx, kind, severity, message, outcome) {
  return makeDiagnosticsRecord({
    kind,
    severity,
    message,
    source: { assetKind: kind === "native-crash" ? "unknown" : "transport" },
    session: ctx.session,
    requestId: ctx.requestId,
    outcome,
    collector: "recovery-orchestrator",
    evidence: ctx.evidence ?? "fake",
  });
}

/**
 * Additive supervision suffix for record messages (Issue #408): when a
 * result carries the durable supervision snapshot, the phase + health +
 * needs-human detail ride the message so diagnostics consumers see the
 * same state every other surface reports. Absent supervision adds
 * nothing — the record contract is unchanged.
 */
function supervisionSuffix(result) {
  const s = result?.supervision;
  // timeout-recovery nests {before, after}; exit-verification carries the
  // snapshot directly on result.supervision.
  const sup = s !== null && typeof s === "object" && ("before" in s || "after" in s)
    ? (s.after ?? s.before ?? null)
    : s;
  if (sup === null || sup === undefined || typeof sup !== "object") return "";
  const parts = [`supervision=${sup.phase ?? sup.status ?? "?"}`];
  if (sup.health) parts.push(`health=${sup.health}`);
  if (sup.needsHuman) {
    parts.push(`needs-human: ${sup.needsHuman.reason ?? "human action required"}`);
  }
  return ` [${parts.join("; ")}]`;
}

/**
 * exit-verification result → diagnostics record(s). Always exactly one
 * record: every verdict is either a finding or an explicit acceptance.
 */
export function exitVerificationToDiagnostics(result, ctx = {}) {
  const verdict = result?.verdict;
  if (!VERDICT_KIND[verdict]) {
    throw new Error(`exitVerificationToDiagnostics: unknown verdict ${JSON.stringify(verdict)}`);
  }
  const reasons = (result.reasons ?? []).join("; ");
  return [
    base(
      ctx,
      VERDICT_KIND[verdict],
      VERDICT_SEVERITY[verdict],
      `exit-verification ${verdict} (expectation ${result.expectation ?? "?"}, pid ${result.pid ?? "?"}): ${reasons || "no reasons recorded"}${supervisionSuffix(result)}`,
      verdict,
    ),
  ];
}

/**
 * timeout-recovery result → one transport-outcome record. The original
 * request's resend prohibition is carried in the message, not implied.
 */
export function timeoutRecoveryToDiagnostics(result, ctx = {}) {
  const verdict = result?.verdict;
  if (!VERDICT_KIND[verdict]) {
    throw new Error(`timeoutRecoveryToDiagnostics: unknown verdict ${JSON.stringify(verdict)}`);
  }
  const oc = result.outcome ?? {};
  const detail = [oc.code, oc.evidence].filter((v) => typeof v === "string" && v.length > 0).join(" — ");
  return [
    base(
      ctx,
      "transport-outcome",
      VERDICT_SEVERITY[verdict],
      `timeout-recovery ${verdict} for ${result.method ?? "?"} (request ${result.requestId ?? "?"}): ${detail || "no outcome detail"} — original request is never resent${supervisionSuffix(result)}`,
      verdict,
    ),
  ];
}

/**
 * crash-evidence manifest → diagnostics records.
 *
 * Emits a `native-crash` record only when the collection actually
 * proves something:
 *   - ≥1 correlated report        → severity error (crash attributed)
 *   - collection incomplete       → severity warning (absence unproven)
 *   - otherwise                   → [] — no finding to record; an empty
 *     result is NOT a clean bill, it is simply nothing to diagnose.
 *
 * artifactHashes pin each correlated report's preserved sha256 so the
 * record cites exactly the bytes collected.
 */
export function crashEvidenceToDiagnostics(manifest, ctx = {}) {
  if (!manifest || manifest.kind !== "crash-evidence") {
    throw new Error("crashEvidenceToDiagnostics: expected a crash-evidence manifest");
  }
  const records = [];
  const counts = manifest.counts ?? {};
  const correlated = manifest.correlated ?? [];

  if (correlated.length > 0) {
    const artifactHashes = {};
    for (const entry of correlated) {
      if (typeof entry.sha256 === "string" && typeof entry.dest === "string") {
        artifactHashes[entry.dest] = entry.sha256;
      }
    }
    records.push(
      makeDiagnosticsRecord({
        kind: "native-crash",
        severity: "error",
        message:
          `crash evidence: ${correlated.length} report(s) correlate to ` +
          `pid ${manifest.target?.pid ?? "?"} (${counts.candidate ?? 0} candidate, ` +
          `${counts.unrelated ?? 0} unrelated, ${counts.unclassified ?? 0} unclassified)`,
        source: { assetKind: "unknown" },
        session: ctx.session,
        requestId: ctx.requestId,
        outcome: "crash-correlated",
        collector: "recovery-orchestrator",
        evidence: ctx.evidence ?? "fake",
        artifactHashes: Object.keys(artifactHashes).length > 0 ? artifactHashes : undefined,
      }),
    );
  }

  if (manifest.complete !== true) {
    records.push(
      base(
        ctx,
        "transport-outcome",
        "warning",
        `crash-evidence collection incomplete: ${(manifest.incompleteReasons ?? []).join("; ") || "unknown reason"} — absence of reports here proves nothing`,
        "evidence-incomplete",
      ),
    );
  }
  return records;
}

/** Verdict → required action, for callers building stop/recovery logic. */
export function recoveryActionFor(verdict) {
  const action = VERDICT_ACTION[verdict];
  if (!action) throw new Error(`recoveryActionFor: unknown verdict ${JSON.stringify(verdict)}`);
  return action;
}
