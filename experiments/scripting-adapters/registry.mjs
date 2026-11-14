/*
 * registry.mjs — versioned operation registry for public After Effects
 * Scripting API adapters (Issue #15, CAP029–CAP032 groundwork).
 *
 * An *operation* is the unit callers use: it owns a stable id, the
 * catalog domain it belongs to, the inventory symbol ids it exercises,
 * a mutating flag, an argument schema, and a `source(args)` builder
 * that emits ES3 ExtendScript for the trusted-execution runner
 * (experiments/trusted-execution/runner.mjs). Operations are NOT MCP
 * tools — per Issue #15, the registry + trusted eval path is the
 * delivery mechanism, not per-symbol tool proliferation.
 *
 * Honesty rules baked in:
 *   - `members` lists provisional inventory symbol ids the op exercises;
 *     tests verify every id exists in inventories/scripting/generated.
 *   - `mutating` marks ops that change project/AE state; consumers
 *     (agent loop) use it for dirty-state gating.
 *   - Object references are resolved BY NAME with type guards inside
 *     the generated source (CAP031) — never by stale handles.
 *   - An op listed here is `implemented` at adapter level only;
 *     verification stays `not-run`/`fake` until real-host evidence.
 *
 * Evidence level: implemented (adapter layer) / automated-test.
 * No AE involved.
 */

export const ADAPTER_SCHEMA = "ae-devtools.scripting-adapter-registry/v1";

const S = (owner, member) => `provisional.ae.scripting.${owner}.${member}`;

/*
 * Shared ES3 prelude inlined into every generated source: resolves a
 * project item by name AND type (avoids same-name comp/layer
 * confusion, Issue #15 acceptance), resolves a layer inside a comp by
 * name, and returns JSON-safe results. ExtendScript is ES3 — no
 * arrow functions, let/const, or JSON-dependent circular refs.
 */
const PRELUDE = `
function __adp_fail(msg) { throw new Error("adapter: " + msg); }
function __adp_items() { return app.project.items; }
// Type discrimination uses instanceof (locale-independent). typeName
// is localized and must NOT be used for branching (PR #46 review).
function __adp_findItem(name, ctor) {
  var items = __adp_items();
  var found = null;
  var sawName = false;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (it.name === name) {
      sawName = true;
      var match = false;
      try { match = (ctor === null) || (it instanceof ctor); } catch (e) { match = false; }
      if (match) {
        if (found !== null) {
          __adp_fail("ambiguous item name '" + name + "': multiple matches — rename or qualify");
        }
        found = it;
      }
    }
  }
  if (found !== null) return found;
  if (sawName) __adp_fail("name '" + name + "' exists but is not the requested type");
  __adp_fail("item not found: " + name);
  return null;
}
function __adp_findLayer(comp, name) {
  var layers = comp.layers;
  var found = null;
  for (var i = 1; i <= layers.length; i++) {
    if (layers[i].name === name) {
      if (found !== null) {
        __adp_fail("ambiguous layer name '" + name + "' in comp '" + comp.name + "': multiple matches");
      }
      found = layers[i];
    }
  }
  if (found !== null) return found;
  __adp_fail("layer not found in comp '" + comp.name + "': " + name);
  return null;
}
// Hand-rolled JSON serializer: ExtendScript's JSON support is NOT
// guaranteed across AE versions, and host objects crash native
// JSON.stringify on circular refs. Adapter results are plain
// objects/arrays/strings/numbers/booleans/null only.
function __adp_json(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") {
    var out = '"';
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      var code = v.charCodeAt(i);
      if (c === '"' || c === "\\\\") out += "\\\\" + c;
      else if (code < 32) out += "\\\\u" + ("000" + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }
  if (t === "object") {
    var isArr = Object.prototype.toString.call(v) === "[object Array]";
    var parts = [];
    var key;
    for (key in v) {
      if (!v.hasOwnProperty(key)) continue;
      if (isArr && (key === "length" || isNaN(key))) continue;
      parts.push(isArr ? __adp_json(v[key]) : __adp_json(key) + ":" + __adp_json(v[key]));
    }
    return (isArr ? "[" : "{") + parts.join(",") + (isArr ? "]" : "}");
  }
  return "null";
}
`;


// Literal for number | finite-number[] args (keyframe values, positions).
function jsLit(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("adapter arg must be a finite number");
    return String(v);
  }
  if (Array.isArray(v)) {
    return "[" + v.map((n) => {
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("adapter arg array must contain finite numbers");
      return String(n);
    }).join(",") + "]";
  }
  throw new Error("adapter arg must be a number or number array");
}

function jsPath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.some((p) => typeof p !== "string" || p.length === 0)) {
    throw new Error("propertyPath must be a non-empty array of matchName strings");
  }
  return "[" + path.map(js).join(",") + "]";
}

// Shared source tail: resolve comp -> layer -> property by matchName path.
const PROP_WALK = `
var comp = __adp_findItem(@COMP@, CompItem);
var layer = __adp_findLayer(comp, @LAYER@);
var prop = layer;
var __path = @PATH@;
for (var __i = 0; __i < __path.length; __i++) { prop = prop.property(__path[__i]); }
`;

function js(v) {
  // JSON-encode a JS literal into the ExtendScript source (strings only
  // reach here after arg validation).
  return JSON.stringify(v);
}

function requireArgs(args, names) {
  for (const n of names) {
    if (args[n] === undefined || args[n] === null) {
      throw new Error(`adapter args missing: ${n}`);
    }
  }
}

export const OPERATIONS = [
  {
    id: "project.new",
    title: "Create a new project",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    destructive: true,
    members: [S("app", "newProject")],
    args: [],
    source: () => `${PRELUDE}
app.newProject();
return __adp_json({ ok: true });
`,
  },
  {
    id: "project.open",
    title: "Open a project file",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    destructive: true,
    members: [S("app", "open")],
    args: ["path"],
    validate: (a) => requireArgs(a, ["path"]),
    source: (a) => `${PRELUDE}
var f = new File(${js(a.path)});
if (!f.exists) __adp_fail("project file not found: " + ${js(a.path)});
app.open(f);
return __adp_json({ ok: true, project: app.project.file.fsName });
`,
  },
  {
    id: "project.save",
    title: "Save the current project",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("Project", "save")],
    args: ["path"],
    validate: (a) => requireArgs(a, ["path"]),
    source: (a) => `${PRELUDE}
app.project.save(new File(${js(a.path)}));
return __adp_json({ ok: true });
`,
  },
  {
    id: "project.close",
    title: "Close the current project",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    destructive: true,
    members: [S("Project", "close")],
    args: [],
    source: () => `${PRELUDE}
app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
return __adp_json({ ok: true });
`,
  },
  {
    id: "item.addComp",
    title: "Add a composition to the project",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("ItemCollection", "addComp")],
    args: ["name", "width", "height", "pixelAspect", "duration", "frameRate"],
    validate: (a) => {
      requireArgs(a, ["name", "width", "height", "pixelAspect", "duration", "frameRate"]);
      for (const n of ["width", "height", "pixelAspect", "duration", "frameRate"]) {
        if (!Number.isFinite(Number(a[n]))) throw new Error(`item.addComp: ${n} must be a finite number`);
      }
    },
    source: (a) => `${PRELUDE}
var comp = app.project.items.addComp(${js(a.name)}, ${Number(a.width)}, ${Number(a.height)}, ${Number(a.pixelAspect)}, ${Number(a.duration)}, ${Number(a.frameRate)});
return __adp_json({ ok: true, id: comp.id, name: comp.name });
`,
  },
  {
    id: "item.addFolder",
    title: "Add a folder to the project",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("ItemCollection", "addFolder")],
    args: ["name"],
    validate: (a) => requireArgs(a, ["name"]),
    source: (a) => `${PRELUDE}
var f = app.project.items.addFolder(${js(a.name)});
return __adp_json({ ok: true, id: f.id, name: f.name });
`,
  },
  {
    id: "item.remove",
    title: "Remove a project item by name+type",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    destructive: true,
    members: [S("Item", "remove")],
    args: ["name", "type"],
    validate: (a) => {
      requireArgs(a, ["name", "type"]);
      if (["CompItem", "FolderItem", "FootageItem"].indexOf(a.type) === -1) {
        throw new Error("item.remove: type must be one of CompItem|FolderItem|FootageItem");
      }
    },
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, ${a.type});
it.remove();
return __adp_json({ ok: true, removed: ${js(a.name)} });
`,
  },
  {
    id: "comp.addNullLayer",
    title: "Add a null layer to a comp",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("LayerCollection", "addNull")],
    args: ["compName", "layerName"],
    validate: (a) => requireArgs(a, ["compName", "layerName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addNull(comp.duration);
layer.name = ${js(a.layerName)};
return __adp_json({ ok: true, layer: layer.name, index: layer.index });
`,
  },
  {
    id: "layer.setTransformPosition",
    title: "Set a layer's Transform > Position",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("Property", "setValue"), S("PropertyBase", "name")],
    args: ["compName", "layerName", "x", "y"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "x", "y"]);
      for (const n of ["x", "y"]) {
        if (!Number.isFinite(Number(a[n]))) throw new Error(`layer.setTransformPosition: ${n} must be a finite number`);
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var pos = layer.property("ADBE Transform Group").property("ADBE Position");
pos.setValue([${Number(a.x)}, ${Number(a.y)}]);
return __adp_json({ ok: true, layer: layer.name, value: pos.value });
`,
  },
  {
    id: "layer.reorder",
    title: "Move a layer to top or bottom of stack",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("Layer", "moveToEnd"), S("Layer", "moveToBeginning")],
    args: ["compName", "layerName", "to"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "to"]);
      if (a.to !== "top" && a.to !== "bottom") {
        throw new Error("layer.reorder: to must be 'top' or 'bottom'");
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
${a.to === "top" ? "layer.moveToBeginning();" : "layer.moveToEnd();"}
return __adp_json({ ok: true, layer: layer.name, index: layer.index });
`,
  },
  {
    id: "layer.setParent",
    title: "Parent or unparent a layer",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("Layer", "parent")],
    args: ["compName", "layerName", "parentName"],
    validate: (a) => requireArgs(a, ["compName", "layerName"]),
    source: (a) => {
      const parentExpr =
        a.parentName === null || a.parentName === undefined
          ? "null"
          : `__adp_findLayer(comp, ${js(a.parentName)})`;
      return `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
layer.parent = ${parentExpr};
return __adp_json({ ok: true, layer: layer.name, parent: layer.parent === null ? null : layer.parent.name });
`;
    },
  },
  {
    id: "layer.duplicate",
    title: "Duplicate a layer",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("Layer", "duplicate")],
    args: ["compName", "layerName"],
    validate: (a) => requireArgs(a, ["compName", "layerName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var dup = layer.duplicate();
return __adp_json({ ok: true, source: layer.name, duplicate: dup.name, index: dup.index });
`,
  },
  {
    id: "read.projectSummary",
    title: "Read project items + active item (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: false,
    members: [S("Project", "activeItem"), S("Item", "name"), S("Item", "id")],
    args: [],
    source: () => `${PRELUDE}
var items = __adp_items();
var list = [];
for (var i = 1; i <= items.length; i++) {
  list.push({ name: items[i].name, typeName: String(items[i].typeName), id: items[i].id }); // typeName is display-only (localized); never branch on it
}
var ai = app.project.activeItem;
return __adp_json({
  ok: true,
  count: items.length,
  items: list,
  activeItem: ai === null ? null : { name: ai.name, typeName: String(ai.typeName) }
});
`,
  },
  // ---- Issue #16: animation / effects / render domains ----
  {
    id: "anim.setValue",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Property", "setValue")],
    args: ["compName", "layerName", "propertyPath", "value"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "value"]);
      jsLit(a.value); jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
prop.setValue(${jsLit(a.value)});
return __adp_json({ ok: true, property: "set" });
`,
  },
  {
    id: "anim.setKeyframe",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Property", "setValueAtKey")],
    args: ["compName", "layerName", "propertyPath", "time", "value"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "time", "value"]);
      if (typeof a.time !== "number" || !Number.isFinite(a.time)) throw new Error("time must be a finite number");
      jsLit(a.value); jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
prop.setValueAtKey(${a.time}, ${jsLit(a.value)});
return __adp_json({ ok: true, property: "keyframed", time: ${a.time} });
`,
  },
  {
    id: "anim.setExpression",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Property", "expression"), S("Property", "expressionEnabled")],
    args: ["compName", "layerName", "propertyPath", "expression"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "expression"]);
      if (typeof a.expression !== "string" || a.expression.length === 0) throw new Error("expression must be a non-empty string");
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
prop.expression = ${js(a.expression)};
prop.expressionEnabled = true;
return __adp_json({ ok: true, property: "expression-set" });
`,
  },
  {
    id: "effect.add",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("PropertyGroup", "addProperty")],
    args: ["compName", "layerName", "effectMatchName"],
    validate: (a) => requireArgs(a, ["compName", "layerName", "effectMatchName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var fx = layer.property("ADBE Effect Parade").addProperty(${js(a.effectMatchName)});
return __adp_json({ ok: true, effect: String(fx.name), matchName: ${js(a.effectMatchName)} });
`,
  },
  {
    id: "render.queueComp",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Project", "renderQueue"), S("RenderQueue", "items"), S("RenderQueueItem", "comp")],
    args: ["compName"],
    validate: (a) => requireArgs(a, ["compName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var item = app.project.renderQueue.items.add(comp);
return __adp_json({ ok: true, queued: comp.name, index: item.index });
`,
  },
  {
    id: "render.renderQueued",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("RenderQueue", "render"), S("RenderQueue", "rendering")],
    args: [],
    validate: () => {},
    source: () => `${PRELUDE}
app.project.renderQueue.render();
return __adp_json({ ok: true, rendered: true });
`,
  },
];

const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));

export function getOperation(id) {
  const op = BY_ID.get(id);
  if (!op) throw new Error(`unknown operation: ${id}`);
  return op;
}

export function opsForDomain(domain) {
  return OPERATIONS.filter((op) => op.domain === domain);
}

/**
 * Build the ExtendScript source for an operation. Validates args first;
 * the returned string is ready for runner.runScript({source}).
 */
export function buildSource(opId, args = {}) {
  const op = typeof opId === "string" ? getOperation(opId) : opId;
  if (typeof op.validate === "function") op.validate(args);
  return op.source(args);
}

export function registryReport() {
  return {
    schema: ADAPTER_SCHEMA,
    operationCount: OPERATIONS.length,
    mutating: OPERATIONS.filter((o) => o.mutating).length,
    destructive: OPERATIONS.filter((o) => o.destructive === true).length,
    readOnly: OPERATIONS.filter((o) => !o.mutating).length,
    domains: [...new Set(OPERATIONS.map((o) => o.domain))],
    operations: OPERATIONS.map((o) => ({
      id: o.id,
      domain: o.domain,
      permission: o.permission,
      mutating: o.mutating,
      memberCount: o.members.length,
    })),
  };
}
