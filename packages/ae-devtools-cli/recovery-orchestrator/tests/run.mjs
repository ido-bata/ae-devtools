/**
 * run.mjs — recovery-orchestrator tests (Issue #55). Fake level only:
 * no After Effects, no GUI session, no real census. The real-host path in
 * cli.mjs is UNVERIFIED while GUI testing is frozen.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

function cliJson(args) {
  try {
    return { code: 0, body: JSON.parse(execFileSync("node", [CLI, ...args], { encoding: "utf8" })) };
  } catch (e) {
    return { code: e.status ?? 1, body: JSON.parse(e.stdout?.toString() ?? "{}") };
  }
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

t("diagnostics converters refuse unknown verdicts instead of guessing", () => {
  assert.throws(() => exitVerificationToDiagnostics({ verdict: "looks-fine", reasons: [] }, {}), /unknown verdict/);
  assert.throws(() => recoveryActionFor("looks-fine"), /unknown verdict/);
  assert.throws(() => crashEvidenceToDiagnostics({ kind: "other" }, {}), /crash-evidence manifest/);
});

await finish("passed");
