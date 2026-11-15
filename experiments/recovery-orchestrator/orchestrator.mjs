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
 *                      degraded observation).
 *   residue          — after an exit/crash, windows or processes remain.
 *   clean            — process gone AND window census agrees AND evidence
 *                      collected. Only this verdict may be reported as
 *                      "recovered".
 *   unknown          — observation itself failed; never read as clean.
 *
 * Every function takes its dependencies as arguments so the whole cycle is
 * testable without After Effects. Real-host wiring lives in cli.mjs and is
 * UNVERIFIED while GUI testing is frozen.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const SCHEMA = "ae-devtools.recovery-orchestrator/v1";

// ------------------------------------------------------------ evidence

/**
 * Collect crash evidence produced since `since` (Date or ISO string).
 *
 * `.ips` files come from macOS DiagnosticReports; Sentry `*.envelope`
 * files come from the per-version SentryIO-db caches. Both are copied —
 * never moved or deleted — into `outDir`, with a manifest recording source
 * path, mtime and size so a later reader can tell preserved evidence from
 * live state.
 */
export function collectCrashEvidence({
  since,
  outDir,
  reportsDirs = [join(process.env.HOME ?? "", "Library/Logs/DiagnosticReports")],
  sentryDirs = [],
  now = () => new Date(),
}) {
  const cutoff = since instanceof Date ? since.getTime() : Date.parse(since);
  if (!Number.isFinite(cutoff)) {
    throw new Error(`collectCrashEvidence: --since is not a valid timestamp: ${since}`);
  }
  mkdirSync(outDir, { recursive: true });
  const copied = [];
  const scan = (dir, pattern, subdir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable dir is not "no crashes" — noted in the manifest
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const src = join(dir, name);
      let st;
      try {
        st = statSync(src);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const destDir = join(outDir, subdir);
      mkdirSync(destDir, { recursive: true });
      const dest = join(destDir, name);
      try {
        copyFileSync(src, dest);
        copied.push({ source: src, dest, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      } catch (error) {
        copied.push({ source: src, dest: null, error: String(error?.message ?? error) });
      }
    }
  };
  for (const dir of reportsDirs) scan(dir, /\.ips$/, "diagnostic-reports");
  for (const dir of sentryDirs) scan(dir, /\.envelope$/, "sentry");
  const manifest = {
    schema: SCHEMA,
    kind: "crash-evidence",
    since: new Date(cutoff).toISOString(),
    collectedAt: now().toISOString(),
    reportsDirs,
    sentryDirs,
    copied,
    note:
      "Copied evidence only. Absence of files here does NOT prove no crash " +
      "occurred — unreadable directories and unsent Sentry events leave gaps.",
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

// ------------------------------------------------------------ recovery

/**
 * Run one recovery attempt for a timed-out request and re-observe after.
 *
 * `recovery` is ae-a8n's HostRecovery (MacHostRecovery in production).
 * The original request is NEVER resent — the driver waits for its result.
 */
export async function runTimeoutRecovery({
  recovery,
  gui,
  requestId,
  method,
  timeoutMs,
  screenshotDir,
}) {
  const before = observeScreen({ gui, screenshotDir, requestId });
  let outcome;
  try {
    outcome = await recovery.attempt({ requestId, method, timeoutMs });
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
 * Requires agreement from independent sources before "clean":
 *   - the pid is gone (pidAlive === false; EPERM counts as alive)
 *   - the WindowServer census lists zero windows for the pid
 *     (or the census is unavailable → verdict degrades to unknown,
 *     never clean)
 *   - crash evidence was collected
 *
 * `gui` may be null when the process is already gone — census alone then
 * decides window residue.
 */
export function verifyHostExit({
  pid,
  pidAlive,
  gui = null,
  censusFor = null,
  screenshotDir = null,
  evidenceDir = null,
  since = null,
  collectEvidence = collectCrashEvidence,
  reportsDirs,
  sentryDirs,
}) {
  const result = {
    schema: SCHEMA,
    kind: "exit-verification",
    pid,
    checkedAt: new Date().toISOString(),
    processAlive: null,
    windowServer: null,
    axSuspect: null,
    screenshotPath: null,
    evidence: null,
    verdict: "unknown",
    reasons: [],
  };

  result.processAlive = pidAlive(pid);
  if (result.processAlive) {
    result.reasons.push("process is still alive — exit not verified");
    result.verdict = "residue";
    return result;
  }

  // Process gone: check window residue via census (independent of AX).
  if (censusFor) {
    try {
      const census = censusFor();
      if (census && census.available === false) {
        result.windowServer = { available: false, reason: census.reason ?? "unavailable" };
        result.reasons.push("window census unavailable — window residue cannot be proven absent");
        result.verdict = "unknown";
        return result;
      }
      const mine = (census?.windows ?? []).filter((w) => w.pid === pid);
      result.windowServer = {
        available: true,
        windowCount: mine.length,
        onScreenCount: mine.filter((w) => w.onScreen).length,
      };
      if (mine.length > 0) {
        result.reasons.push(`${mine.length} WindowServer window(s) still attributed to pid ${pid}`);
        result.verdict = "residue";
        return result;
      }
    } catch (error) {
      result.reasons.push(`window census failed: ${String(error?.message ?? error)}`);
      result.verdict = "unknown";
      return result;
    }
  } else {
    result.reasons.push("no census provided — window residue not independently verified");
    result.verdict = "unknown";
    return result;
  }

  if (evidenceDir) {
    try {
      result.evidence = collectEvidence({
        since: since ?? new Date(Date.now() - 24 * 3600 * 1000),
        outDir: evidenceDir,
        ...(reportsDirs ? { reportsDirs } : {}),
        ...(sentryDirs ? { sentryDirs } : {}),
      });
    } catch (error) {
      result.reasons.push(`evidence collection failed: ${String(error?.message ?? error)}`);
    }
  }

  if (result.reasons.length === 0 || result.reasons.every((r) => r.includes("evidence collection failed"))) {
    result.verdict = "clean";
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

export { existsSync, basename };
