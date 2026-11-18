/**
 * real-run-session.mjs — guarded session open for opt-in REAL-AE driver
 * scripts (Issue #252).
 *
 * The real-run drivers (a8n-transport, jsx-toolchain, conformance) used
 * to call `openSliceSession` directly: canonical session-kind dispatch
 * (dev-loop/session-open.mjs) was bypassed AND no run-guard marker was
 * written, so a SIGKILLed or crashed driver left an owned After Effects
 * that `ae-devtools runs`/`reap`/`recover` could not even see — worse
 * than the pre-#198 MCP/VSCode case, which at least left an unattested
 * marker.
 *
 * This module is the ONE owner of the driver lifecycle prefix:
 *
 *   guard.begin()      — "opening" marker BEFORE session open, so a
 *                        launch that dies mid-open still leaves
 *                        attributable residue
 *   openSession("a8n") — the canonical kind dispatch (transport
 *                        existence check, openSliceSession, common
 *                        session shape + raw `slice` for internals)
 *   guard.mark()       — session evidence on the marker
 *   guard.process()    — attested host-process evidence built from the
 *                        slice's ae-a8n recoveryTarget(), the same rule
 *                        devtools-cli/cli.mjs applies. Because drivers
 *                        hold the slice, their residue IS recoverable
 *                        through the attested reap/recover path — unlike
 *                        MCP/VSCode markers, which stay refused.
 *
 * On open failure the marker is finalized "open-failed" and the error
 * rethrown unchanged — drivers keep their existing evidence/fatal
 * handling. Close-out stays with each driver (they record close
 * outcomes differently); drivers MUST call `guard.end(status)` with
 * "closed" or "close-failed" so the marker contract matches the CLI.
 *
 * `openSessionFn` is injectable for tests — production callers never
 * pass it.
 */
import { openSession } from "./session-open.mjs";
import { createSurfaceGuard } from "./surface-guard.mjs";
import {
  ATTESTATION_SOURCE,
  processStartStamp,
} from "../devtools-cli/session-guard.mjs";

/**
 * Attested process evidence for a slice session, or null when ae-a8n
 * cannot prove the owned target. Mirrors devtools-cli/cli.mjs's
 * openSession attestation block — kept here so every real-run driver
 * records the SAME provenance instead of copy-adapting it.
 *
 * @param {object|null} slice — raw openSliceSession result
 * @returns {Promise<object|null>} noteSessionProcess evidence shape
 */
export async function sliceProcessEvidence(slice) {
  const target = typeof slice?.ae?.recoveryTarget === "function"
    ? slice.ae.recoveryTarget()
    : null;
  if (target === null || target === undefined) return null;
  // Attestation provenance: recorded ONLY from the live ae-a8n session
  // object — never self-declared. Absent attestation is recorded as
  // absent and recover/reap refuse (fail-closed).
  const attestation = {
    source: ATTESTATION_SOURCE,
    ownershipKind: typeof slice.ownership?.kind === "string" ? slice.ownership.kind : null,
    ownershipEvidence: typeof slice.ownership?.evidence === "string" ? slice.ownership.evidence : null,
    transportKind: typeof slice.transportKind === "string" ? slice.transportKind : null,
    aeA8nVersion: typeof slice.aeA8nHead === "string" ? slice.aeA8nHead : null,
  };
  return {
    aePid: target.pid,
    aePidStartStamp: await processStartStamp(target.pid),
    guiSession: target.session === null || target.session === undefined
      ? null
      : { uid: target.session.uid, asid: target.session.asid ?? null },
    attestation,
  };
}

/**
 * Open an OWNED a8n session under a run-guard marker.
 *
 * @param {object} opts
 *   surface        — honest surface label for the marker
 *                    (e.g. "a8n-real-run", "jsx-real-run",
 *                    "conformance-real-run")
 *   argv           — driver argv recorded on the marker
 *   sessionOptions — { aeA8nRoot, installDir, workdir } forwarded to
 *                    openSession (a8n only)
 *   runsDir        — marker dir override (tests)
 *   openSessionFn  — test injection; defaults to the canonical
 *                    dev-loop/session-open.mjs openSession
 * @returns {Promise<{guard:object, opened:object, slice:object}>}
 *   `opened` is the common session shape (kind/evidenceLevel/runner/
 *   pin/close/meta); `slice` is the raw openSliceSession result the
 *   drivers need for transport internals. Throws the openSession error
 *   unchanged after finalizing the marker "open-failed".
 */
export async function openRealRunSession({
  surface,
  argv = [],
  sessionOptions = {},
  runsDir,
  openSessionFn = openSession,
} = {}) {
  const guard = createSurfaceGuard({ surface, sessionKind: "a8n", argv, dir: runsDir });
  await guard.begin();
  let opened;
  try {
    opened = await openSessionFn("a8n", sessionOptions);
  } catch (e) {
    guard.failOpen();
    throw e;
  }
  guard.mark(opened);
  const evidence = await sliceProcessEvidence(opened.slice);
  if (evidence !== null) guard.process(evidence);
  return { guard, opened, slice: opened.slice };
}
