/**
 * session-guard.mjs — run markers + external reaper for the devtools CLI
 * (Issue #54).
 *
 * Problem this solves: `cli.mjs` used to call `process.exit()` from inside
 * `out()`, which bypassed `finally { session.close() }` and could leave an
 * owned After Effects running with no owner. Even with cleanup fixed, a
 * runner that is SIGKILLed or crashes cannot clean up after itself — so
 * every execute/verify run leaves a marker file that an external observer
 * (a later `doctor`/`reap` invocation, a human, ae-a8n #108's adopt path)
 * can use to find the residue.
 *
 * Marker lifecycle (statuses actually written today):
 *   beginRun()          — before session open (status "opening")
 *   markSession()       — after open (status "open"), records ownership
 *   endRun("closed")    — clean close: marker removed
 *   endRun("close-failed"|"open-failed") — marker kept, status set
 *
 * `surface` (Issue #198): which dev-loop surface owns the run —
 * "cli" (devtools-cli/cli.mjs), "mcp" (mcp-server), "vscode"
 * (vscode-extension). Non-CLI surfaces record markers for residue
 * visibility ONLY: they never call noteSessionProcess, so
 * session.process/attestation stays absent and reap/recover keep
 * refusing those markers (fail-closed).
 *
 *   Dead vocabulary note (Issue #196 inventory): "interrupted" and
 *   "error" were documented here historically but no writer ever
 *   emits them — a hard-killed runner simply leaves status "open".
 *   recovery-orchestrator/orchestrator.mjs accepts a WIDER status list
 *   on its own side ("closed","corrupt","open-failed","interrupted",
 *   "error","close-failed"); trimming that list is owned by the
 *   recovery-orchestrator workstream, not this file.
 *
 * Reap rules (fail-closed, mirrors ae-a8n ownership semantics):
 *   - runner pid alive            → refuse (the owner may still clean up)
 *   - runner pid dead + pid reuse → refuse unless start-time evidence matches
 *   - ownership.kind !== "owned"  → report only, NEVER quit (attached/unknown
 *     hosts belong to someone else; ae-a8n pendingLaunch stays provenance)
 *   - owned + exactly one AE process under the recorded install dir
 *                               → graceful quit via AppleScript, verified
 *
 * This is an experiment-level reaper. The durable adopt/resume contract is
 * ae-a8n #108; GUI/modal classification is ae-a8n #109.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GUARD_SCHEMA = "ae-devtools.cli.run-guard/v1";
/**
 * Canonical provenance marker for `session.process.attestation.source`.
 * The value is recorded by devtools-cli's a8n session opener from the LIVE
 * ae-a8n session object (`AfterEffects.recoveryTarget()` +
 * `ownership()`); recovery authorization and reap refuse markers that do
 * not carry it, so a self-declared JSON cannot mint GUI-change authority.
 */
export const ATTESTATION_SOURCE = "ae-a8n:AfterEffects.recoveryTarget()";
// Env override exists for tests; production runs always use the tmpdir
// default so markers are visible to ANY later CLI invocation (that is the
// point of an external reaper).
export const RUNS_DIR = process.env.AE_DEVTOOLS_CLI_RUNS_DIR
  ?? join(tmpdir(), "ae-devtools-cli-runs");

/** Run ids are `run-<timestamp>-<rand>` from beginRun(); anything else is
 *  not a marker we own and must never reach a path join (Issue #227). */
export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/;

/** pid liveness. EPERM means the process exists but is not ours to signal. */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Raw `ps lstart` string for pid-reuse detection; null when unreadable. */
export function processStartStamp(pid, exec = execFileAsync) {
  return exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 })
    .then(({ stdout }) => (stdout ?? "").trim() || null)
    .catch(() => null);
}

function markerPath(dir, runId) {
  return join(dir, `${runId}.json`);
}

function writeMarker(dir, marker) {
  mkdirSync(dir, { recursive: true });
  const target = markerPath(dir, marker.runId);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2));
  renameSync(tmp, target);
  return target;
}

function readMarker(dir, runId) {
  // Only canonical run-* ids may resolve to a marker path — a foreign id
  // must never escape the runs dir via `../` (Issue #227).
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return null;
  const file = markerPath(dir, runId);
  if (!existsSync(file)) return null;
  try {
    return { ...JSON.parse(readFileSync(file, "utf8")), markerPath: file };
  } catch {
    return { schema: GUARD_SCHEMA, runId, status: "corrupt", markerPath: file };
  }
}

/**
 * Record a run before the session is opened. `sessionKind` is "fake"|"a8n".
 * The marker exists even if openSession throws, so a launch that leaves an
 * unproven AE behind is still attributable to this runId.
 */
export async function beginRun({ dir = RUNS_DIR, sessionKind, argv = [], surface = null, exec = execFileAsync } = {}) {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const marker = {
    schema: GUARD_SCHEMA,
    runId,
    // Which surface owns this run ("cli"|"mcp"|"vscode"). Attribution
    // only — it grants no recovery authority.
    surface: typeof surface === "string" && surface.length > 0 ? surface : null,
    pid: process.pid,
    pidStartStamp: await processStartStamp(process.pid, exec),
    startedAt: new Date().toISOString(),
    argv,
    sessionKind,
    status: "opening",
    session: null,
    // Per-request execution records. A GUI recovery may only target a
    // request whose LATEST event is "timeout" — dispatched-then-resolved
    // or already-recovered requests are not recoverable.
    requests: [],
  };
  writeMarker(dir, marker);
  return { runId, markerPath: markerPath(dir, runId), marker };
}

/**
 * readMarker() returns a synthesized {status:"corrupt"} stub when the
 * marker file cannot be parsed. Mutators must NOT write that stub back —
 * doing so would overwrite the original corrupt content and destroy the
 * residue/forensics it carries. writableMarker() returns null for both
 * absent and corrupt markers.
 */
function writableMarker(dir, runId) {
  const marker = readMarker(dir, runId);
  return marker !== null && marker.status !== "corrupt" ? marker : null;
}

/** Attach session evidence once openSession resolves. */
export function markSession(dir, runId, session) {
  const marker = writableMarker(dir, runId);
  if (marker === null) return;
  marker.status = "open";
  marker.session = {
    kind: session.kind,
    evidenceLevel: session.evidenceLevel ?? null,
    meta: session.meta ?? {},
    ownership: session.ownership ?? null,
    installDir: session.installDir ?? null,
    appPath: session.appPath ?? null,
    tracePath: session.tracePath ?? null,
    workdir: session.workdir ?? null,
  };
  writeMarker(dir, marker);
}

/**
 * Attach host-process evidence the session opener actually observed:
 * the AE pid, its start stamp (PID-reuse detection), and the GUI session
 * (uid/asid) the process was verified to belong to. Recovery authorization
 * refuses markers that lack this — a self-declared session is not proof.
 */
export function noteSessionProcess(dir, runId, evidence = {}) {
  const marker = writableMarker(dir, runId);
  if (marker === null) return;
  const att = evidence.attestation;
  marker.session = {
    ...(marker.session ?? {}),
    process: {
      aePid: Number.isInteger(evidence.aePid) ? evidence.aePid : null,
      aePidStartStamp: typeof evidence.aePidStartStamp === "string" ? evidence.aePidStartStamp : null,
      guiSession: evidence.guiSession && Number.isFinite(evidence.guiSession.uid)
        ? { uid: evidence.guiSession.uid, asid: evidence.guiSession.asid ?? null }
        : null,
      // Provenance of the ownership claim: which ae-a8n contract attested
      // it and what ownership().evidence said. Absent attestation is
      // recorded as absent — recover/reap refuse it (fail-closed).
      attestation: att && typeof att === "object" && typeof att.source === "string"
        ? {
            source: att.source,
            ownershipKind: typeof att.ownershipKind === "string" ? att.ownershipKind : null,
            ownershipEvidence: typeof att.ownershipEvidence === "string" ? att.ownershipEvidence : null,
            transportKind: typeof att.transportKind === "string" ? att.transportKind : null,
            aeA8nVersion: typeof att.aeA8nVersion === "string" ? att.aeA8nVersion : null,
            recordedAt: new Date().toISOString(),
          }
        : null,
      recordedAt: new Date().toISOString(),
    },
  };
  writeMarker(dir, marker);
}

/**
 * Link a surviving run marker to the evidence file written for the run
 * (--out). Only markers that outlive cleanup (close-failed/open-failed)
 * can carry this — a cleanly closed run removes its marker, so
 * there is nothing to link. `ae-devtools diagnose <runId>` follows this
 * pointer to re-resolve stored diagnostics (Issue #103).
 */
export function attachEvidence(dir, runId, { file } = {}) {
  const marker = writableMarker(dir, runId);
  if (marker === null) return false;
  marker.evidenceFile = typeof file === "string" ? file : null;
  marker.evidenceRecordedAt = new Date().toISOString();
  writeMarker(dir, marker);
  return true;
}

/**
 * Append a request lifecycle event. Events: "dispatched", "timeout",
 * "resolved", "recovery-attempted". The latest event per requestId is the
 * request's state; only "timeout" is recoverable.
 */
export function recordRequestEvent(dir, runId, { requestId, method, event }) {
  const marker = writableMarker(dir, runId);
  if (marker === null) return false;
  if (typeof requestId !== "string" || requestId.length === 0) return false;
  if (!["dispatched", "timeout", "resolved", "recovery-attempted"].includes(event)) return false;
  marker.requests = Array.isArray(marker.requests) ? marker.requests : [];
  marker.requests.push({
    requestId,
    method: typeof method === "string" ? method : null,
    event,
    at: new Date().toISOString(),
  });
  writeMarker(dir, marker);
  return true;
}

/**
 * The latest recorded event for a requestId, or null when the request was
 * never recorded. Used by recovery authorization.
 */
export function latestRequestEvent(marker, requestId) {
  const events = (marker?.requests ?? []).filter((r) => r && r.requestId === requestId);
  return events.length === 0 ? null : events[events.length - 1];
}

/**
 * Close out a run. status "closed" removes the marker; anything else keeps
 * it so `doctor`/`reap` can still find the residue.
 */
export function endRun(dir, runId, status) {
  // A non-canonical runId can never name one of our markers — refuse
  // before markerPath joins it into a filesystem path (Issue #227).
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return;
  const file = markerPath(dir, runId);
  if (!existsSync(file)) return;
  if (status === "closed") {
    rmSync(file, { force: true });
    return;
  }
  const marker = writableMarker(dir, runId);
  if (marker !== null) {
    marker.status = status;
    marker.endedAt = new Date().toISOString();
    writeMarker(dir, marker);
  }
}

/**
 * Classify every marker. `aliveFn(pid)` decides runner liveness; when the
 * marker recorded a pidStartStamp, a live pid whose stamp differs is PID
 * reuse and counts as dead.
 */
export async function listRuns({
  dir = RUNS_DIR,
  aliveFn = pidAlive,
  stampFn = processStartStamp,
} = {}) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = [];
  for (const f of files) {
    const runId = f.replace(/\.json$/, "");
    const marker = readMarker(dir, runId);
    if (marker === null) continue;
    let runnerAlive = aliveFn(marker.pid);
    if (runnerAlive && marker.pidStartStamp && stampFn) {
      const now = await stampFn(marker.pid);
      if (now !== null && now !== marker.pidStartStamp) runnerAlive = false;
    }
    const owned = marker.session?.ownership?.kind === "owned";
    // reapable must mirror reap()'s gates, not just ownership: without
    // ae-a8n attestation and an app/install identity reap always
    // refuses, so reporting reapable:true would lie about exactly the
    // residue class surface guards (MCP/VSCode) produce (Issue #219).
    const att = marker.session?.process?.attestation;
    const attested = att?.source === ATTESTATION_SOURCE &&
      typeof att?.ownershipEvidence === "string" && att.ownershipEvidence.length > 0 &&
      Number.isInteger(marker.session?.process?.aePid);
    const hasAppIdentity = marker.session?.appPath != null || marker.session?.installDir != null;
    const reapBlockReason = runnerAlive
      ? "RUNNER_ALIVE"
      : owned !== true
        ? "OWNERSHIP_NOT_OWNED"
        : !attested
          ? "NO_A8N_ATTESTATION"
          : !hasAppIdentity
            ? "NO_APP_IDENTITY"
            : null;
    runs.push({
      ...marker,
      markerPath: markerPath(dir, runId),
      runnerAlive,
      reapable: reapBlockReason === null && marker.status !== "closed",
      reapBlockReason,
    });
  }
  return runs;
}

/** AE main-executable processes under a recorded install/app path. */
export async function findAeProcesses({ appPath, installDir, exec = execFileAsync } = {}) {
  const { stdout } = await exec("ps", ["-axo", "pid=,comm="], { timeout: 10_000 });
  const roots = [appPath, installDir].filter((p) => typeof p === "string" && p.length > 0);
  if (roots.length === 0) return [];
  return (stdout ?? "")
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), comm: m[2] }))
    .filter((p) => p.comm.endsWith("MacOS/After Effects"))
    .filter((p) => roots.some((root) => {
      const bundle = root.endsWith(".app") ? root : `${root.replace(/\/$/, "")}.app`;
      return p.comm.startsWith(bundle);
    }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attempt recovery for ONE stale run. Returns a verdict object; never
 * throws for policy refusals. Only an owned session with a resolvable app
 * path and exactly one live AE process is quit — via graceful AppleScript
 * `quit`, never SIGKILL.
 */
export async function reapRun(runId, {
  dir = RUNS_DIR,
  confirm = false,
  aliveFn = pidAlive,
  stampFn = processStartStamp,
  exec = execFileAsync,
  now = () => Date.now(),
  wait = sleep,
} = {}) {
  // A non-canonical runId can never name one of our markers — refuse
  // before markerPath joins it into a filesystem path (Issue #227).
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    return { runId, verdict: "REFUSED", reason: "INVALID_RUN_ID" };
  }
  const marker = readMarker(dir, runId);
  if (marker === null) return { runId, verdict: "NO_MARKER" };
  if (marker.status === "closed") return { runId, verdict: "ALREADY_CLOSED" };

  let runnerAlive = aliveFn(marker.pid);
  if (runnerAlive && marker.pidStartStamp && stampFn) {
    const stamp = await stampFn(marker.pid);
    if (stamp !== null && stamp !== marker.pidStartStamp) runnerAlive = false;
  }
  if (runnerAlive) return { runId, verdict: "REFUSED", reason: "RUNNER_ALIVE", pid: marker.pid };

  const ownership = marker.session?.ownership;
  if (!ownership || ownership.kind !== "owned") {
    return {
      runId, verdict: "REFUSED", reason: "OWNERSHIP_NOT_OWNED",
      ownership: ownership ?? null,
      note: "attached/unknown hosts are never quit by the reaper; resolve via ae-a8n #108 adopt or manually",
    };
  }

  // Quitting a process is a GUI-class mutation: the marker's ownership
  // claim must trace back to ae-a8n's attestation, and the process to be
  // quit must BE the attested aePid — "an AE under the same install dir"
  // is not proof it is this run's leftover (it could be the user's own
  // session). No attestation → refuse; identity mismatch → refuse.
  const proc = marker.session?.process;
  const attestation = proc?.attestation;
  if (
    !proc || !Number.isInteger(proc.aePid) ||
    !attestation || attestation.source !== ATTESTATION_SOURCE ||
    typeof attestation.ownershipEvidence !== "string" || attestation.ownershipEvidence.length === 0
  ) {
    return {
      runId, verdict: "REFUSED", reason: "NO_A8N_ATTESTATION",
      note: "marker lacks ae-a8n ownership attestation (session.process.attestation) — a self-declared owned claim cannot authorize a quit",
    };
  }

  const appPath = marker.session?.appPath ?? null;
  const installDir = marker.session?.installDir ?? null;
  if (appPath === null && installDir === null) {
    return { runId, verdict: "REFUSED", reason: "NO_APP_IDENTITY", ownership };
  }

  let candidates;
  try {
    candidates = await findAeProcesses({ appPath, installDir, exec });
  } catch (e) {
    return { runId, verdict: "REFUSED", reason: "PROCESS_SCAN_FAILED", message: String(e?.message ?? e) };
  }
  if (candidates.length === 0) {
    // No AE under the recorded install — but the attested pid itself may
    // still be alive somewhere the path-based scan cannot see. Declaring
    // CLEAN then would be a lie.
    if (aliveFn(proc.aePid)) {
      return {
        runId, verdict: "REFUSED", reason: "ATTESTED_PID_ALIVE_UNMATCHED",
        attestedPid: proc.aePid,
        note: "the attested aePid is still alive but was not found under the recorded install path — refusing to declare clean",
      };
    }
    endRun(dir, runId, "closed");
    return { runId, verdict: "CLEAN", note: "no live AE process for the recorded install" };
  }
  if (candidates.length > 1) {
    return {
      runId, verdict: "REFUSED", reason: "AMBIGUOUS_TARGET",
      candidates: candidates.map((c) => c.pid),
      note: "multiple AE processes match the install; refusing to pick one",
    };
  }
  // Single candidate must be the attested process, with the recorded
  // start stamp when one exists (PID-reuse check).
  const candidate = candidates[0];
  if (candidate.pid !== proc.aePid) {
    return {
      runId, verdict: "REFUSED", reason: "PID_NOT_ATTESTED",
      candidate,
      attestedPid: proc.aePid,
      note: "the only AE under the recorded install is not the attested aePid — it may be another session's process; refusing to quit",
    };
  }
  if (proc.aePidStartStamp && stampFn) {
    const stamp = await stampFn(candidate.pid);
    if (stamp === null || stamp !== proc.aePidStartStamp) {
      return {
        runId, verdict: "REFUSED", reason: "PID_REUSED",
        candidate,
        note: "the attested pid's start stamp no longer matches — the recorded process is gone and the number was reused",
      };
    }
  }
  if (!confirm) {
    return {
      runId, verdict: "REFUSED", reason: "CONFIRM_REQUIRED",
      candidate: candidates[0],
      note: "pass --confirm to allow a graceful quit of this owned leftover",
    };
  }

  const target = appPath ?? `${installDir.replace(/\/$/, "")}.app`;
  try {
    // Pass the target via argv — never interpolate a marker-controlled
    // path into an AppleScript string literal (Issue #227).
    await exec("osascript", [
      "-e", "on run argv",
      "-e", "tell application (item 1 of argv) to quit",
      "-e", "end run",
      target,
    ], { timeout: 30_000 });
  } catch (e) {
    return { runId, verdict: "QUIT_FAILED", candidate: candidates[0], message: String(e?.message ?? e) };
  }

  // Verify: the process must actually leave. Poll up to ~20s; only an
  // empty `ps -p` answer counts as gone — a failed scan proves nothing.
  const deadline = now() + 20_000;
  let gone = false;
  while (now() < deadline && !gone) {
    await wait(1_000);
    try {
      const { stdout } = await exec("ps", ["-p", String(candidates[0].pid), "-o", "pid="], { timeout: 5_000 });
      gone = (stdout ?? "").trim() === "";
    } catch { /* scan failure is not proof of exit */ }
  }
  if (!gone) {
    return { runId, verdict: "QUIT_UNCONFIRMED", candidate: candidates[0] };
  }
  endRun(dir, runId, "closed");
  return { runId, verdict: "REAPED", candidate: candidates[0] };
}
