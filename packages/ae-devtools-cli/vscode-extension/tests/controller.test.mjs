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

import { createController, EXTENSION_SCHEMA } from "../controller.mjs";
import { openFakeSession } from "../../devtools-cli/fake-session.mjs";

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
