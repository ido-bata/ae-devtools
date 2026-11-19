/*
 * registry.mjs — versioned operation registry for public After Effects
 * Scripting API adapters (Issue #15, CAP029–CAP032 groundwork).
 *
 * An *operation* is the unit callers use: it owns a stable id, the
 * catalog domain it belongs to, the inventory symbol ids it exercises,
 * a mutating flag, an argument schema, and a `source(args)` builder
 * that emits ES3 ExtendScript for the trusted-execution runner
 * (packages/ae-devtools-cli/trusted-execution/runner.mjs). Operations are NOT MCP
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
    members: [S("Property", "setValue"), S("Property", "value")],
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
    members: [S("Project", "activeItem"), S("Item", "name"), S("Item", "id"), S("Item", "typeName")],
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
    // setValueAtKey takes a 1-based KEY INDEX, not a time — confusing the
    // two silently writes the wrong keyframe (PR #47 review).
    id: "anim.setKeyframe",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Property", "setValueAtKey")],
    args: ["compName", "layerName", "propertyPath", "keyIndex", "value"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "keyIndex", "value"]);
      if (!Number.isInteger(a.keyIndex) || a.keyIndex < 1) throw new Error("keyIndex must be an integer >= 1");
      jsLit(a.value); jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
prop.setValueAtKey(${a.keyIndex}, ${jsLit(a.value)});
return __adp_json({ ok: true, property: "keyframed", keyIndex: ${a.keyIndex} });
`,
  },
  {
    // Time-based keyframing is a different API: setValueAtTime.
    id: "anim.setValueAtTime",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Property", "setValueAtTime")],
    args: ["compName", "layerName", "propertyPath", "time", "value"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "time", "value"]);
      if (typeof a.time !== "number" || !Number.isFinite(a.time)) throw new Error("time must be a finite number");
      jsLit(a.value); jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
prop.setValueAtTime(${a.time}, ${jsLit(a.value)});
return __adp_json({ ok: true, property: "keyframed-at-time", time: ${a.time} });
`,
  },
  {
    id: "anim.setExpression",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Property", "expression"), S("Property", "expressionEnabled"), S("Property", "canSetExpression"), S("Property", "expressionError")],
    args: ["compName", "layerName", "propertyPath", "expression"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "expression"]);
      if (typeof a.expression !== "string" || a.expression.length === 0) throw new Error("expression must be a non-empty string");
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
// canSetExpression is a Boolean attribute (inventory kind=attribute).
if (prop.canSetExpression === false) {
  __adp_fail("expression not allowed on this property");
}
prop.expression = ${js(a.expression)};
prop.expressionEnabled = true;
// Surface host-reported expressionError verbatim — never infer it.
return __adp_json({ ok: true, property: "expression-set", expressionError: String(prop.expressionError || "") });
`,
  },
  {
    id: "effect.add",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("PropertyGroup", "addProperty"), S("PropertyGroup", "canAddProperty")],
    args: ["compName", "layerName", "effectMatchName"],
    validate: (a) => requireArgs(a, ["compName", "layerName", "effectMatchName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var parade = layer.property("ADBE Effect Parade");
if (typeof parade.canAddProperty === "function" && !parade.canAddProperty(${js(a.effectMatchName)})) {
  __adp_fail("effect cannot be added: " + ${js(a.effectMatchName)});
}
var fx = parade.addProperty(${js(a.effectMatchName)});
return __adp_json({ ok: true, effect: String(fx.name), matchName: ${js(a.effectMatchName)} });
`,
  },
  {
    id: "render.queueComp",
    domain: "animation-effects-render",
    permission: "execute",
    mutating: true,
    members: [S("Project", "renderQueue"), S("RenderQueue", "items")],
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
    // Render contract (Issue #16 / #21): this op starts a REAL render in
    // AE — it writes output files per each queued item's Output Module
    // settings, can run far beyond the runner deadline, and a transport
    // UNKNOWN means render state is unknowable (AE may still be
    // rendering). execute.mjs therefore requires confirmRender:true in
    // addition to consent + consentProvider. Stop conditions: deadline
    // expiry or reply loss → UNKNOWN → quarantined, never retried;
    // callers must treat UNKNOWN as "render may be in progress" and
    // observe app.project.renderQueue.rendering before any re-dispatch.
    // Output destination/ownership verification is host-side and remains
    // UNVERIFIED until a real render runs on an owned session.
    requiresConfirm: "render",
    members: [S("RenderQueue", "render")],
    args: [],
    validate: () => {},
    source: () => `${PRELUDE}
app.project.renderQueue.render();
return __adp_json({ ok: true, rendered: true });
`,
  },
  // ---- Issue #254: read-side inspection ops (non-mutating) ----
  // These let the dev loop observe project state without mutating.
  // Claims list only symbol ids verified present in
  // inventories/scripting/generated/symbols.json; host properties the
  // source reads but the inventory does not yet carry (e.g. layer.name,
  // comp.width — owned by AVItem in the docs model) are read without a
  // claim rather than over-claiming.
  {
    id: "read.compLayers",
    title: "List layers of a comp (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "254",
    permission: "execute",
    mutating: false,
    members: [
      S("CompItem", "layers"),
      S("Layer", "index"), S("Layer", "inPoint"), S("Layer", "outPoint"),
      S("Layer", "parent"), S("Layer", "locked"),
    ],
    args: ["compName"],
    validate: (a) => requireArgs(a, ["compName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layers = comp.layers;
var list = [];
for (var i = 1; i <= layers.length; i++) {
  var l = layers[i];
  list.push({
    name: String(l.name),
    index: l.index,
    enabled: l.enabled !== false,
    inPoint: l.inPoint,
    outPoint: l.outPoint,
    locked: l.locked === true,
    parent: l.parent === null || l.parent === undefined ? null : String(l.parent.name)
  });
}
return __adp_json({ ok: true, comp: comp.name, count: layers.length, layers: list });
`,
  },
  {
    id: "read.layerDetail",
    title: "Single layer summary incl. transform position (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "254",
    permission: "execute",
    mutating: false,
    members: [
      S("Layer", "index"), S("Layer", "inPoint"), S("Layer", "outPoint"),
      S("Layer", "parent"), S("Layer", "locked"),
      S("PropertyGroup", "property"), S("Property", "value"),
    ],
    args: ["compName", "layerName"],
    validate: (a) => requireArgs(a, ["compName", "layerName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var pos = null;
try {
  pos = layer.property("ADBE Transform Group").property("ADBE Position").value;
} catch (e) { pos = null; }
return __adp_json({
  ok: true,
  comp: comp.name,
  layer: {
    name: String(layer.name),
    index: layer.index,
    enabled: layer.enabled !== false,
    inPoint: layer.inPoint,
    outPoint: layer.outPoint,
    locked: layer.locked === true,
    parent: layer.parent === null || layer.parent === undefined ? null : String(layer.parent.name),
    position: pos
  }
});
`,
  },
  {
    id: "read.propertyValue",
    title: "Read a property value by matchName path (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "254",
    permission: "execute",
    mutating: false,
    members: [
      S("PropertyGroup", "property"),
      S("Property", "value"), S("Property", "numKeys"), S("Property", "isTimeVarying"),
    ],
    args: ["compName", "layerName", "propertyPath"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath"]);
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
return __adp_json({
  ok: true,
  value: prop.value,
  numKeys: prop.numKeys,
  isTimeVarying: prop.isTimeVarying === true
});
`,
  },
  {
    id: "read.keyframes",
    title: "List keyframes of a property by matchName path (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "254",
    permission: "execute",
    mutating: false,
    members: [
      S("PropertyGroup", "property"),
      S("Property", "numKeys"), S("Property", "keyTime"), S("Property", "keyValue"),
    ],
    args: ["compName", "layerName", "propertyPath"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath"]);
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
var keys = [];
var n = prop.numKeys;
for (var i = 1; i <= n; i++) {
  keys.push({ index: i, time: prop.keyTime(i), value: prop.keyValue(i) });
}
return __adp_json({ ok: true, numKeys: n, keyframes: keys });
`,
  },
  {
    id: "read.renderQueueStatus",
    title: "Render queue items + rendering flag (non-mutating)",
    domain: "animation-effects-render",
    issue: "254",
    permission: "execute",
    mutating: false,
    members: [
      S("Project", "renderQueue"),
      S("RenderQueue", "items"), S("RenderQueue", "rendering"),
      S("RenderQueueItem", "comp"), S("RenderQueueItem", "status"),
      S("RenderQueueItem", "timeSpanStart"), S("RenderQueueItem", "timeSpanDuration"),
    ],
    args: [],
    source: () => `${PRELUDE}
var rq = app.project.renderQueue;
var items = rq.items;
var list = [];
for (var i = 1; i <= items.length; i++) {
  var it = items[i];
  list.push({
    index: it.index,
    comp: it.comp === null ? null : String(it.comp.name),
    status: it.status,
    timeSpanStart: it.timeSpanStart,
    timeSpanDuration: it.timeSpanDuration
  });
}
return __adp_json({ ok: true, rendering: rq.rendering === true, count: items.length, items: list });
`,
  },
  {
    id: "read.itemDetail",
    title: "Single project item detail (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "254",
    permission: "execute",
    mutating: false,
    members: [
      S("Item", "name"), S("Item", "id"), S("Item", "typeName"),
      S("AVItem", "duration"), S("AVItem", "width"), S("AVItem", "height"),
      S("AVItem", "pixelAspect"), S("AVItem", "frameRate"),
      S("CompItem", "numLayers"), S("CompItem", "resolutionFactor"),
    ],
    args: ["name"],
    validate: (a) => requireArgs(a, ["name"]),
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, null);
var detail = {
  name: String(it.name),
  id: it.id,
  typeName: String(it.typeName) // display-only (localized); never branch on it
};
// Media-bearing items (CompItem/FootageItem) expose AVItem fields;
// folders and other items do not — discriminate by instanceof.
if (it instanceof AVItem) {
  detail.duration = it.duration;
  detail.width = it.width;
  detail.height = it.height;
  detail.pixelAspect = it.pixelAspect;
  detail.frameRate = it.frameRate;
}
if (it instanceof CompItem) {
  detail.numLayers = it.numLayers;
  detail.resolutionFactor = it.resolutionFactor;
}
return __adp_json({ ok: true, item: detail });
`,
  },
  // ---- Issue #275: coverage batch — real-use ops over existing domains ----
  {
    id: "item.import",
    title: "Import a footage file into the project",
    domain: "project-items-comps-layers",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [S("Project", "importFile"), S("ImportOptions", "file")],
    args: ["path"],
    validate: (a) => {
      requireArgs(a, ["path"]);
      if (typeof a.path !== "string" || a.path.length === 0) {
        throw new Error("item.import: path must be a non-empty string");
      }
    },
    source: (a) => `${PRELUDE}
var io = new ImportOptions();
io.file = new File(${js(a.path)});
if (io.file.exists === false) __adp_fail("import file not found: " + ${js(a.path)});
var it = app.project.importFile(io);
return __adp_json({ ok: true, id: it.id, name: it.name, typeName: String(it.typeName) });
`,
  },
  {
    id: "comp.duplicate",
    title: "Duplicate a composition",
    domain: "project-items-comps-layers",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [S("CompItem", "duplicate"), S("Item", "name"), S("Item", "id")],
    args: ["name"],
    validate: (a) => requireArgs(a, ["name"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.name)}, CompItem);
var dup = comp.duplicate();
return __adp_json({ ok: true, source: comp.name, duplicate: dup.name, id: dup.id });
`,
  },
  {
    id: "item.setLabel",
    title: "Set a project item's label index",
    domain: "project-items-comps-layers",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [S("Item", "label"), S("Item", "name")],
    args: ["name", "type", "label"],
    validate: (a) => {
      requireArgs(a, ["name", "type", "label"]);
      if (["CompItem", "FolderItem", "FootageItem"].indexOf(a.type) === -1) {
        throw new Error("item.setLabel: type must be one of CompItem|FolderItem|FootageItem");
      }
      if (!Number.isInteger(a.label) || a.label < 0 || a.label > 16) {
        throw new Error("item.setLabel: label must be an integer 0-16");
      }
    },
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, ${a.type});
it.label = ${a.label};
return __adp_json({ ok: true, name: it.name, label: it.label });
`,
  },
  {
    id: "layer.setTiming",
    title: "Set a layer's startTime and/or stretch",
    domain: "project-items-comps-layers",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [S("Layer", "startTime"), S("Layer", "stretch")],
    args: ["compName", "layerName", "startTime", "stretch"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName"]);
      const hasStart = a.startTime !== undefined && a.startTime !== null;
      const hasStretch = a.stretch !== undefined && a.stretch !== null;
      if (!hasStart && !hasStretch) {
        throw new Error("layer.setTiming: at least one of startTime/stretch is required");
      }
      if (hasStart && !Number.isFinite(Number(a.startTime))) {
        throw new Error("layer.setTiming: startTime must be a finite number");
      }
      if (hasStretch) {
        const st = Number(a.stretch);
        if (!Number.isFinite(st) || st === 0) {
          throw new Error("layer.setTiming: stretch must be a finite non-zero number");
        }
      }
    },
    source: (a) => {
      const sets = [];
      if (a.startTime !== undefined && a.startTime !== null) sets.push(`layer.startTime = ${Number(a.startTime)};`);
      if (a.stretch !== undefined && a.stretch !== null) sets.push(`layer.stretch = ${Number(a.stretch)};`);
      return `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
${sets.join("\n")}
return __adp_json({ ok: true, layer: layer.name, startTime: layer.startTime, stretch: layer.stretch });
`;
    },
  },
  {
    id: "layer.setState",
    title: "Set a layer's solo/shy/locked/label state",
    domain: "project-items-comps-layers",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [S("Layer", "solo"), S("Layer", "shy"), S("Layer", "locked"), S("Layer", "label")],
    args: ["compName", "layerName", "solo", "shy", "locked", "label"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName"]);
      const flags = ["solo", "shy", "locked"].filter((k) => a[k] !== undefined && a[k] !== null);
      const hasLabel = a.label !== undefined && a.label !== null;
      if (flags.length === 0 && !hasLabel) {
        throw new Error("layer.setState: at least one of solo/shy/locked/label is required");
      }
      for (const k of flags) {
        if (typeof a[k] !== "boolean") throw new Error(`layer.setState: ${k} must be a boolean`);
      }
      if (hasLabel && (!Number.isInteger(a.label) || a.label < 0 || a.label > 16)) {
        throw new Error("layer.setState: label must be an integer 0-16");
      }
    },
    source: (a) => {
      const sets = [];
      for (const k of ["solo", "shy", "locked"]) {
        if (a[k] !== undefined && a[k] !== null) sets.push(`layer.${k} = ${a[k] ? "true" : "false"};`);
      }
      if (a.label !== undefined && a.label !== null) sets.push(`layer.label = ${a.label};`);
      return `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
${sets.join("\n")}
return __adp_json({
  ok: true, layer: layer.name,
  solo: layer.solo === true, shy: layer.shy === true,
  locked: layer.locked === true, label: layer.label
});
`;
    },
  },
  {
    id: "anim.removeKeyframe",
    title: "Remove a keyframe by 1-based key index",
    domain: "animation-effects-render",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [S("Property", "removeKey"), S("Property", "numKeys")],
    args: ["compName", "layerName", "propertyPath", "keyIndex"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "keyIndex"]);
      if (!Number.isInteger(a.keyIndex) || a.keyIndex < 1) {
        throw new Error("anim.removeKeyframe: keyIndex must be an integer >= 1");
      }
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
prop.removeKey(${a.keyIndex});
return __adp_json({ ok: true, property: "keyframe-removed", keyIndex: ${a.keyIndex}, numKeys: prop.numKeys });
`,
  },
  {
    id: "read.valueAtTime",
    title: "Read a property's value at a given time (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "275",
    permission: "execute",
    mutating: false,
    members: [
      S("PropertyGroup", "property"),
      S("Property", "valueAtTime"), S("Property", "numKeys"),
    ],
    args: ["compName", "layerName", "propertyPath", "time"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "time"]);
      if (typeof a.time !== "number" || !Number.isFinite(a.time)) {
        throw new Error("read.valueAtTime: time must be a finite number");
      }
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
return __adp_json({
  ok: true, time: ${a.time},
  value: prop.valueAtTime(${a.time}),
  numKeys: prop.numKeys
});
`,
  },
  {
    id: "render.setTimeSpan",
    title: "Set a queued item's render time span",
    domain: "animation-effects-render",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [
      S("Project", "renderQueue"),
      S("RenderQueue", "items"),
      S("RenderQueueItem", "comp"),
      S("RenderQueueItem", "timeSpanStart"), S("RenderQueueItem", "timeSpanDuration"),
    ],
    args: ["compName", "timeSpanStart", "timeSpanDuration"],
    validate: (a) => {
      requireArgs(a, ["compName", "timeSpanStart", "timeSpanDuration"]);
      for (const n of ["timeSpanStart", "timeSpanDuration"]) {
        if (typeof a[n] !== "number" || !Number.isFinite(a[n])) {
          throw new Error(`render.setTimeSpan: ${n} must be a finite number`);
        }
      }
    },
    source: (a) => `${PRELUDE}
var rq = app.project.renderQueue;
var items = rq.items;
var found = null;
var matches = 0;
for (var i = 1; i <= items.length; i++) {
  if (items[i].comp !== null && items[i].comp.name === ${js(a.compName)}) {
    found = items[i];
    matches++;
  }
}
if (matches === 0) __adp_fail("render queue has no item for comp '" + ${js(a.compName)} + "'");
if (matches > 1) __adp_fail("render queue has " + matches + " items for comp '" + ${js(a.compName)} + "': ambiguous");
found.timeSpanStart = ${Number(a.timeSpanStart)};
found.timeSpanDuration = ${Number(a.timeSpanDuration)};
return __adp_json({
  ok: true, comp: found.comp.name,
  timeSpanStart: found.timeSpanStart,
  timeSpanDuration: found.timeSpanDuration
});
`,
  },
  {
    id: "render.removeFromQueue",
    title: "Remove a comp's item from the render queue",
    domain: "animation-effects-render",
    issue: "275",
    permission: "execute",
    mutating: true,
    members: [
      S("Project", "renderQueue"),
      S("RenderQueue", "items"),
      S("RenderQueueItem", "comp"), S("RenderQueueItem", "remove"),
    ],
    args: ["compName"],
    validate: (a) => requireArgs(a, ["compName"]),
    source: (a) => `${PRELUDE}
var rq = app.project.renderQueue;
var items = rq.items;
var found = null;
var matches = 0;
for (var i = 1; i <= items.length; i++) {
  if (items[i].comp !== null && items[i].comp.name === ${js(a.compName)}) {
    found = items[i];
    matches++;
  }
}
if (matches === 0) __adp_fail("render queue has no item for comp '" + ${js(a.compName)} + "'");
if (matches > 1) __adp_fail("render queue has " + matches + " items for comp '" + ${js(a.compName)} + "': ambiguous");
found.remove();
return __adp_json({ ok: true, removed: ${js(a.compName)}, remaining: rq.items.length });
`,
  },
  // ---- Issue #279: coverage batch 2 — AVLayer state / property detail /
  // expression toggle / output module / comment / resolution ----
  {
    id: "layer.setAvState",
    title: "Set AV-layer flags (audio/3D/motion-blur/guide)",
    domain: "project-items-comps-layers",
    issue: "279",
    permission: "execute",
    mutating: true,
    members: [
      S("AVLayer", "audioEnabled"), S("AVLayer", "threeDLayer"),
      S("AVLayer", "motionBlur"), S("AVLayer", "guideLayer"),
    ],
    args: ["compName", "layerName", "audioEnabled", "threeDLayer", "motionBlur", "guideLayer"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName"]);
      const flags = ["audioEnabled", "threeDLayer", "motionBlur", "guideLayer"]
        .filter((k) => a[k] !== undefined && a[k] !== null);
      if (flags.length === 0) {
        throw new Error("layer.setAvState: at least one of audioEnabled/threeDLayer/motionBlur/guideLayer is required");
      }
      for (const k of flags) {
        if (typeof a[k] !== "boolean") throw new Error(`layer.setAvState: ${k} must be a boolean`);
      }
    },
    source: (a) => {
      const sets = [];
      for (const k of ["audioEnabled", "threeDLayer", "motionBlur", "guideLayer"]) {
        if (a[k] !== undefined && a[k] !== null) sets.push(`layer.${k} = ${a[k] ? "true" : "false"};`);
      }
      return `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
${sets.join("\n")}
return __adp_json({
  ok: true, layer: layer.name,
  audioEnabled: layer.audioEnabled === true,
  threeDLayer: layer.threeDLayer === true,
  motionBlur: layer.motionBlur === true,
  guideLayer: layer.guideLayer === true
});
`;
    },
  },
  {
    id: "read.propertyDetail",
    title: "Property metadata by matchName path (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "279",
    permission: "execute",
    mutating: false,
    members: [
      S("PropertyGroup", "property"),
      S("PropertyBase", "matchName"),
      S("Property", "value"), S("Property", "numKeys"), S("Property", "isTimeVarying"),
      S("Property", "expression"), S("Property", "expressionEnabled"),
      S("Property", "canSetExpression"), S("Property", "expressionError"),
      S("Property", "minValue"), S("Property", "maxValue"), S("Property", "propertyValueType"),
    ],
    args: ["compName", "layerName", "propertyPath"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath"]);
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
return __adp_json({
  ok: true,
  property: {
    matchName: prop.matchName === undefined || prop.matchName === null ? null : String(prop.matchName),
    value: prop.value,
    numKeys: prop.numKeys,
    isTimeVarying: prop.isTimeVarying === true,
    expression: String(prop.expression || ""),
    expressionEnabled: prop.expressionEnabled === true,
    canSetExpression: prop.canSetExpression !== false,
    expressionError: String(prop.expressionError || ""),
    minValue: prop.minValue === undefined ? null : prop.minValue,
    maxValue: prop.maxValue === undefined ? null : prop.maxValue,
    propertyValueType: prop.propertyValueType === undefined ? null : prop.propertyValueType
  }
});
`,
  },
  {
    id: "anim.setExpressionEnabled",
    title: "Enable/disable a property's expression without changing it",
    domain: "animation-effects-render",
    issue: "279",
    permission: "execute",
    mutating: true,
    members: [
      S("Property", "expressionEnabled"), S("Property", "canSetExpression"),
      S("PropertyGroup", "property"),
    ],
    args: ["compName", "layerName", "propertyPath", "enabled"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "enabled"]);
      if (typeof a.enabled !== "boolean") throw new Error("anim.setExpressionEnabled: enabled must be a boolean");
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
if (prop.canSetExpression === false) {
  __adp_fail("expression not allowed on this property");
}
prop.expressionEnabled = ${a.enabled ? "true" : "false"};
return __adp_json({
  ok: true, property: "expression-toggle",
  expressionEnabled: prop.expressionEnabled === true,
  expressionError: String(prop.expressionError || "")
});
`,
  },
  {
    id: "render.getOutputSettings",
    title: "Read a queued item's output module settings (non-mutating)",
    domain: "animation-effects-render",
    issue: "279",
    permission: "execute",
    mutating: false,
    members: [
      S("Project", "renderQueue"),
      S("RenderQueue", "items"),
      S("RenderQueueItem", "comp"), S("RenderQueueItem", "outputModule"),
      S("OutputModule", "name"), S("OutputModule", "getSettings"),
    ],
    args: ["compName"],
    validate: (a) => requireArgs(a, ["compName"]),
    source: (a) => `${PRELUDE}
var rq = app.project.renderQueue;
var items = rq.items;
var found = null;
var matches = 0;
for (var i = 1; i <= items.length; i++) {
  if (items[i].comp !== null && items[i].comp.name === ${js(a.compName)}) {
    found = items[i];
    matches++;
  }
}
if (matches === 0) __adp_fail("render queue has no item for comp '" + ${js(a.compName)} + "'");
if (matches > 1) __adp_fail("render queue has " + matches + " items for comp '" + ${js(a.compName)} + "': ambiguous");
var om = found.outputModule(1);
return __adp_json({
  ok: true, comp: found.comp.name,
  outputModule: String(om.name),
  settings: om.getSettings()
});
`,
  },
  {
    id: "render.setOutputSetting",
    title: "Set one output module setting on a queued item",
    domain: "animation-effects-render",
    issue: "279",
    permission: "execute",
    mutating: true,
    members: [
      S("Project", "renderQueue"),
      S("RenderQueue", "items"),
      S("RenderQueueItem", "comp"), S("RenderQueueItem", "outputModule"),
      S("OutputModule", "setSetting"),
    ],
    args: ["compName", "setting", "value"],
    validate: (a) => {
      requireArgs(a, ["compName", "setting", "value"]);
      if (typeof a.setting !== "string" || a.setting.length === 0) {
        throw new Error("render.setOutputSetting: setting must be a non-empty string");
      }
      const t = typeof a.value;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        throw new Error("render.setOutputSetting: value must be string|number|boolean");
      }
      if (t === "number" && !Number.isFinite(a.value)) {
        throw new Error("render.setOutputSetting: numeric value must be finite");
      }
    },
    source: (a) => `${PRELUDE}
var rq = app.project.renderQueue;
var items = rq.items;
var found = null;
var matches = 0;
for (var i = 1; i <= items.length; i++) {
  if (items[i].comp !== null && items[i].comp.name === ${js(a.compName)}) {
    found = items[i];
    matches++;
  }
}
if (matches === 0) __adp_fail("render queue has no item for comp '" + ${js(a.compName)} + "'");
if (matches > 1) __adp_fail("render queue has " + matches + " items for comp '" + ${js(a.compName)} + "': ambiguous");
var om = found.outputModule(1);
om.setSetting(${js(a.setting)}, ${js(a.value)});
return __adp_json({
  ok: true, comp: found.comp.name,
  setting: ${js(a.setting)},
  value: om.getSettings()[${js(a.setting)}]
});
`,
  },
  {
    id: "item.setComment",
    title: "Set a project item's comment",
    domain: "project-items-comps-layers",
    issue: "279",
    permission: "execute",
    mutating: true,
    members: [S("Item", "comment"), S("Item", "name")],
    args: ["name", "type", "comment"],
    validate: (a) => {
      requireArgs(a, ["name", "type", "comment"]);
      if (["CompItem", "FolderItem", "FootageItem"].indexOf(a.type) === -1) {
        throw new Error("item.setComment: type must be one of CompItem|FolderItem|FootageItem");
      }
      if (typeof a.comment !== "string") throw new Error("item.setComment: comment must be a string");
    },
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, ${a.type});
it.comment = ${js(a.comment)};
return __adp_json({ ok: true, name: it.name, comment: it.comment });
`,
  },
  {
    id: "comp.setResolutionFactor",
    title: "Set a comp's resolution factor",
    domain: "project-items-comps-layers",
    issue: "279",
    permission: "execute",
    mutating: true,
    members: [S("CompItem", "resolutionFactor"), S("Item", "name")],
    args: ["name", "resolutionFactor"],
    validate: (a) => {
      requireArgs(a, ["name", "resolutionFactor"]);
      const r = Number(a.resolutionFactor);
      if (!Number.isFinite(r) || r <= 0) {
        throw new Error("comp.setResolutionFactor: resolutionFactor must be a finite number > 0");
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.name)}, CompItem);
comp.resolutionFactor = ${Number(a.resolutionFactor)};
return __adp_json({ ok: true, comp: comp.name, resolutionFactor: comp.resolutionFactor });
`,
  },
  // ---- Issue #281: coverage batch 3 — layer creation + footage/project
  // read detail. Layer creation covers the dev-loop "generate content"
  // step; footage/project reads expose state the loop must verify. ----
  {
    id: "layer.addSolid",
    title: "Add a solid-color layer to a comp",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: true,
    members: [S("LayerCollection", "addSolid")],
    args: ["compName", "name", "width", "height", "pixelAspect", "color", "duration"],
    validate: (a) => {
      requireArgs(a, ["compName", "name", "width", "height", "pixelAspect", "color", "duration"]);
      for (const n of ["width", "height", "pixelAspect", "duration"]) {
        if (!Number.isFinite(Number(a[n]))) throw new Error(`layer.addSolid: ${n} must be a finite number`);
      }
      if (!Array.isArray(a.color) || a.color.length !== 3 ||
          a.color.some((c) => typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1)) {
        throw new Error("layer.addSolid: color must be [r,g,b] with components in 0..1");
      }
    },
    // Real signature: addSolid(color, name, width, height, pixelAspect, duration).
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addSolid(${jsLit(a.color)}, ${js(a.name)}, ${Number(a.width)}, ${Number(a.height)}, ${Number(a.pixelAspect)}, ${Number(a.duration)});
return __adp_json({ ok: true, layer: layer.name, index: layer.index });
`,
  },
  {
    id: "layer.addText",
    title: "Add a text layer with initial text",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: true,
    members: [S("LayerCollection", "addText"), S("TextDocument", "text")],
    args: ["compName", "name", "text"],
    validate: (a) => {
      requireArgs(a, ["compName", "name", "text"]);
      if (typeof a.text !== "string") throw new Error("layer.addText: text must be a string");
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addText(${js(a.name)});
// TextDocument is reached via the stable matchName path, not a
// locale-dependent display name.
var doc = layer.property("ADBE Text Properties").property("ADBE Text Document");
doc.text = ${js(a.text)};
return __adp_json({ ok: true, layer: layer.name, index: layer.index, text: doc.text });
`,
  },
  {
    id: "layer.addCamera",
    title: "Add a camera layer to a comp",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: true,
    members: [S("LayerCollection", "addCamera")],
    args: ["compName", "name"],
    validate: (a) => requireArgs(a, ["compName", "name"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addCamera(${js(a.name)});
return __adp_json({ ok: true, layer: layer.name, index: layer.index, threeDLayer: layer.threeDLayer === true });
`,
  },
  {
    id: "layer.addLight",
    title: "Add a light layer to a comp",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: true,
    members: [S("LayerCollection", "addLight")],
    args: ["compName", "name", "lightType", "intensity"],
    validate: (a) => {
      requireArgs(a, ["compName", "name"]);
      // Real signature: addLight(name, lightType, lightIntensity).
      // lightType is the LightType enum (1=parallel,2=spot,3=point,4=ambient).
      if (a.lightType !== undefined && a.lightType !== null &&
          (!Number.isInteger(a.lightType) || a.lightType < 1 || a.lightType > 4)) {
        throw new Error("layer.addLight: lightType must be an integer 1-4 (LightType enum)");
      }
      if (a.intensity !== undefined && a.intensity !== null &&
          !Number.isFinite(Number(a.intensity))) {
        throw new Error("layer.addLight: intensity must be a finite number");
      }
    },
    source: (a) => {
      const hasType = a.lightType !== undefined && a.lightType !== null;
      const hasIntensity = a.intensity !== undefined && a.intensity !== null;
      const args = [js(a.name)];
      if (hasType) args.push(String(a.lightType));
      if (hasIntensity) args.push(String(Number(a.intensity)));
      return `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addLight(${args.join(", ")});
return __adp_json({ ok: true, layer: layer.name, index: layer.index, threeDLayer: layer.threeDLayer === true });
`;
    },
  },
  {
    id: "text.setText",
    title: "Set a text layer's TextDocument text",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: true,
    members: [S("TextDocument", "text"), S("PropertyGroup", "property")],
    args: ["compName", "layerName", "text"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "text"]);
      if (typeof a.text !== "string") throw new Error("text.setText: text must be a string");
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var doc = layer.property("ADBE Text Properties").property("ADBE Text Document");
doc.text = ${js(a.text)};
return __adp_json({ ok: true, layer: layer.name, text: doc.text });
`,
  },
  {
    id: "read.footageDetail",
    title: "FootageItem + FootageSource detail (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: false,
    members: [
      S("AVItem", "hasVideo"), S("AVItem", "hasAudio"),
      S("AVItem", "frameDuration"), S("AVItem", "useProxy"),
      S("AVItem", "footageMissing"), S("AVItem", "duration"),
      S("FootageItem", "mainSource"), S("FootageItem", "file"),
      S("FileSource", "file"),
      S("FootageSource", "alphaMode"), S("FootageSource", "hasAlpha"),
      S("FootageSource", "isStill"), S("FootageSource", "loop"),
      S("FootageSource", "nativeFrameRate"), S("FootageSource", "conformFrameRate"),
      S("FileSource", "missingFootagePath"),
    ],
    args: ["name"],
    validate: (a) => requireArgs(a, ["name"]),
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, FootageItem);
var src = it.mainSource;
return __adp_json({
  ok: true,
  item: {
    name: String(it.name),
    hasVideo: it.hasVideo === true,
    hasAudio: it.hasAudio === true,
    frameDuration: it.frameDuration,
    useProxy: it.useProxy === true,
    footageMissing: it.footageMissing === true,
    duration: it.duration,
    width: it.width,
    height: it.height,
    pixelAspect: it.pixelAspect,
    frameRate: it.frameRate
  },
  source: {
    file: src.file === null || src.file === undefined ? null : String(src.file.fsName),
    alphaMode: String(src.alphaMode),
    hasAlpha: src.hasAlpha === true,
    isStill: src.isStill === true,
    loop: src.loop === true,
    nativeFrameRate: src.nativeFrameRate,
    conformFrameRate: src.conformFrameRate === true,
    missingFootagePath: String(src.missingFootagePath || "")
  }
});
`,
  },
  {
    id: "read.projectSettings",
    title: "Project settings snapshot (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "281",
    permission: "execute",
    mutating: false,
    members: [
      S("Project", "bitsPerChannel"), S("Project", "expressionEngine"),
      S("Project", "displayStartFrame"), S("Project", "framesUseFeetFrames"),
      S("Project", "footageTimecodeDisplayStartType"), S("Project", "file"),
    ],
    args: [],
    source: () => `${PRELUDE}
var p = app.project;
return __adp_json({
  ok: true,
  settings: {
    bitsPerChannel: p.bitsPerChannel,
    expressionEngine: p.expressionEngine,
    displayStartFrame: p.displayStartFrame,
    framesUseFeetFrames: p.framesUseFeetFrames === true,
    footageTimecodeDisplayStartType: p.footageTimecodeDisplayStartType,
    file: p.file === null || p.file === undefined ? null : String(p.file.fsName)
  }
});
`,
  },
  // ---- Issue #283: coverage batch 4 — Preferences + app info ----
  {
    id: "pref.get",
    title: "Read a preference value by section/key/type",
    domain: "project-items-comps-layers",
    issue: "283",
    permission: "execute",
    mutating: false,
    members: [
      S("Preferences", "havePref"),
      S("Preferences", "getPrefAsString"), S("Preferences", "getPrefAsBool"),
      S("Preferences", "getPrefAsLong"), S("Preferences", "getPrefAsFloat"),
    ],
    args: ["section", "key", "type", "default"],
    validate: (a) => {
      requireArgs(a, ["section", "key", "type"]);
      if (!["string", "bool", "long", "float"].includes(a.type)) {
        throw new Error("pref.get: type must be one of string|bool|long|float");
      }
      if (a.type === "bool" && a.default !== undefined && typeof a.default !== "boolean") {
        throw new Error("pref.get: bool default must be a boolean");
      }
      if ((a.type === "long" || a.type === "float") && a.default !== undefined &&
          (typeof a.default !== "number" || !Number.isFinite(a.default))) {
        throw new Error(`pref.get: ${a.type} default must be a finite number`);
      }
    },
    source: (a) => `${PRELUDE}
var p = app.preferences;
var exists = (typeof p.havePref === "function") ? p.havePref(${js(a.section)}, ${js(a.key)}) : null;
var v;
${a.type === "string" ? `v = p.getPrefAsString(${js(a.section)}, ${js(a.key)}, ${a.default === undefined ? '""' : js(a.default)});` : ""}
${a.type === "bool" ? `v = p.getPrefAsBool(${js(a.section)}, ${js(a.key)}, ${a.default === undefined ? "false" : js(a.default)});` : ""}
${a.type === "long" ? `v = p.getPrefAsLong(${js(a.section)}, ${js(a.key)}, ${a.default === undefined ? "0" : String(Number(a.default))});` : ""}
${a.type === "float" ? `v = p.getPrefAsFloat(${js(a.section)}, ${js(a.key)}, ${a.default === undefined ? "0" : String(Number(a.default))});` : ""}
return __adp_json({ ok: true, section: ${js(a.section)}, key: ${js(a.key)}, type: ${js(a.type)}, exists: exists, value: v });
`,
  },
  {
    id: "pref.set",
    title: "Write a preference value by section/key/type",
    domain: "project-items-comps-layers",
    issue: "283",
    permission: "execute",
    mutating: true,
    members: [
      S("Preferences", "savePrefAsString"), S("Preferences", "savePrefAsBool"),
      S("Preferences", "savePrefAsLong"), S("Preferences", "savePrefAsFloat"),
    ],
    args: ["section", "key", "type", "value"],
    validate: (a) => {
      requireArgs(a, ["section", "key", "type", "value"]);
      if (!["string", "bool", "long", "float"].includes(a.type)) {
        throw new Error("pref.set: type must be one of string|bool|long|float");
      }
      const t = a.type;
      const v = a.value;
      const okType =
        (t === "string" && typeof v === "string") ||
        (t === "bool" && typeof v === "boolean") ||
        (t === "long" && Number.isInteger(v)) ||
        (t === "float" && typeof v === "number" && Number.isFinite(v));
      if (!okType) throw new Error(`pref.set: value type does not match type '${t}'`);
    },
    source: (a) => `${PRELUDE}
var p = app.preferences;
${a.type === "string" ? `p.savePrefAsString(${js(a.section)}, ${js(a.key)}, ${js(a.value)});` : ""}
${a.type === "bool" ? `p.savePrefAsBool(${js(a.section)}, ${js(a.key)}, ${a.value ? "true" : "false"});` : ""}
${a.type === "long" ? `p.savePrefAsLong(${js(a.section)}, ${js(a.key)}, ${a.value});` : ""}
${a.type === "float" ? `p.savePrefAsFloat(${js(a.section)}, ${js(a.key)}, ${a.value});` : ""}
return __adp_json({ ok: true, section: ${js(a.section)}, key: ${js(a.key)}, type: ${js(a.type)} });
`,
  },
  {
    id: "pref.delete",
    title: "Delete a preference entry",
    domain: "project-items-comps-layers",
    issue: "283",
    permission: "execute",
    mutating: true,
    destructive: true,
    members: [S("Preferences", "deletePref"), S("Preferences", "havePref")],
    args: ["section", "key"],
    validate: (a) => requireArgs(a, ["section", "key"]),
    source: (a) => `${PRELUDE}
var p = app.preferences;
p.deletePref(${js(a.section)}, ${js(a.key)});
return __adp_json({
  ok: true, section: ${js(a.section)}, key: ${js(a.key)},
  exists: (typeof p.havePref === "function") ? p.havePref(${js(a.section)}, ${js(a.key)}) : null
});
`,
  },
  {
    id: "pref.saveToDisk",
    title: "Flush preferences to disk",
    domain: "project-items-comps-layers",
    issue: "283",
    permission: "execute",
    mutating: true,
    members: [S("Preferences", "saveToDisk")],
    args: [],
    source: () => `${PRELUDE}
app.preferences.saveToDisk();
return __adp_json({ ok: true, saved: true });
`,
  },
  {
    id: "read.appInfo",
    title: "App version/build/language + effects + fonts (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "283",
    permission: "execute",
    mutating: false,
    members: [
      S("app", "version"), S("app", "buildName"), S("app", "buildNumber"),
      S("app", "isoLanguage"), S("app", "effects"), S("app", "fonts"),
    ],
    args: [],
    source: () => `${PRELUDE}
var fx = [];
var effects = app.effects;
if (effects !== null && effects !== undefined) {
  for (var i = 1; i <= effects.length; i++) {
    fx.push(String(effects[i].matchName));
  }
}
var fn = [];
var fonts = app.fonts;
if (fonts !== null && fonts !== undefined) {
  for (var j = 1; j <= fonts.length; j++) {
    fn.push(String(fonts[j].name));
  }
}
return __adp_json({
  ok: true,
  app: {
    version: String(app.version),
    buildName: String(app.buildName),
    buildNumber: app.buildNumber,
    isoLanguage: String(app.isoLanguage),
    effects: fx,
    fonts: fn
  }
});
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
    // Evidence accounting is deliberately separated: implemented ops,
    // automated tests, and fake-host verification are NOT real-host
    // verification. realHostVerified stays 0 until an owned AE session
    // runs the disposable-project conformance suite (Issue #15/#16).
    evidence: {
      implemented: OPERATIONS.length,
      automatedTest: OPERATIONS.length,
      fakeMockVerified: OPERATIONS.length,
      realHostVerified: 0,
      level: "fake/mock only",
    },
    operations: OPERATIONS.map((o) => ({
      id: o.id,
      domain: o.domain,
      permission: o.permission,
      mutating: o.mutating,
      memberCount: o.members.length,
    })),
  };
}
