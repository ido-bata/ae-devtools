/**
 * run.mjs — recovery-orchestrator tests (Issue #55). Fake level only:
 * no After Effects, no GUI session, no real census. The real-host path in
 * cli.mjs is UNVERIFIED while GUI testing is frozen.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectCrashEvidence,
  censusSummary,
  observeScreen,
  runTimeoutRecovery,
  verifyHostExit,
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

// ------------------------------------------------ evidence collection

t("collectCrashEvidence copies only files since the cutoff", () => {
  const root = tmp();
  const reports = join(root, "reports");
  const sentry = join(root, "sentry");
  mkdirSync(reports, { recursive: true });
  mkdirSync(sentry, { recursive: true });
  writeFileSync(join(reports, "AE-2026-11-15-120000.ips"), "new");
  writeFileSync(join(reports, "AE-2026-11-14-090000.ips"), "old");
  writeFileSync(join(sentry, "evt.envelope"), "env");
  writeFileSync(join(sentry, "notes.txt"), "not-an-envelope");
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(reports, "AE-2026-11-14-090000.ips"), old, old);

  const out = join(root, "out");
  const m = collectCrashEvidence({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    outDir: out,
    reportsDirs: [reports],
    sentryDirs: [sentry],
  });
  const names = m.copied.map((c) => c.dest?.split("/").pop());
  assert.ok(names.includes("AE-2026-11-15-120000.ips"));
  assert.ok(names.includes("evt.envelope"));
  assert.ok(!names.includes("AE-2026-11-14-090000.ips"), "old .ips must be excluded");
  assert.ok(!names.includes("notes.txt"), "non-envelope files must be excluded");
  assert.ok(m.note.includes("does NOT prove"));
  rmSync(root, { recursive: true, force: true });
});

t("collectCrashEvidence rejects a bad --since", () => {
  assert.throws(() => collectCrashEvidence({ since: "not-a-date", outDir: tmp() }), /not a valid timestamp/);
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

// ------------------------------------------------ recovery verdicts

const win = (title, subrole = "AXDialog") => ({
  title, role: "AXWindow", subrole,
  buttons: [{ title: "OK" }], texts: [],
});

function fakeRecovery(outcome) {
  return { attempt: async () => outcome };
}

await at("runTimeoutRecovery maps dismissed to await-original and never resends", async () => {
  const dir = tmp();
  const gui = fakeGui({ windows: [win("x")] });
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: true, outcome: "dismissed", evidence: "pressed OK" }),
    gui, requestId: "req-1", method: "app.info", timeoutMs: 1000, screenshotDir: dir,
  });
  assert.equal(r.verdict, "await-original");
  assert.equal(r.outcome.outcome, "dismissed");
  assert.equal(r.before.ok, true);
  assert.equal(r.after.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

await at("runTimeoutRecovery quarantined stays quarantined", async () => {
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: false, outcome: "quarantined", code: "A8N-SEC-001", evidence: "unclassified" }),
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1,
  });
  assert.equal(r.verdict, "quarantined");
});

await at("runTimeoutRecovery refused lease reports refused", async () => {
  const r = await runTimeoutRecovery({
    recovery: fakeRecovery({ recovered: false, outcome: "refused", evidence: "lease held by agent-x" }),
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1,
  });
  assert.equal(r.verdict, "refused");
});

await at("runTimeoutRecovery recovery-throw is refused-with-error, not a crash", async () => {
  const r = await runTimeoutRecovery({
    recovery: { attempt: async () => { throw new Error("boom"); } },
    gui: fakeGui({}), requestId: "r", method: "m", timeoutMs: 1,
  });
  assert.equal(r.verdict, "refused");
  assert.match(r.outcome.evidence, /boom/);
});

// ------------------------------------------------ exit verification

t("verifyHostExit: alive process is residue", () => {
  const r = verifyHostExit({ pid: 1, pidAlive: () => true });
  assert.equal(r.verdict, "residue");
});

t("verifyHostExit: dead pid + census windows = residue", () => {
  const r = verifyHostExit({
    pid: 4242,
    pidAlive: () => false,
    censusFor: () => ({ available: true, windows: [{ pid: 4242, onScreen: true }] }),
  });
  assert.equal(r.verdict, "residue");
});

t("verifyHostExit: census unavailable degrades to unknown, never clean", () => {
  const r = verifyHostExit({
    pid: 4242,
    pidAlive: () => false,
    censusFor: () => ({ available: false, reason: "no python" }),
  });
  assert.equal(r.verdict, "unknown");
});

t("verifyHostExit: dead pid + empty census = clean with evidence", () => {
  const root = tmp();
  const r = verifyHostExit({
    pid: 4242,
    pidAlive: () => false,
    censusFor: () => ({ available: true, windows: [{ pid: 9999, onScreen: true }] }),
    evidenceDir: join(root, "ev"),
    reportsDirs: [join(root, "reports")],
    sentryDirs: [],
  });
  assert.equal(r.verdict, "clean");
  assert.ok(r.evidence);
  rmSync(root, { recursive: true, force: true });
});

t("censusSummary counts only the target pid", () => {
  const s = censusSummary({
    available: true,
    windows: [
      { pid: 1, onScreen: true, name: "a" },
      { pid: 2, onScreen: false, name: "b" },
      { pid: 2, onScreen: true, name: "c" },
    ],
  }, 2);
  assert.equal(s.windowCount, 2);
  assert.equal(s.onScreenCount, 1);
});

// ------------------------------------------------ CLI surface

t("cli evidence writes a manifest", () => {
  const root = tmp();
  const out = join(root, "ev");
  const body = JSON.parse(execFileSync("node", [CLI, "evidence", "--since", new Date(Date.now() - 3600e3).toISOString(), "--out", out], { encoding: "utf8" }));
  assert.equal(body.schema, "ae-devtools.recovery-orchestrator/v1");
  assert.ok(Array.isArray(body.copied));
  rmSync(root, { recursive: true, force: true });
});

t("cli observe refuses without --ae-a8n-root surface", () => {
  let code = 0, body = {};
  try {
    body = JSON.parse(execFileSync("node", [CLI, "observe", "--pid", "1", "--session-uid", "501", "--session-asid", "1"], { encoding: "utf8" }));
  } catch (e) { code = e.status ?? 1; body = JSON.parse(e.stdout?.toString() ?? "{}"); }
  assert.equal(code, 2);
  assert.equal(body.code, "AE_A8N_SURFACE_MISSING");
});

console.log(`\n${passed} passed`);
