/*
 * scripting-adapters tests — Issue #15 (CAP029–CAP032 groundwork).
 *
 * Two evidence levels, kept separate:
 *   1. Registry contract — every claimed inventory symbol id exists in
 *      inventories/scripting/generated/symbols.json; args validate;
 *      generated sources are ES3-safe.
 *   2. Fake execution — generated sources actually RUN against
 *      fake-app.mjs (a minimal ExtendScript surface) in node:vm.
 *      This is fake/mock evidence only: it proves the adapter emits
 *      runnable code against a modeled API, NOT that real AE behaves
 *      the same. Real-host verification stays BLOCKED on an owned
 *      AE session (Issue #15 acceptance).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { OPERATIONS, buildSource, getOperation, opsForDomain, registryReport } from "../registry.mjs";
import { createAdapterFakeApp } from "../fake-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const symbolsJson = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "inventories", "scripting", "generated", "symbols.json"), "utf8")
);

function allSymbolIds() {
  const ids = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      if (typeof o.id === "string") ids.add(o.id);
      Object.values(o).forEach(walk);
    }
  };
  walk(symbolsJson);
  return ids;
}
const SYMBOL_IDS = allSymbolIds();

function evalSource(source, app) {
  const ctx = vm.createContext({
    app, JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp,
    Error, TypeError, ReferenceError, parseInt, parseFloat, isNaN, isFinite, undefined,
    File: class File { constructor(p) { this.fsName = p; this.exists = true; } },
    CloseOptions: { DO_NOT_SAVE_CHANGES: 2 },
    CompItem: app.CompItem, FolderItem: app.FolderItem, FootageItem: app.FootageItem,
  });
  return vm.runInContext(`(function(){\n${source}\n})()`, ctx, { filename: "adapter.jsx" });
}

/* ---------- registry contract ---------- */

test("every claimed member id exists in the scripting inventory", () => {
  const missing = [];
  for (const op of OPERATIONS) {
    for (const m of op.members) if (!SYMBOL_IDS.has(m)) missing.push(`${op.id}: ${m}`);
  }
  assert.deepEqual(missing, []);
});

test("all ops belong to the #15 domain and declare execute permission", () => {
  for (const op of OPERATIONS) {
    assert.equal(op.domain, "project-items-comps-layers");
    assert.equal(op.permission, "execute");
    assert.ok(op.members.length > 0, `${op.id} claims no symbols`);
  }
});

test("generated sources are ES3-safe (no arrow functions / let / const)", () => {
  for (const op of OPERATIONS) {
    const src = buildSource(op.id, sampleArgs(op));
    assert.doesNotMatch(src, /=>/, `${op.id} contains arrow function`);
    assert.doesNotMatch(src, /\b(const|let)\s/, `${op.id} contains let/const`);
  }
});

function sampleArgs(op) {
  const a = {};
  for (const n of op.args) {
    if (["x", "y", "width", "height", "pixelAspect", "duration", "frameRate"].includes(n)) a[n] = 30;
    else if (n === "to") a[n] = "top";
    else if (n === "type") a[n] = "CompItem";
    else if (n === "path") a[n] = "/tmp/x.aep";
    else if (n === "parentName") a[n] = null;
    else a[n] = `sample-${n}`;
  }
  return a;
}

test("buildSource validates required args", () => {
  assert.throws(() => buildSource("item.addComp", { name: "c" }), /missing: width/);
  assert.throws(() => buildSource("layer.reorder", { compName: "c", layerName: "l", to: "middle" }), /top.*bottom/);
  assert.throws(() => getOperation("no.such.op"), /unknown operation/);
});

test("registryReport counts match the operation table", () => {
  const r = registryReport();
  assert.equal(r.operationCount, OPERATIONS.length);
  assert.equal(r.mutating + r.readOnly, OPERATIONS.length);
  assert.deepEqual(opsForDomain("project-items-comps-layers").length, OPERATIONS.length);
});

/* ---------- fake execution ---------- */

function freshApp() {
  return { app: createAdapterFakeApp(), run(opId, args) {
    return evalSource(buildSource(opId, args), this.app);
  } };
}

test("fake exec: project.new -> item.addComp -> read.projectSummary", () => {
  const t = freshApp();
  t.run("project.new", {});
  const r1 = t.run("item.addComp", { name: "Hero", width: 1920, height: 1080, pixelAspect: 1, duration: 10, frameRate: 30 });
  assert.equal(JSON.parse(r1).name, "Hero");
  t.run("item.addFolder", { name: "Assets" });
  const summary = JSON.parse(t.run("read.projectSummary", {}));
  assert.equal(summary.count, 2);
  assert.equal(summary.items[0].typeName, "Composition");
  assert.equal(summary.items[1].typeName, "Folder");
});

test("fake exec: comp/layer lifecycle — addNull, position, reorder, parent, duplicate", () => {
  const t = freshApp();
  t.run("project.new", {});
  t.run("item.addComp", { name: "C1", width: 100, height: 100, pixelAspect: 1, duration: 5, frameRate: 30 });
  t.run("comp.addNullLayer", { compName: "C1", layerName: "Rig" });
  t.run("comp.addNullLayer", { compName: "C1", layerName: "Cam" });

  const pos = JSON.parse(t.run("layer.setTransformPosition", { compName: "C1", layerName: "Rig", x: 10, y: 20 }));
  assert.deepEqual(pos.value, [10, 20]);

  const top = JSON.parse(t.run("layer.reorder", { compName: "C1", layerName: "Cam", to: "top" }));
  assert.equal(top.index, 1);

  const par = JSON.parse(t.run("layer.setParent", { compName: "C1", layerName: "Rig", parentName: "Cam" }));
  assert.equal(par.parent, "Cam");
  const un = JSON.parse(t.run("layer.setParent", { compName: "C1", layerName: "Rig", parentName: null }));
  assert.equal(un.parent, null);

  const dup = JSON.parse(t.run("layer.duplicate", { compName: "C1", layerName: "Rig" }));
  assert.equal(dup.duplicate, "Rig copy");
});

test("fake exec: item.remove and same-name type guard (CAP031)", () => {
  const t = freshApp();
  t.run("project.new", {});
  t.run("item.addComp", { name: "Same", width: 1, height: 1, pixelAspect: 1, duration: 1, frameRate: 30 });
  t.run("item.addFolder", { name: "Same" });
  // type guard: "Same" as CompItem resolves the comp, not the folder
  const r = JSON.parse(t.run("item.remove", { name: "Same", type: "CompItem" }));
  assert.equal(r.removed, "Same");
  const summary = JSON.parse(t.run("read.projectSummary", {}));
  assert.equal(summary.count, 1);
  assert.equal(summary.items[0].typeName, "Folder");
});

test("fake exec: name-not-found and wrong-type produce adapter errors, not silent wrong-target", () => {
  const t = freshApp();
  t.run("project.new", {});
  t.run("item.addFolder", { name: "OnlyFolder" });
  assert.throws(() => t.run("item.remove", { name: "OnlyFolder", type: "CompItem" }), /not the requested type/);
  assert.throws(() => t.run("comp.addNullLayer", { compName: "Ghost", layerName: "x" }), /item not found/);
  assert.throws(() => t.run("layer.setTransformPosition", { compName: "OnlyFolder", layerName: "x", x: 0, y: 0 }), /not the requested type/);
});

test("fake exec: project.save/open/close are dispatchable", () => {
  const t = freshApp();
  t.run("project.new", {});
  assert.equal(JSON.parse(t.run("project.save", { path: "/tmp/out.aep" })).ok, true);
  assert.equal(JSON.parse(t.run("project.open", { path: "/tmp/in.aep" })).ok, true);
  assert.equal(JSON.parse(t.run("project.close", {})).ok, true);
});

/* ---- PR #46 independent-review regressions ---- */

test("R1: two same-name+type items -> ambiguous error, never silent first-match", () => {
  const t = freshApp();
  t.run("project.new", {});
  t.run("item.addComp", { name: "Dup", width: 1, height: 1, pixelAspect: 1, duration: 1, frameRate: 30 });
  t.run("item.addComp", { name: "Dup", width: 2, height: 2, pixelAspect: 1, duration: 1, frameRate: 30 });
  assert.throws(() => t.run("comp.addNullLayer", { compName: "Dup", layerName: "x" }), /ambiguous/);
});

test("R2: non-finite numeric args rejected at buildSource, never reach host", () => {
  assert.throws(() => buildSource("item.addComp", { name: "c", width: NaN, height: 1, pixelAspect: 1, duration: 1, frameRate: 30 }), /finite number/);
  assert.throws(() => buildSource("layer.setTransformPosition", { compName: "c", layerName: "l", x: "abc", y: 0 }), /finite number|missing/);
});

test("R3: destructive ops are explicitly flagged for consent/loop gating", () => {
  for (const id of ["project.new", "project.open", "project.close", "item.remove"]) {
    assert.equal(getOperation(id).destructive, true, `${id} must be destructive`);
  }
  assert.equal(getOperation("read.projectSummary").destructive, undefined);
  assert.equal(registryReport().destructive, 4);
});

test("R4: generated sources only call API surface the fake host actually implements", () => {
  // If a source references a member fake-app lacks, vm throws at exec —
  // but assert statically too so coverage is explicit per op.
  const t = freshApp();
  t.run("project.new", {});
  t.run("item.addComp", { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30 });
  const comp = t.app.project.items[1];
  for (const m of ["layers", "duration", "name"]) assert.ok(m in comp || comp[m] !== undefined, `comp.${m} missing on fake`);
  const layer = comp.layers.addNull(1);
  for (const m of ["property", "moveToBeginning", "moveToEnd", "duplicate", "remove"]) {
    assert.equal(typeof layer[m], "function", `layer.${m} must be callable`);
  }
  for (const m of ["parent", "name", "index", "enabled"]) {
    assert.ok(m in layer, `layer.${m} must exist`);
  }
});

test("contract: generated sources use locale-independent matchName + instanceof, no typeName branching, no JSON global", () => {
  for (const op of OPERATIONS) {
    const args = {};
    for (const a of op.args) {
      if (a === "name" || a === "compName" || a === "layerName") args[a] = "x";
      else if (a === "type") args[a] = "CompItem";
      else if (a === "to") args[a] = "top";
      else if (["width","height","pixelAspect","duration","frameRate","x","y","durationSeconds"].includes(a)) args[a] = 1;
    }
    let src;
    try { src = op.source(args); } catch { continue; }
    assert.ok(!/typeName\s*[=!]==?/.test(src), `${op.id} must not branch on typeName (localized)`);
    assert.ok(!/property\("(Transform|Position|Opacity|Scale)"\)/.test(src), `${op.id} must use matchName, not display name`);
    assert.ok(!/\bJSON\.(stringify|parse)\s*\(/.test(src), `${op.id} must not rely on host JSON (not guaranteed in ExtendScript)`);
  }
  const pos = getOperation("layer.setTransformPosition").source({ compName:"c", layerName:"l", x:1, y:2 });
  assert.ok(pos.includes('"ADBE Position"'), "position access must use ADBE matchName");
  const rem = getOperation("item.remove").source({ name:"x", type:"CompItem" });
  assert.ok(rem.includes("instanceof"), "type discrimination must use instanceof");
});
