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
 * Marker lifecycle:
 *   beginRun()          — before session open (status "opening")
 *   markSession()       — after open, records ownership evidence
 *   endRun("closed")    — clean close: marker removed
 *   endRun("close-failed"|"interrupted"|"error") — marker kept, status set
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
// Env override exists for tests; production runs always use the tmpdir
// default so markers are visible to ANY later CLI invocation (that is the
// point of an external reaper).
export const RUNS_DIR = process.env.AE_DEVTOOLS_CLI_RUNS_DIR
  ?? join(tmpdir(), "ae-devtools-cli-runs");

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
export async function beginRun({ dir = RUNS_DIR, sessionKind, argv = [], exec = execFileAsync } = {}) {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const marker = {
    schema: GUARD_SCHEMA,
    runId,
    pid: process.pid,
    pidStartStamp: await processStartStamp(process.pid, exec),
    startedAt: new Date().toISOString(),
    argv,
    sessionKind,
    status: "opening",
    session: null,
  };
  writeMarker(dir, marker);
  return { runId, markerPath: markerPath(dir, runId), marker };
}

/** Attach session evidence once openSession resolves. */
export function markSession(dir, runId, session) {
  const marker = readMarker(dir, runId);
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
 * Close out a run. status "closed" removes the marker; anything else keeps
 * it so `doctor`/`reap` can still find the residue.
 */
export function endRun(dir, runId, status) {
  const file = markerPath(dir, runId);
  if (!existsSync(file)) return;
  if (status === "closed") {
    rmSync(file, { force: true });
    return;
  }
  const marker = readMarker(dir, runId);
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
    runs.push({
      ...marker,
      markerPath: markerPath(dir, runId),
      runnerAlive,
      reapable: !runnerAlive && owned === true && marker.status !== "closed",
      reapBlockReason: runnerAlive
        ? "RUNNER_ALIVE"
        : owned !== true
          ? "OWNERSHIP_NOT_OWNED"
          : null,
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
  if (!confirm) {
    return {
      runId, verdict: "REFUSED", reason: "CONFIRM_REQUIRED",
      candidate: candidates[0],
      note: "pass --confirm to allow a graceful quit of this owned leftover",
    };
  }

  const target = appPath ?? `${installDir.replace(/\/$/, "")}.app`;
  try {
    await exec("osascript", [
      "-e", `tell application "${target}" to quit`,
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
