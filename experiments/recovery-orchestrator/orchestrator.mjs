/**
 * orchestrator.mjs — crash/modal/session-rebuild orchestration (Issue #55).
 *
 * Sits between ae-devtools callers and ae-a8n's macOS recovery surface
 * (ae-a8n #109 observation + #111 lease/classification, exported from the
 * package root). It never decides a dialog is absent when observation is
 * degraded, never presses anything itself, and never claims a cleanup that
 * an external actor performed.
 *
 * Verdict vocabulary (deliberately small and honest):
 *
 *   await-original   — a measured dialog was dismissed; the timed-out
 *                      request may still complete. Wait for its result;
 *                      do NOT resend it.
 *   quarantined      — a blocking window exists but is not pressable
 *                      (unclassified, human-only, unpressable class, or a
 *                      mutation whose result is unknown). Stop; a human
 *                      inspects.
 *   refused          — recovery declined before touching the screen
 *                      (no window, lease contention, session refusal,
 *                      degraded observation, missing/invalid run proof).
 *   residue          — after an exit/crash, the process is alive or the
 *                      window census still attributes windows to it.
 *   clean            — NORMAL-EXIT acceptance only: process gone AND
 *                      census agrees AND crash-evidence collection ran AND
 *                      no report correlates to the target. Requires all
 *                      four; any gap degrades to unknown, never clean.
 *   crash-verified   — CRASH acceptance: process gone, no window residue,
 *                      evidence collected, and ≥1 report CORRELATES to the
 *                      target (pid / launch / path proven).
 *   crash-unconfirmed— a crash was expected but only weak candidates or
 *                      nothing correlates; the crash itself is unproven.
 *   crash-suspect    — a normal exit was expected but correlated crash
 *                      evidence exists for the target.
 *   unknown          — observation or evidence itself failed; never read
 *                      as clean, residue, or verified.
 *
 * Every function takes its dependencies as arguments so the whole cycle is
 * testable without After Effects. Real-host wiring lives in cli.mjs and is
 * UNVERIFIED while GUI testing is frozen.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { GUARD_SCHEMA, latestRequestEvent } from "../devtools-cli/session-guard.mjs";

export const SCHEMA = "ae-devtools.recovery-orchestrator/v2";
export { GUARD_SCHEMA };

// ------------------------------------------------------------ evidence

const IPS_NAME = /\.ips$/;
const ENVELOPE_NAME = /\.envelope$/;

/** Parse the two-part .ips format: header line JSON + body JSON. */
export function parseIpsReport(text) {
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  let header;
  let body;
  try {
    header = JSON.parse(text.slice(0, nl));
    body = JSON.parse(text.slice(nl + 1));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  return {
    header: {
      appName: header.app_name ?? header.name ?? null,
      timestamp: header.timestamp ?? null,
      appVersion: header.app_version ?? null,
      buildVersion: header.build_version ?? null,
      bundleId: header.bundleID ?? null,
      bugType: header.bug_type ?? null,
      incidentId: header.incident_id ?? null,
    },
    body: {
      pid: typeof body.pid === "number" ? body.pid : null,
      procName: body.procName ?? null,
      procPath: body.procPath ?? null,
      procLaunch: body.procLaunch ?? null,
      captureTime: body.captureTime ?? null,
      userID: typeof body.userID === "number" ? body.userID : null,
    },
  };
}

/**
 * Correlate one parsed report to the target process.
 *
 * Fail-closed rules — a report is `correlated` ONLY when every available
 * identity signal agrees:
 *
 *   - pid matches AND procPath matches AND version matches AND
 *     procLaunch matches. An unrecorded launch stamp is unproven, not
 *     neutral — pid reuse under the same binary is exactly what the
 *     launch time exists to disprove, so `correlated` requires it.
 *
 * A bare pid match is NOT enough (pids are reused; the same binary can be
 * relaunched under the same pid). A name+path+version match without the
 * pid is a `candidate` — probably the same app, possibly a different run.
 * Anything else is `unrelated`.
 */
export function correlateReport(report, target) {
  if (report === null) return { level: "unparseable", reasons: ["report body could not be parsed"] };
  const reasons = [];
  const { header, body } = report;
  const nameMatch =
    (target.procName && body.procName === target.procName) ||
    (target.appName && (header.appName === target.appName || body.procName === target.appName));
  const versionMatch =
    target.appVersion &&
    (header.appVersion === target.appVersion || header.buildVersion === target.appVersion);
  const pathMatch = target.procPath && body.procPath === target.procPath;
  const pidMatch = target.pid !== null && target.pid !== undefined && body.pid === target.pid;
  const launchMatch =
    target.procLaunch === undefined || target.procLaunch === null || body.procLaunch === null || body.procLaunch === undefined
      ? null // either side lacks a launch stamp — cannot prove identity
      : launchStampsMatch(target.procLaunch, body.procLaunch);

  if (pidMatch && pathMatch && versionMatch && launchMatch === true) {
    reasons.push("pid, executable path, version and launch time all match the target");
    return { level: "correlated", reasons };
  }
  if (pidMatch) {
    reasons.push(
      !pathMatch
        ? "pid matches but executable path is unproven (pid may be reused)"
        : !versionMatch
          ? "pid+path match but version is unproven"
          : launchMatch === false
            ? "pid+path+version match but launch time differs"
            : "pid+path+version match but launch time is unrecorded — identity unproven",
    );
    return { level: "candidate", reasons };
  }
  if (nameMatch && pathMatch && versionMatch) {
    reasons.push("name+path+version match but pid does not — likely a different run of the same app");
    return { level: "candidate", reasons };
  }
  if (nameMatch) {
    reasons.push("same app name but pid/path/version could not be proven");
    return { level: "candidate", reasons };
  }
  reasons.push(`app '${header.appName ?? body.procName ?? "?"}' does not match target '${target.procName ?? target.appName ?? "?"}'`);
  return { level: "unrelated", reasons };
}

/**
 * Process launch stamps arrive in two formats that never string-match:
 *   .ips body `procLaunch`: "2026-11-15 10:47:39.0407 +0900"
 *   `ps -o lstart=`:         "Sun Nov 15 10:47:39 2026"   (local time)
 * Both are parsed to epoch ms; an unparseable stamp is unproven (null),
 * never guessed.
 */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function launchStampToMs(stamp) {
  if (typeof stamp !== "string" || stamp.length === 0) return null;
  const ips = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*([+-])(\d{2})(\d{2})?$/.exec(stamp.trim());
  if (ips) {
    const [, y, mo, d, h, mi, s, frac = "", sign, oh, om] = ips;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Number((frac + "000").slice(0, 3)));
    const off = (sign === "+" ? 1 : -1) * (+oh * 60 + +om) * 60_000;
    return ms - off;
  }
  const ps = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(stamp.trim());
  if (ps) {
    const mo = MONTHS[ps[1].slice(0, 3).toLowerCase()];
    if (mo === undefined) return null;
    return new Date(+ps[6], mo, +ps[2], +ps[3], +ps[4], +ps[5]).getTime();
  }
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Same process launch, allowing for the two formats' precision. */
function launchStampsMatch(a, b) {
  const ma = launchStampToMs(a);
  const mb = launchStampToMs(b);
  if (ma === null || mb === null) return null; // unproven
  return Math.abs(ma - mb) <= 2_000;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Collect crash evidence produced since `since` and CORRELATE it to the
 * target process.
 *
 * `.ips` files come from macOS DiagnosticReports; Sentry `*.envelope`
 * files come from the per-version SentryIO-db caches. Both are copied —
 * never moved or deleted — into `outDir`. Every copied file gets a
 * sha256 so later readers can verify the preserved bytes; the manifest
 * records correlation level per report so an unrelated app's crash is
 * never attributed to the target run.
 *
 * `target` fields (all optional except where noted):
 *   pid         — the AE pid recorded at run start (strongest signal)
 *   procName    — e.g. "After Effects"
 *   appName     — .ips header app_name, e.g. "After Effects"
 *   appVersion  — e.g. "27.0.0"
 *   procPath    — absolute executable path
 *   runId       — recorded for traceability; appears in the manifest only
 */
export function collectCrashEvidence({
  since,
  outDir,
  target = {},
  reportsDirs = [join(process.env.HOME ?? "", "Library/Logs/DiagnosticReports")],
  sentryDirs = [],
  now = () => new Date(),
}) {
  const cutoff = since instanceof Date ? since.getTime() : Date.parse(since);
  if (!Number.isFinite(cutoff)) {
    throw new Error(`collectCrashEvidence: --since is not a valid timestamp: ${since}`);
  }
  mkdirSync(outDir, { recursive: true });
  const entries = [];
  const unreadableDirs = [];
  const scan = (dir, kind) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      // An unreadable source dir means the collection is INCOMPLETE —
      // recorded, never silently treated as "no crashes here".
      unreadableDirs.push({ dir, kind, error: String(error?.message ?? error) });
      return;
    }
    for (const name of names) {
      const isIps = IPS_NAME.test(name);
      const isEnvelope = ENVELOPE_NAME.test(name);
      if ((kind === "reports" && !isIps) || (kind === "sentry" && !isEnvelope)) continue;
      const src = join(dir, name);
      let st;
      try {
        st = statSync(src);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const subdir = kind === "reports" ? "diagnostic-reports" : "sentry";
      const destDir = join(outDir, subdir);
      mkdirSync(destDir, { recursive: true });
      const dest = join(destDir, name);
      const entry = {
        source: src,
        dest: null,
        name,
        kind: kind === "reports" ? "ips" : "sentry-envelope",
        bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        sha256: null,
        correlation: null,
        error: null,
      };
      try {
        copyFileSync(src, dest);
        entry.dest = dest;
        entry.sha256 = sha256File(dest);
        if (isIps) {
          const report = parseIpsReport(readFileSync(dest, "utf-8"));
          const c = correlateReport(report, target);
          entry.correlation = { level: c.level, reasons: c.reasons };
          entry.report = report === null ? null : {
            pid: report.body.pid,
            procName: report.body.procName,
            procPath: report.body.procPath,
            procLaunch: report.body.procLaunch,
            captureTime: report.body.captureTime,
            appName: report.header.appName,
            appVersion: report.header.appVersion,
            incidentId: report.header.incidentId,
          };
        } else {
          entry.correlation = {
            level: "unclassified",
            reasons: ["Sentry envelopes are not parsed for attribution; treat as supporting evidence only"],
          };
        }
      } catch (error) {
        entry.error = String(error?.message ?? error);
      }
      entries.push(entry);
    }
  };
  for (const dir of reportsDirs) scan(dir, "reports");
  for (const dir of sentryDirs) scan(dir, "sentry");

  const byLevel = (level) => entries.filter((e) => e.correlation?.level === level);
  const copyErrors = entries.filter((e) => e.error !== null).length;
  const manifest = {
    schema: SCHEMA,
    kind: "crash-evidence",
    since: new Date(cutoff).toISOString(),
    collectedAt: now().toISOString(),
    // Independent completeness state: false whenever any source dir was
    // unreadable or any file failed to copy. Consumers must not treat an
    // incomplete collection as proof of absence.
    complete: unreadableDirs.length === 0 && copyErrors === 0,
    incompleteReasons: [
      ...unreadableDirs.map((d) => `unreadable ${d.kind} dir: ${d.dir} (${d.error})`),
      ...(copyErrors > 0 ? [`${copyErrors} file(s) failed to copy`] : []),
    ],
    unreadableDirs,
    target: {
      pid: target.pid ?? null,
      procName: target.procName ?? null,
      appName: target.appName ?? null,
      appVersion: target.appVersion ?? null,
      procPath: target.procPath ?? null,
      runId: target.runId ?? null,
    },
    reportsDirs,
    sentryDirs,
    counts: {
      total: entries.length,
      correlated: byLevel("correlated").length,
      candidate: byLevel("candidate").length,
      unrelated: byLevel("unrelated").length,
      unclassified: byLevel("unclassified").length + byLevel("unparseable").length,
      copyErrors,
    },
    correlated: byLevel("correlated"),
    candidates: entries.filter((e) => ["candidate", "unparseable", "unclassified"].includes(e.correlation?.level)),
    unrelated: byLevel("unrelated"),
    entries,
    note:
      "Copied evidence only; sha256 proves the preserved bytes. Absence of " +
      "files here does NOT prove no crash occurred — unreadable directories, " +
      "unsent Sentry events and .ips write lag leave gaps. Reports marked " +
      "'candidate' or 'unrelated' must NOT be attributed to the target run. " +
      ".ips files may contain local paths and process details; handle as " +
      "sensitive local evidence.",
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ------------------------------------------------------------ observation

/**
 * Observe the target's GUI state and take a screenshot as evidence.
 *
 * `gui` is anything shaped like ae-a8n's MacGuiRecovery (listWindows +
 * capture). A failed observation is reported, never converted into
 * "no windows".
 */
export function observeScreen({ gui, screenshotDir, requestId }) {
  const observedAt = new Date().toISOString();
  let state;
  try {
    state = gui.listWindows();
  } catch (error) {
    return {
      ok: false,
      observedAt,
      error: String(error?.message ?? error),
      verdict: "unknown",
    };
  }
  let screenshotPath = null;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    const target = join(screenshotDir, `recovery-${requestId}.png`);
    try {
      gui.capture(target);
      screenshotPath = target;
    } catch {
      // A missing screenshot degrades evidence, not the verdict.
    }
  }
  return {
    ok: true,
    observedAt,
    pid: state.pid,
    frontmost: state.frontmost,
    windowCount: state.windows.length,
    windows: state.windows.map((w) => ({
      title: w.title,
      role: w.role,
      subrole: w.subrole,
      buttons: (w.buttons ?? []).map((b) => b.title),
      texts: w.texts ?? [],
    })),
    windowServer: state.windowServer ?? null,
    axSuspect: state.axSuspect === true,
    screenshotPath,
  };
}

// ------------------------------------------------------------ run marker auth

/**
 * Recovery authorization reuses the devtools-cli run-guard marker
 * (`ae-devtools.cli.run-guard/v1`) — the same contract `runs`/`reap` use.
 * There is deliberately NO second, self-declared proof format: a JSON file
 * the caller writes proves nothing. Authorization requires the marker the
 * CLI itself wrote, cross-checked against live process state:
 *
 *   - marker exists, schema matches, status is not terminal/closed
 *   - the OWNING RUNNER is alive with the recorded start stamp (a dead
 *     runner's residue goes through reap/adopt, not GUI recovery)
 *   - ownership.kind === "owned" — attached/unknown sessions are never
 *     mutated
 *   - session.process evidence was recorded at open time: aePid,
 *     aePidStartStamp and guiSession {uid, asid}; all three required
 *   - the AE process is alive with the SAME start stamp (no pid reuse)
 *   - the request's LATEST recorded event is "timeout" with a matching
 *     method — dispatched-then-resolved or never-recorded requests are
 *     not recoverable
 *
 * Until a session producer records session.process evidence, every check
 * fails closed and `recover` cannot reach the GUI — which is the intended
 * state while the a8n session path is unverified.
 */
const TERMINAL_MARKER_STATUSES = new Set([
  "closed", "corrupt", "open-failed", "interrupted", "error", "close-failed",
]);

/** Read and schema-check a run marker. */
export function loadRunMarker(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    return { ok: false, reason: `run marker is not readable JSON: ${String(error?.message ?? error)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "run marker is not an object" };
  }
  if (parsed.schema !== GUARD_SCHEMA) {
    return { ok: false, reason: `run marker schema is '${parsed.schema}', expected '${GUARD_SCHEMA}'` };
  }
  if (typeof parsed.runId !== "string" || parsed.runId.length === 0) {
    return { ok: false, reason: "run marker has no runId" };
  }
  return { ok: true, marker: parsed };
}

/**
 * Authorize a recovery attempt against a loaded marker.
 *
 * `probes` are injected so the whole check is testable without live
 * processes: `pidAlive(pid)` and `pidStartStamp(pid)` (ps lstart string
 * or null). Both must be supplied — there is no "skip the liveness check"
 * path.
 */
export function authorizeRecovery({ marker, requestId, method, probes }) {
  if (TERMINAL_MARKER_STATUSES.has(marker.status)) {
    return { ok: false, reason: `run ${marker.runId} marker status is '${marker.status}' — nothing live to recover` };
  }
  if (marker.session?.ownership?.kind !== "owned") {
    return {
      ok: false,
      reason: `run ${marker.runId} session ownership is '${marker.session?.ownership?.kind ?? "none"}' — only owned sessions may be mutated`,
    };
  }
  const proc = marker.session?.process;
  if (!proc || !Number.isInteger(proc.aePid) || !proc.guiSession || !Number.isFinite(proc.guiSession.uid)) {
    return {
      ok: false,
      reason: "run marker carries no session.process evidence (aePid/guiSession) — the session opener did not prove which process and GUI session it owns",
    };
  }

  // Runner liveness: the process that owns this run must still be alive
  // with the same start stamp, or this marker is residue for `reap`, not
  // a live authorization.
  if (!probes.pidAlive(marker.pid)) {
    return { ok: false, reason: `run ${marker.runId} runner pid ${marker.pid} is dead — residue goes through reap/adopt, not GUI recovery` };
  }
  if (marker.pidStartStamp) {
    const now = probes.pidStartStamp(marker.pid);
    if (now !== null && now !== marker.pidStartStamp) {
      return { ok: false, reason: `run ${marker.runId} runner pid ${marker.pid} was reused (start stamp changed) — marker is stale` };
    }
  }

  // AE process liveness + identity: same pid AND same start stamp, or the
  // pid was reused by a different process.
  if (!probes.pidAlive(proc.aePid)) {
    return { ok: false, reason: `recorded aePid ${proc.aePid} is dead — nothing to recover` };
  }
  if (proc.aePidStartStamp) {
    const now = probes.pidStartStamp(proc.aePid);
    if (now !== null && now !== proc.aePidStartStamp) {
      return { ok: false, reason: `aePid ${proc.aePid} was reused (start stamp changed) — recorded process is gone` };
    }
  }

  // Request state: the LATEST recorded event must be "timeout" with the
  // claimed method. Anything else — never dispatched, already resolved,
  // already recovery-attempted — is not recoverable.
  const latest = latestRequestEvent(marker, requestId);
  if (latest === null) {
    return { ok: false, reason: `request '${requestId}' has no recorded execution in run ${marker.runId}` };
  }
  if (latest.method !== null && method !== null && latest.method !== method) {
    return { ok: false, reason: `request '${requestId}' was recorded as method '${latest.method}', not '${method}'` };
  }
  if (latest.event !== "timeout") {
    return {
      ok: false,
      reason: `request '${requestId}' latest event is '${latest.event}' — only a timed-out (UNKNOWN) request is recoverable`,
    };
  }

  return {
    ok: true,
    runId: marker.runId,
    ownerId: `run:${marker.runId}`,
    aePid: proc.aePid,
    guiSession: { uid: proc.guiSession.uid, asid: proc.guiSession.asid ?? null },
    request: latest,
  };
}

// ------------------------------------------------------------ recovery

/**
 * Run one recovery attempt for a timed-out request and re-observe after.
 *
 * `recovery` is ae-a8n's HostRecovery (MacHostRecovery in production).
 * The original request is NEVER resent — the driver waits for its result.
 * `ownerId` comes from the verified run proof, not from a flag.
 */
export async function runTimeoutRecovery({
  recovery,
  gui,
  requestId,
  method,
  timeoutMs,
  ownerId,
  screenshotDir,
}) {
  const before = observeScreen({ gui, screenshotDir, requestId });
  let outcome;
  try {
    outcome = await recovery.attempt({ requestId, method, timeoutMs, ownerId });
  } catch (error) {
    outcome = {
      recovered: false,
      outcome: "refused",
      evidence: `the recovery attempt itself failed: ${String(error?.message ?? error)}`,
    };
  }
  const after = observeScreen({ gui, screenshotDir, requestId: `${requestId}-post` });
  return {
    schema: SCHEMA,
    kind: "timeout-recovery",
    requestId,
    method,
    ownerId: ownerId ?? null,
    before,
    outcome: {
      recovered: outcome.recovered === true,
      outcome: outcome.outcome ?? null,
      code: outcome.code ?? null,
      evidence: outcome.evidence ?? null,
      window: outcome.window ?? null,
      screenshotPath: outcome.screenshotPath ?? null,
    },
    after,
    verdict: verdictForRecovery(outcome),
    rules: [
      "the timed-out request is never resent — its result may still arrive",
      "a quarantined or refused state is reported, never retried",
      "an external actor closing the dialog is not our recovery",
      "GUI mutation requires a verified run proof, not a self-declared requestId",
    ],
  };
}

function verdictForRecovery(outcome) {
  if (outcome.recovered === true) return "await-original";
  if (outcome.outcome === "quarantined") return "quarantined";
  if (outcome.outcome === "refused") return "refused";
  return "unknown";
}

// ------------------------------------------------------------ exit verify

/**
 * Verify that a host exit/crash actually cleaned up.
 *
 * Three evidence channels are recorded INDEPENDENTLY — process liveness,
 * WindowServer window census, crash-evidence collection — and the verdict
 * is derived from all three, never from a subset:
 *
 *   clean             expectation "exit":  process gone + census clean +
 *                     evidence collected + zero correlated reports
 *   crash-verified    expectation "crash": process gone + census clean +
 *                     evidence collected + ≥1 correlated report
 *   crash-unconfirmed expectation "crash": evidence collected but only
 *                     candidates/unrelated — the crash is unproven
 *   crash-suspect     expectation "exit":  correlated crash evidence found
 *                     for a process expected to exit cleanly
 *   residue           process still alive, or census attributes windows
 *   unknown           any channel failed or was not provided — never
 *                     promoted to clean
 *
 * `census` must already be scoped to the target GUI session by the caller
 * (ae-a8n `censusRunnerInSession`); `session` records whether uid/asid
 * were confirmed. An unconfirmed session degrades the census channel to
 * unavailable → unknown, never clean.
 */
export function verifyHostExit({
  pid,
  pidAlive,
  census = null,
  session = null,
  evidenceDir = null,
  target = {},
  expectation = "exit", // "exit" | "crash"
  since = null,
  collectEvidence = collectCrashEvidence,
  reportsDirs,
  sentryDirs,
}) {
  const result = {
    schema: SCHEMA,
    kind: "exit-verification",
    pid,
    expectation,
    checkedAt: new Date().toISOString(),
    channels: {
      process: { state: "unknown", detail: null },
      windows: { state: "unknown", detail: null, windowCount: null, onScreenCount: null },
      evidence: { state: "not-requested", detail: null, correlated: null, candidates: null },
    },
    verdict: "unknown",
    reasons: [],
  };

  // --- channel 1: process liveness -------------------------------------
  try {
    result.channels.process.state = pidAlive(pid) ? "alive" : "dead";
  } catch (error) {
    result.channels.process.detail = `pid liveness probe failed: ${String(error?.message ?? error)}`;
  }
  if (result.channels.process.state === "alive") {
    result.channels.windows.state = "skipped";
    result.channels.windows.detail = "process alive — window census not consulted";
    result.verdict = "residue";
    result.reasons.push("process is still alive — exit not verified");
    return result;
  }
  if (result.channels.process.state !== "dead") {
    result.verdict = "unknown";
    result.reasons.push(result.channels.process.detail ?? "process liveness could not be determined");
    return result;
  }

  // --- channel 2: WindowServer census (session-scoped by the caller) ----
  const sessionOk =
    session !== null &&
    Number.isFinite(session.uid) &&
    session.confirmed === true;
  if (!sessionOk) {
    result.channels.windows.state = "unavailable";
    result.channels.windows.detail =
      "GUI session (uid/asid) could not be confirmed — census cannot be scoped to the target session";
    result.verdict = "unknown";
    result.reasons.push(result.channels.windows.detail);
    return result;
  }
  if (!census || census.available !== true) {
    result.channels.windows.state = "unavailable";
    result.channels.windows.detail = census?.reason ?? "no census provided";
    result.verdict = "unknown";
    result.reasons.push(`window census unavailable: ${result.channels.windows.detail}`);
    return result;
  }
  const mine = (census.windows ?? []).filter((w) => w.pid === pid);
  result.channels.windows.state = "ok";
  result.channels.windows.windowCount = mine.length;
  result.channels.windows.onScreenCount = mine.filter((w) => w.onScreen).length;
  if (mine.length > 0) {
    result.verdict = "residue";
    result.reasons.push(`${mine.length} WindowServer window(s) still attributed to pid ${pid}`);
    return result;
  }

  // --- channel 3: crash evidence ----------------------------------------
  if (!evidenceDir) {
    result.channels.evidence.state = "not-requested";
    result.channels.evidence.detail = "no --evidence-dir given; collection skipped";
    result.verdict = "unknown";
    result.reasons.push("crash-evidence collection was not requested — cannot distinguish clean exit from unobserved crash");
    return result;
  }
  let manifest;
  try {
    manifest = collectEvidence({
      since: since ?? new Date(Date.now() - 24 * 3600 * 1000),
      outDir: evidenceDir,
      target: { ...target, pid },
      ...(reportsDirs ? { reportsDirs } : {}),
      ...(sentryDirs ? { sentryDirs } : {}),
    });
    result.channels.evidence.correlated = manifest.counts.correlated;
    result.channels.evidence.candidates = manifest.counts.candidate + manifest.counts.unclassified;
    // Completeness is an independent gate: an incomplete collection can
    // never support clean OR crash-verified — absence of evidence inside
    // an incomplete scan proves nothing.
    if (manifest.complete !== true) {
      result.channels.evidence.state = "incomplete";
      result.channels.evidence.detail = (manifest.incompleteReasons ?? []).join("; ") || "collection incomplete";
      result.verdict = "unknown";
      result.reasons.push(`evidence collection incomplete: ${result.channels.evidence.detail}`);
      return result;
    }
    result.channels.evidence.state = "collected";
  } catch (error) {
    result.channels.evidence.state = "failed";
    result.channels.evidence.detail = String(error?.message ?? error);
    result.verdict = "unknown";
    result.reasons.push(`evidence collection failed: ${result.channels.evidence.detail}`);
    return result;
  }

  // --- verdict ----------------------------------------------------------
  const correlated = manifest.counts.correlated;
  if (expectation === "crash") {
    if (correlated > 0) {
      result.verdict = "crash-verified";
      result.reasons.push(`${correlated} crash report(s) correlate to pid ${pid}`);
    } else {
      result.verdict = "crash-unconfirmed";
      result.reasons.push(
        manifest.counts.total === 0
          ? "no crash reports found since the cutoff — the crash itself is unproven"
          : `only ${manifest.counts.candidate} candidate / ${manifest.counts.unrelated} unrelated report(s); none correlate to pid ${pid}`,
      );
    }
  } else {
    if (correlated > 0) {
      result.verdict = "crash-suspect";
      result.reasons.push(`${correlated} correlated crash report(s) found for a process expected to exit cleanly`);
    } else {
      result.verdict = "clean";
      result.reasons.push("process gone, census clean, evidence collected, no correlated crash reports");
    }
  }
  return result;
}

// ------------------------------------------------------------ helpers

/** Summarize census windows for one pid (used by cli.mjs). */
export function censusSummary(census, pid) {
  const mine = (census?.windows ?? []).filter((w) => w.pid === pid);
  return {
    available: census?.available === true,
    reason: census?.available === true ? null : (census?.reason ?? "unavailable"),
    windowCount: mine.length,
    onScreenCount: mine.filter((w) => w.onScreen).length,
    windows: mine.map((w) => ({
      id: w.id ?? null,
      name: w.name ?? null,
      layer: w.layer ?? null,
      onScreen: w.onScreen === true,
      bounds: w.bounds ?? null,
    })),
  };
}

export { basename, existsSync };
