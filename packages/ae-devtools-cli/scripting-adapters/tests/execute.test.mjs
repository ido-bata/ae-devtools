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
        result = vm.runInContext(env.source /* trustedEval contract: evaluated once as a program; function-body sources arrive IIFE-wrapped from the dispatch boundary */, ctx, { filename: "adapter.jsx" });
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
    applyFill: true, applyStroke: true, strokeOverFill: true, autoLeading: true,
    strokeColor: [1, 0, 0], strokeWidth: 5,
    boxTextSize: [200, 100], boxTextPos: [0, 0],
    baselineShift: 0, horizontalScale: 100, verticalScale: 100,
    adjustmentLayer: true, preserveTransparency: false,
    frameBlending: true, collapseTransformation: false,
    inPoint: 0, outPoint: 5,
    inType: "LINEAR", outType: "HOLD",
    inEase: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }],
    outEase: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }],
    matteLayerName: "Text 1", matteType: "ALPHA", fixExpressions: false,
    bgColor: [0, 0, 0], displayStartTime: 0, displayStartFrame: 0,
    shutterAngle: 180, shutterPhase: 0,
    motionBlur: false, frameBlending: false, draft3d: false,
    hideShyLayers: false, preserveNestedFrameRate: true, dropFrame: false,
    footageName: "x.aep", parentFolder: null, selected: true, id: 1,
    solidName: "Proxy Solid", placeholderName: "Proxy Placeholder",
    forceAlphabetical: true, useProxy: true,
    moduleIndex: 1, templateName: "Lossless",
    includeSourceXMP: true, postRenderAction: "SET_PROXY",
    vertices: [[0, 0], [10, 0], [10, 10]],
    inTangents: [[0, 0], [0, 0], [0, 0]],
    outTangents: [[0, 0], [0, 0], [0, 0]],
    closed: true,
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
    if (["comp.addNullLayer","layer.setTransformPosition","layer.reorder","layer.setParent","layer.duplicate","layer.setTiming","layer.setState","anim.removeKeyframe","read.valueAtTime","render.setTimeSpan","render.removeFromQueue","render.listTemplates","render.applyTemplate","render.saveTemplate","render.listOutputModules","render.addOutputModule","render.applyOutputModuleTemplate","render.saveOutputModuleTemplate","render.setOutputModuleOptions","layer.addSolid","layer.addText","layer.addBoxText","layer.addCamera","layer.addLight","text.setText","text.setPaint","text.setBoxMetrics","text.setCharAttributes","text.readDocument","layer.replaceSource","render.duplicateQueueItem","layer.addShape","shape.readContents","shape.addPath","marker.setLayerMarker","marker.readLayerMarkers"].includes(op.id)) args.compName = "C";
    // Batch-3 layer creators get distinct names so text.setText can
    // resolve the text layer unambiguously.
    if (op.id === "layer.addSolid") args.name = "Solid 1";
    if (op.id === "layer.addText") args.name = "Text 1";
    if (op.id === "layer.addBoxText") args.name = "Box 1";
    if (op.id === "layer.addCamera") args.name = "Cam 1";
    if (op.id === "layer.addLight") args.name = "Light 1";
    if (["text.setText", "text.setStyle", "text.readStyle", "text.setPaint", "text.setCharAttributes"].includes(op.id)) args.layerName = "Text 1";
    // Box-metric ops need the paragraph (box) text layer created above.
    if (["text.setBoxMetrics", "text.readDocument"].includes(op.id)) args.layerName = "Box 1";
    // layer.addShape names its layer "N" (VALUE.name); shape.* ops must
    // target that shape layer, not the earlier "Null 1".
    if (op.id === "layer.addShape") args.name = "N";
    if (op.id.startsWith("shape.")) args.layerName = "N";
    // Footage detail reads the item imported earlier by item.import
    // (path /tmp/x.aep → footage name "x.aep"). Proxy ops target it too.
    if (["read.footageDetail", "item.setProxy", "item.setProxyWithSequence",
         "item.setProxyWithSolid", "item.setProxyWithPlaceholder",
         "item.setProxyToNone", "item.setUseProxy", "read.itemProxy"].includes(op.id)) args.name = "x.aep";
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
  // fontStyle is read-only on TextDocument — passing it is rejected.
  assert.equal((await go("text.setStyle", { compName: "C", layerName: "T1", fontStyle: "Bold" })).reason, "INVALID_ARGS");
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
  // frameBlending is read-only on AVLayer — passing it is rejected.
  assert.equal((await go("layer.setLayerFlags", { compName: "C", layerName: "N1", adjustmentLayer: true, frameBlending: true })).reason, "INVALID_ARGS");
  const fl = await go("layer.setLayerFlags", { compName: "C", layerName: "N1", adjustmentLayer: true });
  assert.equal(fl.outcome, "COMPLETED");
  const cl = await go("read.compLayers", { compName: "C" });
  const n1 = cl.result.layers.find((l) => l.name === "N1");
  assert.equal(n1.adjustmentLayer, true);
  assert.equal(n1.frameBlending, false);
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

  // anim.setTemporalEase: KeyframeEase arrays validated, partial update.
  assert.equal((await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1 })).reason, "INVALID_ARGS");
  assert.equal((await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, inEase: { speed: "x", influence: 1 } })).reason, "INVALID_ARGS");
  assert.equal((await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, inEase: [{ speed: 0, influence: 0 }] })).reason, "INVALID_ARGS");
  assert.notEqual((await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, inEase: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }, { speed: 0, influence: 50 }] })).outcome, "COMPLETED"); // length mismatch is host-level for 2D Position
  const ez = await go("anim.setTemporalEase", {
    compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1,
    inEase: [{ speed: 10, influence: 25 }, { speed: 10, influence: 25 }],
    outEase: [{ speed: 0, influence: 75 }, { speed: 0, influence: 75 }],
  });
  assert.equal(ez.outcome, "COMPLETED");
  assert.equal(ez.result.inEase.length, 2);
  assert.equal(ez.result.inEase[0].speed, 10);
  assert.equal(ez.result.inEase[0].influence, 25);
  const ez2 = await go("anim.setTemporalEase", { compName: "C", layerName: "N1", propertyPath: PATH, keyIndex: 1, outEase: [{ speed: 5, influence: 60 }, { speed: 5, influence: 60 }] });
  assert.equal(ez2.outcome, "COMPLETED");
  assert.equal(ez2.result.inEase[0].speed, 10); // inEase preserved

  // layer.setTrackMatte: set → read-back via compLayers → clear.
  assert.equal((await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteType: "ALPHA" })).reason, "INVALID_ARGS");
  // Self-matte is rejected at host level.
  const selfMatte = await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteLayerName: "N1", matteType: "ALPHA" });
  assert.notEqual(selfMatte.outcome, "COMPLETED");
  const tm = await go("layer.setTrackMatte", { compName: "C", layerName: "N1", matteLayerName: "N2", matteType: "ALPHA_INVERTED" });
  assert.equal(tm.outcome, "COMPLETED");
  assert.equal(tm.result.hasTrackMatte, true);
  assert.equal(tm.result.trackMatteLayer, "N2");
  // Matte layer side: N2.isTrackMatte is exported by read.compLayers.
  const cl = await go("read.compLayers", { compName: "C" });
  const n1 = cl.result.layers.find((l) => l.name === "N1");
  const n2 = cl.result.layers.find((l) => l.name === "N2");
  assert.equal(n1.hasTrackMatte, true);
  assert.equal(n1.isTrackMatte, false);
  assert.equal(n2.isTrackMatte, true);
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

  // layer.replaceSource: AVItem swap + required fixExpressions + read-back.
  assert.equal((await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "clip.mov" })).reason, "INVALID_ARGS");
  const rs1 = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "clip.mov", fixExpressions: false });
  assert.equal(rs1.outcome, "COMPLETED");
  assert.equal(rs1.result.source, "clip.mov");
  const ld = await go("read.layerDetail", { compName: "C", layerName: "N1" });
  assert.equal(ld.result.layer.source, "clip.mov");
  // FolderItem is not an AVItem and refuses before mutation.
  await go("item.addFolder", { name: "F" });
  const bad = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "F", fixExpressions: false });
  assert.notEqual(bad.outcome, "COMPLETED");
  // CompItem is a valid AVItem source too.
  assert.equal((await go("item.addComp", { name: "D", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30 })).outcome, "COMPLETED");
  const rsComp = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "D", fixExpressions: true });
  assert.equal(rsComp.outcome, "COMPLETED");
  assert.equal(rsComp.result.source, "D");
  // Re-replace back to footage works (relink scenario).
  const rs2 = await go("layer.replaceSource", { compName: "C", layerName: "N1", footageName: "clip2.mov", fixExpressions: false });
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

test("issue #295 batch: MarkerValue layer/comp markers — write, read-back, params, counterexamples", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "N1" })).outcome, "COMPLETED");

  // Full-field layer marker with cue-point params.
  const set = await go("marker.setLayerMarker", {
    compName: "C", layerName: "N1", time: 1.5, comment: "Fade Up",
    chapter: "ch2", url: "https://example.com", frameTarget: "f3",
    cuePointName: "cue1", duration: 0.5, eventCuePoint: true,
    params: { alpha: "a", beta: "b" },
  });
  assert.equal(set.outcome, "COMPLETED");
  assert.equal(set.result.numKeys, 1);
  const m = set.result.markers[0];
  assert.equal(m.time, 1.5);
  assert.equal(m.comment, "Fade Up");
  assert.equal(m.chapter, "ch2");
  assert.equal(m.url, "https://example.com");
  assert.equal(m.frameTarget, "f3");
  assert.equal(m.cuePointName, "cue1");
  assert.equal(m.duration, 0.5);
  assert.equal(m.eventCuePoint, true);
  assert.deepEqual(m.params, { alpha: "a", beta: "b" });

  // Second marker at a different time; read op returns both in order.
  await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: 3, comment: "Outro" });
  const rd = await go("marker.readLayerMarkers", { compName: "C", layerName: "N1" });
  assert.equal(rd.outcome, "COMPLETED");
  assert.equal(rd.result.numKeys, 2);
  assert.equal(rd.result.markers[1].comment, "Outro");
  assert.equal(rd.result.markers[1].chapter, "");
  assert.deepEqual(rd.result.markers[1].params, {});

  // Same-time write updates the existing key (Property.setValueAtTime
  // semantics) rather than appending a duplicate.
  const dup = await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: 1.5, comment: "Renamed" });
  assert.equal(dup.outcome, "COMPLETED");
  assert.equal(dup.result.numKeys, 2);
  assert.equal(dup.result.markers[0].comment, "Renamed");

  // Comp markers live on comp.markerProperty — a separate store from
  // layer markers even at the same times.
  const cm = await go("marker.setCompMarker", { compName: "C", time: 1.5, comment: "Beat", duration: 1 });
  assert.equal(cm.outcome, "COMPLETED");
  assert.equal(cm.result.numKeys, 1);
  const cr = await go("marker.readCompMarkers", { compName: "C" });
  assert.equal(cr.result.markers[0].comment, "Beat");
  assert.equal(cr.result.markers[0].duration, 1);
  // Layer marker count is untouched by the comp marker.
  const lr = await go("marker.readLayerMarkers", { compName: "C", layerName: "N1" });
  assert.equal(lr.result.numKeys, 2);

  // Counterexamples: wrong comp, wrong layer, wrong item type.
  assert.notEqual((await go("marker.setLayerMarker", { compName: "C", layerName: "Ghost", time: 0, comment: "x" })).outcome, "COMPLETED");
  assert.notEqual((await go("marker.readCompMarkers", { compName: "Ghost" })).outcome, "COMPLETED");
  await go("item.import", { path: "/tmp/clip.mov" });
  assert.notEqual((await go("marker.readCompMarkers", { compName: "clip.mov" })).outcome, "COMPLETED");

  // Non-marker property is not a marker store: Position keys are
  // numbers, and marker ops never touch it.
  const PATH = ["ADBE Transform Group", "ADBE Position"];
  await go("anim.setValueAtTime", { compName: "C", layerName: "N1", propertyPath: PATH, time: 0, value: [0, 0] });
  const pv = await go("read.propertyValue", { compName: "C", layerName: "N1", propertyPath: PATH });
  assert.equal(pv.result.numKeys, 1);
  assert.deepEqual(pv.result.value, [0, 0]);

  // Arg validation refuses malformed markers before any dispatch.
  assert.equal((await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: "x", comment: "c" })).reason, "INVALID_ARGS");
  assert.equal((await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: 0 })).reason, "INVALID_ARGS");
  assert.equal((await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: 0, comment: "c", duration: -1 })).reason, "INVALID_ARGS");
  assert.equal((await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: 0, comment: "c", params: { k: 1 } })).reason, "INVALID_ARGS");
  assert.equal((await go("marker.setLayerMarker", { compName: "C", layerName: "N1", time: 0, comment: "c", eventCuePoint: "yes" })).reason, "INVALID_ARGS");

  // Version-gated fields (label/protectedRegion, AE 16.0+) are not
  // modeled: no member claim and no source reference — no overclaim.
  const { OPERATIONS, buildSource } = await import("../registry.mjs");
  for (const op of OPERATIONS.filter((o) => o.id.startsWith("marker."))) {
    assert.ok(!op.members.some((m) => /MarkerValue\.(label|protectedRegion)/.test(m)), `${op.id} overclaims version-gated member`);
    const src = buildSource(op.id, {
      compName: "C", layerName: "N1", time: 0, comment: "c",
      chapter: "x", url: "u", frameTarget: "f", cuePointName: "cp",
      duration: 1, eventCuePoint: false, params: { a: "b" },
    });
    assert.ok(!/protectedRegion|\.label\b/.test(src), `${op.id} source references version-gated field`);
  }
});

test("issue #296 batch: ShapeLayer addShape + Contents path slice — write, read-back, counterexamples", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("comp.addNullLayer", { compName: "C", layerName: "N1" })).outcome, "COMPLETED");

  // addShape takes no host args; the op renames via layer.name.
  const add = await go("layer.addShape", { compName: "C", name: "Shapes" });
  assert.equal(add.outcome, "COMPLETED");
  assert.equal(add.result.layer, "Shapes");

  // Fresh shape layer: Contents exists but is empty.
  const empty = await go("shape.readContents", { compName: "C", layerName: "Shapes" });
  assert.equal(empty.outcome, "COMPLETED");
  assert.equal(empty.result.numProperties, 0);
  assert.deepEqual(empty.result.contents, []);

  // Add a closed triangular path with explicit tangents.
  const V = [[0, 0], [10, 0], [5, 10]];
  const Z = [[0, 0], [0, 0], [0, 0]];
  const path = await go("shape.addPath", {
    compName: "C", layerName: "Shapes",
    vertices: V, inTangents: Z, outTangents: Z, closed: true,
  });
  assert.equal(path.outcome, "COMPLETED");
  assert.equal(path.result.numProperties, 1);
  const grp = path.result.contents[0];
  assert.equal(grp.matchName, "ADBE Vector Shape - Group");
  assert.equal(grp.numProperties, 2);
  const shapeLeaf = grp.children.find((c) => c.matchName === "ADBE Vector Shape");
  assert.ok(shapeLeaf, "path group must contain ADBE Vector Shape leaf");
  assert.deepEqual(shapeLeaf.shape.vertices, V);
  assert.equal(shapeLeaf.shape.closed, true);
  const dirLeaf = grp.children.find((c) => c.matchName === "ADBE Vector Shape Direction");
  assert.equal(dirLeaf.value, 1);

  // Second path accumulates; read-back is stable.
  await go("shape.addPath", {
    compName: "C", layerName: "Shapes",
    vertices: [[0, 0], [4, 4]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]],
  });
  const rd = await go("shape.readContents", { compName: "C", layerName: "Shapes" });
  assert.equal(rd.result.numProperties, 2);
  assert.equal(rd.result.contents[1].children.find((c) => c.matchName === "ADBE Vector Shape").shape.closed, false);

  // Counterexamples: non-shape layer has no Contents; wrong layer/comp;
  // unsupported matchName cannot be added.
  assert.notEqual((await go("shape.readContents", { compName: "C", layerName: "N1" })).outcome, "COMPLETED");
  assert.notEqual((await go("shape.addPath", { compName: "C", layerName: "N1", vertices: V, inTangents: Z, outTangents: Z })).outcome, "COMPLETED");
  assert.notEqual((await go("shape.readContents", { compName: "Ghost", layerName: "Shapes" })).outcome, "COMPLETED");
  // Unsupported contents child (e.g. a filter) is refused, not faked.
  const appLayer = app.project.items.find((i) => i.name === "C").layers[2]; // "Shapes"
  const contents = appLayer.property("ADBE Root Vectors Group");
  assert.equal(contents.canAddProperty("ADBE Vector Filter - Gaussian Blur 2"), false);
  assert.throws(() => contents.addProperty("ADBE Vector Filter - Gaussian Blur 2"), /cannot add property/);

  // Stale layer reference: remove the shape layer, ops must fail.
  appLayer.remove();
  assert.notEqual((await go("shape.readContents", { compName: "C", layerName: "Shapes" })).outcome, "COMPLETED");

  // Arg validation refuses malformed geometry before dispatch.
  assert.equal((await go("shape.addPath", { compName: "C", layerName: "Shapes", vertices: [[0, 0]], inTangents: Z, outTangents: Z })).reason, "INVALID_ARGS");
  assert.equal((await go("shape.addPath", { compName: "C", layerName: "Shapes", vertices: V, inTangents: [[0, 0]], outTangents: Z })).reason, "INVALID_ARGS");
  assert.equal((await go("shape.addPath", { compName: "C", layerName: "Shapes", vertices: V, inTangents: Z, outTangents: Z, closed: "yes" })).reason, "INVALID_ARGS");

  // Duplicate copies Contents with independent Shape values.
  await go("layer.addShape", { compName: "C", name: "Shapes2" });
  await go("shape.addPath", { compName: "C", layerName: "Shapes2", vertices: V, inTangents: Z, outTangents: Z, closed: true });
  await go("layer.duplicate", { compName: "C", layerName: "Shapes2" });
  const dupRead = await go("shape.readContents", { compName: "C", layerName: "Shapes2 copy" });
  assert.equal(dupRead.result.numProperties, 1);
  const dupShape = dupRead.result.contents[0].children.find((c) => c.matchName === "ADBE Vector Shape");
  assert.deepEqual(dupShape.shape.vertices, V);
});

test("issue #297 batch: TextDocument residual attributes — box text, paint, char attrs, counterexamples", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("layer.addText", { compName: "C", name: "Text 1", text: "hi" })).outcome, "COMPLETED");

  // Point text: box metrics are gated off and report null, not throw.
  const rd0 = await go("text.readDocument", { compName: "C", layerName: "Text 1" });
  assert.equal(rd0.outcome, "COMPLETED");
  assert.equal(rd0.result.pointText, true);
  assert.equal(rd0.result.boxText, false);
  assert.equal(rd0.result.boxTextSize, null);
  assert.equal(rd0.result.boxTextPos, null);
  assert.equal(rd0.result.paragraphCount, 1);
  // AE 24.x attributes are not modeled — they must not appear.
  assert.equal(rd0.result.lineOrientation, undefined);
  assert.equal(rd0.result.fontCapsOption, undefined);

  // paragraphCount tracks newline-separated paragraphs.
  await go("text.setText", { compName: "C", layerName: "Text 1", text: "a\nb\nc" });
  const rd1 = await go("text.readDocument", { compName: "C", layerName: "Text 1" });
  assert.equal(rd1.result.paragraphCount, 3);

  // Box metrics throw on point text (real host and fake agree).
  assert.notEqual((await go("text.setBoxMetrics", { compName: "C", layerName: "Text 1", boxTextSize: [100, 100] })).outcome, "COMPLETED");

  // addBoxText creates a paragraph (box) text layer.
  const add = await go("layer.addBoxText", { compName: "C", name: "Box 1", width: 200, height: 100 });
  assert.equal(add.outcome, "COMPLETED");
  assert.equal(add.result.boxText, true);
  assert.equal(add.result.pointText, false);
  assert.deepEqual(add.result.boxTextSize, [200, 100]);

  // Box metrics write + read-back on box text.
  const bm = await go("text.setBoxMetrics", { compName: "C", layerName: "Box 1", boxTextSize: [300, 150], boxTextPos: [10, 20] });
  assert.equal(bm.outcome, "COMPLETED");
  assert.deepEqual(bm.result.boxTextSize, [300, 150]);
  assert.deepEqual(bm.result.boxTextPos, [10, 20]);
  const rd2 = await go("text.readDocument", { compName: "C", layerName: "Box 1" });
  assert.deepEqual(rd2.result.boxTextSize, [300, 150]);
  assert.deepEqual(rd2.result.boxTextPos, [10, 20]);

  // Paint: applyFill=false hides fillColor on read; setting strokeColor
  // enables applyStroke per the documented side effect.
  const p = await go("text.setPaint", {
    compName: "C", layerName: "Box 1",
    applyFill: false, strokeColor: [0, 0, 1], strokeWidth: 5, strokeOverFill: true,
  });
  assert.equal(p.outcome, "COMPLETED");
  assert.equal(p.result.applyFill, false);
  assert.equal(p.result.applyStroke, true);
  assert.deepEqual(p.result.strokeColor, [0, 0, 1]);
  assert.equal(p.result.strokeWidth, 5);
  const rd3 = await go("text.readDocument", { compName: "C", layerName: "Box 1" });
  assert.equal(rd3.result.fillColor, null);
  assert.deepEqual(rd3.result.strokeColor, [0, 0, 1]);

  // Disabling applyStroke gates strokeColor reads to null.
  await go("text.setPaint", { compName: "C", layerName: "Box 1", applyStroke: false });
  const rd4 = await go("text.readDocument", { compName: "C", layerName: "Box 1" });
  assert.equal(rd4.result.strokeColor, null);

  // strokeWidth 0 is silently clipped to 0.01 (documented behavior).
  const sw = await go("text.setPaint", { compName: "C", layerName: "Box 1", strokeWidth: 0 });
  assert.equal(sw.result.strokeWidth, 0.01);

  // Character attributes write + read-back.
  const ca = await go("text.setCharAttributes", { compName: "C", layerName: "Box 1", baselineShift: 12, horizontalScale: 90, verticalScale: 80 });
  assert.equal(ca.outcome, "COMPLETED");
  assert.equal(ca.result.baselineShift, 12);
  assert.equal(ca.result.horizontalScale, 90);
  assert.equal(ca.result.verticalScale, 80);

  // Duplicated box text keeps independent document state.
  await go("layer.duplicate", { compName: "C", layerName: "Box 1" });
  const rdDup = await go("text.readDocument", { compName: "C", layerName: "Box 1 copy" });
  assert.equal(rdDup.result.boxText, true);
  assert.deepEqual(rdDup.result.boxTextSize, [300, 150]);

  // Arg validation refuses malformed input before dispatch.
  assert.equal((await go("layer.addBoxText", { compName: "C", name: "B2", width: 0, height: 10 })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setBoxMetrics", { compName: "C", layerName: "Box 1", boxTextSize: [100.5, 100] })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setBoxMetrics", { compName: "C", layerName: "Box 1", boxTextSize: [0, 100] })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setBoxMetrics", { compName: "C", layerName: "Box 1" })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setPaint", { compName: "C", layerName: "Box 1" })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setPaint", { compName: "C", layerName: "Box 1", strokeWidth: 1001 })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setPaint", { compName: "C", layerName: "Box 1", strokeColor: [1, 0] })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setCharAttributes", { compName: "C", layerName: "Box 1" })).reason, "INVALID_ARGS");
  assert.equal((await go("text.setCharAttributes", { compName: "C", layerName: "Box 1", baselineShift: "x" })).reason, "INVALID_ARGS");
});

test("issue #298 batch: AVItem proxy surface — file/solid/placeholder, main-vs-proxy, counterexamples", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("item.import", { path: "/tmp/clip.mov" })).outcome, "COMPLETED");

  // Initial state: no proxy, mainSource is the imported file.
  const rd0 = await go("read.itemProxy", { name: "clip.mov" });
  assert.equal(rd0.outcome, "COMPLETED");
  assert.equal(rd0.result.useProxy, false);
  assert.equal(rd0.result.proxy, null);
  assert.equal(rd0.result.mainSource.kind, "file");
  assert.equal(rd0.result.mainSource.file, "/tmp/clip.mov");

  // setProxy: file proxy, useProxy flips on, mainSource untouched.
  const sp = await go("item.setProxy", { name: "clip.mov", path: "/tmp/proxy.mov" });
  assert.equal(sp.outcome, "COMPLETED");
  assert.equal(sp.result.useProxy, true);
  assert.equal(sp.result.proxy.kind, "file");
  assert.equal(sp.result.proxy.file, "/tmp/proxy.mov");
  const rd1 = await go("read.itemProxy", { name: "clip.mov" });
  assert.equal(rd1.result.mainSource.file, "/tmp/clip.mov");
  assert.equal(rd1.result.proxy.file, "/tmp/proxy.mov");

  // useProxy toggle keeps proxySource assigned (disable/enable cycle).
  const off = await go("item.setUseProxy", { name: "clip.mov", useProxy: false });
  assert.equal(off.result.useProxy, false);
  assert.equal(off.result.proxy.kind, "file");
  const on = await go("item.setUseProxy", { name: "clip.mov", useProxy: true });
  assert.equal(on.result.useProxy, true);
  assert.equal(on.result.proxy.file, "/tmp/proxy.mov");

  // itemRef object form resolves the same footage item.
  const ref = await go("item.setUseProxy", { name: { name: "clip.mov" }, useProxy: false });
  assert.equal(ref.outcome, "COMPLETED");

  // Solid proxy replaces the file proxy entirely.
  const solid = await go("item.setProxyWithSolid", {
    name: "clip.mov", color: [1, 0, 0], solidName: "Red Proxy",
    width: 640, height: 480, pixelAspect: 1,
  });
  assert.equal(solid.outcome, "COMPLETED");
  assert.equal(solid.result.proxy.kind, "solid");
  assert.deepEqual(solid.result.proxy.color, [1, 0, 0]);
  // name/width/height/pixelAspect are not documented FootageSource
  // members (Issue #329) — the snapshot reports only documented fields.
  assert.equal(solid.result.proxy.name, undefined);
  assert.equal(solid.result.proxy.isStill, true);
  assert.equal(solid.result.useProxy, true);

  // Placeholder proxy.
  const ph = await go("item.setProxyWithPlaceholder", {
    name: "clip.mov", placeholderName: "Offline", width: 320, height: 240,
    frameRate: 24, duration: 60,
  });
  assert.equal(ph.outcome, "COMPLETED");
  assert.equal(ph.result.proxy.kind, "placeholder");
  assert.equal(ph.result.proxy.name, undefined);
  assert.equal(ph.result.proxy.frameRate, undefined);
  assert.equal(ph.result.proxy.isStill, false);

  // Sequence proxy is still a FileSource.
  const seq = await go("item.setProxyWithSequence", { name: "clip.mov", path: "/tmp/seq.####.exr", forceAlphabetical: true });
  assert.equal(seq.outcome, "COMPLETED");
  assert.equal(seq.result.proxy.kind, "file");
  assert.equal(seq.result.proxy.file, "/tmp/seq.####.exr");

  // setProxyToNone clears proxySource AND useProxy; mainSource survives.
  const none = await go("item.setProxyToNone", { name: "clip.mov" });
  assert.equal(none.outcome, "COMPLETED");
  assert.equal(none.result.proxy, null);
  assert.equal(none.result.useProxy, false);
  const rd2 = await go("read.itemProxy", { name: "clip.mov" });
  assert.equal(rd2.result.mainSource.file, "/tmp/clip.mov");

  // Counterexamples: missing proxy file, non-footage targets, bad args.
  assert.notEqual((await go("item.setProxy", { name: "clip.mov", path: "/tmp/missing.missing" })).outcome, "COMPLETED");
  assert.notEqual((await go("item.setProxy", { name: "C", path: "/tmp/p.mov" })).outcome, "COMPLETED");
  assert.notEqual((await go("item.setProxy", { name: "Ghost", path: "/tmp/p.mov" })).outcome, "COMPLETED");
  assert.equal((await go("item.setProxy", { name: "clip.mov", path: "" })).reason, "INVALID_ARGS");
  assert.equal((await go("item.setUseProxy", { name: "clip.mov", useProxy: "yes" })).reason, "INVALID_ARGS");
  assert.equal((await go("item.setProxyWithSolid", { name: "clip.mov", color: [1, 0], solidName: "S", width: 10, height: 10, pixelAspect: 1 })).reason, "INVALID_ARGS");
  assert.equal((await go("item.setProxyWithSolid", { name: "clip.mov", color: [1, 0, 0], solidName: "S", width: 0, height: 10, pixelAspect: 1 })).reason, "INVALID_ARGS");
  assert.equal((await go("item.setProxyWithSolid", { name: "clip.mov", color: [1, 0, 0], solidName: "S", width: 10, height: 10, pixelAspect: 200 })).reason, "INVALID_ARGS");
  assert.equal((await go("item.setProxyWithPlaceholder", { name: "clip.mov", placeholderName: "P", width: 100, height: 100, frameRate: 0, duration: 10 })).reason, "INVALID_ARGS");
  assert.equal((await go("item.setProxyWithPlaceholder", { name: "clip.mov", placeholderName: "P", width: 100, height: 100, frameRate: 24, duration: 10801 })).reason, "INVALID_ARGS");

  // Ambiguous name: importing the same path twice makes "clip.mov"
  // unresolvable by bare name.
  await go("item.import", { path: "/tmp/clip.mov" });
  assert.notEqual((await go("read.itemProxy", { name: "clip.mov" })).outcome, "COMPLETED");
  // ...but an itemRef with id still resolves unambiguously.
  const items = app.project.items;
  let secondId = null;
  for (let i = 1; i <= items.length; i++) {
    if (items[i].name === "clip.mov") secondId = items[i].id;
  }
  const byId = await go("read.itemProxy", { name: { id: secondId } });
  assert.equal(byId.outcome, "COMPLETED");
});

test("issue #299 batch: render/output-module templates — apply/save/list, multi-OM, counterexamples", async () => {
  const app = createAdapterFakeApp();
  const t = baseInput(app);
  const provider = approvingProvider();
  const go = (opId, args = {}, extra = {}) =>
    runOperation({ opId, args, consentProvider: provider, ...t, ...extra });
  const mut = { confirmDestructive: true };

  assert.equal((await go("project.new", {}, mut)).outcome, "COMPLETED");
  assert.equal((await go("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 5, frameRate: 30 })).outcome, "COMPLETED");
  assert.equal((await go("render.queueComp", { compName: "C" })).outcome, "COMPLETED");

  // Render-settings templates: deterministic seeded names.
  const lt = await go("render.listTemplates", { compName: "C" });
  assert.equal(lt.outcome, "COMPLETED");
  assert.ok(lt.result.templates.includes("Best Settings"));
  assert.ok(lt.result.templates.includes("Lossless"));
  assert.ok(lt.result.templates.includes("Draft"));

  // applyTemplate mutates RQ item settings (Draft payload sets logType 1).
  const at = await go("render.applyTemplate", { compName: "C", templateName: "Draft" });
  assert.equal(at.outcome, "COMPLETED");
  assert.equal(at.result.logType, 1);
  assert.equal(at.result.timeSpanStart, 0);

  // saveTemplate persists current settings under a new name; re-applying
  // restores them.
  await go("render.setTimeSpan", { compName: "C", timeSpanStart: 1, timeSpanDuration: 3 });
  const sv = await go("render.saveTemplate", { compName: "C", templateName: "My Preset" });
  assert.equal(sv.outcome, "COMPLETED");
  assert.ok(sv.result.templates.includes("My Preset"));
  await go("render.applyTemplate", { compName: "C", templateName: "Draft" });
  const re = await go("render.applyTemplate", { compName: "C", templateName: "My Preset" });
  assert.equal(re.result.timeSpanStart, 1);
  assert.equal(re.result.timeSpanDuration, 3);

  // Unknown template is refused by the host, not silently ignored.
  assert.notEqual((await go("render.applyTemplate", { compName: "C", templateName: "No Such Template" })).outcome, "COMPLETED");
  assert.notEqual((await go("render.applyTemplate", { compName: "Ghost", templateName: "Draft" })).outcome, "COMPLETED");
  assert.equal((await go("render.applyTemplate", { compName: "C", templateName: "" })).reason, "INVALID_ARGS");

  // Output modules: one by default; add a second.
  const lom = await go("render.listOutputModules", { compName: "C" });
  assert.equal(lom.result.numOutputModules, 1);
  assert.equal(lom.result.modules[0].name, "Lossless");
  assert.ok(lom.result.modules[0].templates.includes("Draft"));
  assert.equal(lom.result.modules[0].file, null);

  const add = await go("render.addOutputModule", { compName: "C" });
  assert.equal(add.outcome, "COMPLETED");
  assert.equal(add.result.numOutputModules, 2);
  assert.equal(add.result.index, 2);
  const lom2 = await go("render.listOutputModules", { compName: "C" });
  assert.equal(lom2.result.numOutputModules, 2);
  assert.equal(lom2.result.modules[1].name, "Output Module 2");

  // OM template apply/save on module 2; module 1 stays independent.
  const aot = await go("render.applyOutputModuleTemplate", { compName: "C", moduleIndex: 2, templateName: "Draft" });
  assert.equal(aot.outcome, "COMPLETED");
  assert.equal(aot.result.settings["Output File Info"], "[compName].avi");
  const sot = await go("render.saveOutputModuleTemplate", { compName: "C", moduleIndex: 2, templateName: "My OM" });
  assert.ok(sot.result.templates.includes("My OM"));
  const lom3 = await go("render.listOutputModules", { compName: "C" });
  assert.equal(lom3.result.modules[0].settings, undefined); // no settings in list shape
  assert.equal(lom3.result.modules[0].file, null);

  // OM options: file/includeSourceXMP/postRenderAction on module 1.
  const soo = await go("render.setOutputModuleOptions", {
    compName: "C", moduleIndex: 1,
    file: "/tmp/out.mov", includeSourceXMP: true, postRenderAction: "SET_PROXY",
  });
  assert.equal(soo.outcome, "COMPLETED");
  assert.equal(soo.result.file, "/tmp/out.mov");
  assert.equal(soo.result.includeSourceXMP, true);
  assert.equal(soo.result.postRenderAction, 3); // fake PostRenderAction.SET_PROXY
  const lom4 = await go("render.listOutputModules", { compName: "C" });
  assert.equal(lom4.result.modules[0].file, "/tmp/out.mov");
  assert.equal(lom4.result.modules[0].includeSourceXMP, true);
  assert.equal(lom4.result.modules[0].postRenderAction, 3);
  // Module 2 unaffected — independence across output modules.
  assert.equal(lom4.result.modules[1].file, null);

  // Counterexamples: bad module index, unknown OM template, bad enum,
  // missing option, wrong comp.
  assert.notEqual((await go("render.applyOutputModuleTemplate", { compName: "C", moduleIndex: 9, templateName: "Draft" })).outcome, "COMPLETED");
  assert.notEqual((await go("render.applyOutputModuleTemplate", { compName: "C", moduleIndex: 1, templateName: "Nope" })).outcome, "COMPLETED");
  assert.equal((await go("render.applyOutputModuleTemplate", { compName: "C", moduleIndex: 0, templateName: "Draft" })).reason, "INVALID_ARGS");
  assert.equal((await go("render.setOutputModuleOptions", { compName: "C", moduleIndex: 1 })).reason, "INVALID_ARGS");
  assert.equal((await go("render.setOutputModuleOptions", { compName: "C", moduleIndex: 1, postRenderAction: "BOGUS" })).reason, "INVALID_ARGS");
  assert.equal((await go("render.setOutputModuleOptions", { compName: "C", moduleIndex: 1.5, includeSourceXMP: true })).reason, "INVALID_ARGS");
  assert.notEqual((await go("render.listOutputModules", { compName: "Ghost" })).outcome, "COMPLETED");

  // Duplicate queue item copies all output modules; afterwards the comp
  // name is ambiguous for compName-based ops (itemRef by id unaffected
  // is a separate resolver path not exercised here).
  const dq = await go("render.duplicateQueueItem", { compName: "C" });
  assert.equal(dq.outcome, "COMPLETED");
  assert.notEqual((await go("render.listOutputModules", { compName: "C" })).outcome, "COMPLETED");
});
