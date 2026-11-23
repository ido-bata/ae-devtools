/**
 * supervision.mjs — dev-loop supervision snapshot helpers (Issue #408,
 * Epic #407).
 *
 * dev-loop surfaces (CLI, MCP, VSCode) never implement GUI probing,
 * dialog pressing or recovery policy. They consume the ae-a8n durable
 * supervision contract through a8n-transport/supervision.mjs and attach
 * an honest snapshot to evidence/diagnostics payloads:
 *
 *   - the snapshot records phase + observation health + the structured
 *     needs-human request (dialog, reason, options, resume path);
 *   - monitor-lost/degraded/unavailable health is recorded verbatim —
 *     never folded into "healthy";
 *   - waits on supervision are ALWAYS bounded (waitForSupervisionPhase
 *     honours both the caller's timeout and the phase's own deadline);
 *   - attached sessions get the same read-only view — this module only
 *     reads files, it never takes a lease or mutates the host.
 */
import {
  supervisionForSession,
  supervisionReport,
  supervisionSnapshot,
  supervisionStatePath,
  sessionDirFor,
  waitForSupervisionPhase,
} from "../a8n-transport/supervision.mjs";

export {
  supervisionForSession,
  supervisionSnapshot,
  supervisionStatePath,
  waitForSupervisionPhase,
  sessionDirFor,
};

/** Phases that mean "supervision has something to report". */
export const BLOCKING_SUPERVISION_PHASES = Object.freeze([
  "blocked",
  "recovering",
  "needs-human",
  "quarantined",
]);

/**
 * Read the supervision report for an open dev-loop session and return
 * the compact snapshot used in evidence/diagnostics payloads. Returns
 * null for sessions without an ae-a8n session root (fake) — honest
 * non-applicability, not a fabricated state.
 */
export function supervisionSnapshotForSession(session, options = {}) {
  const report = supervisionForSession(session, options);
  return report === null ? null : supervisionSnapshot(report);
}

/**
 * Read the supervision snapshot for an explicit ae-a8n session
 * directory (Issue #409): the same durable contract the session-bound
 * path uses, for surfaces that name the dir directly (CLI
 * `--session-root`, MCP `ae_supervision.sessionRoot`). Read-only —
 * never opens a session, never touches AE.
 */
export function supervisionSnapshotForDir(sessionDir, options = {}) {
  if (typeof sessionDir !== "string" || sessionDir.length === 0) return null;
  return supervisionSnapshot(supervisionReport(sessionDir, options));
}

/**
 * Bounded wait on an explicit session dir (Issue #409): same contract
 * as awaitSupervisionClassification but dir-addressed, for surfaces
 * that never opened a session.
 * @returns {Promise<{timedOut:boolean, deadlineExceeded:boolean,
 *   snapshot:object|null}>}
 */
export async function awaitSupervisionPhaseForDir(sessionDir, {
  timeoutMs = 5_000,
  intervalMs = 250,
  phases = BLOCKING_SUPERVISION_PHASES,
} = {}) {
  if (typeof sessionDir !== "string" || sessionDir.length === 0) {
    return { timedOut: false, deadlineExceeded: false, snapshot: null };
  }
  const outcome = await waitForSupervisionPhase(sessionDir, {
    phases,
    timeoutMs,
    intervalMs,
  });
  return {
    timedOut: outcome.timedOut,
    deadlineExceeded: outcome.deadlineExceeded,
    snapshot: supervisionSnapshot(outcome.report),
  };
}

// ------------------------------------------------------------ attached sessions (Issue #410)

/**
 * Whether a session is an explicit-attached session (Issue #366
 * contract): kind a8n-attached, or a session whose policy declares the
 * attached/read-only mode. Owned-disposable sessions are NOT attached —
 * they keep their own lifecycle and need no target re-validation to
 * read their own supervision state.
 */
export function isAttachedSession(session) {
  if (session === null || typeof session !== "object") return false;
  if (session.kind === "a8n-attached") return true;
  const policy = session.policy;
  return (
    policy !== null && typeof policy === "object" &&
    (policy.mode === "attached" || policy.readOnly === true)
  );
}

/**
 * Honest "cannot prove the target" snapshot for attached sessions whose
 * identity guard fails or is absent. Deliberately NOT the durable
 * report: after a session change / PID reuse / second instance the
 * state file may describe a DIFFERENT After Effects, and serving it
 * as current would be a false green. Fail closed — unavailable.
 */
function guardUnavailableSnapshot(reason, code = null) {
  return {
    status: "unavailable",
    source: "target-guard",
    code,
    reason,
    readAt: new Date().toISOString(),
  };
}

/**
 * Re-validate an attached session's target identity through the SAME
 * `targetGuard` runOperation invokes before mutating dispatches
 * (a8n-transport/attached-session.mjs revalidateTarget: census,
 * pid/start-stamp, version, project — fail closed on ambiguity). The
 * guard itself performs only ae-a8n attested reads; it never mutates.
 *
 * @returns {Promise<{ok:boolean, code:string|null, detail:string|null}>}
 *   ok:true for non-attached sessions (guard not required) and for
 *   attached sessions whose guard passes; ok:false with the guard's
 *   own code/detail otherwise. Never throws.
 */
export async function attachedTargetGuardVerdict(session) {
  if (!isAttachedSession(session)) return { ok: true, code: null, detail: null };
  if (typeof session?.targetGuard !== "function") {
    return {
      ok: false,
      code: "ATTACHED_TARGET_UNGUARDED",
      detail: "attached session carries no targetGuard — supervision state cannot be tied to a proven AE instance",
    };
  }
  try {
    const verdict = await session.targetGuard();
    if (verdict !== null && typeof verdict === "object" && verdict.ok === true) {
      return { ok: true, code: null, detail: null };
    }
    return {
      ok: false,
      code: typeof verdict?.code === "string" ? verdict.code : "ATTACHED_TARGET_UNVERIFIED",
      detail: typeof verdict?.detail === "string" ? verdict.detail : "attached target re-validation did not attest the session",
    };
  } catch (error) {
    return {
      ok: false,
      code: "ATTACHED_TARGET_UNVERIFIED",
      detail: `attached target re-validation threw: ${String(error?.message ?? error)}`,
    };
  }
}

/**
 * Guarded supervision snapshot for any dev-loop session (Issue #410).
 *
 *   - fake / no ae-a8n root → null (honest non-applicability)
 *   - owned a8n session → the durable report, unguarded (the session
 *     owns its AE; its own lifecycle bounds staleness)
 *   - attached session → the target identity is re-validated FIRST;
 *     a failed/missing guard yields an honest `unavailable`
 *     (source "target-guard") snapshot instead of a possibly-stale
 *     report. Reading never promotes ownership and never mutates.
 *
 * @returns {Promise<object|null>} supervisionSnapshot() shape, or null
 */
export async function guardedSupervisionSnapshot(session, options = {}) {
  const dir = sessionDirFor(session);
  if (dir === null) return null;
  if (isAttachedSession(session)) {
    const verdict = await attachedTargetGuardVerdict(session);
    if (!verdict.ok) {
      return guardUnavailableSnapshot(
        `attached target re-validation failed (${verdict.code}): ${verdict.detail} — ` +
          "the durable supervision state may describe a different After Effects instance",
        verdict.code,
      );
    }
  }
  return supervisionSnapshot(supervisionReport(dir, options));
}

/**
 * Bounded wait for supervision to classify a blocking state after a
 * dispatch ended UNKNOWN (the modal-dialog case supervision exists
 * for). Polls the durable state file only — never AE — until the phase
 * reaches one of `phases`, `timeoutMs` elapses, or the document's own
 * phase deadline passes, whichever comes first. There is no unbounded
 * wait path: a phase without a deadline simply cannot extend the wait.
 *
 * @returns {Promise<{timedOut:boolean, deadlineExceeded:boolean,
 *   snapshot:object|null}>}
 */
export async function awaitSupervisionClassification(session, {
  timeoutMs = 5_000,
  intervalMs = 250,
  phases = BLOCKING_SUPERVISION_PHASES,
} = {}) {
  const root = session?.slice?.sessionRoot ?? session?.sessionRoot ?? null;
  if (typeof root !== "string" || root.length === 0) {
    return { timedOut: false, deadlineExceeded: false, snapshot: null };
  }
  const outcome = await waitForSupervisionPhase(root, {
    phases,
    timeoutMs,
    intervalMs,
  });
  return {
    timedOut: outcome.timedOut,
    deadlineExceeded: outcome.deadlineExceeded,
    snapshot: supervisionSnapshot(outcome.report),
  };
}
