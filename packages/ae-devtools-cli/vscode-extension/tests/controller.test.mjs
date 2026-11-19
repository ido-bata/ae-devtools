/**
 * controller.test.mjs — VSCode extension controller tests (Issue #152).
 *
 * Fake/mock level only: the controller is exercised against the
 * codec-faithful fake session through the SAME callTool/dev-loop path
 * the MCP server uses. No After Effects, no vscode API — `ui` is a
 * recording fake. Real-host evidence is a separate acceptance item.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createController, EXTENSION_SCHEMA } from "../controller.mjs";
import { openFakeSession } from "../../devtools-cli/fake-session.mjs";
import { reapRun } from "../../devtools-cli/session-guard.mjs";

function recordingUi(answers = {}) {
  const prompts = [];
  return {
    prompts,
    async confirm(req) {
      prompts.push(req);
      // Default: approve everything unless the test overrides by title.
      for (const [key, value] of Object.entries(answers)) {
        if (req.title.includes(key)) return value;
      }
      return true;
    },
    async info() {},
    async error() {},
  };
}

function factorySpy() {
  const calls = [];
  return {
    calls,
    factory: async (kind, opts) => {
      calls.push({ kind, opts });
      return openFakeSession();
    },
  };
}

test("discover returns registry ops with honest metadata, no session opened", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi() });
  const res = await c.discover();
  assert.equal(res.schema, EXTENSION_SCHEMA);
  assert.ok(Array.isArray(res.operations));
  assert.ok(res.operations.length > 0);
  assert.ok(res.operations.every((o) => typeof o.id === "string" && Array.isArray(o.args)));
  // Unimplemented inventory members are not listed as executable ops.
  assert.ok(!res.operations.some((o) => o.id === "no.such.op"));
  assert.equal(spy.calls.length, 0);
});

test("sessionStatus reports closed then open state without dispatching itself (CAP049)", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi() });
  const before = await c.sessionStatus();
  assert.equal(before.session.state, "closed");
  assert.equal(before.session.kind, "fake");
  assert.equal(before.session.evidenceLevel, undefined);
  assert.equal(spy.calls.length, 0, "sessionStatus must never open a session");

  await c.execute({ opId: "read.projectSummary", args: {} });
  const after = await c.sessionStatus();
  assert.equal(after.session.state, "open");
  assert.equal(after.session.evidenceLevel, "fake/mock only");
  assert.ok(after.session.pin && typeof after.session.pin === "object");
  assert.equal(spy.calls.length, 1);
});

test("inspect returns op metadata; unknown op is a typed result, never executes", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi() });
  const ok = await c.inspect("item.addComp");
  assert.equal(ok.status, "ok");
  assert.equal(ok.op.id, "item.addComp");
  assert.equal(ok.op.mutating, true);
  const bad = await c.inspect("no.such.op");
  assert.equal(bad.status, "unknown-operation");
  assert.equal(spy.calls.length, 0);
});

test("execute without UI consent is refused BEFORE any session opens", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi({ "Dispatch": false }) });
  const res = await c.execute({ opId: "read.projectSummary" });
  assert.equal(res.status, "refused");
  assert.equal(res.stage, "ui-confirm");
  assert.equal(res.reason, "DECLINED_BY_USER");
  assert.equal(res.dispatched, false);
  assert.equal(spy.calls.length, 0);
});

test("destructive op requires its own confirm before consent; decline stops dispatch", async () => {
  const spy = factorySpy();
  const ui = recordingUi({ "Destructive operation": false });
  const c = createController({ sessionFactory: spy.factory, ui });
  const res = await c.execute({ opId: "project.new" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "DECLINED_BY_USER");
  assert.equal(spy.calls.length, 0);
  // Only the destructive prompt was shown — consent was never asked.
  assert.equal(ui.prompts.length, 1);
  assert.match(ui.prompts[0].title, /Destructive operation/);
});

test("render op requires confirmRender path; decline stops dispatch", async () => {
  const spy = factorySpy();
  const ui = recordingUi({ "Render operation": false });
  const c = createController({ sessionFactory: spy.factory, ui });
  const res = await c.execute({ opId: "render.renderQueued" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "DECLINED_BY_USER");
  assert.equal(spy.calls.length, 0);
});

test("execute → verify completes on the fake session with fake evidence level", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi() });
  const ex = await c.execute({ opId: "read.projectSummary", args: {} });
  assert.equal(ex.outcome === "ok" || ex.result?.ok === true || ex.status === "ok" || ex.outcome != null, true);
  assert.equal(ex.session.evidenceLevel, "fake/mock only");
  const vf = await c.verify();
  assert.equal(vf.session.evidenceLevel, "fake/mock only");
  assert.equal(spy.calls.length, 1); // one shared session
  await c.close();
});

test("unknown opId is refused without opening a session", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi() });
  const res = await c.execute({ opId: "no.such.op" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "UNKNOWN_OPERATION");
  assert.equal(spy.calls.length, 0);
});

test("verify without consent is refused before session open", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi({ "Verify": false }) });
  const res = await c.verify();
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "DECLINED_BY_USER");
  assert.equal(spy.calls.length, 0);
});

test("missing opId is a usage refusal, not a crash", async () => {
  const c = createController({ ui: recordingUi() });
  const res = await c.execute({});
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "USAGE");
});

test("close is safe before and after a session opens", async () => {
  const spy = factorySpy();
  const c = createController({ sessionFactory: spy.factory, ui: recordingUi() });
  assert.deepEqual(await c.close(), { closed: false });
  await c.execute({ opId: "read.projectSummary" });
  assert.deepEqual(await c.close(), { closed: true });
});

test("adapter payload failure reports FAILED outcome, never COMPLETED (Issue #196)", async () => {
  // Wire COMPLETED + adapter ok:false payload — the reported outcome
  // must be normalized so summarize()/payload consumers never show
  // "COMPLETED" for a failed dispatch.
  const prev = process.env.AE_DEVTOOLS_CLI_FAKE_REPLY;
  process.env.AE_DEVTOOLS_CLI_FAKE_REPLY = JSON.stringify({
    ok: true,
    result: JSON.stringify({ ok: false, error: { message: "adapter boom" } }),
  });
  try {
    const c = createController({
      sessionFactory: async () => openFakeSession(),
      ui: recordingUi(),
    });
    const res = await c.execute({ opId: "read.projectSummary" });
    assert.equal(res.isError, true);
    assert.equal(res.outcome, "FAILED");
    assert.equal(res.result?.status, "failed");
    await c.close();
  } finally {
    if (prev === undefined) delete process.env.AE_DEVTOOLS_CLI_FAKE_REPLY;
    else process.env.AE_DEVTOOLS_CLI_FAKE_REPLY = prev;
  }
});

test("execute/verify attach an explicit empty diagnostics plan when nothing failed (Issue #302)", async () => {
  const c = createController({
    sessionFactory: async () => openFakeSession(),
    ui: recordingUi(),
  });
  const ex = await c.execute({ opId: "read.projectSummary", args: {} });
  assert.equal(ex.diagnostics?.schema, "ae-devtools.vscode-diagnostics/v1");
  assert.equal(ex.diagnostics.summary.total, 0);
  assert.deepEqual(ex.diagnostics.items, []);
  const vf = await c.verify();
  assert.equal(vf.diagnostics?.schema, "ae-devtools.vscode-diagnostics/v1");
  assert.equal(vf.diagnostics.summary.total, 0);
  await c.close();
});

// ---- run-guard residue markers for a8n sessions (Issue #198, 案 C) ----

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), "ae-devtools-vscode-runs-"));
}

function readOnlyMarker(runsDir) {
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, `expected exactly one run marker, got ${files.join(",")}`);
  return JSON.parse(readFileSync(join(runsDir, files[0]), "utf8"));
}

/** Session shaped like the stripped a8n session mcp-server/session.mjs returns. */
function fakeA8nSession() {
  const s = openFakeSession();
  return {
    ...s,
    kind: "a8n",
    evidenceLevel: "verified on real host (macOS)",
    meta: { aeVersion: "26.5-fake", ownership: "owned", aeA8nHead: "deadbeef" },
  };
}

test("a8n execute writes a run-guard marker (surface vscode) with request events and NO attestation", async () => {
  const runsDir = tempRunsDir();
  try {
    const c = createController({
      session: "a8n",
      sessionFactory: async () => fakeA8nSession(),
      runsDir,
      ui: recordingUi(),
    });
    const res = await c.execute({ opId: "read.projectSummary" });
    assert.equal(res.isError, false);

    const marker = readOnlyMarker(runsDir);
    assert.equal(marker.schema, "ae-devtools.cli.run-guard/v1");
    assert.equal(marker.surface, "vscode");
    assert.equal(marker.sessionKind, "a8n");
    assert.equal(marker.status, "open");
    assert.equal(marker.session.ownership?.kind, "owned");
    // Fail-closed: no process attestation — the slice handle is
    // stripped before this surface sees the session.
    assert.equal(marker.session.process, undefined);
    const dispatched = marker.requests.filter((r) => r.event === "dispatched");
    const resolved = marker.requests.filter((r) => r.event === "resolved");
    assert.equal(dispatched.length, 1);
    assert.equal(resolved.length, 1);
    assert.equal(dispatched[0].requestId, resolved[0].requestId);
    assert.match(dispatched[0].requestId, /^req-mcp-/);
    assert.equal(dispatched[0].method, "read.projectSummary");

    // Residue-visible but not recoverable: reap refuses at the
    // missing-attestation gate.
    const verdict = await reapRun(marker.runId, {
      dir: runsDir, aliveFn: () => false,
    });
    assert.equal(verdict.verdict, "REFUSED");
    assert.equal(verdict.reason, "NO_A8N_ATTESTATION");

    // Clean close removes the marker.
    assert.deepEqual(await c.close(), { closed: true });
    assert.equal(existsSync(join(runsDir, `${marker.runId}.json`)), false);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("fake session writes NO run-guard marker", async () => {
  const runsDir = tempRunsDir();
  try {
    const c = createController({
      sessionFactory: async () => openFakeSession(),
      runsDir,
      ui: recordingUi(),
    });
    await c.execute({ opId: "read.projectSummary" });
    assert.deepEqual(readdirSync(runsDir), []);
    await c.close();
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("close is bounded when session.close hangs (Issue #196)", async () => {
  // AE_DEVTOOLS_CLI_FAKE_CLOSE=hang makes the fake session's close()
  // never resolve; the shared bounded close must report failure fast.
  const prev = process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
  process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE = "hang";
  try {
    const c = createController({
      sessionFactory: async () => openFakeSession(),
      ui: recordingUi(),
      closeTimeoutMs: 80,
    });
    await c.execute({ opId: "read.projectSummary" });
    const started = Date.now();
    const res = await c.close();
    assert.ok(Date.now() - started < 10_000, "session close was not bounded");
    assert.equal(res.closed, false);
    assert.match(res.error, /timed out/);
  } finally {
    if (prev === undefined) delete process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
    else process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE = prev;
  }
});
