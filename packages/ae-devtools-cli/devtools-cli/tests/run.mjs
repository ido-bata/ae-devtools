/**
 * run.mjs — devtools-cli tests (Issue #54). Fake level only.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginRun, markSession, endRun, listRuns, reapRun, noteSessionProcess,
  attachEvidence, ATTESTATION_SOURCE,
} from "../session-guard.mjs";
import { failureOutcome, isFailureResult, normalizedOutcome, isUnknownOutcome } from "../../dev-loop/outcomes.mjs";
import { parseArgs, arg as argvArg, hasFlag } from "../argv.mjs";
import {
  aeProcessSnapshot,
  createEvalDispatch,
  gitHeadAndDirty,
  spawnMcpStdio,
  withTimeout,
} from "../real-run-kit.mjs";
import { consentScopeFor } from "../../trusted-execution/permissions.mjs";
import { t, at, finish } from "../../scripts/testkit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.mjs");
const RUNS_DIR = join(tmpdir(), "ae-devtools-cli-test-runs");
// diagnostics fixtures (committed sourcemap artifacts, Issue #37/#95):
// runtime-error.jsx line 3 maps back to runtime-error.ts line 3.
// Packaged diagnostics module (Issue #113): diagnostics/ ships in the
// tarball next to devtools-cli/.
const DIAG_FIXTURE_JSX = join(HERE, "..", "..", "diagnostics", "tests", "fixtures", "single", "runtime-error.jsx");

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
  assert.equal(r.outcome, "REFUSED");
});

t("execute refuses destructive op without --confirm-destructive", () => {
  const r = run(["execute", "project.new", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "REFUSED");
  assert.match(JSON.stringify(r.result), /DESTRUCTIVE|refused/);
});

t("execute reports unknown op", () => {
  const r = run(["execute", "no.such.op", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "REFUSED");
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

t("bare --close-timeout-ms does not collapse the close timeout (Issue #219)", () => {
  freshRunsDir();
  // A bare flag parses to boolean true; the buggy path turned that into
  // a 1ms timeout. With a 150ms fake close, only the default 20s bound
  // lets cleanup succeed.
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant",
    "--close-timeout-ms"],
    { AE_DEVTOOLS_CLI_FAKE_CLOSE: "slow" });
  assert.equal(r.body.cleanup.ok, true, JSON.stringify(r.body.cleanup));
});

t("unknown --session is a usage error and leaves no run marker (Issue #219)", () => {
  freshRunsDir();
  const r = run(["execute", "read.projectSummary", "--session", "typo", "--consent", "grant"]);
  assert.equal(r.code, 2);
  assert.equal(r.body.code, "USAGE");
  assert.equal(run(["runs"]).body.runs.length, 0);
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
    // Attested process evidence: the quit target must BE the ae-a8n
    // attested pid, not merely "an AE under the install dir".
    noteSessionProcess(dir, runId, {
      aePid: 4242,
      aePidStartStamp: "stamp-ae",
      guiSession: { uid: 501, asid: 42 },
      attestation: {
        source: ATTESTATION_SOURCE,
        ownershipKind: "owned",
        ownershipEvidence: "probe answered in owned session",
      },
    });

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
    const stampFn = async (pid) => (pid === 4242 ? "stamp-ae" : null);

    // no --confirm → refused, names the candidate
    let v = await reapRun(runId, { dir, confirm: false, aliveFn: dead, stampFn, exec, wait: noWait, now: () => t0 });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "CONFIRM_REQUIRED");
    assert.equal(v.candidate.pid, 4242);

    // --confirm → graceful quit verified
    v = await reapRun(runId, { dir, confirm: true, aliveFn: dead, stampFn, exec, wait: noWait, now: () => Date.now() });
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
    noteSessionProcess(dir, runId2, {
      aePid: 5555,
      guiSession: { uid: 501, asid: 42 },
      attestation: {
        source: ATTESTATION_SOURCE,
        ownershipKind: "owned",
        ownershipEvidence: "probe answered in owned session",
      },
    });
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
    // Runner pid (this test process) is alive but stamp-mismatched → dead;
    // the attested aePid 5555 is dead too → zero candidates → CLEAN.
    const aliveOnlyRunner = (pid) => pid === process.pid;
    v = await reapRun(runId2, { dir, confirm: true, aliveFn: aliveOnlyRunner, stampFn, exec });
    // stamp mismatch → runnerAlive=false → owned + attested + zero candidates → CLEAN
    assert.equal(v.verdict, "CLEAN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await at("guard: owned marker without ae-a8n attestation is never reaped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    const { runId } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId, {
      kind: "a8n", ownership: { kind: "owned", evidence: "self-declared" },
      installDir: "/x", appPath: "/x.app",
    });
    endRun(dir, runId, "close-failed");
    // No noteSessionProcess → no attestation → refuse before any process scan.
    let v = await reapRun(runId, {
      dir, confirm: true, aliveFn: () => false,
      exec: async () => ({ stdout: "" }),
    });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "NO_A8N_ATTESTATION");

    // Attestation with wrong source is equally refused.
    const { runId: runId2 } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId2, {
      kind: "a8n", ownership: { kind: "owned", evidence: "t" },
      installDir: "/x", appPath: "/x.app",
    });
    endRun(dir, runId2, "close-failed");
    noteSessionProcess(dir, runId2, {
      aePid: 4242,
      attestation: { source: "self-declared", ownershipKind: "owned", ownershipEvidence: "fake" },
    });
    v = await reapRun(runId2, {
      dir, confirm: true, aliveFn: () => false,
      exec: async () => ({ stdout: "" }),
    });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "NO_A8N_ATTESTATION");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await at("guard: listRuns marks unattested owned markers not reapable (Issue #219)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    // Same shape the MCP/VSCode surface guards write: ownership claims
    // "owned" but session.process attestation is absent by design.
    const { runId } = await beginRun({ dir, sessionKind: "a8n", surface: "mcp" });
    markSession(dir, runId, {
      kind: "a8n", evidenceLevel: "verified on real host (macOS)",
      meta: { aeVersion: "26.5-fake", ownership: "owned" },
      ownership: { kind: "owned", evidence: null },
    });
    endRun(dir, runId, "close-failed");
    const runs = await listRuns({ dir, aliveFn: () => false });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].reapable, false);
    assert.equal(runs[0].reapBlockReason, "NO_A8N_ATTESTATION");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await at("guard: single AE candidate that is NOT the attested pid is never quit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    const { runId } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId, {
      kind: "a8n", ownership: { kind: "owned", evidence: "t" },
      installDir: "/Applications/Adobe After Effects 2027",
      appPath: "/Applications/Adobe After Effects 2027/Adobe After Effects 2027.app",
    });
    endRun(dir, runId, "close-failed");
    // The run's AE (pid 4242) is gone; a DIFFERENT AE (pid 9999 — e.g. the
    // user's own session) is alive under the same install.
    noteSessionProcess(dir, runId, {
      aePid: 4242,
      attestation: {
        source: ATTESTATION_SOURCE,
        ownershipKind: "owned",
        ownershipEvidence: "probe answered in owned session",
      },
    });
    const exec = async (cmd, args) => {
      if (cmd === "ps" && args[0] === "-axo") {
        return { stdout: "  9999 /Applications/Adobe After Effects 2027/Adobe After Effects 2027.app/Contents/MacOS/After Effects\n" };
      }
      return { stdout: "" };
    };
    const v = await reapRun(runId, {
      dir, confirm: true, aliveFn: () => false, exec,
    });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "PID_NOT_ATTESTED");
    assert.equal(v.attestedPid, 4242);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- failure diagnostics + diagnose (Issue #103, fake level only) ----

t("completed execute carries no diagnostics block (additive contract)", () => {
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(r.diagnostics, undefined);
});

t("host failure evidence carries diagnostics record + mapped sourcemap resolution", () => {
  freshRunsDir();
  const outDir = mkdtempSync(join(tmpdir(), "diag-out-"));
  try {
    const out = join(outDir, "evidence.json");
    const hostError = JSON.stringify({
      name: "ReferenceError",
      message: "injected host failure",
      line: 3,
      file: DIAG_FIXTURE_JSX,
    });
    const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant",
      "--out", out], { AE_DEVTOOLS_CLI_FAKE_HOST_ERROR: hostError });
    assert.equal(r.body.diagnostics?.schema, "ae-devtools.cli.diagnostics/v1");
    assert.equal(r.body.diagnostics.status, "ok");
    const rec = r.body.diagnostics.records[0];
    assert.equal(rec.recordVersion, "ae-devtools.diagnostics/v1");
    assert.equal(rec.kind, "script-exception");
    assert.equal(rec.severity, "error");
    assert.equal(rec.source.assetKind, "jsx-script");
    assert.equal(rec.source.line, 3);
    assert.equal(rec.source.hostReported, true);
    assert.equal(rec.evidence, "fake");
    const res = r.body.diagnostics.resolutions[0];
    assert.equal(res.status, "mapped");
    assert.equal(res.original.file, "runtime-error.ts");
    assert.equal(res.original.line, 3);
    // The --out file holds the same evidence for `diagnose`.
    const saved = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(saved.diagnostics.records.length, 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

t("host failure without a resolvable position records honest no-map/no-position", () => {
  const hostError = JSON.stringify({ name: "Error", message: "positionless failure" });
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"],
    { AE_DEVTOOLS_CLI_FAKE_HOST_ERROR: hostError });
  const res = r.body.diagnostics?.resolutions?.[0];
  assert.ok(res, "diagnostics.resolutions missing");
  // No line on the record → the resolver refuses to invent a position.
  assert.equal(res.status, "no-position");
});

t("wire FAILED outcome exits non-zero (Issue #105)", () => {
  const hostError = JSON.stringify({ name: "Error", message: "wire-level failure" });
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"],
    { AE_DEVTOOLS_CLI_FAKE_HOST_ERROR: hostError });
  assert.equal(r.body.outcome, "FAILED");
  assert.equal(r.code, 1);
});

t("adapter-level refusal produces a transport-outcome diagnostics record", () => {
  const r = run(["execute", "project.new", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "REFUSED"); // destructive confirm missing
  const rec = r.diagnostics?.records?.[0];
  assert.equal(rec?.recordVersion, "ae-devtools.diagnostics/v1");
  assert.equal(rec?.kind, "transport-outcome");
});

// ---- Issue #127 review fixes: outcome normalization + failure precedence ----

await at("diagnostics: failureOutcome normalizes spellings; failure status beats COMPLETED wire outcome", async () => {
  // wire uppercase REFUSED (used to slip through FAILURE_OUTCOMES)
  assert.equal(failureOutcome({ outcome: "REFUSED" }, "REFUSED"), "REFUSED");
  // adapter lowercase status with no wire outcome
  assert.equal(failureOutcome({ status: "refused", reason: "CONSENT_DENIED" }, "refused"), "REFUSED");
  // adapter ok:false payload: wire COMPLETED + status failed → FAILED wins
  assert.equal(failureOutcome({ outcome: "COMPLETED", status: "failed" }, "COMPLETED"), "FAILED");
  // clean completion is not a failure
  assert.equal(failureOutcome({ outcome: "COMPLETED" }, "COMPLETED"), null);
  assert.equal(isFailureResult({ outcome: "COMPLETED" }, "COMPLETED"), false);
  // host error object is failure evidence even with a clean outcome
  assert.equal(failureOutcome({ outcome: "COMPLETED", error: { message: "x" } }, "COMPLETED"), "FAILED");
});

t("normalizedOutcome/isUnknownOutcome normalize spellings; null-safe (Issue #226)", () => {
  // lowercase/mixed-case spellings normalize to the wire vocabulary
  assert.equal(normalizedOutcome({ status: "refused" }), "REFUSED");
  assert.equal(normalizedOutcome({ outcome: "completed" }), "COMPLETED");
  assert.equal(normalizedOutcome({ outcome: "WeIrD" }), "WeIrD"); // unknown spellings pass through verbatim
  assert.equal(normalizedOutcome(null), null);
  assert.equal(normalizedOutcome({}), null);
  // explicit outcome argument wins over result fields
  assert.equal(normalizedOutcome({ outcome: "COMPLETED" }, "failed"), "FAILED");
  // UNKNOWN detection is spelling-normalized: lowercase "unknown" is
  // the recoverable in-flight state; null/missing is not
  assert.equal(isUnknownOutcome({ outcome: "UNKNOWN" }), true);
  assert.equal(isUnknownOutcome({ status: "unknown" }), true);
  assert.equal(isUnknownOutcome({ outcome: "COMPLETED" }), false);
  assert.equal(isUnknownOutcome(null), false);
  assert.equal(isUnknownOutcome({}), false);
});

t("verify accepts --args and completes (readArgs forwarding, Issue #226)", () => {
  const r = run(["verify", "--session", "fake", "--consent", "grant",
    "--read-op", "read.projectSummary", "--args", '{"unused":true}']);
  assert.equal(r.body.outcome, "COMPLETED");
});

t("wire REFUSED outcome exits 1 and carries a diagnostics block", () => {
  const reply = JSON.stringify({
    ok: false,
    refusal: { code: "HOST_BUSY", message: "host reported busy/modal before execution" },
  });
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"],
    { AE_DEVTOOLS_CLI_FAKE_REPLY: reply });
  assert.equal(r.body.outcome, "REFUSED");
  assert.equal(r.code, 1);
  const rec = r.body.diagnostics?.records?.[0];
  assert.equal(rec?.kind, "transport-outcome");
  assert.equal(rec?.outcome, "REFUSED");
  assert.equal(rec?.severity, "warning");
  // reason code appears once (as code), host message is not dropped
  assert.match(rec?.message ?? "", /HOST_BUSY/);
  assert.match(rec?.message ?? "", /host reported busy\/modal/);
});

t("adapter payload failure reports FAILED outcome, exits 1 with FAILED record", () => {
  const reply = JSON.stringify({
    ok: true,
    result: JSON.stringify({ ok: false, error: { message: "adapter boom" } }),
  });
  const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"],
    { AE_DEVTOOLS_CLI_FAKE_REPLY: reply });
  // Issue #196: the reported outcome is normalized at the adapter —
  // a failure-bearing dispatch must never read COMPLETED on any surface.
  assert.equal(r.body.outcome, "FAILED");
  assert.equal(r.body.result?.status, "failed"); // adapter level
  assert.equal(r.body.result?.outcome, "FAILED");
  assert.equal(r.code, 1, "failure-bearing status must drive the exit code");
  const rec = r.body.diagnostics?.records?.[0];
  assert.equal(rec?.kind, "transport-outcome");
  assert.equal(rec?.outcome, "FAILED");
  assert.equal(rec?.severity, "error");
  assert.match(rec?.message ?? "", /adapter boom/);
});

t("diagnose resolves a stored --out evidence file through sourcemaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-evidence-"));
  const out = join(dir, "evidence.json");
  const hostError = JSON.stringify({
    name: "Error", message: "diag target", line: 3, file: DIAG_FIXTURE_JSX,
  });
  run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant",
    "--out", out], { AE_DEVTOOLS_CLI_FAKE_HOST_ERROR: hostError });
  const d = run(["diagnose", out]).body;
  assert.equal(d.schema, "ae-devtools.cli.diagnose/v1");
  assert.equal(d.recordCount, 1);
  assert.equal(d.results[0].recordValid, true);
  assert.equal(d.results[0].resolution.status, "mapped");
  assert.equal(d.results[0].resolution.original.file, "runtime-error.ts");
  rmSync(dir, { recursive: true, force: true });
});

t("diagnose accepts a bare diagnostics record and a surviving run marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-record-"));
  try {
    // bare ae-devtools.diagnostics/v1 record
    const recPath = join(dir, "record.json");
    writeFileSync(recPath, JSON.stringify({
      recordVersion: "ae-devtools.diagnostics/v1",
      kind: "script-exception",
      severity: "error",
      message: "bare record",
      collector: "test",
      occurredAt: new Date().toISOString(),
      source: { assetKind: "jsx-script", path: DIAG_FIXTURE_JSX, line: 3 },
    }));
    const d1 = run(["diagnose", recPath]).body;
    assert.equal(d1.recordCount, 1);
    assert.equal(d1.results[0].resolution.status, "mapped");

    // surviving marker (close-failed) linked to its --out evidence
    freshRunsDir();
    const out = join(dir, "run-evidence.json");
    const hostError = JSON.stringify({
      name: "Error", message: "marker run", line: 3, file: DIAG_FIXTURE_JSX,
    });
    const r = run(["execute", "read.projectSummary", "--session", "fake", "--consent", "grant",
      "--out", out], {
      AE_DEVTOOLS_CLI_FAKE_HOST_ERROR: hostError,
      AE_DEVTOOLS_CLI_FAKE_CLOSE: "throw",
    });
    assert.equal(r.code, 3);
    const marker = run(["runs"]).body.runs[0];
    assert.ok(marker, "expected a surviving run marker");
    const d2 = run(["diagnose", marker.runId]).body;
    assert.equal(d2.target.via, "run-marker");
    assert.equal(d2.recordCount, 1);
    assert.equal(d2.results[0].resolution.status, "mapped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // The close-failed run intentionally survives — do not leak its
    // marker into the shared runs dir for later cases.
    freshRunsDir();
  }
});

await at("guard: attachEvidence refuses to overwrite a corrupt marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  try {
    const runId = "run-corrupt-marker";
    const file = join(dir, `${runId}.json`);
    const corrupt = "{ this is not json ";
    writeFileSync(file, corrupt);
    // readMarker synthesizes a {status:"corrupt"} stub; writing it back
    // would destroy the original residue — attachEvidence must refuse.
    assert.equal(attachEvidence(dir, runId, { file: "/tmp/evidence.json" }), false);
    assert.equal(readFileSync(file, "utf8"), corrupt);
    // A healthy marker still accepts the link.
    const { runId: ok } = await beginRun({ dir, sessionKind: "fake" });
    assert.equal(attachEvidence(dir, ok, { file: "/tmp/evidence.json" }), true);
    const marker = JSON.parse(readFileSync(join(dir, `${ok}.json`), "utf8"));
    assert.equal(marker.evidenceFile, "/tmp/evidence.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("diagnose reports usage/IO errors honestly", () => {
  const missing = run(["diagnose", "/nonexistent/nope.json"]);
  assert.equal(missing.code, 2);
  assert.equal(missing.body.schema, "ae-devtools.cli.diagnose/v1");
  const noArg = run(["diagnose"]);
  assert.equal(noArg.code, 2);
});

t("diagnose recognizes a CLI error document explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-err-"));
  try {
    const p = join(dir, "err.json");
    writeFileSync(p, JSON.stringify({
      schema: "ae-devtools.cli.error/v1", code: "CLI_ERROR", message: "boom",
    }));
    const d = run(["diagnose", p]).body;
    assert.equal(d.source, "cli-error");
    assert.equal(d.recordCount, 0);
    assert.ok(d.notes.some((n) => n.includes("CLI_ERROR")), JSON.stringify(d.notes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Issue #197: shared argv parser + real-run kit -------------------

t("argv: --flag value / --flag=value / boolean / positional", () => {
  const { pos, flags } = parseArgs([
    "cmd", "tail", "--out", "ev.json", "--name=My Comp", "--force",
    "--empty=", "--next", "--other",
  ]);
  assert.deepEqual(pos, ["cmd", "tail"]);
  assert.equal(flags.out, "ev.json");
  assert.equal(flags.name, "My Comp");
  assert.equal(flags.force, true);
  assert.equal(flags.empty, "");
  // --next is followed by another flag → boolean, not a value
  assert.equal(flags.next, true);
  assert.equal(flags.other, true);
});

t("argv: multi collects repeated flags; singles stay last-wins", () => {
  const { flags, multi } = parseArgs(
    ["--reports-dir", "a", "--reports-dir=b", "--sentry-dir", "s", "--once", "1", "--once", "2"],
    { multi: ["reports-dir", "sentry-dir"] },
  );
  assert.deepEqual(multi["reports-dir"], ["a", "b"]);
  assert.deepEqual(multi["sentry-dir"], ["s"]);
  assert.equal(flags.once, "2");
  assert.equal(flags["reports-dir"], undefined);
});

t("argv: arg() returns string values only; hasFlag sees bare flags", () => {
  const argv = ["--install-dir", "/Applications/AE.app", "--force", "--empty="];
  assert.equal(argvArg("--install-dir", argv), "/Applications/AE.app");
  assert.equal(argvArg("--install-dir=/x", argv), undefined);
  assert.equal(argvArg("--missing", argv), undefined);
  // bare boolean is not a value
  assert.equal(argvArg("--force", argv), undefined);
  assert.equal(argvArg("--empty", argv), "");
  assert.equal(hasFlag("--force", argv), true);
  assert.equal(hasFlag("--missing", argv), false);
  // --flag=value form
  assert.equal(argvArg("--out", ["--out=/tmp/e.json"]), "/tmp/e.json");
});

await at("kit: createEvalDispatch binds consent scope and runScript args shape", async () => {
  const pin = { sessionId: "sess-1", aeVersion: "26.0", dispatchId: "d1" };
  const seen = [];
  const runner = { runScript: async (input) => { seen.push(input); return { outcome: "COMPLETED" }; } };
  let identity = "proj-a";
  const dispatch = createEvalDispatch({
    runner, pin,
    projectIdentity: () => identity,
    operationId: "op.test.eval",
    scriptProvenance: "test",
  });
  const r1 = await dispatch("source-one", "req-1");
  assert.equal(r1.outcome, "COMPLETED");
  const expectedScope = consentScopeFor({
    pin, operationId: "op.test.eval",
    args: { source: "source-one", dispatchArgs: null },
    projectIdentity: "proj-a",
  });
  assert.deepEqual(seen[0].consent.scope, expectedScope);
  assert.equal(seen[0].source, "source-one");
  assert.equal(seen[0].args, null);
  assert.equal(seen[0].projectIdentity, "proj-a");
  assert.equal(seen[0].trustedScriptOptIn, true);
  assert.equal(seen[0].scriptProvenance, "test");
  assert.equal(seen[0].requestId, "req-1");
  // lazy projectIdentity: re-bound identity is used on the next dispatch
  identity = "proj-b";
  await dispatch("source-two", "req-2", { extra: 1 });
  assert.equal(seen[1].projectIdentity, "proj-b");
  assert.deepEqual(seen[1].args, { extra: 1 });
  assert.deepEqual(seen[1].consent.scope, consentScopeFor({
    pin, operationId: "op.test.eval",
    args: { source: "source-two", dispatchArgs: { extra: 1 } },
    projectIdentity: "proj-b",
  }));
});

await at("kit: withTimeout rejects with TIMEOUT tag", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, "probe"),
    /TIMEOUT probe/,
  );
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "ok"), 7);
});

await at("kit: spawnMcpStdio round-trips NDJSON against a stub server", async () => {
  const records = [];
  const stub = [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "rl.on('line', (l) => {",
    "  const m = JSON.parse(l);",
    "  if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echo: m.method } }) + '\\n');",
    "});",
  ].join(" ");
  const { child, send, notify, call } = spawnMcpStdio({
    scriptArgs: ["-e", stub],
    cwd: tmpdir(),
    onRecord: (o) => records.push(o),
    onStderr: () => {},
  });
  try {
    const res = await withTimeout(send("ping", {}), 5000, "stub");
    assert.equal(res.result.echo, "ping");
    notify("notifications/initialized");
    const tool = await withTimeout(call("ae_discover", {}), 5000, "stub-call");
    assert.equal(tool.result.echo, "tools/call");
    assert.ok(records.some((r) => r.rx && r.rx.result));
  } finally {
    child.kill("SIGKILL");
  }
});

await at("kit: spawnMcpStdio rejects pending sends when the child exits (Issue #219)", async () => {
  const { child, send } = spawnMcpStdio({
    scriptArgs: ["-e", "setTimeout(() => process.exit(0), 50)"],
    cwd: tmpdir(),
    onStderr: () => {},
  });
  try {
    await assert.rejects(
      withTimeout(send("ping", {}), 5000, "dead-child"),
      /exited with requests in flight/,
    );
  } finally {
    child.kill("SIGKILL");
  }
});

t("kit: aeProcessSnapshot and gitHeadAndDirty degrade honestly", async () => {
  const snap = await aeProcessSnapshot("ae-devtools-definitely-no-such-proc-197");
  assert.ok(Array.isArray(snap), JSON.stringify(snap));
  const git = await gitHeadAndDirty(HERE);
  assert.ok("head" in git && "dirty" in git);
  assert.ok(git.head === null || typeof git.head === "string");
});


// ---- Issue #227: runId path-traversal + AppleScript injection guards ----

await at("guard: non-run-* ids can never reach marker paths", async () => {
  const base = mkdtempSync(join(tmpdir(), "guard-trav-"));
  const dir = join(base, "runs");
  try {
    // A foreign .json in the runs dir is not a marker and is ignored.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.json"), "{}");
    assert.equal((await listRuns({ dir, aliveFn: () => false })).length, 0);

    // reap on a traversal id refuses before touching the filesystem.
    let v = await reapRun("../../etc/passwd", { dir, confirm: true, exec: async () => ({ stdout: "" }) });
    assert.equal(v.verdict, "REFUSED");
    assert.equal(v.reason, "INVALID_RUN_ID");
    v = await reapRun("run-x/../../y", { dir, confirm: true, exec: async () => ({ stdout: "" }) });
    assert.equal(v.reason, "INVALID_RUN_ID");

    // endRun on a traversal id must not delete outside the runs dir.
    const victim = join(base, "victim.json");
    writeFileSync(victim, "{}");
    endRun(dir, "../victim", "closed");
    assert.ok(existsSync(victim), "endRun deleted a file outside the runs dir");
    rmSync(victim, { force: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

await at("guard: reap passes the quit target via osascript argv, never interpolated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-osa-"));
  try {
    // A marker-controlled path containing a double quote must reach
    // osascript as an argv element, never inside a script literal.
    const appPath = "/Applications/AE \"quoted\".app";
    const { runId } = await beginRun({ dir, sessionKind: "a8n" });
    markSession(dir, runId, {
      kind: "a8n", ownership: { kind: "owned", evidence: "t" },
      installDir: "/x", appPath,
    });
    endRun(dir, runId, "close-failed");
    noteSessionProcess(dir, runId, {
      aePid: 4242,
      attestation: {
        source: ATTESTATION_SOURCE,
        ownershipKind: "owned",
        ownershipEvidence: "probe answered in owned session",
      },
    });
    let osaArgs = null;
    const exec = async (cmd, args) => {
      if (cmd === "ps" && args[0] === "-axo") {
        return { stdout: "  4242 " + appPath + "/Contents/MacOS/After Effects\n" };
      }
      if (cmd === "ps" && args.includes("4242")) return { stdout: "" };
      if (cmd === "osascript") { osaArgs = args; return { stdout: "" }; }
      throw new Error("unexpected exec " + cmd);
    };
    const v = await reapRun(runId, {
      dir, confirm: true, aliveFn: () => false, exec, wait: async () => {},
    });
    assert.equal(v.verdict, "REAPED");
    assert.ok(osaArgs, "osascript was not invoked");
    assert.equal(osaArgs[osaArgs.length - 1], appPath);
    assert.ok(osaArgs.includes("on run argv"));
    assert.ok(!osaArgs.some((a) => a.includes("tell application \"" + appPath)),
      "target was interpolated into a script literal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("diagnose refuses marker-lookup traversal ids", () => {
  freshRunsDir();
  const r = run(["diagnose", "../outside-marker"]);
  assert.equal(r.code, 2);
  assert.equal(r.body.schema, "ae-devtools.cli.diagnose/v1");
  assert.ok(r.body.notes.some((n) => n.includes("no such file or run marker")), JSON.stringify(r.body.notes));
});

await finish("tests passed");
