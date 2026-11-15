/**
 * run.mjs — devtools-cli tests (Issue #54). Fake level only.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginRun, markSession, endRun, listRuns, reapRun,
} from "../session-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.mjs");
const RUNS_DIR = join(tmpdir(), "ae-devtools-cli-test-runs");
let passed = 0;

function run(args, env = {}) {
  try {
    return { code: 0, body: JSON.parse(execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, AE_DEVTOOLS_CLI_RUNS_DIR: RUNS_DIR, ...env },
    })) };
  } catch (e) {
    // nonzero exit still prints the JSON result on stdout
    return { code: e.status ?? 1, body: JSON.parse(e.stdout?.toString() ?? "{}") };
  }
}
function t(name, fn) {
  try { fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}
async function at(name, fn) {
  try { await fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}
function freshRunsDir() {
  rmSync(RUNS_DIR, { recursive: true, force: true });
}

t("doctor reports environment without contacting AE", () => {
  const r = run(["doctor"]).body;
  assert.equal(r.schema, "ae-devtools.cli.doctor/v1");
  assert.ok(Array.isArray(r.aeInstalls));
  assert.equal(typeof r.a8nTransportPresent, "boolean");
});

t("discover lists registry ops, honest evidence", () => {
  const r = run(["discover"]).body;
  assert.equal(r.operationCount, 20);
  assert.equal(r.evidence.realHostVerified, 0);
});

t("inspect returns metadata without executing", () => {
  const r = run(["inspect", "item.addComp"]).body;
  assert.equal(r.status, "ok");
  assert.equal(r.evidenceLevel, "metadata only — nothing executed");
  assert.equal(run(["inspect", "no.such"]).body.status, "unknown-operation");
});

t("execute on fake session completes and verify reads back", () => {
  const ex = run(["execute", "project.new", "--session", "fake", "--consent", "grant", "--confirm-destructive"]).body;
  assert.equal(ex.outcome, "COMPLETED");
  assert.equal(ex.session.kind, "fake");
  assert.equal(ex.session.evidenceLevel, "fake/mock only");
  const v = run(["verify", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(v.outcome, "COMPLETED");
});

t("execute refuses without --consent grant (default deny)", () => {
  const r = run(["execute", "project.new", "--session", "fake", "--confirm-destructive"]).body;
  assert.equal(r.outcome, "refused");
});

t("execute refuses destructive op without --confirm-destructive", () => {
  const r = run(["execute", "project.new", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "refused");
  assert.match(JSON.stringify(r.result), /DESTRUCTIVE|refused/);
});

t("execute reports unknown op", () => {
  const r = run(["execute", "no.such.op", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "refused");
  assert.equal(r.result.reason, "UNKNOWN_OPERATION");
});

t("verify refuses mutating read-op", () => {
  const r = run(["verify", "--session", "fake", "--consent", "grant", "--read-op", "item.addComp"]).body;
  assert.equal(r.result.reason, "VERIFY_REQUIRES_READ_OP");
});

// ---- cleanup contract (Issue #54 follow-up: process.exit used to bypass
// ---- session.close(); every path must now settle cleanup first) ----

t("successful execute leaves no run marker", () => {
  freshRunsDir();
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"]);
  assert.equal(r.body.outcome, "COMPLETED");
  assert.equal(r.body.cleanup.ok, true);
  const runs = run(["runs"]).body.runs;
  assert.equal(runs.length, 0, `expected no markers, got ${JSON.stringify(runs)}`);
});

t("close failure is reported, escalates exit code, keeps marker", () => {
  freshRunsDir();
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"],
    { AE_DEVTOOLS_CLI_FAKE_CLOSE: "throw" });
  assert.equal(r.code, 3);
  assert.equal(r.body.cleanup.ok, false);
  assert.match(r.body.cleanup.error, /injected fake close failure/);
  const runs = run(["runs"]).body.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "close-failed");
  // fake sessions have no ownership evidence → never reapable
  assert.equal(runs[0].reapable, false);
  assert.equal(runs[0].reapBlockReason, "OWNERSHIP_NOT_OWNED");
  const reap = run(["reap", runs[0].runId, "--confirm"]);
  assert.equal(reap.body.verdict, "REFUSED");
  assert.equal(reap.body.reason, "OWNERSHIP_NOT_OWNED");
});

t("hung close hits --close-timeout-ms and keeps marker", () => {
  freshRunsDir();
  const started = Date.now();
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant",
    "--close-timeout-ms", "300"],
    { AE_DEVTOOLS_CLI_FAKE_CLOSE: "hang" });
  assert.equal(r.code, 3);
  // generous bound: node startup + module load alone is multi-second on a
  // loaded machine; the point is the wait is bounded, not fast
  assert.ok(Date.now() - started < 60_000, "close timeout did not bound the wait");
  assert.match(r.body.cleanup.error, /timed out/);
  assert.equal(run(["runs"]).body.runs[0].status, "close-failed");
});

await at("SIGTERM during execute runs cleanup then exits 143", async () => {
  freshRunsDir();
  const child = spawn("node", [CLI, "execute", "read.projectSummary",
    "--session", "fake", "--consent", "grant",
    "--close-timeout-ms", "400"], {
    env: { ...process.env, AE_DEVTOOLS_CLI_RUNS_DIR: RUNS_DIR, AE_DEVTOOLS_CLI_FAKE_CLOSE: "hang" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // wait until the marker shows the session is open, then interrupt —
  // signalling earlier would race session assignment and prove nothing
  const deadline = Date.now() + 15_000;
  let open = false;
  while (Date.now() < deadline && !open) {
    try {
      const files = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")) : [];
      open = files.some((f) => JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")).status === "open");
    } catch { /* marker mid-write */ }
    if (!open) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(open, "session never reached open state");
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 143);
  const runs = run(["runs"]).body.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "close-failed");
});

// ---- session-guard unit tests (injected fakes, no real processes) ----

await at("guard: stale owned marker is reapable only with confirm + single candidate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    const { runId } = await beginRun({ dir, sessionKind: "a8n", argv: ["execute", "x"] });
    markSession(dir, runId, {
      kind: "a8n", evidenceLevel: "verified on real host (macOS)",
      meta: {}, ownership: { kind: "owned", evidence: "test" },
      installDir: "/Applications/Adobe After Effects 2027",
      appPath: "/Applications/Adobe After Effects 2027/Adobe After Effects 2027.app",
      close: async () => {},
    });
    endRun(dir, runId, "close-failed"); // simulate runner died mid-cleanup

    const dead = () => false;
    const psOut = "  4242 /Applications/Adobe After Effects 2027/Adobe After Effects 2027.app/Contents/MacOS/After Effects\n";
    const exec = async (cmd, args) => {
      if (cmd === "ps" && args[0] === "-axo") return { stdout: psOut };
      if (cmd === "ps" && args.includes("4242")) return { stdout: "" }; // gone after quit
      if (cmd === "osascript") return { stdout: "" };
      throw new Error(`unexpected exec ${cmd} ${args}`);
    };
    const noWait = async () => {};
    const t0 = Date.now();

    // no --confirm → refused, names the candidate
    let v = await reapRun(runId, { dir, confirm: false, aliveFn: dead, exec, wait: noWait, now: () => t0 });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "CONFIRM_REQUIRED");
    assert.equal(v.candidate.pid, 4242);

    // --confirm → graceful quit verified
    v = await reapRun(runId, { dir, confirm: true, aliveFn: dead, exec, wait: noWait, now: () => Date.now() });
    assert.equal(v.verdict, "REAPED");
    assert.equal(existsSync(join(dir, `${runId}.json`)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await at("guard: attached/unknown ownership is never reaped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    const { runId } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId, {
      kind: "a8n", ownership: { kind: "attached", evidence: "pre-existing" },
      installDir: "/Applications/Adobe After Effects 2027",
    });
    endRun(dir, runId, "close-failed");
    const v = await reapRun(runId, {
      dir, confirm: true, aliveFn: () => false,
      exec: async () => ({ stdout: "" }),
    });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "OWNERSHIP_NOT_OWNED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await at("guard: live runner and PID reuse both refuse reap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    const { runId } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId, {
      kind: "a8n", ownership: { kind: "owned", evidence: "t" },
      installDir: "/x", appPath: "/x.app",
    });
    endRun(dir, runId, "close-failed");

    // runner alive → refuse even with ownership proof
    let v = await reapRun(runId, { dir, confirm: true, aliveFn: () => true, exec: async () => ({ stdout: "" }) });
    assert.equal(v.reason, "RUNNER_ALIVE");

    // pid alive but start stamp differs → reuse → treated as dead, proceeds to ownership checks
    const { runId: runId2 } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId2, {
      kind: "a8n", ownership: { kind: "owned", evidence: "t" },
      installDir: "/x", appPath: "/x.app",
    });
    endRun(dir, runId2, "close-failed");
    // craft marker with a start stamp, then simulate reuse
    const { readFileSync, writeFileSync } = await import("node:fs");
    const mf = join(dir, `${runId2}.json`);
    const m = JSON.parse(readFileSync(mf, "utf8"));
    m.pidStartStamp = "Mon Jan  1 00:00:00 2024";
    writeFileSync(mf, JSON.stringify(m));
    const exec = async (cmd, args) => {
      if (cmd === "ps" && args[0] === "-axo") return { stdout: "" }; // no AE candidates
      return { stdout: "" };
    };
    // stampFn signature is (pid) → stamp string; simulate PID reuse
    const stampFn = async () => "Tue Feb  2 00:00:00 2026";
    v = await reapRun(runId2, { dir, confirm: true, aliveFn: () => true, stampFn, exec });
    // stamp mismatch → runnerAlive=false → owned + zero candidates → CLEAN
    assert.equal(v.verdict, "CLEAN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
