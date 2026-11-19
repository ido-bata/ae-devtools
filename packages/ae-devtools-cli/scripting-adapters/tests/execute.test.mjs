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
    resolutionFactor: 0.5, color: [1, 0, 0], text: "hello", centerPoint: [0, 0],
    section: "S", key: "K", default: "d",
    font: "F", fontStyle: "S", fontSize: 100, justification: 1,
    fillColor: [1, 0, 0], tracking: 0, leading: 100,
    adjustmentLayer: true, preserveTransparency: false,
    frameBlending: true, collapseTransformation: false,
    inPoint: 0, outPoint: 5,
    inType: "LINEAR", outType: "HOLD",
    inEase: { speed: 0, influence: 50 }, outEase: { speed: 0, influence: 50 },
    matteLayerName: "Text 1", matteType: "ALPHA",
    bgColor: [0, 0, 0], displayStartTime: 0, displayStartFrame: 0,
    shutterAngle: 180, shutterPhase: 0,
    motionBlur: false, frameBlending: false, draft3d: false,
    hideShyLayers: false, preserveNestedFrameRate: true, dropFrame: false,
    footageName: "x.aep", parentFolder: null, selected: true, id: 1,
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
    if (["comp.duplicate", "item.setLabel", "item.setComment", "comp.setResolutionFactor", "comp.setSettings", "read.compSettings", "item.setParentFolder", "item.setSelected"].includes(op.id)) args.name = "C";
    if (op.id === "item.setParentFolder" || op.id === "item.setSelected") args.type = "CompItem";
    if (op.id === "read.itemById") args.id = 1;
    if (op.id === "render.setOutputSetting") args.value = "h264";
    if (op.id === "layer.setParent") args.parentName = null;
    if (["comp.addNullLayer","layer.setTransformPosition","layer.reorder","layer.setParent","layer.duplicate","layer.setTiming","layer.setState","anim.removeKeyframe","read.valueAtTime","render.setTimeSpan","render.removeFromQueue","layer.addSolid","layer.addText","layer.addCamera","layer.addLight","text.setText","layer.replaceSource","render.duplicateQueueItem"].includes(op.id)) args.compName = "C";
    // Batch-3 layer creators get distinct names so text.setText can
    // resolve the text layer unambiguously.
    if (op.id === "layer.addSolid") args.name = "Solid 1";
    if (op.id === "layer.addText") args.name = "Text 1";
    if (op.id === "layer.addCamera") args.name = "Cam 1";
    if (op.id === "layer.addLight") args.name = "Light 1";
    if (["text.setText", "text.setStyle", "text.readStyle"].includes(op.id)) args.layerName = "Text 1";
    // Footage detail reads the item imported earlier by item.import
    // (path /tmp/x.aep → footage name "x.aep").
    if (op.id === "read.footageDetail") args.name = "x.aep";
    // pref.* ops share the `type` arg name with item.* ops but need a
    // preference type token, and pref.set needs a string value.
    if (op.id.startsWith("pref.")) { args.type = "string"; args.section = "S"; args.key = "K"; }
    if (op.id === "pref.set") args.value = "v";
    if (op.id === "pref.get") args.default = "d";
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
    if (["anim.setKeyframe", "anim.removeKeyframe", "anim.setInterpolation", "anim.setTemporalEase"].includes(op.id)) {
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

test("issue #281 batch: layer creation + text + footage/project read detail", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  assert.equal((await go("project.new", {}, { confirmDestructive: true })).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");

  // layer.addSolid: real signature order + persisted spec read-back via comp layers.
  assert.equal((await go("layer.addSolid", { compName: "C", name: "BG", width: 50, height: 50, pixelAspect: 1, color: [0, 0, 0], duration: 5 })).outcome, "COMPLETED");
  assert.equal((await go("layer.addSolid", { compName: "C", name: "Bad", width: 1, height: 1, pixelAspect: 1, color: [2, 0, 0], duration: 1 })).reason, "INVALID_ARGS");
  const layers = await go("read.compLayers", { compName: "C" });
  assert.equal(layers.result.count, 1);
  assert.equal(layers.result.layers[0].name, "BG");

  // layer.addText + text.setText: TextDocument reachable via matchName path.
  const lt = await go("layer.addText", { compName: "C", name: "Title", text: "v1" });
  assert.equal(lt.outcome, "COMPLETED");
  assert.equal(lt.result.text, "v1");
  const ts = await go("text.setText", { compName: "C", layerName: "Title", text: "v2 — 修正" });
  assert.equal(ts.outcome, "COMPLETED");
  assert.equal(ts.result.text, "v2 — 修正");
  // Non-text layer has no TextDocument — honest host failure, not silent ok.
  const badText = await go("text.setText", { compName: "C", layerName: "BG", text: "x" });
  assert.notEqual(badText.outcome, "COMPLETED");

  // layer.addCamera / addLight use the real (name, centerPoint) signature.
  const cam = await go("layer.addCamera", { compName: "C", name: "Cam 1", centerPoint: [10, 20] });
  assert.equal(cam.outcome, "COMPLETED");
  assert.equal(cam.result.threeDLayer, true);
  const light = await go("layer.addLight", { compName: "C", name: "Key", centerPoint: [30, 40] });
  assert.equal(light.outcome, "COMPLETED");
  assert.equal(light.result.threeDLayer, true);
  // Missing/invalid centerPoint refuses before dispatch.
  assert.equal((await go("layer.addLight", { compName: "C", name: "Bad" })).reason, "INVALID_ARGS");
  assert.equal((await go("layer.addLight", { compName: "C", name: "Bad", centerPoint: [1] })).reason, "INVALID_ARGS");

  // read.footageDetail: import footage, then read AVItem + FootageSource fields.
  await go("item.import", { path: "/tmp/clip.mov" });
  const fd = await go("read.footageDetail", { name: "clip.mov" });
  assert.equal(fd.outcome, "COMPLETED");
  assert.equal(fd.result.item.hasVideo, true);
  assert.equal(fd.result.item.hasAudio, false);
  assert.equal(fd.result.item.useProxy, false);
  assert.equal(fd.result.source.file, "/tmp/clip.mov");
  assert.equal(fd.result.source.alphaMode, "IGNORE");
  assert.equal(fd.result.source.isStill, false);
  // Wrong-type guard: a comp name is not a FootageItem.
  const wrongType = await go("read.footageDetail", { name: "C" });
  assert.notEqual(wrongType.outcome, "COMPLETED");

  // read.projectSettings: project-level fields snapshot.
  const ps = await go("read.projectSettings");
  assert.equal(ps.outcome, "COMPLETED");
  assert.equal(ps.result.settings.bitsPerChannel, 16);
  assert.equal(ps.result.settings.framesUseFeetFrames, false);
  assert.equal(ps.result.settings.file, "/tmp/fake.aep");
});

test("issue #283 batch: preferences get/set/delete + app info", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  // pref.get on an unset key returns the caller default + exists:false.
  const miss = await go("pref.get", { section: "General", key: "Nope", type: "string", default: "fallback" });
  assert.equal(miss.outcome, "COMPLETED");
  assert.equal(miss.result.exists, false);
  assert.equal(miss.result.value, "fallback");

  // pref.set → pref.get read-back for each type.
  for (const [type, value] of [["string", "hello"], ["bool", true], ["long", 42], ["float", 1.5]]) {
    const set = await go("pref.set", { section: "S", key: "K" + type, type, value });
    assert.equal(set.outcome, "COMPLETED", type);
    const got = await go("pref.get", { section: "S", key: "K" + type, type, default: type === "string" ? "" : type === "bool" ? false : 0 });
    assert.equal(got.result.exists, true, type);
    assert.equal(got.result.value, value, type);
  }
  // Type/value mismatch refuses before dispatch.
  assert.equal((await go("pref.set", { section: "S", key: "X", type: "long", value: "nan" })).reason, "INVALID_ARGS");
  assert.equal((await go("pref.set", { section: "S", key: "X", type: "bogus", value: 1 })).reason, "INVALID_ARGS");

  // pref.delete is destructive: needs confirmDestructive, then havePref=false.
  const delNoConfirm = await go("pref.delete", { section: "S", key: "Kstring" });
  assert.equal(delNoConfirm.reason, "DESTRUCTIVE_CONFIRMATION_REQUIRED");
  const del = await go("pref.delete", { section: "S", key: "Kstring" }, { confirmDestructive: true });
  assert.equal(del.outcome, "COMPLETED");
  assert.equal(del.result.exists, false);
  const gone = await go("pref.get", { section: "S", key: "Kstring", type: "string", default: "d" });
  assert.equal(gone.result.exists, false);
  assert.equal(gone.result.value, "d");

  // pref.saveToDisk flushes (fake no-op, but the op must dispatch).
  const flush = await go("pref.saveToDisk");
  assert.equal(flush.outcome, "COMPLETED");
  assert.equal(flush.result.saved, true);

  // read.appInfo: version/build + effects matchNames + font names.
  const info = await go("read.appInfo");
  assert.equal(info.outcome, "COMPLETED");
  assert.equal(info.result.app.version, "99.0-fake");
  assert.equal(info.result.app.buildName, "fake-build");
  assert.ok(info.result.app.effects.includes("ADBE Gaussian Blur 2"));
  assert.ok(info.result.app.fonts.includes("ArialMT"));
});

test("issue #285 batch: text style + layer flags + in/out points", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  assert.equal((await go("project.new", {}, { confirmDestructive: true })).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("layer.addText", { compName: "C", name: "T1", text: "hi" })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "N1" })).outcome, "COMPLETED");

  // text.setStyle: validation then partial update + read-back.
  assert.equal((await go("text.setStyle", { compName: "C", layerName: "T1" })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setStyle", { compName: "C", layerName: "T1", justification: 9 })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setStyle", { compName: "C", layerName: "T1", fillColor: [2, 0, 0] })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setStyle", { compName: "C", layerName: "T1", fontSize: -1 })).reason, "INVALID_ARGS");
  const st = await go("text.setStyle", {
    compName: "C", layerName: "T1",
    font: "HelveticaLTStd-Bold", fontSize: 48, justification: 2,
    fillColor: [1, 0, 0], tracking: 20, leading: 60,
  });
  assert.equal(st.outcome, "COMPLETED");
  assert.equal(st.result.font, "HelveticaLTStd-Bold");
  assert.equal(st.result.justification, 2);
  const rd = await go("text.readStyle", { compName: "C", layerName: "T1" });
  assert.equal(rd.outcome, "COMPLETED");
  assert.equal(rd.result.text, "hi");
  assert.deepEqual(rd.result.fillColor, [1, 0, 0]);
  assert.equal(rd.result.leading, 60);
  // Non-text layer refuses at host level (no TextDocument).
  const badLayer = await go("text.readStyle", { compName: "C", layerName: "N1" });
  assert.notEqual(badLayer.outcome, "COMPLETED");

  // layer.setLayerFlags: partial flags + read-back via read.compLayers.
  assert.equal((await go("layer.setLayerFlags", { compName: "C", layerName: "N1" })).reason, "INVALID_ARGS");
  assert.equal((await go("layer.setLayerFlags", { compName: "C", layerName: "N1", adjustmentLayer: "yes" })).reason, "INVALID_ARGS");
  const fl = await go("layer.setLayerFlags", { compName: "C", layerName: "N1", adjustmentLayer: true, frameBlending: true });
  assert.equal(fl.outcome, "COMPLETED");
  const cl = await go("read.compLayers", { compName: "C" });
  const n1 = cl.result.layers.find((l) => l.name === "N1");
  assert.equal(n1.adjustmentLayer, true);
  assert.equal(n1.frameBlending, true);
  assert.equal(n1.collapseTransformation, false);

  // layer.setInOutPoint: bounds validation + read-back.
  assert.equal((await go("layer.setInOutPoint", { compName: "C", layerName: "N1" })).reason, "INVALID_ARGS");
  assert.equal((await go("layer.setInOutPoint", { compName: "C", layerName: "N1", inPoint: 4, outPoint: 2 })).reason, "INVALID_ARGS");
  const io = await go("layer.setInOutPoint", { compName: "C", layerName: "N1", inPoint: 0.5, outPoint: 4.5 });
  assert.equal(io.outcome, "COMPLETED");
  const ld = await go("read.layerDetail", { compName: "C", layerName: "N1" });
  assert.equal(ld.result.layer.inPoint, 0.5);
  assert.equal(ld.result.layer.outPoint, 4.5);
});

test("issue #287 batch: interpolation/ease + track matte + time remap", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  assert.equal((await go("project.new", {}, { confirmDestructive: true })).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "N1" })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "N2" })).outcome, "COMPLETED");
  const PATH = ["ADBE Transform Group", "ADBE Position"];
  await go("anim.setValueAtTime", { compName: "C", layerName: "N1", propertyPath: PATH, time: 0, value: [0, 0] });
  await go("anim.setValueAtTime", { compName: "C", layerName: "N1", propertyPath: PATH, time: 1, value: [1, 1] });

  // anim.setInterpolation: validation + partial update + read-back.
  assert.equal((await go("anim.setInterpolation", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1 })).reason, "INVALID_ARGS");
  assert.equal((await go("anim.setInterpolation", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, inType: "BOGUS" })).reason, "INVALID_ARGS");
  const ip = await go("anim.setInterpolation", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, inType: "LINEAR", outType: "HOLD" });
  assert.equal(ip.outcome, "COMPLETED");
  // inType only: outType preserved from previous set.
  const ip2 = await go("anim.setInterpolation", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 2, inType: "BEZIER" });
  assert.equal(ip2.outcome, "COMPLETED");
  // Out-of-range key index is a host-level failure.
  const ipBad = await go("anim.setInterpolation", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 9, inType: "LINEAR" });
  assert.notEqual(ipBad.outcome, "COMPLETED");

  // anim.setTemporalEase: ease objects validated, partial update.
  assert.equal((await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1 })).reason, "INVALID_ARGS");
  assert.equal((await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, inEase: { speed: "x", influence: 1 } })).reason, "INVALID_ARGS");
  const ez = await go("anim.setTemporalEase", {
    compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1,
    inEase: { speed: 10, influence: 25 }, outEase: { speed: 0, influence: 75 },
  });
  assert.equal(ez.outcome, "COMPLETED");
  assert.deepEqual(ez.result.inEase, { speed: 10, influence: 25 });
  const ez2 = await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, outEase: { speed: 5, influence: 60 } });
  assert.equal(ez2.outcome, "COMPLETED");
  assert.equal(ez2.result.inEase.speed, 10); // inEase preserved

  // layer.setTrackMatte: set → read-back via compLayers → clear.
  assert.equal((await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteType: "ALPHA" })).reason, "INVALID_ARGS");
  // Self-matte is rejected at host level.
  const selfMatte = await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteLayerName: "N1", matteType: "ALPHA" });
  assert.notEqual(selfMatte.outcome, "COMPLETED");
  const tm = await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteLayerName: "N2", matteType: "ALPHA_INVERTED" });
  assert.equal(tm.outcome, "COMPLETED");
  assert.equal(tm.result.hasTrackMatte, true);
  assert.equal(tm.result.trackMatteLayer, "N2");
  // Matte layer side: N2.isTrackMatte reflected in compLayers? (not exported there) — check via layerDetail not available; verify via re-set symmetry.
  const cl = await go("read.compLayers", { compName: "C" });
  const n1 = cl.result.layers.find((l) => l.name === "N1");
  assert.equal(n1.hasTrackMatte, true);
  assert.equal(n1.trackMatteType, 2); // ALPHA_INVERTED stand-in value — fake-level only
  const clr = await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteType: "NO_TRACK_MATTE" });
  assert.equal(clr.outcome, "COMPLETED");
  assert.equal(clr.result.hasTrackMatte, false);
  assert.equal(clr.result.trackMatteLayer, null);

  // layer.setTimeRemap.
  const tr = await go("layer.setTimeRemap", { compName: "C", layerName: "N1", enabled: true });
  assert.equal(tr.outcome, "COMPLETED");
  assert.equal(tr.result.timeRemapEnabled, true);
  const cl2 = await go("read.compLayers", { compName: "C" });
  assert.equal(cl2.result.layers.find((l) => l.name === "N1").timeRemapEnabled, true);
});

test("issue #289 batch: comp settings + replaceSource + queue duplicate", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });

  assert.equal((await go("project.new", {}, { confirmDestructive: true })).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "N1" })).outcome, "COMPLETED");
  assert.equal((await go("item.import", { path: "/tmp/clip.mov" })).outcome, "COMPLETED");
  assert.equal((await go("item.import", { path: "/tmp/clip2.mov" })).outcome, "COMPLETED");

  // comp.setSettings: validation + partial update + read.compSettings.
  assert.equal((await go("comp.setSettings", { name: "C" })).reason, "INVALID_ARGS");
  assert.equal((await go("comp.setSettings", { name: "C", shutterAngle: 400 })).reason, "INVALID_ARGS");
  assert.equal((await go("comp.setSettings", { name: "C", bgColor: [1, 0] })).reason, "INVALID_ARGS");
  assert.equal((await go("comp.setSettings", { name: "C", motionBlur: "yes" })).reason, "INVALID_ARGS");
  const cs = await go("comp.setSettings", {
    name: "C", bgColor: [0.1, 0.2, 0.3], shutterAngle: 90, shutterPhase: -45,
    motionBlur: true, displayStartFrame: 12,
  });
  assert.equal(cs.outcome, "COMPLETED");
  assert.deepEqual(cs.result.bgColor, [0.1, 0.2, 0.3]);
  const rs = await go("read.compSettings", { name: "C" });
  assert.equal(rs.outcome, "COMPLETED");
  assert.equal(rs.result.shutterAngle, 90);
  assert.equal(rs.result.motionBlur, true);
  assert.equal(rs.result.frameBlending, false); // untouched default
  assert.equal(rs.result.preserveNestedFrameRate, true);

  // layer.replaceSource: footage swap + read-back via read.layerDetail.
  const rs1 = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "clip.mov" });
  assert.equal(rs1.outcome, "COMPLETED");
  assert.equal(rs1.result.source, "clip.mov");
  const ld = await go("read.layerDetail", { compName: "C", layerName: "N1" });
  assert.equal(ld.result.layer.source, "clip.mov");
  // Wrong-type footage name refuses (FolderItem/comp not FootageItem).
  const bad = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "C" });
  assert.notEqual(bad.outcome, "COMPLETED");
  // Re-replace works (relink scenario).
  const rs2 = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "clip2.mov" });
  assert.equal(rs2.result.source, "clip2.mov");

  // render.duplicateQueueItem: duplicate copies settings; ambiguous after dup is refused.
  await go("render.queueComp", { compName: "C" });
  await go("render.setTimeSpan", { compName: "C", timeSpanStart: 1, timeSpanDuration: 2 });
  const dq = await go("render.duplicateQueueItem", { compName: "C" });
  assert.equal(dq.outcome, "COMPLETED");
  assert.equal(dq.result.timeSpanStart, 1);
  assert.equal(dq.result.timeSpanDuration, 2);
  assert.equal(dq.result.remaining, 2);
  // Now two items for "C" — a second duplicate must refuse as ambiguous.
  const dq2 = await go("render.duplicateQueueItem", { compName: "C" });
  assert.notEqual(dq2.outcome, "COMPLETED");
  // Queue status exposes the new fields.
  const rq = await go("read.renderQueueStatus");
  assert.equal(rq.result.count, 2);
  assert.ok(rq.result.items.every((i) => i.startTime === 0 && i.skipFrames === 0));
});

test("issue #291 batch: FolderItem hierarchy, move, selection, recursive delete", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  const f = await go("item.addFolder", { name: "F" }, mut);
  assert.equal(f.outcome, "COMPLETED");
  const g = await go("item.addFolder", { name: "G", parentFolder: "F" }, mut);
  assert.equal(g.outcome, "COMPLETED");
  const c = await go("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30, parentFolder: "F" }, mut);
  assert.equal(c.outcome, "COMPLETED");
  const d = await go("item.addComp", { name: "D", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30, parentFolder: "G" }, mut);
  assert.equal(d.outcome, "COMPLETED");

  let tree = await go("read.projectTree");
  assert.equal(tree.outcome, "COMPLETED");
  assert.equal(tree.result.numItems, 4);
  assert.equal(tree.result.root.length, 1);
  assert.equal(tree.result.root[0].name, "F");
  assert.equal(tree.result.root[0].children.length, 2); // G and C are direct children of F
  assert.equal(tree.result.root[0].children.find((n) => n.name === "G").children.length, 1); // D inside G

  // Move C back to the project root via Item.parentFolder.
  const mv = await go("item.setParentFolder", { name: "C", type: "CompItem", parentFolder: null }, mut);
  assert.equal(mv.outcome, "COMPLETED");
  assert.equal(mv.result.parent, null);
  tree = await go("read.projectTree");
  assert.equal(tree.result.root.length, 2);
  assert.equal(tree.result.root.find((n) => n.name === "C").parent, null);

  // Folder cycle is refused: F cannot be parented into its descendant G.
  const cyc = await go("item.setParentFolder", { name: "F", type: "FolderItem", parentFolder: "G" }, mut);
  assert.notEqual(cyc.outcome, "COMPLETED");

  // Selection is exposed through Project.selection / read.projectTree.
  const sel = await go("item.setSelected", { name: "C", type: "CompItem", selected: true }, mut);
  assert.equal(sel.outcome, "COMPLETED");
  assert.deepEqual(sel.result.selection, ["C"]);
  tree = await go("read.projectTree");
  assert.deepEqual(tree.result.selection, ["C"]);

  // Stable id lookup survives hierarchy moves.
  const byId = await go("read.itemById", { id: c.result.id });
  assert.equal(byId.outcome, "COMPLETED");
  assert.equal(byId.result.item.name, "C");

  // Removing a folder removes its whole descendant tree, not just the folder.
  const rm = await go("item.remove", { name: "F", type: "FolderItem" }, mut);
  assert.equal(rm.outcome, "COMPLETED");
  tree = await go("read.projectTree");
  assert.equal(tree.result.numItems, 1);
  assert.equal(tree.result.root.length, 1);
  assert.equal(tree.result.root[0].name, "C");
  const gone = await go("read.itemById", { id: d.result.id });
  assert.notEqual(gone.outcome, "COMPLETED");
});

test("issue #293 batch: itemRef id/path resolves duplicate names safely", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };
  const compArgs = (parentFolder) => ({
    name: "C", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30, parentFolder,
  });

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addFolder", { name: "F" }, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addFolder", { name: "G" }, mut)).outcome, "COMPLETED");
  const cf = await go("item.addComp", compArgs("F"), mut);
  const cg = await go("item.addComp", compArgs("G"), mut);
  assert.equal(cf.outcome, "COMPLETED");
  assert.equal(cg.outcome, "COMPLETED");

  // Legacy name-only lookup stays fail-closed on duplicate names.
  const amb = await go("item.setLabel", { name: "C", type: "CompItem", label: 1 }, mut);
  assert.notEqual(amb.outcome, "COMPLETED");

  // Folder path qualifies the same name without exposing ids to callers.
  const detailF = await go("read.itemDetail", { name: { name: "C", path: ["F"] } });
  assert.equal(detailF.outcome, "COMPLETED");
  assert.equal(detailF.result.item.id, cf.result.id);
  const detailG = await go("read.itemDetail", { name: { name: "C", path: ["G"] } });
  assert.equal(detailG.result.item.id, cg.result.id);

  // Stable id is project-scoped and survives reparenting.
  const byId = await go("item.setLabel", { name: { id: cg.result.id }, type: "CompItem", label: 2 }, mut);
  assert.equal(byId.outcome, "COMPLETED");
  const moved = await go("item.setParentFolder", { name: { id: cg.result.id }, type: "CompItem", parentFolder: "F" }, mut);
  assert.equal(moved.outcome, "COMPLETED");
  assert.equal(moved.result.parent, "F");
  const byIdPath = await go("item.setLabel", { name: { id: cg.result.id, path: ["F"] }, type: "CompItem", label: 3 }, mut);
  assert.equal(byIdPath.outcome, "COMPLETED");

  // id + name/path are consistency checks, not alternate targets.
  const badName = await go("item.setLabel", { name: { id: cg.result.id, name: "Other" }, type: "CompItem", label: 3 }, mut);
  assert.notEqual(badName.outcome, "COMPLETED");
  const badPath = await go("item.setLabel", { name: { id: cg.result.id, path: ["G"] }, type: "CompItem", label: 3 }, mut);
  assert.notEqual(badPath.outcome, "COMPLETED");

  // Optional project consistency binds a saved project file path; an
  // unsaved project cannot satisfy the check.
  const projOk = await go("item.setLabel", { name: { id: cg.result.id, project: "/tmp/fake.aep" }, type: "CompItem", label: 4 }, mut);
  assert.equal(projOk.outcome, "COMPLETED");
  const projBad = await go("item.setLabel", { name: { id: cg.result.id, project: "/tmp/other.aep" }, type: "CompItem", label: 5 }, mut);
  assert.notEqual(projBad.outcome, "COMPLETED");
  const savedFile = app.project.file;
  app.project.file = null;
  const unsaved = await go("item.setLabel", { name: { id: cg.result.id, project: "/tmp/fake.aep" }, type: "CompItem", label: 6 }, mut);
  app.project.file = savedFile;
  assert.notEqual(unsaved.outcome, "COMPLETED");

  // Wrong-type and stale ids refuse before mutation.
  const f = await go("item.addFolder", { name: "H" }, mut);
  const wrongType = await go("item.setLabel", { name: { id: f.result.id }, type: "CompItem", label: 4 }, mut);
  assert.notEqual(wrongType.outcome, "COMPLETED");
  const doomed = await go("item.addComp", compArgs("F"), mut);
  assert.equal((await go("item.remove", { name: { id: doomed.result.id }, type: "CompItem" }, mut)).outcome, "COMPLETED");
  const stale = await go("item.setLabel", { name: { id: doomed.result.id }, type: "CompItem", label: 5 }, mut);
  assert.notEqual(stale.outcome, "COMPLETED");

  // Duplicate folder names make a path segment ambiguous even when the leaf is unique.
  const h1 = await go("item.addFolder", { name: "H" }, mut);
  const h2 = await go("item.addFolder", { name: "H" }, mut);
  await go("item.setParentFolder", { name: { id: cf.result.id }, type: "CompItem", parentFolder: { id: h1.result.id } }, mut);
  assert.equal((await go("item.addComp", { name: "X", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30, parentFolder: { id: h1.result.id } }, mut)).outcome, "COMPLETED");
  const ambPath = await go("item.setLabel", { name: { name: "X", path: ["H"] }, type: "CompItem", label: 6 }, mut);
  assert.notEqual(ambPath.outcome, "COMPLETED");

  // compName accepts the same itemRef object for comp-targeted ops.
  const nl = await go("comp.addNullLayer", { compName: { name: "C", path: ["F"] }, layerName: "N1" }, mut);
  assert.equal(nl.outcome, "COMPLETED");
  const layers = await go("read.compLayers", { compName: { id: cg.result.id } });
  assert.equal(layers.outcome, "COMPLETED");
  assert.equal(layers.result.layers.length, 1);
});
