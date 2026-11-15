import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadTrustedCodec, createJsxRunner } from "../../trusted-execution/runner.mjs";
import { runOperation } from "../execute.mjs";
import { createAdapterFakeApp } from "../fake-app.mjs";

const codec = loadTrustedCodec();
const PIN = { sessionId: "sess-exec", aeVersion: "26.5.3", dispatchId: "disp-1" };
const PROJECT = "proj-A";

/**
 * Fake host transport: parses the wire envelope, evaluates the ExtendScript
 * source in a vm against the adapter fake app, and replies through the
 * codec with the echoed requestId — the same contract a real bridge peer
 * must satisfy.
 */
function makeHostTransport(app) {
  const calls = [];
  return {
    calls,
    send(text) {
      calls.push(text);
      const env = codec.parse(text);
      const ctx = vm.createContext({
        app,
        JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp,
        Error, TypeError, ReferenceError, parseInt, parseFloat, isNaN, isFinite,
        undefined,
        File: class File { constructor(p) { this.fsName = p; this.exists = true; } },
        CloseOptions: { DO_NOT_SAVE_CHANGES: 2 },
        CompItem: app.CompItem, FolderItem: app.FolderItem, FootageItem: app.FootageItem,
      });
      let result;
      try {
        result = vm.runInContext("(function(){\n" + env.source + "\n})()", ctx, { filename: "adapter.jsx" });
        return Promise.resolve(codec.stringify({ ok: true, result, requestId: env.requestId }));
      } catch (err) {
        return Promise.resolve(codec.stringify({
          ok: false,
          error: { name: err.name ?? "Error", message: String(err.message ?? err) },
          requestId: env.requestId,
        }));
      }
    },
  };
}

function approvingProvider(calls = []) {
  return async ({ opId, source, scope }) => {
    calls.push({ opId, source, scope });
    return { approved: true };
  };
}

function baseInput(app, extra = {}) {
  const transport = makeHostTransport(app);
  const runner = createJsxRunner({ transport, codec });
  return {
    runner, transport,
    pin: PIN, projectIdentity: PROJECT,
    trustedScriptOptIn: true, scriptProvenance: "adapter-test",
    ...extra,
  };
}

test("vertical slice: project.new → item.addComp → read.projectSummary all via runner", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();

  for (const [opId, args] of [
    ["project.new", {}],
    ["item.addComp", { name: "Hero", width: 1920, height: 1080, pixelAspect: 1, duration: 10, frameRate: 30 }],
    ["read.projectSummary", {}],
  ]) {
    const r = await runOperation({ opId, args, consentProvider: provider, confirmDestructive: true, ...t });
    assert.equal(r.outcome, "COMPLETED", `${opId}: ${JSON.stringify(r)}`);
    assert.equal(r.contractOutcome, "completed");
  }
  assert.equal(app.project.items.length, 1);
  assert.equal(t.transport.calls.length, 3);
});

test("consent denial refuses BEFORE transport — nothing is sent", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const r = await runOperation({
    opId: "item.addFolder", args: { name: "X" }, consentProvider: async () => ({ approved: false, reason: "operator said no" }), ...t,
  });
  assert.equal(r.status, "refused");
  assert.equal(r.stage, "consent");
  assert.equal(t.transport.calls.length, 0);
});

test("missing consentProvider is a refusal, never an implicit approval", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const r = await runOperation({ opId: "project.new", args: {}, ...t });
  assert.equal(r.reason, "CONSENT_PROVIDER_REQUIRED");
  assert.equal(t.transport.calls.length, 0);
});

test("unknown op and invalid args refuse before consent evaluation", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  let providerCalled = false;
  const provider = async () => { providerCalled = true; return { approved: true }; };

  const bad = await runOperation({ opId: "no.such.op", args: {}, consentProvider: provider, ...t });
  assert.equal(bad.reason, "UNKNOWN_OPERATION");

  const nan = await runOperation({
    opId: "item.addComp",
    args: { name: "x", width: NaN, height: 1, pixelAspect: 1, duration: 1, frameRate: 30 },
    consentProvider: provider, ...t,
  });
  assert.equal(nan.reason, "INVALID_ARGS");
  assert.equal(providerCalled, false);
  assert.equal(t.transport.calls.length, 0);
});

test("destructive op metadata surfaces on the outcome; duplicate requestId is refused", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();

  const r1 = await runOperation({ opId: "project.close", args: {}, consentProvider: provider, confirmDestructive: true, requestId: "dup-1", ...t });
  assert.equal(r1.outcome, "COMPLETED");
  assert.equal(r1.destructive, true);

  const r2 = await runOperation({ opId: "project.new", args: {}, consentProvider: provider, confirmDestructive: true, requestId: "dup-1", ...t });
  assert.equal(r2.outcome, "BLOCKED");
  assert.equal(r2.refusal?.code, "DUPLICATE_REQUEST");
  assert.equal(t.transport.calls.length, 1);
});

test("host-side failure surfaces hostReported diagnostics through the runner", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  // No project.new first: item.addComp resolves items on an empty fake —
  // fake still has items collection; instead remove a nonexistent item.
  const r = await runOperation({
    opId: "item.remove", args: { name: "Ghost", type: "CompItem" },
    consentProvider: approvingProvider(), confirmDestructive: true, ...t,
  });
  assert.notEqual(r.outcome, "COMPLETED");
  assert.equal(t.transport.calls.length, 1);
});

test("destructive ops require confirmDestructive in addition to consent", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const r = await runOperation({ opId: "project.close", args: {}, consentProvider: provider, ...t });
  assert.equal(r.reason, "DESTRUCTIVE_CONFIRMATION_REQUIRED");
  assert.equal(t.transport.calls.length, 0);
  const ok = await runOperation({ opId: "project.close", args: {}, consentProvider: provider, confirmDestructive: true, ...t });
  assert.equal(ok.outcome, "COMPLETED");
});

test("every registered op dispatches through the runner end-to-end", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const VALUE = {
    name: "N", compName: "C", layerName: "Null 1", parentName: "Null 1",
    type: "CompItem", to: "top", path: "/tmp/x.aep",
    width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30, x: 0, y: 0,
  };
  const { OPERATIONS } = await import("../registry.mjs");
  // project.new resets state — run it first, then the rest in order.
  const ordered = [...OPERATIONS].sort((a, b) => (a.id === "project.new" ? -1 : b.id === "project.new" ? 1 : 0));
  for (const op of ordered) {
    if (op.id === "project.open" || op.id === "project.close") continue; // lifecycle resets; covered elsewhere
    const args = {};
    for (const a of op.args) args[a] = VALUE[a];
    if (op.id === "item.addComp") args.name = "C";
    if (op.id === "item.addFolder") args.name = "F";
    if (op.id === "item.remove") { args.name = "F"; args.type = "FolderItem"; }
    if (["comp.addNullLayer","layer.setTransformPosition","layer.reorder","layer.setParent","layer.duplicate"].includes(op.id)) args.compName = "C";
    const r = await runOperation({ opId: op.id, args, consentProvider: provider,
      confirmDestructive: true, ...t });
    assert.equal(r.outcome, "COMPLETED", `${op.id}: ${JSON.stringify(r).slice(0, 200)}`);
  }
});
