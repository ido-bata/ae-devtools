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

export const SCHEMA = "ae-devtools.recovery-orchestrator/v2";

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
 *   correlated — the report's pid IS the target pid (strongest proof), or
 *                procPath + procLaunch + app version all match the target
 *                identity recorded at run start.
 *   candidate  — app/proc name matches but pid or path cannot be proven
 *                (pid may have been reused; the report may belong to a
 *                different run of the same app).
 *   unrelated  — a different application entirely.
 */
export function correlateReport(report, target) {
  if (report === null) return { level: "unparseable", reasons: ["report body could not be parsed"] };
  const reasons = [];
  const { header, body } = report;
  const nameMatch =
    (target.procName && body.procName === target.procName) ||
    (target.appName && (header.appName === target.appName || body.procName === target.appName));

  if (target.pid !== null && target.pid !== undefined && body.pid === target.pid) {
    reasons.push(`pid ${body.pid} matches the target process`);
    return { level: "correlated", reasons };
  }
  if (
    nameMatch &&
    target.procPath &&
    body.procPath === target.procPath &&
    target.appVersion &&
    (header.appVersion === target.appVersion || header.buildVersion === target.appVersion)
  ) {
    reasons.push("proc name, executable path and version all match the target");
    return { level: "correlated", reasons };
  }
  if (nameMatch) {
    reasons.push(
      body.pid !== null && body.pid !== target.pid
        ? `same app name but pid ${body.pid} is not the target pid ${target.pid ?? "?"}`
        : "same app name but pid/path could not be proven",
    );
    return { level: "candidate", reasons };
  }
  reasons.push(`app '${header.appName ?? body.procName ?? "?"}' does not match target '${target.procName ?? target.appName ?? "?"}'`);
  return { level: "unrelated", reasons };
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
  const scan = (dir, kind) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable dir is not "no crashes" — noted in the manifest
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
  const manifest = {
    schema: SCHEMA,
    kind: "crash-evidence",
    since: new Date(cutoff).toISOString(),
    collectedAt: now().toISOString(),
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
      copyErrors: entries.filter((e) => e.error !== null).length,
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

// ------------------------------------------------------------ run proof

/**
 * A run proof is the ownership/authorization record a caller must present
 * before `recover` may touch the GUI. It is produced by whatever launched
 * or adopted the AE session (ae-devtools execute/verify, a session
 * manager) and binds: which process, which GUI session, which requests
 * timed out, and who owns the recovery.
 *
 * Shape:
 *   {
 *     schema: "ae-devtools.run-proof/v1",
 *     ownerId: string,
 *     aePid: number,
 *     session: { uid: number, asid: number|null },
 *     issuedAt: string,
 *     requests: [{ requestId, method, timedOut: true }]
 *   }
 *
 * `verifyRunProof` never trusts self-declared flags: every field the CLI
 * was given must match the proof, and the request being recovered must be
 * a recorded timed-out request — an arbitrary pid + requestId pair cannot
 * reach a GUI mutation.
 */
export const RUN_PROOF_SCHEMA = "ae-devtools.run-proof/v1";

export function loadRunProof(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { ok: false, reason: `run proof is not readable JSON: ${String(error?.message ?? error)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "run proof is not an object" };
  }
  if (parsed.schema !== RUN_PROOF_SCHEMA) {
    return { ok: false, reason: `run proof schema is '${parsed.schema}', expected '${RUN_PROOF_SCHEMA}'` };
  }
  if (typeof parsed.ownerId !== "string" || parsed.ownerId.length === 0) {
    return { ok: false, reason: "run proof has no ownerId" };
  }
  if (!Number.isFinite(parsed.aePid)) {
    return { ok: false, reason: "run proof has no valid aePid" };
  }
  if (typeof parsed.session !== "object" || parsed.session === null ||
      !Number.isFinite(parsed.session.uid)) {
    return { ok: false, reason: "run proof has no valid session" };
  }
  if (!Array.isArray(parsed.requests)) {
    return { ok: false, reason: "run proof has no requests array" };
  }
  return { ok: true, proof: parsed };
}

/**
 * Check a run proof against what the caller claims. Returns
 * `{ ok: true, proof }` or `{ ok: false, reason }`. Pure — no GUI, no
 * filesystem beyond the already-loaded proof.
 */
export function verifyRunProof(proof, claim) {
  if (proof.aePid !== claim.pid) {
    return { ok: false, reason: `run proof is for aePid ${proof.aePid}, not ${claim.pid}` };
  }
  if (proof.session.uid !== claim.session.uid ||
      (proof.session.asid ?? null) !== (claim.session.asid ?? null)) {
    return { ok: false, reason: "run proof session does not match the claimed GUI session" };
  }
  const req = (proof.requests ?? []).find(
    (r) => r && r.requestId === claim.requestId && r.method === claim.method,
  );
  if (!req) {
    return {
      ok: false,
      reason: `request '${claim.requestId}' / '${claim.method}' is not a recorded timed-out request in the run proof`,
    };
  }
  if (req.timedOut !== true) {
    return { ok: false, reason: `request '${claim.requestId}' is not marked timedOut in the run proof` };
  }
  return { ok: true, proof };
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
    result.channels.evidence.state = "collected";
    result.channels.evidence.correlated = manifest.counts.correlated;
    result.channels.evidence.candidates = manifest.counts.candidate + manifest.counts.unclassified;
    if (manifest.counts.copyErrors > 0) {
      result.channels.evidence.detail = `${manifest.counts.copyErrors} file(s) failed to copy`;
      result.reasons.push(result.channels.evidence.detail);
    }
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
