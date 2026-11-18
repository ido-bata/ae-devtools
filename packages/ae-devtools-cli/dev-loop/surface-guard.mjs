/**
 * surface-guard.mjs — run-guard markers for non-CLI dev-loop surfaces
 * (Issue #198, design 案 C).
 *
 * MCP (`--session a8n`) and VSCode a8n sessions used to leave NO
 * run-guard residue: a SIGKILLed or crashed server could orphan an
 * owned After Effects with nothing attributable in the runs dir.
 * This module gives those surfaces the SAME marker lifecycle the CLI
 * uses (devtools-cli/session-guard.mjs) — beginRun before session
 * open, markSession after, recordRequestEvent per dispatch,
 * endRun on close — with an honest `surface` label ("mcp" / "vscode").
 *
 * What is deliberately NOT recorded (fail-closed, unchanged):
 *
 *   - `noteSessionProcess` is only reachable through `guard.process()`
 *     (Issue #252): surfaces holding the raw slice session — the
 *     opt-in real-run drivers via dev-loop/real-run-session.mjs — can
 *     attest the owned target through ae-a8n's recoveryTarget().
 *     MCP/VSCode never call it (the slice handle is stripped in
 *     mcp-server/session.mjs), so their markers stay unattested and
 *     reap/recover keep refusing them — residue is visible, but
 *     marker-only runs are never recoverable through the attested path.
 *   - No pids, ownership evidence or install paths are invented. Only
 *     what the stripped session actually carries (kind, evidenceLevel,
 *     meta incl. the ae-a8n-reported ownership KIND as a string) is
 *     written.
 *
 * Markers are only created for `sessionKind === "a8n"`: fake sessions
 * launch no AE and can leave no host residue, so recording them would
 * be noise, not signal.
 */
import {
  beginRun, markSession, recordRequestEvent, endRun, noteSessionProcess, RUNS_DIR,
} from "../devtools-cli/session-guard.mjs";

/**
 * Per-surface guard state for one lazily opened session. `begin()` is
 * awaited once before the session factory runs; `mark()`/`request()`/
 * `end()` no-op until then, so denied/never-opened sessions write
 * nothing.
 *
 * @param {object} opts
 *   surface    — "mcp" | "vscode" (honest label written to the marker)
 *   sessionKind— the requested kind; guard is inert unless "a8n"
 *   argv       — optional argv recorded on the marker (default [])
 *   dir        — runs dir (default RUNS_DIR / AE_DEVTOOLS_CLI_RUNS_DIR)
 */
export function createSurfaceGuard({ surface, sessionKind, argv = [], dir = RUNS_DIR } = {}) {
  const enabled = sessionKind === "a8n";
  let run = null; // { dir, runId } once begin() succeeds

  return {
    /** True once a marker exists (session open attempted). */
    get active() { return run !== null; },

    /** Write the "opening" marker BEFORE the session factory runs. */
    async begin() {
      if (!enabled || run !== null) return run;
      const g = await beginRun({ dir, sessionKind, argv, surface });
      run = { dir, runId: g.runId };
      return run;
    },

    /**
     * Attach session evidence after open. The stripped session has no
     * top-level `ownership` object — only `meta.ownership` (the kind
     * string ae-a8n reported). That is recorded as {kind, evidence:null}
     * so residue triage sees the claim while reap/recover still refuse
     * at the missing attestation gate.
     */
    mark(session) {
      if (run === null || !session || typeof session !== "object") return;
      const ownershipKind = session.ownership?.kind
        ?? (typeof session.meta?.ownership === "string" ? session.meta.ownership : null);
      markSession(run.dir, run.runId, {
        ...session,
        ownership: session.ownership ?? (ownershipKind !== null ? { kind: ownershipKind, evidence: null } : null),
      });
    },

    /**
     * Attach attested host-process evidence (Issue #252). Surfaces that
     * hold the raw slice session — the opt-in real-run drivers — can
     * prove the owned target via ae-a8n's recoveryTarget(); recording it
     * here makes a killed driver's residue recoverable through
     * `runs`/`reap`/`recover` instead of merely visible. Callers that
     * only have the stripped session (MCP/VSCode) never call this —
     * their markers stay unattested and recovery keeps refusing them.
     */
    process(evidence) {
      if (run === null || !evidence || typeof evidence !== "object") return;
      noteSessionProcess(run.dir, run.runId, evidence);
    },

    /** Append a request lifecycle event ({requestId, method, event}). */
    request(event) {
      if (run === null) return false;
      return recordRequestEvent(run.dir, run.runId, event);
    },

    /** Session open threw — keep the marker as open-failed residue. */
    failOpen() {
      if (run === null) return;
      endRun(run.dir, run.runId, "open-failed");
      run = null;
    },

    /**
     * Close out the run. "closed" removes the marker; "close-failed"
     * keeps it so `runs`/`reap` can find the residue — same contract as
     * the CLI's cleanup path.
     */
    end(status) {
      if (run === null) return;
      endRun(run.dir, run.runId, status);
      run = null;
    },
  };
}
