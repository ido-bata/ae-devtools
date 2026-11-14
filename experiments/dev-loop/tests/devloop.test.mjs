import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadTrustedCodec, createJsxRunner } from "../../trusted-execution/runner.mjs";
import { discover, inspect, execute, verify } from "../devloop.mjs";
import { createAdapterFakeApp } from "../../scripting-adapters/fake-app.mjs";

const codec = loadTrustedCodec();
const PIN = { sessionId: "sess-dl", aeVersion: "26.5.3" };

function hostTransport(app) {
  return { send(text) {
    const env = codec.parse(text);
    const ctx = vm.createContext({ app, JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp,
      Error, TypeError, ReferenceError, parseInt, parseFloat, isNaN, isFinite, undefined,
      File: class { constructor(p) { this.fsName = p; this.exists = true; } },
      CloseOptions: { DO_NOT_SAVE_CHANGES: 2 },
      CompItem: app.CompItem, FolderItem: app.FolderItem, FootageItem: app.FootageItem });
    try {
      const result = vm.runInContext("(function(){\n" + env.source + "\n})()", ctx);
      return Promise.resolve(codec.stringify({ ok: true, result, requestId: env.requestId }));
    } catch (e) {
      return Promise.resolve(codec.stringify({ ok: false, error: { name: "Error", message: String(e.message) }, requestId: env.requestId }));
    }
  }};
}

function fixture() {
  const app = createAdapterFakeApp();
  const transport = hostTransport(app);
  const runner = createJsxRunner({ transport, codec });
  const consentProvider = async () => ({ approved: true });
  const base = { runner, pin: PIN, projectIdentity: "p", consentProvider,
    trustedScriptOptIn: true, scriptProvenance: "devloop-test" };
  return { app, transport, ...base };
}

test("discover lists ops with honest metadata; unimplemented members not executable", () => {
  const d = discover();
  assert.equal(d.operationCount, 20);
  assert.equal(d.evidence.realHostVerified, 0);
  assert.ok(d.operations.every((o) => typeof o.id === "string"));
  const d16 = discover({ domain: "animation-effects-render" });
  assert.equal(d16.operationCount, 7);
});

test("inspect returns schema without executing; unknown op reported", () => {
  const i = inspect("item.addComp");
  assert.equal(i.status, "ok");
  assert.ok(i.op.members.length > 0);
  assert.equal(inspect("no.such").status, "unknown-operation");
});

test("developer-loop vertical: discover→inspect→execute→verify", async () => {
  const f = fixture();
  assert.equal(inspect("project.new").status, "ok");
  const r1 = await execute({ opId: "project.new", args: {}, confirmDestructive: true, ...f });
  assert.equal(r1.outcome, "COMPLETED");
  const r2 = await execute({ opId: "item.addComp",
    args: { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30 }, ...f });
  assert.equal(r2.outcome, "COMPLETED");
  // verify reads back real fake state through the runner — not inferred
  const v = await verify({ ...f });
  assert.equal(v.outcome, "COMPLETED");
  assert.equal(v.result.count, 1);
  assert.equal(v.result.items[0].name, "C");
});

test("verify refuses mutating ops as read-backs", async () => {
  const f = fixture();
  const v = await verify({ ...f, readOpId: "item.addComp" });
  assert.equal(v.reason, "VERIFY_REQUIRES_READ_OP");
});

test("execute adds no approval path: denial still refuses before transport", async () => {
  const f = fixture();
  const origSend = f.transport.send.bind(f.transport);
  let sent = 0;
  f.transport.send = (t) => { sent++; return origSend(t); };
  const r = await execute({ ...f, opId: "item.addFolder", args: { name: "X" },
    consentProvider: async () => ({ approved: false }) });
  assert.equal(r.stage, "consent");
  assert.equal(sent, 0);
});
