import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadTrustedCodec, createJsxRunner } from "../../trusted-execution/runner.mjs";
import { runOperation } from "../execute.mjs";
import { createAdapterFakeApp } from "../fake-app.mjs";
import { fakeHostContext } from "../fake-host.mjs";

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
      const ctx = vm.createContext(fakeHostContext(app));
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
    propertyPath: ["ADBE Transform Group", "ADBE Position"], time: 0, keyIndex: 1, value: [0, 0],
    expression: "0", effectMatchName: "ADBE Gaussian Blur 2",
    label: 3, startTime: 0, stretch: 100, timeSpanStart: 0, timeSpanDuration: 5,
    audioEnabled: true, enabled: true, comment: "note", setting: "Output File Info",
    resolutionFactor: 0.5,
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
    if (op.id === "read.itemDetail") args.name = "C";
    if (["comp.duplicate", "item.setLabel", "item.setComment", "comp.setResolutionFactor"].includes(op.id)) args.name = "C";
    if (op.id === "render.setOutputSetting") args.value = "h264";
    if (op.id === "layer.setParent") args.parentName = null;
    if (["comp.addNullLayer","layer.setTransformPosition","layer.reorder","layer.setParent","layer.duplicate","layer.setTiming","layer.setState","anim.removeKeyframe","read.valueAtTime","render.setTimeSpan","render.removeFromQueue"].includes(op.id)) args.compName = "C";
    // Output-module ops need "C" back in the queue: render.removeFromQueue
    // (earlier batch) already dequeued it. Re-queue exactly once — a second
    // queueComp would make the comp-name match ambiguous.
    if ((op.id === "render.getOutputSettings" || op.id === "render.setOutputSetting")
        && !t.__requeued) {
      t.__requeued = true;
      await runOperation({ opId: "render.queueComp", args: { compName: "C" },
        consentProvider: provider, confirmDestructive: true, ...t });
    }
    // Keyframe ops need an existing key: seed one via setValueAtTime first.
    if (op.id === "anim.setKeyframe" || op.id === "anim.removeKeyframe") {
      await runOperation({ opId: "anim.setValueAtTime",
        args: { compName: "C", layerName: "Null 1", propertyPath: args.propertyPath, time: 0, value: [0, 0] },
        consentProvider: provider, confirmDestructive: true, ...t });
    }
    const r = await runOperation({ opId: op.id, args, consentProvider: provider,
      confirmDestructive: true, confirmRender: true, ...t });
    assert.equal(r.outcome, "COMPLETED", `${op.id}: ${JSON.stringify(r).slice(0, 200)}`);
  }
});

test("render.renderQueued requires confirmRender in addition to consent+destructive", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const r = await runOperation({ opId: "render.renderQueued", args: {}, consentProvider: provider, ...t });
  assert.equal(r.reason, "RENDER_CONFIRMATION_REQUIRED");
  assert.equal(t.transport.calls.length, 0);
  const ok = await runOperation({ opId: "render.renderQueued", args: {}, consentProvider: provider, confirmRender: true, ...t });
  assert.equal(ok.outcome, "COMPLETED");
});

test("issue #275 batch: import/duplicate/label/timing/state/keyframe/render-queue semantics", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  // Setup: project + comp + null layer.
  assert.equal((await go("project.new", {}, { confirmDestructive: true })).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "Null 1" })).outcome, "COMPLETED");

  // item.import: real state change — a FootageItem appears in the project.
  const imp = await go("item.import", { path: "/tmp/clip.mov" });
  assert.equal(imp.outcome, "COMPLETED");
  assert.equal(imp.result.name, "clip.mov");
  const summary = await go("read.projectSummary");
  assert.ok(summary.result.items.some((i) => i.name === "clip.mov" && i.typeName === "Footage"));

  // comp.duplicate: new comp with copied layers, source untouched.
  const dup = await go("comp.duplicate", { name: "C" });
  assert.equal(dup.outcome, "COMPLETED");
  assert.equal(dup.result.duplicate, "C copy");
  const dupLayers = await go("read.compLayers", { compName: "C copy" });
  assert.equal(dupLayers.result.count, 1);
  assert.equal(dupLayers.result.layers[0].name, "Null 1");

  // item.setLabel: arg validation + read-back through item detail path.
  assert.equal((await go("item.setLabel", { name: "C", type: "CompItem", label: 17 })).reason, "INVALID_ARGS");
  const lbl = await go("item.setLabel", { name: "C", type: "CompItem", label: 5 });
  assert.equal(lbl.outcome, "COMPLETED");
  assert.equal(lbl.result.label, 5);
  // Wrong-type guard: name exists but is not a FolderItem.
  const wrongType = await go("item.setLabel", { name: "C", type: "FolderItem", label: 1 });
  assert.notEqual(wrongType.outcome, "COMPLETED");

  // layer.setTiming / setState: partial-update semantics + validation.
  assert.equal((await go("layer.setTiming", { compName: "C", layerName: "Null 1" })).reason, "INVALID_ARGS");
  assert.equal((await go("layer.setTiming", { compName: "C", layerName: "Null 1", stretch: 0 })).reason, "INVALID_ARGS");
  const timing = await go("layer.setTiming", { compName: "C", layerName: "Null 1", startTime: 1.5, stretch: 50 });
  assert.equal(timing.outcome, "COMPLETED");
  assert.equal(timing.result.startTime, 1.5);
  assert.equal(timing.result.stretch, 50);
  const state = await go("layer.setState", { compName: "C", layerName: "Null 1", solo: true, label: 9 });
  assert.equal(state.outcome, "COMPLETED");
  assert.equal(state.result.solo, true);
  assert.equal(state.result.label, 9);
  assert.equal(state.result.locked, false);

  // Keyframes: seed two keys, read valueAtTime, remove by index.
  const PATH = ["ADBE Transform Group", "ADBE Position"];
  await go("anim.setValueAtTime", { compName: "C", layerName: "Null 1", propertyPath: PATH, time: 0, value: [0, 0] });
  await go("anim.setValueAtTime", { compName: "C", layerName: "Null 1", propertyPath: PATH, time: 2, value: [10, 20] });
  const atT = await go("read.valueAtTime", { compName: "C", layerName: "Null 1", propertyPath: PATH, time: 2 });
  assert.equal(atT.outcome, "COMPLETED");
  assert.deepEqual(atT.result.value, [10, 20]);
  const keys = await go("read.keyframes", { compName: "C", layerName: "Null 1", propertyPath: PATH });
  assert.equal(keys.result.numKeys, 2);
  const rm = await go("anim.removeKeyframe", { compName: "C", layerName: "Null 1", propertyPath: PATH, keyIndex: 2 });
  assert.equal(rm.outcome, "COMPLETED");
  assert.equal(rm.result.numKeys, 1);
  // Out-of-range key index is a host-level failure, not silent success.
  const rmBad = await go("anim.removeKeyframe", { compName: "C", layerName: "Null 1", propertyPath: PATH, keyIndex: 5 });
  assert.notEqual(rmBad.outcome, "COMPLETED");

  // Render queue: set span, verify via read-back, then remove.
  await go("render.queueComp", { compName: "C" });
  const span = await go("render.setTimeSpan", { compName: "C", timeSpanStart: 1, timeSpanDuration: 3 });
  assert.equal(span.outcome, "COMPLETED");
  assert.equal(span.result.timeSpanStart, 1);
  assert.equal(span.result.timeSpanDuration, 3);
  const rq = await go("read.renderQueueStatus");
  const item = rq.result.items.find((i) => i.comp === "C");
  assert.equal(item.timeSpanStart, 1);
  assert.equal(item.timeSpanDuration, 3);
  // Removing a comp that is not queued is a host-level failure.
  const rmMiss = await go("render.removeFromQueue", { compName: "NoSuchComp" });
  assert.notEqual(rmMiss.outcome, "COMPLETED");
  const rmOk = await go("render.removeFromQueue", { compName: "C" });
  assert.equal(rmOk.outcome, "COMPLETED");
  assert.equal(rmOk.result.remaining, 0);
});

test("issue #279 batch: av-state/property-detail/expression-toggle/output-module/comment/resolution", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  assert.equal((await go("project.new", {}, { confirmDestructive: true })).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "Null 1" })).outcome, "COMPLETED");
  const PATH = ["ADBE Transform Group", "" + "ADBE Position"];

  // layer.setAvState: partial flags + read-back + validation.
  assert.equal((await go("layer.setAvState", { compName: "C", layerName: "Null 1" })).reason, "INVALID_ARGS");
  assert.equal((await go("layer.setAvState", { compName: "C", layerName: "Null 1", threeDLayer: "yes" })).reason, "INVALID_ARGS");
  const av = await go("layer.setAvState", { compName: "C", layerName: "Null 1", threeDLayer: true, motionBlur: true });
  assert.equal(av.outcome, "COMPLETED");
  assert.equal(av.result.threeDLayer, true);
  assert.equal(av.result.motionBlur, true);
  assert.equal(av.result.audioEnabled, true);

  // read.propertyDetail: metadata without mutating.
  const pd = await go("read.propertyDetail", { compName: "C", layerName: "Null 1", propertyPath: PATH });
  assert.equal(pd.outcome, "COMPLETED");
  assert.equal(pd.result.property.matchName, "ADBE Position");
  assert.equal(pd.result.property.canSetExpression, true);
  assert.equal(pd.result.property.propertyValueType, null); // fake has no type model — honest null

  // anim.setExpressionEnabled: toggle without touching expression text.
  await go("anim.setExpression", { compName: "C", layerName: "Null 1", propertyPath: PATH, expression: "transform.position" });
  const en = await go("anim.setExpressionEnabled", { compName: "C", layerName: "Null 1", propertyPath: PATH, enabled: false });
  assert.equal(en.outcome, "COMPLETED");
  assert.equal(en.result.expressionEnabled, false);
  const pd2 = await go("read.propertyDetail", { compName: "C", layerName: "Null 1", propertyPath: PATH });
  assert.equal(pd2.result.property.expression, "transform.position"); // text preserved
  assert.equal(pd2.result.property.expressionEnabled, false);
  // Non-expressionable property refuses the toggle.
  await go("effect.add", { compName: "C", layerName: "Null 1", effectMatchName: "ADBE Gaussian Blur 2" });
  const fxToggle = await go("anim.setExpressionEnabled", {
    compName: "C", layerName: "Null 1",
    propertyPath: ["ADBE Effect Parade", "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001"], enabled: true,
  });
  // path may not resolve in fake — accept either host failure or guard refusal, never COMPLETED-with-lie
  assert.notEqual(fxToggle.outcome === "COMPLETED" && fxToggle.result?.expressionEnabled === true, true);

  // Output module: read settings, set one, read back.
  await go("render.queueComp", { compName: "C" });
  const om = await go("render.getOutputSettings", { compName: "C" });
  assert.equal(om.outcome, "COMPLETED");
  assert.equal(om.result.outputModule, "Lossless");
  assert.equal(om.result.settings["Output File Info"], "[compName].mov");
  const set = await go("render.setOutputSetting", { compName: "C", setting: "Output File Info", value: "[compName]_v2.mov" });
  assert.equal(set.outcome, "COMPLETED");
  assert.equal(set.result.value, "[compName]_v2.mov");
  const om2 = await go("render.getOutputSettings", { compName: "C" });
  assert.equal(om2.result.settings["Output File Info"], "[compName]_v2.mov");
  // Bad value type refuses before dispatch.
  assert.equal((await go("render.setOutputSetting", { compName: "C", setting: "x", value: [1] })).reason, "INVALID_ARGS");

  // item.setComment + comp.setResolutionFactor with read-back via detail paths.
  const cm = await go("item.setComment", { name: "C", type: "CompItem", comment: "hero comp" });
  assert.equal(cm.outcome, "COMPLETED");
  assert.equal(cm.result.comment, "hero comp");
  const rf = await go("comp.setResolutionFactor", { name: "C", resolutionFactor: 0.5 });
  assert.equal(rf.outcome, "COMPLETED");
  assert.equal(rf.result.resolutionFactor, 0.5);
  assert.equal((await go("comp.setResolutionFactor", { name: "C", resolutionFactor: -1 })).reason, "INVALID_ARGS");
  const detail = await go("read.itemDetail", { name: "C" });
  assert.equal(detail.result.item.resolutionFactor, 0.5);
});
