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
  collectCrashEvidence,
  correlateReport,
  loadRunProof,
  observeScreen,
  parseIpsReport,
  RUN_PROOF_SCHEMA,
  runTimeoutRecovery,
  verifyHostExit,
  verifyRunProof,
} from "../orchestrator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.mjs");
let passed = 0;

function t(name, fn) {
  try { fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}
async function at(name, fn) {
  try { await fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}
function tmp() { return mkdtempSync(join(tmpdir(), "ae-rec-orch-")); }

function ips(pid, procName = "After Effects", appVersion = "27.0.0", procPath = "/Applications/AE.app/Contents/MacOS/After Effects") {
  const header = { app_name: "After Effects", timestamp: "2026-11-15 10:51:01.00 +0900", app_version: appVersion, bundleID: "com.adobe.AfterEffects.application", bug_type: "309", incident_id: "INC-1" };
  const body = { pid, procName, procPath, procLaunch: "2026-11-15 10:47:39.0000 +0900", captureTime: "2026-11-15 10:50:30.0000 +0900", userID: 501 };
  return `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`;
}

const SESSION_OK = { uid: 501, asid: 42, confirmed: true };
const CENSUS_CLEAN = { available: true, windows: [{ pid: 9999, onScreen: true }] };
const CENSUS_DIRTY = { available: true, windows: [{ pid: 4242, onScreen: true, name: "dlg" }] };
const fakeEvidence = (counts) => () => ({
  counts: { total: 0, correlated: 0, candidate: 0, unrelated: 0, unclassified: 0, copyErrors: 0, ...counts },
});

// ------------------------------------------------ .ips parsing + correlation

t("parseIpsReport extracts header and body identity", () => {
  const r = parseIpsReport(ips(76784));
  assert.equal(r.header.appName, "After Effects");
  assert.equal(r.header.appVersion, "27.0.0");
  assert.equal(r.body.pid, 76784);
  assert.equal(r.body.procPath, "/Applications/AE.app/Contents/MacOS/After Effects");
  assert.equal(parseIpsReport("garbage"), null);
});

t("correlateReport: pid match is correlated", () => {
  const c = correlateReport(parseIpsReport(ips(4242)), { pid: 4242, procName: "After Effects" });
  assert.equal(c.level, "correlated");
});

t("correlateReport: same app different pid is only a candidate", () => {
  const c = correlateReport(parseIpsReport(ips(9999)), { pid: 4242, procName: "After Effects" });
  assert.equal(c.level, "candidate");
});

t("correlateReport: pid match correlates regardless of app name; name mismatch without pid is unrelated", () => {
  // A pid cannot belong to two processes — a pid match is proof even if
  // the app name looks different (renamed binary, helper).
  const c = correlateReport(parseIpsReport(ips(4242, "Safari")), { pid: 4242, procName: "After Effects" });
  assert.equal(c.level, "correlated");
  const c2 = correlateReport(parseIpsReport(ips(9999, "Safari")), { pid: 4242, procName: "After Effects" });
  assert.equal(c2.level, "unrelated");
});

// ------------------------------------------------ evidence collection

t("collectCrashEvidence correlates, hashes, and separates unrelated reports", () => {
  const root = tmp();
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "AE-target.ips"), ips(4242));
  writeFileSync(join(reports, "Safari-other.ips"), ips(7777, "Safari"));
  writeFileSync(join(reports, "notes.txt"), "ignored");
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(reports, "notes.txt"), old, old);

  const out = join(root, "out");
  const m = collectCrashEvidence({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    outDir: out,
    target: { pid: 4242, procName: "After Effects" },
    reportsDirs: [reports],
    sentryDirs: [],
  });
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

t("collectCrashEvidence: same-name different-pid lands in candidates", () => {
  const root = tmp();
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "AE-prev-run.ips"), ips(31337));
  const m = collectCrashEvidence({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    outDir: join(root, "out"),
    target: { pid: 4242, procName: "After Effects" },
    reportsDirs: [reports],
    sentryDirs: [],
  });
  assert.equal(m.counts.correlated, 0);
  assert.equal(m.counts.candidate, 1);
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

// ------------------------------------------------ run proof

function proof(over = {}) {
  return {
    schema: RUN_PROOF_SCHEMA,
    ownerId: "runner-1",
    aePid: 4242,
    session: { uid: 501, asid: 42 },
    issuedAt: new Date().toISOString(),
    requests: [{ requestId: "req-1", method: "app.info", timedOut: true }],
    ...over,
  };
}

t("loadRunProof rejects missing file, bad schema, missing fields", () => {
  const root = tmp();
  assert.equal(loadRunProof(join(root, "nope.json")).ok, false);
  const bad = join(root, "bad.json");
  writeFileSync(bad, "{}");
  assert.equal(loadRunProof(bad).ok, false);
  const noReq = join(root, "noreq.json");
  writeFileSync(noReq, JSON.stringify(proof({ requests: "nope" })));
  assert.equal(loadRunProof(noReq).ok, false);
  rmSync(root, { recursive: true, force: true });
});

t("verifyRunProof accepts a matching claim", () => {
  const p = proof();
  const r = verifyRunProof(p, { pid: 4242, session: { uid: 501, asid: 42 }, requestId: "req-1", method: "app.info" });
  assert.equal(r.ok, true);
});

t("verifyRunProof rejects pid/session/request/method/timedOut mismatches", () => {
  const p = proof();
  const base = { pid: 4242, session: { uid: 501, asid: 42 }, requestId: "req-1", method: "app.info" };
  assert.equal(verifyRunProof(p, { ...base, pid: 9999 }).ok, false);
  assert.equal(verifyRunProof(p, { ...base, session: { uid: 502, asid: 42 } }).ok, false);
  assert.equal(verifyRunProof(p, { ...base, requestId: "req-evil" }).ok, false);
  assert.equal(verifyRunProof(p, { ...base, method: "app.quit" }).ok, false);
  const notTimedOut = proof({ requests: [{ requestId: "req-1", method: "app.info", timedOut: false }] });
  assert.equal(verifyRunProof(notTimedOut, base).ok, false);
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
    ownerId: "runner-1", screenshotDir: dir,
  });
  assert.equal(r.verdict, "await-original");
  assert.equal(r.ownerId, "runner-1");
  assert.equal(recovery.lastCtx.ownerId, "runner-1");
  assert.equal(r.before.ok, true);
  assert.equal(r.after.ok, true);
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
    "--reports-dir", reports,
  ], { encoding: "utf8" }));
  assert.equal(body.counts.correlated, 1);
  assert.match(body.correlated[0].sha256, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

t("cli recover refuses without --run-proof before touching ae-a8n", () => {
  let code = 0, body = {};
  try {
    body = JSON.parse(execFileSync("node", [
      CLI, "recover", "--request-id", "req-1", "--method", "app.info",
    ], { encoding: "utf8" }));
  } catch (e) { code = e.status ?? 1; body = JSON.parse(e.stdout?.toString() ?? "{}"); }
  assert.equal(code, 2);
  assert.equal(body.code, "RUN_PROOF_REQUIRED");
});

t("cli recover rejects a proof that contradicts the request", () => {
  const root = tmp();
  const p = join(root, "proof.json");
  writeFileSync(p, JSON.stringify(proof()));
  let code = 0, body = {};
  try {
    body = JSON.parse(execFileSync("node", [
      CLI, "recover", "--run-proof", p, "--request-id", "req-evil", "--method", "app.info",
    ], { encoding: "utf8" }));
  } catch (e) { code = e.status ?? 1; body = JSON.parse(e.stdout?.toString() ?? "{}"); }
  assert.equal(code, 2);
  assert.equal(body.code, "RUN_PROOF_MISMATCH");
  rmSync(root, { recursive: true, force: true });
});

t("cli recover rejects contradictory --pid flag", () => {
  const root = tmp();
  const p = join(root, "proof.json");
  writeFileSync(p, JSON.stringify(proof()));
  let code = 0, body = {};
  try {
    body = JSON.parse(execFileSync("node", [
      CLI, "recover", "--run-proof", p, "--request-id", "req-1", "--method", "app.info",
      "--pid", "9999",
    ], { encoding: "utf8" }));
  } catch (e) { code = e.status ?? 1; body = JSON.parse(e.stdout?.toString() ?? "{}"); }
  assert.equal(code, 2);
  assert.equal(body.code, "RUN_PROOF_MISMATCH");
  rmSync(root, { recursive: true, force: true });
});

t("cli observe still requires the ae-a8n surface (read-only path unchanged)", () => {
  let code = 0, body = {};
  try {
    body = JSON.parse(execFileSync("node", [CLI, "observe", "--pid", "1", "--session-uid", "501", "--session-asid", "1"], { encoding: "utf8" }));
  } catch (e) { code = e.status ?? 1; body = JSON.parse(e.stdout?.toString() ?? "{}"); }
  assert.equal(code, 2);
  assert.equal(body.code, "AE_A8N_SURFACE_MISSING");
});

console.log(`\n${passed} passed`);
