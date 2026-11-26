/**
 * run.mjs — recovery-orchestrator tests (Issue #55). Fake level only:
 * no After Effects, no GUI session, no real census. The real-host path in
 * cli.mjs is UNVERIFIED while GUI testing is frozen.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeRecovery,
  ATTESTATION_SOURCE,
  collectCrashEvidence,
  confirmGuiSession,
  correlateReport,
  GUARD_SCHEMA,
  loadRunMarker,
  observeScreen,
  parseIpsReport,
  runTimeoutRecovery,
  verifyHostExit,
} from "../orchestrator.mjs";
import {
  crashEvidenceToDiagnostics,
  exitVerificationToDiagnostics,
  recoveryActionFor,
  RECOVERY_VERDICTS,
  timeoutRecoveryToDiagnostics,
} from "../diagnostics.mjs";
import { validateDiagnosticsRecord } from "../../diagnostics/schema.mjs";
import { t, at, finish } from "../../scripts/testkit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.mjs");
const FAKE_A8N = join(HERE, "fixtures", "fake-a8n");

function tmp() { return mkdtempSync(join(tmpdir(), "ae-rec-orch-")); }

const IPS_PROC_PATH = "/Applications/Adobe After Effects 2027/Adobe After Effects 2027.app/Contents/MacOS/After Effects";
const IPS_LAUNCH = "2026-11-15 10:47:39.0407 +0900";

function ips(pid, { procName = "After Effects", appVersion = "27.0.0", procPath = IPS_PROC_PATH, procLaunch = IPS_LAUNCH } = {}) {
  const header = { app_name: "After Effects", timestamp: "2026-11-15 10:51:01.00 +0900", app_version: appVersion, build_version: appVersion, bundleID: "com.adobe.AfterEffects.application", bug_type: "309", incident_id: "INC-1" };
  const body = { pid, procName, procPath, procLaunch, captureTime: "2026-11-15 10:50:30.0000 +0900", userID: 501 };
  return `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`;
}

const TARGET_FULL = { pid: 4242, procName: "After Effects", appVersion: "27.0.0", procPath: IPS_PROC_PATH, procLaunch: IPS_LAUNCH };

const SESSION_OK = { uid: 501, asid: 42, confirmed: true };
const CENSUS_CLEAN = { available: true, windows: [{ pid: 9999, onScreen: true }] };
const CENSUS_DIRTY = { available: true, windows: [{ pid: 4242, onScreen: true, name: "dlg" }] };
const fakeEvidence = (counts, extra = {}) => () => ({
  complete: true,
  counts: { total: 0, correlated: 0, candidate: 0, unrelated: 0, unclassified: 0, copyErrors: 0, ...counts },
  ...extra,
});

// ------------------------------------------------ .ips parsing + correlation

t("parseIpsReport extracts header and body identity", () => {
  const r = parseIpsReport(ips(76784));
  assert.equal(r.header.appName, "After Effects");
  assert.equal(r.header.appVersion, "27.0.0");
  assert.equal(r.body.pid, 76784);
  assert.equal(r.body.procPath, IPS_PROC_PATH);
  assert.equal(parseIpsReport("garbage"), null);
});

t("correlateReport: pid+path+version+launch all matching is correlated", () => {
  const c = correlateReport(parseIpsReport(ips(4242)), TARGET_FULL);
  assert.equal(c.level, "correlated");
});

t("correlateReport: pid match ALONE is only a candidate (pid reuse)", () => {
  const c = correlateReport(parseIpsReport(ips(4242)), { pid: 4242 });
  assert.equal(c.level, "candidate");
});

t("correlateReport: pid+path but no version proof is candidate", () => {
  const c = correlateReport(parseIpsReport(ips(4242)), { pid: 4242, procPath: IPS_PROC_PATH });
  assert.equal(c.level, "candidate");
});

t("correlateReport: procLaunch mismatch downgrades to candidate", () => {
  const c = correlateReport(parseIpsReport(ips(4242)), { ...TARGET_FULL, procLaunch: "2026-11-15 09:00:00.0000 +0900" });
  assert.equal(c.level, "candidate");
});

t("correlateReport: ps-lstart target stamp matches ips procLaunch across formats", () => {
  // The two formats must normalize to the same instant, not string-match.
  // Build the ps-lstart string in LOCAL time from the ips instant so the
  // test is timezone-independent.
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const instant = new Date("2026-11-15T10:47:39.040+09:00"); // == IPS_LAUNCH
  const p2 = (n) => String(n).padStart(2, "0");
  const psStamp = `${DAYS[instant.getDay()]} ${MON[instant.getMonth()]} ${instant.getDate()} ` +
    `${p2(instant.getHours())}:${p2(instant.getMinutes())}:${p2(instant.getSeconds())} ${instant.getFullYear()}`;
  const c = correlateReport(parseIpsReport(ips(4242)), { ...TARGET_FULL, procLaunch: psStamp });
  assert.equal(c.level, "correlated");
});

t("correlateReport: unparseable launch stamp is unproven → candidate", () => {
  const c = correlateReport(parseIpsReport(ips(4242)), { ...TARGET_FULL, procLaunch: "not a stamp" });
  assert.equal(c.level, "candidate");
});

t("correlateReport: same app different pid is candidate; different app unrelated", () => {
  const c = correlateReport(parseIpsReport(ips(9999)), TARGET_FULL);
  assert.equal(c.level, "candidate");
  const c2 = correlateReport(parseIpsReport(ips(9999, { procName: "Safari" })), TARGET_FULL);
  assert.equal(c2.level, "unrelated");
});

// ------------------------------------------------ evidence collection

t("collectCrashEvidence correlates, hashes, separates unrelated, reports complete", () => {
  const root = tmp();
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "AE-target.ips"), ips(4242));
  writeFileSync(join(reports, "Safari-other.ips"), ips(7777, { procName: "Safari", procPath: "/Applications/Safari.app/Contents/MacOS/Safari" }));
  writeFileSync(join(reports, "notes.txt"), "ignored");

  const out = join(root, "out");
  const m = collectCrashEvidence({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    outDir: out,
    target: TARGET_FULL,
    reportsDirs: [reports],
    sentryDirs: [],
  });
  assert.equal(m.complete, true);
  assert.equal(m.counts.correlated, 1);
  assert.equal(m.counts.unrelated, 1);
  assert.equal(m.counts.total, 2);
  const corr = m.correlated[0];
  assert.equal(corr.report.pid, 4242);
  assert.match(corr.sha256, /^[0-9a-f]{64}$/);
  assert.equal(corr.sha256, createHash("sha256").update(readFileSync(corr.dest)).digest("hex"));
  assert.ok(m.note.includes("must NOT be attributed"));
  rmSync(root, { recursive: true, force: true });
});

t("collectCrashEvidence: pid-only target leaves matching-pid reports as candidates", () => {
  const root = tmp();
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  // Same pid but no procPath/version proof → candidate, not correlated.
  writeFileSync(join(reports, "AE-samepid.ips"), ips(4242));
  const m = collectCrashEvidence({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    outDir: join(root, "out"),
    target: { pid: 4242 },
    reportsDirs: [reports],
    sentryDirs: [],
  });
  assert.equal(m.counts.correlated, 0);
  assert.equal(m.counts.candidate, 1);
  rmSync(root, { recursive: true, force: true });
});

t("collectCrashEvidence: unreadable dir marks collection incomplete", () => {
  const root = tmp();
  const missing = join(root, "does-not-exist");
  const m = collectCrashEvidence({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    outDir: join(root, "out"),
    target: TARGET_FULL,
    reportsDirs: [missing],
    sentryDirs: [],
  });
  assert.equal(m.complete, false);
  assert.equal(m.unreadableDirs.length, 1);
  assert.ok(m.incompleteReasons[0].includes("unreadable"));
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------ observation honesty

function fakeGui({ windows = [], ws = { available: true, windowCount: 0, onScreenCount: 0 }, axSuspect = false, throwOnList = null }) {
  return {
    listWindows() {
      if (throwOnList) throw new Error(throwOnList);
      return {
        pid: 4242, frontmost: false, windows,
        windowServer: { available: ws.available, reason: ws.reason ?? null, windowCount: ws.windowCount, onScreenCount: ws.onScreenCount },
        axSuspect,
      };
    },
    capture(path) { writeFileSync(path, "png"); return path; },
  };
}

t("observeScreen reports AX-empty + WindowServer-visible as axSuspect", () => {
  const dir = tmp();
  const gui = fakeGui({ windows: [], ws: { available: true, windowCount: 6, onScreenCount: 1 }, axSuspect: true });
  const s = observeScreen({ gui, screenshotDir: dir, requestId: "r1" });
  assert.equal(s.ok, true);
  assert.equal(s.windowCount, 0);
  assert.equal(s.axSuspect, true);
  assert.equal(s.windowServer.windowCount, 6);
  assert.ok(s.screenshotPath);
  rmSync(dir, { recursive: true, force: true });
});

t("observeScreen failure is unknown, never empty", () => {
  const s = observeScreen({ gui: fakeGui({ throwOnList: "AX dead" }), requestId: "r2" });
  assert.equal(s.ok, false);
  assert.equal(s.verdict, "unknown");
});

// ------------------------------------------------ session confirmation

function sessionDeps({ alive = true, instances = null, liveSession = { uid: 501, asid: 42, username: "u", kind: "Aqua" } } = {}) {
  return {
    readGuiSession: (uid) => (uid === 501 ? liveSession : null),
    listAppInstances: () => {
      if (instances === null) throw new Error("lsappinfo unavailable");
      return instances;
    },
    pidAlive: () => alive,
  };
}

t("confirmGuiSession: dead pid confirms session with pidAttribution dead (lsappinfo cannot list it)", () => {
  const r = confirmGuiSession({
    deps: sessionDeps({ alive: false, instances: [] }),
    uid: 501, asid: 42, pid: 4242,
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.pidAttribution, "dead");
  assert.equal(r.session.asid, 42);
});

t("confirmGuiSession: live pid must be attributed to the claimed session", () => {
  const ok = confirmGuiSession({
    deps: sessionDeps({ alive: true, instances: [{ name: "AE", pid: 4242, uid: 501, asid: 42 }] }),
    uid: 501, asid: 42, pid: 4242,
  });
  assert.equal(ok.confirmed, true);
  assert.equal(ok.pidAttribution, "live-attributed");

  const unattributed = confirmGuiSession({
    deps: sessionDeps({ alive: true, instances: [{ name: "AE", pid: 4242, uid: 501, asid: 99 }] }),
    uid: 501, asid: 42, pid: 4242,
  });
  assert.equal(unattributed.confirmed, false);
  assert.match(unattributed.reason, /uid\/asid 501\/99/);

  const missing = confirmGuiSession({
    deps: sessionDeps({ alive: true, instances: [] }),
    uid: 501, asid: 42, pid: 4242,
  });
  assert.equal(missing.confirmed, false);
  assert.match(missing.reason, /not a registered app instance/);
});

t("confirmGuiSession: session identity failures refuse regardless of pid state", () => {
  for (const [deps, uid, asid, frag] of [
    [sessionDeps({ liveSession: null }), 501, 42, /no GUI session/],
    [sessionDeps({ liveSession: { uid: 501, asid: null } }), 501, 42, /no asid/],
    [sessionDeps({ liveSession: { uid: 501, asid: 7 } }), 501, 42, /claimed asid 42 but/],
    [sessionDeps({}), 501, null, /--session-asid is required/],
  ]) {
    const r = confirmGuiSession({ deps, uid, asid, pid: 4242 });
    assert.equal(r.confirmed, false);
    assert.match(r.reason, frag);
  }
});

// ------------------------------------------------ run marker authorization

function marker(over = {}) {
  return {
    schema: GUARD_SCHEMA,
    runId: "run-test-1",
    pid: 1000,
    pidStartStamp: "stamp-runner",
    startedAt: new Date().toISOString(),
    argv: ["execute", "op.x"],
    sessionKind: "a8n",
    status: "open",
    session: {
      kind: "a8n",
      evidenceLevel: "verified on real host (macOS)",
      meta: {},
      ownership: { kind: "owned" },
      installDir: "/Applications/Adobe After Effects 2027",
      appPath: null,
      process: {
        aePid: 4242,
        aePidStartStamp: "stamp-ae",
        guiSession: { uid: 501, asid: 42 },
        attestation: {
          source: ATTESTATION_SOURCE,
          ownershipKind: "owned",
          ownershipEvidence: "launched by this session; probe answered in session uid 501 asid 42",
          transportKind: "script-invocation",
          aeA8nVersion: "test",
          recordedAt: new Date().toISOString(),
        },
        recordedAt: new Date().toISOString(),
      },
    },
    requests: [
      { requestId: "req-1", method: "op.x", event: "dispatched", at: new Date().toISOString() },
      { requestId: "req-1", method: "op.x", event: "timeout", at: new Date().toISOString() },
    ],
    ...over,
  };
}

const liveProbes = {
  pidAlive: () => true,
  pidStartStamp: (pid) => (pid === 1000 ? "stamp-runner" : pid === 4242 ? "stamp-ae" : null),
};

t("loadRunMarker rejects missing/corrupt/wrong-schema files", () => {
  const root = tmp();
  assert.equal(loadRunMarker(join(root, "nope.json")).ok, false);
  const bad = join(root, "bad.json");
  writeFileSync(bad, "{}");
  assert.equal(loadRunMarker(bad).ok, false);
  rmSync(root, { recursive: true, force: true });
});

t("authorizeRecovery accepts a fully consistent live marker", () => {
  const r = authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: liveProbes });
  assert.equal(r.ok, true);
  assert.equal(r.aePid, 4242);
  assert.equal(r.guiSession.asid, 42);
  assert.equal(r.ownerId, "run:run-test-1");
});

t("authorizeRecovery refuses: terminal status, non-owned, missing process evidence", () => {
  for (const [m, frag] of [
    [marker({ status: "closed" }), /status is 'closed'/],
    [marker({ session: { ...marker().session, ownership: { kind: "attached" } } }), /ownership is 'attached'/],
    [marker({ session: { ...marker().session, process: null } }), /session\.process evidence/],
    [marker({ session: { ...marker().session, process: { aePid: 4242, aePidStartStamp: "s", guiSession: null } } }), /session\.process evidence/],
  ]) {
    const r = authorizeRecovery({ marker: m, requestId: "req-1", method: "op.x", probes: liveProbes });
    assert.equal(r.ok, false);
    assert.match(r.reason, frag);
  }
});

t("authorizeRecovery refuses dead runner, reused runner pid, dead/reused aePid", () => {
  const deadRunner = { ...liveProbes, pidAlive: (pid) => pid !== 1000 };
  assert.match(authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: deadRunner }).reason, /runner pid 1000 is dead/);
  const reusedRunner = { ...liveProbes, pidStartStamp: () => "different-stamp" };
  assert.match(authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: reusedRunner }).reason, /was reused/);
  const deadAe = { ...liveProbes, pidAlive: (pid) => pid === 1000 };
  assert.match(authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: deadAe }).reason, /aePid 4242 is dead/);
  const reusedAe = { ...liveProbes, pidStartStamp: (pid) => (pid === 1000 ? "stamp-runner" : "other") };
  assert.match(authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: reusedAe }).reason, /aePid 4242 was reused/);
});

t("authorizeRecovery refuses liveness 'unknown' for runner and aePid (Issue #423)", () => {
  const tri = (state) => ({ ...liveProbes, pidLiveness: () => state });
  for (const state of ["unknown", "dead"]) {
    const r = authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: tri(state) });
    assert.equal(r.ok, false);
    assert.match(r.reason, state === "dead" ? /runner pid 1000 is dead/ : /runner pid 1000 liveness is 'unknown'/);
  }
  // Runner alive but AE liveness unknown → still refused before any GUI op.
  const probes = {
    pidLiveness: (pid) => (pid === 1000 ? "alive" : "unknown"),
    pidStartStamp: liveProbes.pidStartStamp,
  };
  const r = authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes });
  assert.equal(r.ok, false);
  assert.match(r.reason, /aePid 4242 liveness is 'unknown'/);
  // A throwing liveness probe is unknown, never a crash or a pass.
  const throwing = { ...liveProbes, pidLiveness: () => { throw new Error("probe exploded"); } };
  assert.equal(authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: throwing }).ok, false);
});

t("authorizeRecovery refuses when a recorded start stamp probes unreadable", () => {
  // Runner alive, stamp recorded, ps cannot read it → identity unproven.
  const noRunnerStamp = { ...liveProbes, pidStartStamp: (pid) => (pid === 4242 ? "stamp-ae" : null) };
  assert.match(
    authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: noRunnerStamp }).reason,
    /runner pid 1000 start stamp is unreadable/,
  );
  // Same for the AE pid.
  const noAeStamp = { ...liveProbes, pidStartStamp: (pid) => (pid === 1000 ? "stamp-runner" : null) };
  assert.match(
    authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: noAeStamp }).reason,
    /aePid 4242 start stamp is unreadable/,
  );
  // A missing stamp probe entirely reads as unreadable, not skipped.
  const noStampProbe = { pidAlive: liveProbes.pidAlive };
  assert.match(
    authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.x", probes: noStampProbe }).reason,
    /start stamp is unreadable/,
  );
});

t("confirmGuiSession refuses pid liveness 'unknown' instead of recording dead", () => {
  const deps = {
    readGuiSession: () => ({ uid: 501, asid: 42, username: "u", kind: "Aqua" }),
    listAppInstances: () => [],
    pidLiveness: () => "unknown",
  };
  const r = confirmGuiSession({ deps, uid: 501, asid: 42, pid: 4242 });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /liveness could not be proven/);
});

t("authorizeRecovery refuses markers without ae-a8n attestation provenance", () => {
  const noAtt = marker();
  delete noAtt.session.process.attestation;
  let r = authorizeRecovery({ marker: noAtt, requestId: "req-1", method: "op.x", probes: liveProbes });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no ae-a8n ownership attestation/);

  const wrongSource = marker();
  wrongSource.session.process.attestation = { ...wrongSource.session.process.attestation, source: "self-declared" };
  r = authorizeRecovery({ marker: wrongSource, requestId: "req-1", method: "op.x", probes: liveProbes });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no ae-a8n ownership attestation/);

  const noEvidence = marker();
  noEvidence.session.process.attestation = { ...noEvidence.session.process.attestation, ownershipEvidence: "" };
  r = authorizeRecovery({ marker: noEvidence, requestId: "req-1", method: "op.x", probes: liveProbes });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ownership\(\)\.evidence/);
});

t("authorizeRecovery refuses unrecorded/resolved/recovery-attempted/wrong-method requests", () => {
  assert.match(
    authorizeRecovery({ marker: marker(), requestId: "req-evil", method: "op.x", probes: liveProbes }).reason,
    /no recorded execution/,
  );
  const resolved = marker({ requests: [
    { requestId: "req-1", method: "op.x", event: "dispatched", at: "" },
    { requestId: "req-1", method: "op.x", event: "resolved", at: "" },
  ] });
  assert.match(authorizeRecovery({ marker: resolved, requestId: "req-1", method: "op.x", probes: liveProbes }).reason, /latest event is 'resolved'/);
  const attempted = marker({ requests: [
    { requestId: "req-1", method: "op.x", event: "timeout", at: "" },
    { requestId: "req-1", method: "op.x", event: "recovery-attempted", at: "" },
  ] });
  assert.match(authorizeRecovery({ marker: attempted, requestId: "req-1", method: "op.x", probes: liveProbes }).reason, /latest event is 'recovery-attempted'/);
  assert.match(
    authorizeRecovery({ marker: marker(), requestId: "req-1", method: "op.other", probes: liveProbes }).reason,
    /recorded as method 'op\.x'/,
  );
});

// ------------------------------------------------ recovery verdicts

const win = (title, subrole = "AXDialog") => ({
  title, role: "AXWindow", subrole,
  buttons: [{ title: "OK" }], texts: [],
});

function fakeRecovery(outcome) {
  const rec = { lastCtx: null, attempt: async (ctx) => { rec.lastCtx = ctx; return outcome; } };
  return rec;
}

await at("runTimeoutRecovery maps dismissed to await-original, passes ownerId, never resends", async () => {
  const dir = tmp();
  const gui = fakeGui({ windows: [win("x")] });
  const recovery = fakeRecovery({ recovered: true, outcome: "dismissed", evidence: "pressed OK" });
  const r = await runTimeoutRecovery({
    recovery, gui, requestId: "req-1", method: "app.info", timeoutMs: 1000,
    ownerId: "run:run-test-1", screenshotDir: dir,
  });
  assert.equal(r.verdict, "await-original");
  assert.equal(r.ownerId, "run:run-test-1");
  assert.equal(recovery.lastCtx.ownerId, "run:run-test-1");
  rmSync(dir, { recursive: true, force: true });
});

await at("runTimeoutRecovery quarantined/refused/throw map honestly", async () => {
  for (const [outcome, verdict] of [
    [{ recovered: false, outcome: "quarantined", code: "A8N-SEC-001" }, "quarantined"],
    [{ recovered: false, outcome: "refused", evidence: "lease held" }, "refused"],
  ]) {
    const r = await runTimeoutRecovery({
      recovery: fakeRecovery(outcome), gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
    });
    assert.equal(r.verdict, verdict);
  }
  const r = await runTimeoutRecovery({
    recovery: { attempt: async () => { throw new Error("boom"); } },
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
  });
  assert.equal(r.verdict, "refused");
  assert.match(r.outcome.evidence, /boom/);
});

// ------------------------------------------------ exit verification

t("verifyHostExit: alive process is residue regardless of other channels", () => {
  const r = verifyHostExit({ pid: 1, pidAlive: () => true, census: CENSUS_CLEAN, session: SESSION_OK });
  assert.equal(r.verdict, "residue");
  assert.equal(r.channels.windows.state, "skipped");
});

t("verifyHostExit: pid liveness 'unknown' is unknown, never clean (Issue #423)", () => {
  const r = verifyHostExit({
    pid: 4242, pidLiveness: () => "unknown",
    census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), target: {}, collectEvidence: fakeEvidence({ correlated: 0 }),
  });
  assert.equal(r.channels.process.state, "unknown");
  assert.equal(r.verdict, "unknown");
  // Legacy boolean probe still maps false → dead for injected doubles.
  const legacy = verifyHostExit({
    pid: 4242, pidAlive: () => false,
    census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), target: {}, collectEvidence: fakeEvidence({ correlated: 0 }),
  });
  assert.equal(legacy.channels.process.state, "dead");
  assert.equal(legacy.verdict, "clean");
});

t("verifyHostExit: dead + unconfirmed session is unknown, never clean", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false,
    census: CENSUS_CLEAN,
    session: { uid: 501, asid: 42, confirmed: false, reason: "no GUI session" },
    evidenceDir: tmp(),
  });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.channels.windows.state, "unavailable");
});

t("verifyHostExit: census unavailable is unknown", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: { available: false, reason: "no python" },
    session: SESSION_OK, evidenceDir: tmp(),
  });
  assert.equal(r.verdict, "unknown");
});

t("verifyHostExit: census windows for pid is residue", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_DIRTY,
    session: SESSION_OK, evidenceDir: tmp(),
  });
  assert.equal(r.verdict, "residue");
  assert.equal(r.channels.windows.windowCount, 1);
});

t("verifyHostExit: missing evidenceDir is unknown, NOT clean", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
  });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.channels.evidence.state, "not-requested");
});

t("verifyHostExit: evidence failure is unknown", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: () => { throw new Error("disk full"); },
  });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.channels.evidence.state, "failed");
});

t("verifyHostExit: INCOMPLETE evidence collection is unknown, never clean/crash-verified", () => {
  for (const expectation of ["exit", "crash"]) {
    const r = verifyHostExit({
      pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
      evidenceDir: tmp(),
      collectEvidence: fakeEvidence({ correlated: expectation === "crash" ? 5 : 0 }, { complete: false, incompleteReasons: ["unreadable reports dir"] }),
      expectation,
    });
    assert.equal(r.verdict, "unknown", `${expectation} must not verify on incomplete evidence`);
    assert.equal(r.channels.evidence.state, "incomplete");
  }
});

t("verifyHostExit: clean exit requires all four conditions", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({}), expectation: "exit",
  });
  assert.equal(r.verdict, "clean");
});

t("verifyHostExit: correlated crash on expected-clean exit is crash-suspect", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({ correlated: 2 }), expectation: "exit",
  });
  assert.equal(r.verdict, "crash-suspect");
});

t("verifyHostExit: crash expectation verifies only on correlation", () => {
  const verified = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({ correlated: 1, total: 3 }), expectation: "crash",
  });
  assert.equal(verified.verdict, "crash-verified");
  const unconfirmed = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({ candidate: 2, unrelated: 1, total: 3 }), expectation: "crash",
  });
  assert.equal(unconfirmed.verdict, "crash-unconfirmed");
});

// ------------------------------------------------ CLI surface

t("cli evidence writes a correlated manifest", () => {
  const root = tmp();
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "x.ips"), ips(4242));
  const out = join(root, "ev");
  const body = JSON.parse(execFileSync("node", [
    CLI, "evidence", "--since", new Date(Date.now() - 3600e3).toISOString(),
    "--out", out, "--pid", "4242", "--proc-name", "After Effects",
    "--proc-path", IPS_PROC_PATH, "--app-version", "27.0.0",
    "--proc-launch", IPS_LAUNCH,
    "--reports-dir", reports,
  ], { encoding: "utf8" }));
  assert.equal(body.counts.correlated, 1);
  assert.match(body.correlated[0].sha256, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

function cliJson(args, env = {}) {
  try {
    return {
      code: 0,
      body: JSON.parse(execFileSync("node", [CLI, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      })),
    };
  } catch (e) {
    return { code: e.status ?? 1, body: JSON.parse(e.stdout?.toString() ?? "{}") };
  }
}

/**
 * Write a fake-a8n config (see fixtures/fake-a8n/dist/index.js) into a fresh
 * tmp dir and return { root, env } for cliJson. Liveness is NOT faked —
 * tests must pass real live/dead pids through the config and flags.
 */
function fakeA8nFixture(over = {}) {
  const root = tmp();
  const cfg = {
    guiSession: { uid: 501, asid: 42, username: "fakeuser", kind: "Aqua" },
    instances: [],
    windows: [
      {
        title: "Fake After Effects",
        role: "AXWindow",
        subrole: "AXDialog",
        buttons: [{ title: "OK" }],
        texts: ["a measured fake dialog"],
      },
    ],
    frontmost: false,
    windowServer: { available: true, reason: null, windowCount: 0, onScreenCount: 0 },
    axSuspect: false,
    census: { available: true, windows: [] },
    recoveryOutcome: {
      recovered: true,
      outcome: "dismissed",
      evidence: "fake-a8n: pressed OK on the measured dialog",
      window: "Fake After Effects",
    },
    ...over,
  };
  const file = join(root, "a8n.json");
  writeFileSync(file, JSON.stringify(cfg));
  return { root, env: { FAKE_A8N_CONFIG: file } };
}

/** A pid that is provably dead by the time the CLI probes it. */
async function deadPid() {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

t("cli recover refuses without --run-id before touching ae-a8n", () => {
  const { code, body } = cliJson(["recover", "--request-id", "req-1", "--method", "op.x"]);
  assert.equal(code, 2);
  assert.equal(body.code, "RUN_ID_REQUIRED");
});

t("cli recover refuses a missing run marker", () => {
  const root = tmp();
  const { code, body } = cliJson([
    "recover", "--run-id", "run-nope", "--request-id", "req-1", "--method", "op.x",
    "--runs-dir", root,
  ]);
  assert.equal(code, 2);
  assert.equal(body.code, "RUN_MARKER_INVALID");
  rmSync(root, { recursive: true, force: true });
});

t("cli recover refuses a non-run-* run-id before touching the filesystem (Issue #227)", () => {
  const root = tmp();
  const victim = join(root, "victim.json");
  writeFileSync(victim, JSON.stringify({ schema: "ae-devtools.cli.run-guard/v1" }));
  const { code, body } = cliJson([
    "recover", "--run-id", "../victim", "--request-id", "req-1", "--method", "op.x",
    "--runs-dir", root,
  ]);
  assert.equal(code, 2);
  assert.equal(body.code, "RUN_MARKER_INVALID");
  assert.ok(existsSync(victim), "recover read a marker outside runs-dir naming");
  rmSync(root, { recursive: true, force: true });
});

t("cli recover refuses when the recorded request is not timed out", () => {
  const root = tmp();
  // Liveness checks run before the request check: point the marker at
  // pids that are alive during this test — this process (runner) and
  // launchd (aePid stand-in). Start stamps are omitted so no ps compare.
  const liveMarker = marker({
    runId: "run-x",
    pid: process.pid,
    pidStartStamp: null,
    session: {
      ...marker().session,
      process: {
        aePid: 1, aePidStartStamp: null, guiSession: { uid: 501, asid: 42 }, recordedAt: "",
        attestation: {
          source: ATTESTATION_SOURCE,
          ownershipKind: "owned",
          ownershipEvidence: "probe answered in owned session",
        },
      },
    },
    requests: [{ requestId: "req-1", method: "op.x", event: "resolved", at: "" }],
  });
  writeFileSync(join(root, "run-x.json"), JSON.stringify(liveMarker));
  const { code, body } = cliJson([
    "recover", "--run-id", "run-x", "--request-id", "req-1", "--method", "op.x",
    "--runs-dir", root,
  ]);
  assert.equal(code, 2);
  assert.equal(body.code, "RECOVERY_REFUSED");
  assert.match(body.message, /latest event is 'resolved'/);
  rmSync(root, { recursive: true, force: true });
});

t("cli observe refuses when the ae-a8n surface cannot be resolved", () => {
  const { code, body } = cliJson([
    "observe", "--pid", "1", "--session-uid", "501", "--session-asid", "1",
    "--ae-a8n-root", "/nonexistent-ae-a8n-root",
  ]);
  assert.equal(code, 2);
  assert.equal(body.code, "AE_A8N_SURFACE_MISSING");
});

// ---- Issue #195: fake-a8n fixture drives observe / verify-exit / recover --

await at("cli observe returns a valid verdict via the fake-a8n fixture", async () => {
  const fx = fakeA8nFixture();
  const shot = join(fx.root, "shots");
  const { code, body } = cliJson([
    "observe", "--pid", "4242", "--session-uid", "501", "--session-asid", "42",
    "--ae-a8n-root", FAKE_A8N, "--shot-dir", shot,
  ], fx.env);
  assert.equal(code, 0);
  assert.equal(body.schema, "ae-devtools.recovery-orchestrator.observe/v1");
  assert.equal(body.ok, true);
  assert.equal(body.windowCount, 1);
  assert.deepEqual(body.windows[0].buttons, ["OK"]);
  assert.ok(body.screenshotPath.endsWith("recovery-observe.png"));
  rmSync(fx.root, { recursive: true, force: true });
});

await at("cli observe reports a degraded GUI as ok:false, never empty", async () => {
  const fx = fakeA8nFixture({ guiError: "fake AX tree dead" });
  const { code, body } = cliJson([
    "observe", "--pid", "4242", "--session-uid", "501", "--session-asid", "42",
    "--ae-a8n-root", FAKE_A8N,
  ], fx.env);
  assert.equal(code, 1);
  assert.equal(body.ok, false);
  assert.equal(body.verdict, "unknown");
  assert.match(body.error, /fake AX tree dead/);
  rmSync(fx.root, { recursive: true, force: true });
});

await at("cli verify-exit reaches clean on dead pid + confirmed session + empty census", async () => {
  const pid = await deadPid();
  const fx = fakeA8nFixture();
  const evidenceDir = join(fx.root, "evidence");
  const reportsDir = join(fx.root, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const { code, body } = cliJson([
    "verify-exit", "--pid", String(pid),
    "--session-uid", "501", "--session-asid", "42",
    "--expectation", "exit",
    "--evidence-dir", evidenceDir,
    "--reports-dir", reportsDir,
    "--since", new Date(Date.now() - 3600e3).toISOString(),
    "--ae-a8n-root", FAKE_A8N,
  ], fx.env);
  assert.equal(code, 0);
  assert.equal(body.verdict, "clean");
  assert.equal(body.channels.process.state, "dead");
  assert.equal(body.channels.windows.state, "ok");
  assert.equal(body.channels.windows.pidAttribution, "dead");
  assert.equal(body.channels.evidence.state, "collected");
  rmSync(fx.root, { recursive: true, force: true });
});

await at("cli verify-exit reports residue when the census still attributes a window", async () => {
  const pid = await deadPid();
  const fx = fakeA8nFixture({
    census: { available: true, windows: [{ pid, owner: "fake", layer: 0, onScreen: true, name: "leftover", bounds: null }] },
  });
  const { code, body } = cliJson([
    "verify-exit", "--pid", String(pid),
    "--session-uid", "501", "--session-asid", "42",
    "--expectation", "exit",
    "--ae-a8n-root", FAKE_A8N,
  ], fx.env);
  assert.equal(code, 1);
  assert.equal(body.verdict, "residue");
  assert.equal(body.channels.windows.windowCount, 1);
  rmSync(fx.root, { recursive: true, force: true });
});

await at("cli recover reaches fake MacHostRecovery.attempt with the authorized ownerId", async () => {
  const fx = fakeA8nFixture();
  const runsDir = join(fx.root, "runs");
  mkdirSync(runsDir, { recursive: true });
  // Live test pids: this test process is the "runner", a sleeper stands in
  // for the AE process. Start stamps are omitted so no ps compare runs.
  const ae = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    writeFileSync(join(runsDir, "run-cli-fake.json"), JSON.stringify({
      ...marker({ runId: "run-cli-fake" }),
      pid: process.pid,
      pidStartStamp: null,
      session: {
        ...marker().session,
        process: {
          aePid: ae.pid,
          aePidStartStamp: null,
          guiSession: { uid: 501, asid: 42 },
          attestation: {
            source: ATTESTATION_SOURCE,
            ownershipKind: "owned",
            ownershipEvidence: "probe answered in owned session",
          },
          recordedAt: new Date().toISOString(),
        },
      },
    }));
    // listAppInstances must attribute the live aePid to the fake session.
    writeFileSync(join(fx.root, "a8n.json"), JSON.stringify({
      ...JSON.parse(readFileSync(join(fx.root, "a8n.json"), "utf-8")),
      instances: [{ name: "Fake After Effects", pid: ae.pid, uid: 501, asid: 42 }],
      attemptLog: join(fx.root, "attempts.jsonl"),
    }));
    const { code, body } = cliJson([
      "recover", "--run-id", "run-cli-fake",
      "--request-id", "req-1", "--method", "op.x",
      "--runs-dir", runsDir,
      "--ae-a8n-root", FAKE_A8N,
    ], fx.env);
    assert.equal(code, 0);
    assert.equal(body.verdict, "await-original");
    assert.equal(body.outcome.recovered, true);
    assert.equal(body.outcome.outcome, "dismissed");
    assert.ok(body.rules.some((r) => r.includes("never resent")));
    assert.equal(body.guiLease.available, true);
    assert.equal(body.guiLease.state, "free");
    // The fake host recovery saw the authorized context — never a
    // self-declared requestId.
    const attempt = JSON.parse(readFileSync(join(fx.root, "attempts.jsonl"), "utf-8").trim());
    assert.equal(attempt.ownerId, "run:run-cli-fake");
    assert.equal(attempt.requestId, "req-1");
    assert.equal(attempt.method, "op.x");
    assert.equal(attempt.pid, ae.pid);
  } finally {
    ae.kill("SIGKILL");
    rmSync(fx.root, { recursive: true, force: true });
  }
});

await at("cli recover still refuses a marker without ae-a8n attestation, fixture or not", async () => {
  const fx = fakeA8nFixture();
  const runsDir = join(fx.root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const noAtt = marker({ runId: "run-noatt" });
  delete noAtt.session.process.attestation;
  writeFileSync(join(runsDir, "run-noatt.json"), JSON.stringify(noAtt));
  const { code, body } = cliJson([
    "recover", "--run-id", "run-noatt",
    "--request-id", "req-1", "--method", "op.x",
    "--runs-dir", runsDir,
    "--ae-a8n-root", FAKE_A8N,
  ], fx.env);
  assert.equal(code, 2);
  assert.equal(body.code, "RECOVERY_REFUSED");
  assert.match(body.message, /no ae-a8n ownership attestation/);
  rmSync(fx.root, { recursive: true, force: true });
});

await at("cli fails loudly when the ae-a8n build lacks a command-required export", async () => {
  // observe needs the session surfaces even though it never mutates.
  const obs = cliJson([
    "observe", "--pid", "1", "--session-uid", "501", "--session-asid", "42",
    "--ae-a8n-root", FAKE_A8N,
  ], { FAKE_A8N_OMIT: "readGuiSession" });
  assert.equal(obs.code, 2);
  assert.equal(obs.body.code, "AE_A8N_SURFACE_MISSING");
  assert.match(obs.body.message, /'observe'.*readGuiSession/);

  // verify-exit needs the session-scoped census pair.
  const vex = cliJson([
    "verify-exit", "--pid", "1", "--session-uid", "501", "--session-asid", "42",
    "--ae-a8n-root", FAKE_A8N,
  ], { FAKE_A8N_OMIT: "windowServerCensus" });
  assert.equal(vex.code, 2);
  assert.equal(vex.body.code, "AE_A8N_SURFACE_MISSING");
  assert.match(vex.body.message, /'verify-exit'.*windowServerCensus/);
});

await at("cli fails loudly when a required ae-a8n export is null, not just missing (Issue #234)", async () => {
  // `typeof null === "object"` used to let a null export pass the
  // surface check — the command would then crash mid-run instead of
  // refusing up front.
  const obs = cliJson([
    "observe", "--pid", "1", "--session-uid", "501", "--session-asid", "42",
    "--ae-a8n-root", FAKE_A8N,
  ], { FAKE_A8N_NULL: "readGuiSession" });
  assert.equal(obs.code, 2);
  assert.equal(obs.body.code, "AE_A8N_SURFACE_MISSING");
  assert.match(obs.body.message, /'observe'.*readGuiSession/);
});

// ---- Issue #155: recovery verdicts -> diagnostics records ----

const EXPECTED = {
  "await-original": ["transport-outcome", "info"],
  quarantined: ["transport-outcome", "error"],
  refused: ["transport-outcome", "warning"],
  residue: ["transport-outcome", "warning"],
  clean: ["transport-outcome", "info"],
  "crash-verified": ["native-crash", "error"],
  "crash-suspect": ["native-crash", "error"],
  "crash-unconfirmed": ["native-crash", "warning"],
  unknown: ["transport-outcome", "error"],
};

t("every verdict maps to a valid diagnostics record with honest kind/severity", () => {
  assert.deepEqual([...RECOVERY_VERDICTS].sort(), Object.keys(EXPECTED).sort());
  for (const verdict of RECOVERY_VERDICTS) {
    const [rec] = exitVerificationToDiagnostics(
      { verdict, expectation: "exit", pid: 1, reasons: ["test reason"] },
      { requestId: "req-x" },
    );
    const [kind, severity] = EXPECTED[verdict];
    assert.equal(rec.kind, kind, `${verdict} kind`);
    assert.equal(rec.severity, severity, `${verdict} severity`);
    assert.equal(rec.outcome, verdict);
    assert.equal(rec.requestId, "req-x");
    assert.equal(rec.collector, "recovery-orchestrator");
    validateDiagnosticsRecord(rec);
    assert.equal(typeof recoveryActionFor(verdict), "string");
  }
});

t("unknown verdict surfaces as error, never clean-looking", () => {
  const [rec] = exitVerificationToDiagnostics(
    { verdict: "unknown", expectation: "crash", pid: 1, reasons: ["census unavailable"] },
    {},
  );
  assert.equal(rec.severity, "error");
  assert.equal(rec.outcome, "unknown");
  assert.match(rec.message, /census unavailable/);
});

t("crash verdicts become native-crash; exit verdicts stay transport-outcome", () => {
  for (const verdict of ["crash-verified", "crash-suspect", "crash-unconfirmed"]) {
    const [rec] = exitVerificationToDiagnostics({ verdict, expectation: "crash", pid: 1, reasons: [] }, {});
    assert.equal(rec.kind, "native-crash");
  }
  const [rec] = exitVerificationToDiagnostics({ verdict: "clean", expectation: "exit", pid: 1, reasons: ["all channels clean"] }, {});
  assert.equal(rec.kind, "transport-outcome");
  assert.equal(rec.severity, "info");
});

t("timeout-recovery quarantined -> error and carries the no-resend rule", () => {
  const result = {
    verdict: "quarantined",
    requestId: "req-9",
    method: "op.x",
    outcome: { recovered: false, outcome: "quarantined", code: "HUMAN_ONLY", evidence: "license dialog" },
  };
  const [rec] = timeoutRecoveryToDiagnostics(result, {});
  assert.equal(rec.severity, "error");
  assert.equal(rec.outcome, "quarantined");
  assert.match(rec.message, /never resent/);
  assert.match(rec.message, /HUMAN_ONLY/);
  validateDiagnosticsRecord(rec);
});

t("timeout-recovery await-original -> info", () => {
  const [rec] = timeoutRecoveryToDiagnostics(
    { verdict: "await-original", requestId: "r", method: "m", outcome: { recovered: true, outcome: "dismissed" } },
    {},
  );
  assert.equal(rec.severity, "info");
});

t("crashEvidenceToDiagnostics: correlated reports -> native-crash error with artifact hashes", () => {
  const manifest = {
    kind: "crash-evidence",
    complete: true,
    counts: { total: 2, correlated: 1, candidate: 1, unrelated: 0, unclassified: 0, copyErrors: 0 },
    target: { pid: 4242 },
    correlated: [{ sha256: "a".repeat(64), dest: "/ev/diagnostic-reports/x.ips" }],
    incompleteReasons: [],
  };
  const records = crashEvidenceToDiagnostics(manifest, { requestId: "req-c" });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "native-crash");
  assert.equal(records[0].severity, "error");
  assert.equal(records[0].artifactHashes["/ev/diagnostic-reports/x.ips"], "a".repeat(64));
  validateDiagnosticsRecord(records[0]);
});

t("crashEvidenceToDiagnostics: incomplete collection -> warning, empty complete -> no records", () => {
  const incomplete = crashEvidenceToDiagnostics(
    { kind: "crash-evidence", complete: false, counts: { correlated: 0 }, incompleteReasons: ["unreadable dir"], target: {} },
    {},
  );
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].severity, "warning");
  assert.equal(incomplete[0].outcome, "evidence-incomplete");

  const empty = crashEvidenceToDiagnostics(
    { kind: "crash-evidence", complete: true, counts: { correlated: 0, candidate: 0, unrelated: 0, unclassified: 0 }, target: {}, correlated: [] },
    {},
  );
  assert.deepEqual(empty, []);
});

// ------------------------------------------------ supervision verdicts (Issue #408)
// Fake level only: supervision reports are built as plain objects matching
// the ae-a8n.supervision/v1 contract consumed by a8n-transport/supervision.mjs.
// No AE, no monitor, no GUI.

function supDoc(overrides = {}) {
  return {
    schemaVersion: "ae-a8n.supervision/v1",
    sessionId: "sess-1",
    phase: "running",
    observationHealth: "ok",
    blocking: null,
    pendingRequests: [],
    enteredAt: "2026-11-20T11:59:00.000Z",
    deadline: null,
    evidence: [],
    monitor: {
      ownerId: "mon-1", pid: 1, pidStart: null,
      acquiredAt: "2026-11-20T11:58:00.000Z", heartbeatAt: new Date().toISOString(),
    },
    history: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function supReport(docOverrides = {}, reportOverrides = {}) {
  const doc = supDoc(docOverrides);
  return {
    status: "observed",
    source: "state",
    doc,
    health: doc.observationHealth,
    healthDetail: null,
    readAt: new Date().toISOString(),
    ...reportOverrides,
  };
}

await at("runTimeoutRecovery: needs-human supervision escalates to quarantined with structured detail", async () => {
  const report = supReport({
    phase: "needs-human",
    deadline: "2026-11-20T12:10:00.000Z",
    blocking: {
      host: "none",
      detail: "sign-in dialog is up",
      windows: [{
        title: "Sign In", role: "AXWindow", subrole: "AXDialog", blocking: true,
        tier: "human-required", dialogClass: "sign-in", code: "A8N-AUTH-001",
        texts: ["Please sign in"], buttons: ["Cancel", "Sign In"],
      }],
    },
  });
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: true, outcome: "dismissed", evidence: "pressed OK" }),
    gui: fakeGui({ windows: [win("x")] }),
    requestId: "req-1", method: "app.info", timeoutMs: 1000,
    ownerId: "run:run-test-1",
    readSupervision: async () => report,
  });
  // Recovery claimed dismissed → await-original, but supervision says a
  // human must act: escalation wins, never downgrade.
  assert.equal(r.verdict, "quarantined");
  assert.equal(r.supervision.after.phase, "needs-human");
  assert.equal(r.supervision.after.needsHuman.phase, "needs-human");
  assert.deepEqual(r.supervision.after.needsHuman.options.sort(), ["Cancel", "Sign In"]);
  assert.match(r.supervision.after.needsHuman.resumePath, /supervision status/);
  assert.match(r.supervision.after.needsHuman.requiredAction, /human/i);
});

await at("runTimeoutRecovery: monitor-lost/unavailable health escalates to unknown, never clean", async () => {
  for (const health of ["monitor-lost", "unavailable"]) {
    const report = supReport({ phase: "running" }, { health });
    const r = await runTimeoutRecovery({
      recovery: fakeRecovery({ recovered: true, outcome: "dismissed" }),
      gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
      readSupervision: async () => report,
    });
    assert.equal(r.verdict, "unknown", `${health} must not be read as recovered`);
    assert.equal(r.supervision.after.health, health);
  }
});

await at("runTimeoutRecovery: blocked phase maps to await-original within deadline", async () => {
  const report = supReport({ phase: "blocked", deadline: "2026-11-20T12:05:00.000Z" });
  // Base verdict await-original (recovered) + supervision blocked →
  // still await-original: the request may complete inside the deadline.
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: true, outcome: "dismissed" }),
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
    readSupervision: async () => report,
  });
  assert.equal(r.verdict, "await-original");
  assert.equal(r.supervision.after.phase, "blocked");
  assert.equal(r.supervision.after.deadline, "2026-11-20T12:05:00.000Z");
});

await at("runTimeoutRecovery: blocked supervision never downgrades an unknown verdict", async () => {
  const report = supReport({ phase: "blocked", deadline: "2026-11-20T12:05:00.000Z" });
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: false, outcome: "still-blocked", evidence: "dialog remains" }),
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
    readSupervision: async () => report,
  });
  assert.equal(r.verdict, "unknown");
});

await at("runTimeoutRecovery: corrupt supervision state escalates to unknown", async () => {
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: true, outcome: "dismissed" }),
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
    readSupervision: async () => ({ status: "unavailable", source: "corrupt", reason: "bad json", readAt: new Date().toISOString() }),
  });
  assert.equal(r.verdict, "unknown");
});

await at("runTimeoutRecovery: absent supervision does not change the verdict", async () => {
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: true, outcome: "dismissed" }),
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1, ownerId: "o",
    readSupervision: async () => null,
  });
  assert.equal(r.verdict, "await-original");
  assert.equal(r.supervision.after, null);
});

t("verifyHostExit: degraded/monitor-lost supervision never allows clean", () => {
  const base = {
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({}), expectation: "exit",
  };
  for (const [doc, health] of [
    [{ phase: "running" }, "degraded"],
    [{ phase: "running" }, "monitor-lost"],
    [{ phase: "blocked", deadline: "2999-01-01T00:00:00.000Z" }, "ok"],
  ]) {
    const r = verifyHostExit({ ...base, supervision: supReport(doc, { health }) });
    assert.equal(r.verdict, "unknown", `health=${health} phase=${doc.phase}`);
    assert.equal(r.supervision.status, "observed");
  }
  // ok + running stays clean — the gate only blocks untrustworthy observation.
  const clean = verifyHostExit({ ...base, supervision: supReport() });
  assert.equal(clean.verdict, "clean");
});

t("verifyHostExit: corrupt supervision state is unknown, not clean", () => {
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({}), expectation: "exit",
    supervision: { status: "unavailable", source: "corrupt", reason: "bad json", readAt: new Date().toISOString() },
  });
  assert.equal(r.verdict, "unknown");
});

t("supervision diagnostics suffix carries phase/health/needs-human", () => {
  const report = supReport({
    phase: "needs-human",
    deadline: "2026-11-20T12:10:00.000Z",
    blocking: { host: "none", detail: "license dialog", windows: [] },
  });
  const r = verifyHostExit({
    pid: 4242, pidAlive: () => false, census: CENSUS_CLEAN, session: SESSION_OK,
    evidenceDir: tmp(), collectEvidence: fakeEvidence({}), expectation: "exit",
    supervision: report,
  });
  assert.equal(r.verdict, "unknown"); // needs-human blocks clean
  const [rec] = exitVerificationToDiagnostics(r, {});
  assert.match(rec.message, /supervision=needs-human/);
  assert.match(rec.message, /needs-human: license dialog/);
  validateDiagnosticsRecord(rec);
});

t("diagnostics converters refuse unknown verdicts instead of guessing", () => {
  assert.throws(() => exitVerificationToDiagnostics({ verdict: "looks-fine", reasons: [] }, {}), /unknown verdict/);
  assert.throws(() => recoveryActionFor("looks-fine"), /unknown verdict/);
  assert.throws(() => crashEvidenceToDiagnostics({ kind: "other" }, {}), /crash-evidence manifest/);
});

await finish("passed");
