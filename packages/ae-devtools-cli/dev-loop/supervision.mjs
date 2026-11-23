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
  supervisionSnapshot,
  supervisionStatePath,
  waitForSupervisionPhase,
} from "../a8n-transport/supervision.mjs";

export {
  supervisionForSession,
  supervisionSnapshot,
  supervisionStatePath,
  waitForSupervisionPhase,
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
