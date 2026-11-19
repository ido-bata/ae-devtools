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
 *   - Object references are resolved through a common item selector
 *     inside the generated source — legacy name strings keep the
 *     project-wide name+type search, while itemRef objects
 *     {id?, name?, path?, project?} add stable-id, folder-path, and
 *     saved-project consistency checks with ambiguity/mismatch
 *     refusal (CAP031, Issue #293).
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
function __adp_typeMatch(it, ctor) {
  if (ctor === null) return true;
  try { return it instanceof ctor; } catch (e) { return false; }
}
function __adp_findInColl(coll, name, ctor, scope) {
  var found = null;
  var sawName = false;
  for (var i = 1; i <= coll.length; i++) {
    var it = coll[i];
    if (it.name === name) {
      sawName = true;
      if (__adp_typeMatch(it, ctor)) {
        if (found !== null) {
          __adp_fail("ambiguous " + scope + " name '" + name + "': multiple matches — qualify with id or path");
        }
        found = it;
      }
    }
  }
  if (found !== null) return found;
  if (sawName) __adp_fail("name '" + name + "' exists but is not the requested type");
  __adp_fail(scope + " not found: " + name);
  return null;
}
function __adp_isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
function __adp_resolveFolderPath(path) {
  if (path === undefined || path === null) return null;
  if (!__adp_isArray(path)) __adp_fail("item path must be an array of folder names");
  var cur = app.project.rootFolder;
  for (var i = 0; i < path.length; i++) {
    var seg = path[i];
    if (typeof seg !== "string" || seg.length === 0) __adp_fail("item path segment must be a non-empty string");
    var found = null;
    var count = 0;
    var coll = cur.items;
    for (var j = 1; j <= coll.length; j++) {
      var it = coll[j];
      if (it instanceof FolderItem && it.name === seg) { count++; found = it; }
    }
    if (count === 0) __adp_fail("folder path not found at '" + seg + "'");
    if (count > 1) __adp_fail("ambiguous folder path segment '" + seg + "': rename folders or qualify deeper");
    cur = found;
  }
  return cur;
}
function __adp_findItemRef(ref, ctor) {
  var id = ref.id;
  var name = ref.name;
  var path = ref.path;
  var project = ref.project;
  if (project !== undefined && project !== null) {
    if (typeof project !== "string") __adp_fail("item ref project must be a project file path string");
    var pf = app.project.file;
    if (pf === null || pf === undefined) __adp_fail("item ref project check requires a saved project file");
    if (String(pf.fsName) !== project) __adp_fail("item ref project mismatch");
  }
  if (id !== undefined && id !== null) {
    if (typeof id !== "number" || !isFinite(id) || Math.floor(id) !== id) {
      __adp_fail("item ref id must be an integer");
    }
    var byId = app.project.itemByID(id);
    if (byId === null) __adp_fail("item not found: id " + id);
    if (!__adp_typeMatch(byId, ctor)) __adp_fail("item id " + id + " exists but is not the requested type");
    if (name !== undefined && name !== null && byId.name !== name) {
      __adp_fail("item id/name mismatch: id " + id + " is '" + byId.name + "', not '" + name + "'");
    }
    if (path !== undefined && path !== null) {
      var wantFolder = __adp_resolveFolderPath(path);
      var actualFolder = byId.parentFolder;
      var sameFolder = actualFolder === wantFolder;
      if (!sameFolder && actualFolder !== null && actualFolder !== undefined &&
          wantFolder !== null && actualFolder.id !== undefined && actualFolder.id === wantFolder.id) {
        sameFolder = true;
      }
      if (!sameFolder) __adp_fail("item id/path mismatch: id " + id);
    }
    return byId;
  }
  if (name === undefined || name === null) __adp_fail("item ref requires id or name");
  var folder = __adp_resolveFolderPath(path);
  var coll = folder === null ? __adp_items() : folder.items;
  var scope = folder === null ? "item" : "item in folder path";
  return __adp_findInColl(coll, name, ctor, scope);
}
function __adp_findItem(name, ctor) {
  if (name !== null && typeof name === "object") return __adp_findItemRef(name, ctor);
  return __adp_findInColl(__adp_items(), name, ctor, "item");
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

// Item selectors accept either a legacy name string or an itemRef
// object {id?, name?, path?, project?}. The ExtendScript resolver
// enforces the actual guarantees; this only keeps non-selector values
// out early.
function isItemRef(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFolderSelector(v) {
  return typeof v === "string" || isItemRef(v);
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
    members: [S("ItemCollection", "addComp"), S("Item", "parentFolder"), S("Project", "rootFolder")],
    args: ["name", "width", "height", "pixelAspect", "duration", "frameRate", "parentFolder"],
    validate: (a) => {
      requireArgs(a, ["name", "width", "height", "pixelAspect", "duration", "frameRate"]);
      for (const n of ["width", "height", "pixelAspect", "duration", "frameRate"]) {
        if (!Number.isFinite(Number(a[n]))) throw new Error(`item.addComp: ${n} must be a finite number`);
      }
      if (a.parentFolder !== undefined && a.parentFolder !== null && !isFolderSelector(a.parentFolder)) {
        throw new Error("item.addComp: parentFolder must be a folder name/itemRef or null for root");
      }
    },
    source: (a) => `${PRELUDE}
var parent = app.project.rootFolder;
var coll = app.project.items;
${a.parentFolder !== undefined && a.parentFolder !== null ? `parent = __adp_findItem(${js(a.parentFolder)}, FolderItem); coll = parent.items;` : ""}
var comp = coll.addComp(${js(a.name)}, ${Number(a.width)}, ${Number(a.height)}, ${Number(a.pixelAspect)}, ${Number(a.duration)}, ${Number(a.frameRate)});
return __adp_json({ ok: true, id: comp.id, name: comp.name, parent: comp.parentFolder === app.project.rootFolder ? null : String(comp.parentFolder.name) });
`,
  },
  {
    id: "item.addFolder",
    title: "Add a folder to the project",
    domain: "project-items-comps-layers",
    issue: "15",
    permission: "execute",
    mutating: true,
    members: [S("ItemCollection", "addFolder"), S("Item", "parentFolder"), S("Project", "rootFolder")],
    args: ["name", "parentFolder"],
    validate: (a) => {
      requireArgs(a, ["name"]);
      if (a.parentFolder !== undefined && a.parentFolder !== null && !isFolderSelector(a.parentFolder)) {
        throw new Error("item.addFolder: parentFolder must be a folder name/itemRef or null for root");
      }
    },
    source: (a) => `${PRELUDE}
var coll = app.project.items;
${a.parentFolder !== undefined && a.parentFolder !== null ? `var parent = __adp_findItem(${js(a.parentFolder)}, FolderItem); coll = parent.items;` : ""}
var f = coll.addFolder(${js(a.name)});
return __adp_json({ ok: true, id: f.id, name: f.name, parent: f.parentFolder === app.project.rootFolder ? null : String(f.parentFolder.name) });
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
    id: "item.setParentFolder",
    title: "Move a project item into a folder (or back to root)",
    domain: "project-items-comps-layers",
    issue: "291",
    permission: "execute",
    mutating: true,
    members: [S("Item", "parentFolder"), S("Project", "rootFolder"), S("Item", "name"), S("Item", "id"), S("Item", "typeName")],
    args: ["name", "type", "parentFolder"],
    validate: (a) => {
      requireArgs(a, ["name", "type"]);
      if (["CompItem", "FolderItem", "FootageItem"].indexOf(a.type) === -1) {
        throw new Error("item.setParentFolder: type must be one of CompItem|FolderItem|FootageItem");
      }
      if (a.parentFolder !== undefined && a.parentFolder !== null && !isFolderSelector(a.parentFolder)) {
        throw new Error("item.setParentFolder: parentFolder must be a folder name/itemRef or null for root");
      }
    },
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, ${a.type});
var parent = ${a.parentFolder === undefined || a.parentFolder === null ? "app.project.rootFolder" : `__adp_findItem(${js(a.parentFolder)}, FolderItem)`};
it.parentFolder = parent;
return __adp_json({ ok: true, name: it.name, id: it.id, parent: it.parentFolder === app.project.rootFolder ? null : String(it.parentFolder.name) });
`,
  },
  {
    id: "item.setSelected",
    title: "Select or deselect a project item",
    domain: "project-items-comps-layers",
    issue: "291",
    permission: "execute",
    mutating: true,
    members: [S("Item", "selected"), S("Project", "selection"), S("Item", "name"), S("Item", "id"), S("Item", "typeName")],
    args: ["name", "type", "selected"],
    validate: (a) => {
      requireArgs(a, ["name", "type", "selected"]);
      if (["CompItem", "FolderItem", "FootageItem"].indexOf(a.type) === -1) {
        throw new Error("item.setSelected: type must be one of CompItem|FolderItem|FootageItem");
      }
      if (typeof a.selected !== "boolean") throw new Error("item.setSelected: selected must be boolean");
    },
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, ${a.type});
it.selected = ${a.selected === true ? "true" : "false"};
var sel = app.project.selection;
var names = [];
for (var i = 0; i < sel.length; i++) names.push(String(sel[i].name));
return __adp_json({ ok: true, name: it.name, selected: it.selected === true, selection: names });
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
    members: [S("Project", "activeItem"), S("Project", "items"), S("Project", "numItems"), S("Project", "rootFolder"), S("Project", "selection"), S("Item", "name"), S("Item", "id"), S("Item", "typeName"), S("Item", "parentFolder"), S("Item", "selected")],
    args: [],
    source: () => `${PRELUDE}
var items = __adp_items();
var list = [];
for (var i = 1; i <= items.length; i++) {
  var it = items[i];
  list.push({
    name: it.name, typeName: String(it.typeName), id: it.id, // typeName is display-only (localized); never branch on it
    selected: it.selected === true,
    parent: it.parentFolder === app.project.rootFolder ? null : String(it.parentFolder.name)
  });
}
var ai = app.project.activeItem;
var sel = app.project.selection;
var selNames = [];
for (var s = 0; s < sel.length; s++) selNames.push(String(sel[s].name));
return __adp_json({
  ok: true,
  count: items.length,
  numItems: app.project.numItems,
  items: list,
  activeItem: ai === null ? null : { name: ai.name, typeName: String(ai.typeName) },
  selection: selNames
});
`,
  },
  {
    id: "read.projectTree",
    title: "Read the Project panel folder hierarchy (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "291",
    permission: "execute",
    mutating: false,
    members: [S("Project", "rootFolder"), S("Project", "numItems"), S("Project", "selection"), S("FolderItem", "numItems"), S("FolderItem", "item"), S("Item", "name"), S("Item", "id"), S("Item", "typeName"), S("Item", "parentFolder"), S("Item", "selected")],
    args: [],
    source: () => `${PRELUDE}
function __adp_brief(it) {
  return {
    name: String(it.name), id: it.id, typeName: String(it.typeName), // display-only (localized)
    selected: it.selected === true,
    parent: it.parentFolder === app.project.rootFolder ? null : String(it.parentFolder.name)
  };
}
function __adp_tree(folder) {
  var out = [];
  for (var i = 1; i <= folder.numItems; i++) {
    var it = folder.item(i);
    var node = __adp_brief(it);
    if (it instanceof FolderItem) {
      node.numItems = it.numItems;
      node.children = __adp_tree(it);
    }
    out.push(node);
  }
  return out;
}
var sel = app.project.selection;
var selNames = [];
for (var s = 0; s < sel.length; s++) selNames.push(String(sel[s].name));
return __adp_json({ ok: true, numItems: app.project.numItems, root: __adp_tree(app.project.rootFolder), selection: selNames });
`,
  },
  {
    id: "read.itemById",
    title: "Read a project item by stable id (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "291",
    permission: "execute",
    mutating: false,
    members: [S("Project", "itemByID"), S("Item", "id"), S("Item", "name"), S("Item", "typeName"), S("Item", "parentFolder"), S("Item", "selected")],
    args: ["id"],
    validate: (a) => {
      requireArgs(a, ["id"]);
      if (!Number.isInteger(a.id)) throw new Error("read.itemById: id must be an integer");
    },
    source: (a) => `${PRELUDE}
var it = app.project.itemByID(${a.id});
if (it === null) __adp_fail("item not found: id " + ${a.id});
return __adp_json({
  ok: true,
  item: {
    name: String(it.name), id: it.id, typeName: String(it.typeName),
    selected: it.selected === true,
    parent: it.parentFolder === app.project.rootFolder ? null : String(it.parentFolder.name)
  }
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
      S("AVLayer", "adjustmentLayer"), S("AVLayer", "preserveTransparency"),
      S("AVLayer", "frameBlending"), S("AVLayer", "collapseTransformation"),
      S("AVLayer", "hasTrackMatte"), S("AVLayer", "trackMatteType"),
      S("AVLayer", "trackMatteLayer"), S("AVLayer", "isTrackMatte"),
      S("AVLayer", "timeRemapEnabled"),
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
    adjustmentLayer: l.adjustmentLayer === true,
    preserveTransparency: l.preserveTransparency !== false,
    frameBlending: l.frameBlending === true,
    collapseTransformation: l.collapseTransformation === true,
    hasTrackMatte: l.hasTrackMatte === true,
    trackMatteType: l.trackMatteType === undefined ? 0 : l.trackMatteType,
    trackMatteLayer: l.trackMatteLayer === null || l.trackMatteLayer === undefined ? null : String(l.trackMatteLayer.name),
    isTrackMatte: l.isTrackMatte === true,
    timeRemapEnabled: l.timeRemapEnabled === true,
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
      S("AVLayer", "adjustmentLayer"), S("AVLayer", "preserveTransparency"),
      S("AVLayer", "frameBlending"), S("AVLayer", "collapseTransformation"),
      S("AVLayer", "source"), S("AVLayer", "replaceSource"),
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
    adjustmentLayer: layer.adjustmentLayer === true,
    preserveTransparency: layer.preserveTransparency !== false,
    frameBlending: layer.frameBlending === true,
    collapseTransformation: layer.collapseTransformation === true,
    source: layer.source === null || layer.source === undefined ? null : String(layer.source.name),
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
      S("RenderQueueItem", "startTime"), S("RenderQueueItem", "skipFrames"),
      S("RenderQueueItem", "logType"), S("RenderQueueItem", "elapsedSeconds"),
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
    timeSpanDuration: it.timeSpanDuration,
    startTime: it.startTime,
    skipFrames: it.skipFrames,
    logType: it.logType,
    elapsedSeconds: it.elapsedSeconds
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
// folders and other items do not. AVItem/Item are documentation base
// classes, not ExtendScript globals — branch on the concrete classes.
if (it instanceof CompItem || it instanceof FootageItem) {
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
    args: ["compName", "name", "centerPoint"],
    validate: (a) => {
      requireArgs(a, ["compName", "name", "centerPoint"]);
      jsLit(a.centerPoint);
      if (!Array.isArray(a.centerPoint) || a.centerPoint.length !== 2) {
        throw new Error("layer.addCamera: centerPoint must be [x, y]");
      }
    },
    // Real signature: addCamera(name, centerPoint); z is set to 0 by AE.
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addCamera(${js(a.name)}, ${jsLit(a.centerPoint)});
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
    args: ["compName", "name", "centerPoint"],
    validate: (a) => {
      requireArgs(a, ["compName", "name", "centerPoint"]);
      jsLit(a.centerPoint);
      if (!Array.isArray(a.centerPoint) || a.centerPoint.length !== 2) {
        throw new Error("layer.addLight: centerPoint must be [x, y]");
      }
    },
    // Real signature: addLight(name, centerPoint). Light type/intensity
    // are layer properties set after creation, not addLight arguments.
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = comp.layers.addLight(${js(a.name)}, ${jsLit(a.centerPoint)});
return __adp_json({ ok: true, layer: layer.name, index: layer.index, threeDLayer: layer.threeDLayer === true });
`,
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
    id: "text.setStyle",
    title: "Set TextDocument style fields (font/size/style/justification/color/tracking/leading)",
    domain: "project-items-comps-layers",
    issue: "285",
    permission: "execute",
    mutating: true,
    members: [
      S("TextDocument", "font"), S("TextDocument", "fontSize"),
      S("TextDocument", "fontStyle"), S("TextDocument", "justification"),
      S("TextDocument", "fillColor"), S("TextDocument", "tracking"),
      S("TextDocument", "leading"), S("PropertyGroup", "property"),
    ],
    args: ["compName", "layerName", "font", "fontSize", "fontStyle", "justification", "fillColor", "tracking", "leading"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName"]);
      const set = ["font", "fontSize", "fontStyle", "justification", "fillColor", "tracking", "leading"]
        .filter((k) => a[k] !== undefined);
      if (set.length === 0) {
        throw new Error("text.setStyle: at least one style field is required");
      }
      if (a.font !== undefined && typeof a.font !== "string") throw new Error("text.setStyle: font must be a string");
      if (a.fontStyle !== undefined && typeof a.fontStyle !== "string") throw new Error("text.setStyle: fontStyle must be a string");
      if (a.fontSize !== undefined && !(typeof a.fontSize === "number" && Number.isFinite(a.fontSize) && a.fontSize > 0)) {
        throw new Error("text.setStyle: fontSize must be a positive finite number");
      }
      // ParagraphJustification enum: 0=LEFT, 1=CENTER, 2=RIGHT,
      // 3-6=FULL_JUSTIFY_LASTLINE_*, 7=MULTIPLE_JUSTIFICATIONS.
      if (a.justification !== undefined && !(Number.isInteger(a.justification) && a.justification >= 0 && a.justification <= 7)) {
        throw new Error("text.setStyle: justification must be an integer 0-7 (ParagraphJustification)");
      }
      if (a.fillColor !== undefined) {
        if (!Array.isArray(a.fillColor) || a.fillColor.length !== 3 ||
            a.fillColor.some((c) => typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1)) {
          throw new Error("text.setStyle: fillColor must be [r,g,b] with components in 0..1");
        }
      }
      if (a.tracking !== undefined && !(typeof a.tracking === "number" && Number.isFinite(a.tracking))) {
        throw new Error("text.setStyle: tracking must be a finite number");
      }
      if (a.leading !== undefined && !(typeof a.leading === "number" && Number.isFinite(a.leading) && a.leading >= 0)) {
        throw new Error("text.setStyle: leading must be a non-negative finite number");
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var doc = layer.property("ADBE Text Properties").property("ADBE Text Document");
${a.font !== undefined ? `doc.font = ${js(a.font)};` : ""}
${a.fontSize !== undefined ? `doc.fontSize = ${a.fontSize};` : ""}
${a.fontStyle !== undefined ? `doc.fontStyle = ${js(a.fontStyle)};` : ""}
${a.justification !== undefined ? `doc.justification = ${a.justification};` : ""}
${a.fillColor !== undefined ? `doc.fillColor = [${a.fillColor.join(", ")}];` : ""}
${a.tracking !== undefined ? `doc.tracking = ${a.tracking};` : ""}
${a.leading !== undefined ? `doc.leading = ${a.leading};` : ""}
return __adp_json({
  ok: true, layer: layer.name,
  font: doc.font, fontSize: doc.fontSize, fontStyle: doc.fontStyle,
  justification: doc.justification, fillColor: doc.fillColor,
  tracking: doc.tracking, leading: doc.leading
});
`,
  },
  {
    id: "text.readStyle",
    title: "Read a text layer's TextDocument text + style (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "285",
    permission: "execute",
    mutating: false,
    members: [
      S("TextDocument", "text"), S("TextDocument", "font"),
      S("TextDocument", "fontSize"), S("TextDocument", "fontStyle"),
      S("TextDocument", "justification"), S("TextDocument", "fillColor"),
      S("TextDocument", "tracking"), S("TextDocument", "leading"),
      S("PropertyGroup", "property"),
    ],
    args: ["compName", "layerName"],
    validate: (a) => requireArgs(a, ["compName", "layerName"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var doc = layer.property("ADBE Text Properties").property("ADBE Text Document");
return __adp_json({
  ok: true, layer: layer.name, text: doc.text,
  font: doc.font, fontSize: doc.fontSize, fontStyle: doc.fontStyle,
  justification: doc.justification, fillColor: doc.fillColor,
  tracking: doc.tracking, leading: doc.leading
});
`,
  },
  {
    id: "layer.setLayerFlags",
    title: "Set AVLayer stacking/render flags (adjustment/preserveTransparency/frameBlending/collapseTransformation)",
    domain: "project-items-comps-layers",
    issue: "285",
    permission: "execute",
    mutating: true,
    members: [
      S("AVLayer", "adjustmentLayer"), S("AVLayer", "preserveTransparency"),
      S("AVLayer", "frameBlending"), S("AVLayer", "collapseTransformation"),
    ],
    args: ["compName", "layerName", "adjustmentLayer", "preserveTransparency", "frameBlending", "collapseTransformation"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName"]);
      const flags = ["adjustmentLayer", "preserveTransparency", "frameBlending", "collapseTransformation"];
      const set = flags.filter((k) => a[k] !== undefined);
      if (set.length === 0) {
        throw new Error("layer.setLayerFlags: at least one flag is required");
      }
      for (const k of set) {
        if (typeof a[k] !== "boolean") throw new Error(`layer.setLayerFlags: ${k} must be a boolean`);
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
${a.adjustmentLayer !== undefined ? `layer.adjustmentLayer = ${a.adjustmentLayer ? "true" : "false"};` : ""}
${a.preserveTransparency !== undefined ? `layer.preserveTransparency = ${a.preserveTransparency ? "true" : "false"};` : ""}
${a.frameBlending !== undefined ? `layer.frameBlending = ${a.frameBlending ? "true" : "false"};` : ""}
${a.collapseTransformation !== undefined ? `layer.collapseTransformation = ${a.collapseTransformation ? "true" : "false"};` : ""}
return __adp_json({
  ok: true, layer: layer.name,
  adjustmentLayer: layer.adjustmentLayer === true,
  preserveTransparency: layer.preserveTransparency !== false,
  frameBlending: layer.frameBlending === true,
  collapseTransformation: layer.collapseTransformation === true
});
`,
  },
  {
    id: "layer.setInOutPoint",
    title: "Set a layer's in/out points (time bounds)",
    domain: "project-items-comps-layers",
    issue: "285",
    permission: "execute",
    mutating: true,
    members: [S("Layer", "inPoint"), S("Layer", "outPoint")],
    args: ["compName", "layerName", "inPoint", "outPoint"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName"]);
      if (a.inPoint === undefined && a.outPoint === undefined) {
        throw new Error("layer.setInOutPoint: inPoint and/or outPoint is required");
      }
      for (const k of ["inPoint", "outPoint"]) {
        if (a[k] !== undefined && !(typeof a[k] === "number" && Number.isFinite(a[k]))) {
          throw new Error(`layer.setInOutPoint: ${k} must be a finite number`);
        }
      }
      if (a.inPoint !== undefined && a.outPoint !== undefined && a.outPoint <= a.inPoint) {
        throw new Error("layer.setInOutPoint: outPoint must be greater than inPoint");
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
${a.inPoint !== undefined ? `layer.inPoint = ${a.inPoint};` : ""}
${a.outPoint !== undefined ? `layer.outPoint = ${a.outPoint};` : ""}
return __adp_json({ ok: true, layer: layer.name, inPoint: layer.inPoint, outPoint: layer.outPoint });
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
  {
    id: "anim.setInterpolation",
    title: "Set keyframe interpolation type (LINEAR/HOLD/BEZIER) at a key index",
    domain: "animation-effects-render",
    issue: "287",
    permission: "execute",
    mutating: true,
    members: [
      S("Property", "setInterpolationTypeAtKey"), S("Property", "isInterpolationTypeValid"),
      S("Property", "keyInInterpolationType"), S("Property", "keyOutInterpolationType"),
      S("PropertyGroup", "property"),
    ],
    args: ["compName", "layerName", "propertyPath", "keyIndex", "inType", "outType"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "keyIndex"]);
      if (!Number.isInteger(a.keyIndex) || a.keyIndex < 1) {
        throw new Error("anim.setInterpolation: keyIndex must be a positive integer");
      }
      if (a.inType === undefined && a.outType === undefined) {
        throw new Error("anim.setInterpolation: inType and/or outType is required");
      }
      for (const k of ["inType", "outType"]) {
        if (a[k] !== undefined && !["BEZIER", "LINEAR", "HOLD"].includes(a[k])) {
          throw new Error(`anim.setInterpolation: ${k} must be BEZIER|LINEAR|HOLD`);
        }
      }
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
var inT = ${a.inType !== undefined ? `KeyframeInterpolationType[${js(a.inType)}]` : "prop.keyInInterpolationType(" + a.keyIndex + ")"};
var outT = ${a.outType !== undefined ? `KeyframeInterpolationType[${js(a.outType)}]` : "prop.keyOutInterpolationType(" + a.keyIndex + ")"};
if (!prop.isInterpolationTypeValid(inT) || !prop.isInterpolationTypeValid(outT)) {
  __adp_fail("interpolation type is not valid for this property");
}
prop.setInterpolationTypeAtKey(${a.keyIndex}, inT, outT);
return __adp_json({
  ok: true,
  keyIndex: ${a.keyIndex},
  inType: prop.keyInInterpolationType(${a.keyIndex}),
  outType: prop.keyOutInterpolationType(${a.keyIndex})
});
`,
  },
  {
    id: "anim.setTemporalEase",
    title: "Set keyframe temporal ease (speed/influence) at a key index",
    domain: "animation-effects-render",
    issue: "287",
    permission: "execute",
    mutating: true,
    members: [
      S("Property", "setTemporalEaseAtKey"), S("Property", "keyInTemporalEase"),
      S("Property", "keyOutTemporalEase"), S("PropertyGroup", "property"),
      S("KeyframeEase", "speed"), S("KeyframeEase", "influence"),
    ],
    args: ["compName", "layerName", "propertyPath", "keyIndex", "inEase", "outEase"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "propertyPath", "keyIndex"]);
      if (!Number.isInteger(a.keyIndex) || a.keyIndex < 1) {
        throw new Error("anim.setTemporalEase: keyIndex must be a positive integer");
      }
      if (a.inEase === undefined && a.outEase === undefined) {
        throw new Error("anim.setTemporalEase: inEase and/or outEase is required");
      }
      const isEase = (e) => e !== null && typeof e === "object" && !Array.isArray(e) &&
        typeof e.speed === "number" && Number.isFinite(e.speed) &&
        typeof e.influence === "number" && Number.isFinite(e.influence) &&
        e.influence >= 0.1 && e.influence <= 100;
      for (const k of ["inEase", "outEase"]) {
        const e = a[k];
        if (e === undefined) continue;
        if (!Array.isArray(e) || e.length < 1 || e.length > 3 || !e.every(isEase)) {
          throw new Error(`anim.setTemporalEase: ${k} must be an array of 1..3 {speed:number, influence:number(0.1..100)}`);
        }
      }
      jsPath(a.propertyPath);
    },
    source: (a) => `${PRELUDE}${PROP_WALK.replace("@COMP@", js(a.compName)).replace("@LAYER@", js(a.layerName)).replace("@PATH@", jsPath(a.propertyPath))}
function __adp_keyframeEases(spec) {
  var out = [];
  for (var i = 0; i < spec.length; i++) {
    out.push(new KeyframeEase(spec[i].speed, spec[i].influence));
  }
  return out;
}
var inE = ${a.inEase !== undefined ? `__adp_keyframeEases(${js(a.inEase)})` : "prop.keyInTemporalEase(" + a.keyIndex + ")"};
var outE = ${a.outEase !== undefined ? `__adp_keyframeEases(${js(a.outEase)})` : "prop.keyOutTemporalEase(" + a.keyIndex + ")"};
prop.setTemporalEaseAtKey(${a.keyIndex}, inE, outE);
return __adp_json({
  ok: true,
  keyIndex: ${a.keyIndex},
  inEase: prop.keyInTemporalEase(${a.keyIndex}),
  outEase: prop.keyOutTemporalEase(${a.keyIndex})
});
`,
  },
  {
    id: "layer.setTrackMatte",
    title: "Set or clear a layer's track matte",
    domain: "project-items-comps-layers",
    issue: "287",
    permission: "execute",
    mutating: true,
    members: [
      S("AVLayer", "setTrackMatte"), S("AVLayer", "removeTrackMatte"),
      S("AVLayer", "hasTrackMatte"), S("AVLayer", "trackMatteType"),
      S("AVLayer", "trackMatteLayer"),
    ],
    args: ["compName", "layerName", "matteLayerName", "matteType"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "matteType"]);
      if (!["NO_TRACK_MATTE", "ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"].includes(a.matteType)) {
        throw new Error("layer.setTrackMatte: matteType must be a TrackMatteType name");
      }
      if (a.matteType === "NO_TRACK_MATTE") {
        if (a.matteLayerName !== undefined && a.matteLayerName !== null) {
          throw new Error("layer.setTrackMatte: matteLayerName must be null when matteType is NO_TRACK_MATTE");
        }
      } else if (typeof a.matteLayerName !== "string" || a.matteLayerName.length === 0) {
        throw new Error("layer.setTrackMatte: matteLayerName is required for a matte type");
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
if (${js(a.matteType)} === "NO_TRACK_MATTE") {
  layer.removeTrackMatte();
} else {
  var matte = __adp_findLayer(comp, ${js(a.matteLayerName)});
  layer.setTrackMatte(matte, TrackMatteType[${js(a.matteType)}]);
}
return __adp_json({
  ok: true, layer: layer.name,
  hasTrackMatte: layer.hasTrackMatte === true,
  trackMatteType: layer.trackMatteType,
  trackMatteLayer: layer.trackMatteLayer === null ? null : String(layer.trackMatteLayer.name)
});
`,
  },
  {
    id: "layer.setTimeRemap",
    title: "Enable/disable time remapping on an AV layer",
    domain: "project-items-comps-layers",
    issue: "287",
    permission: "execute",
    mutating: true,
    members: [S("AVLayer", "timeRemapEnabled"), S("AVLayer", "canSetTimeRemapEnabled")],
    args: ["compName", "layerName", "enabled"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "enabled"]);
      if (typeof a.enabled !== "boolean") throw new Error("layer.setTimeRemap: enabled must be a boolean");
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
if (layer.canSetTimeRemapEnabled !== true) {
  __adp_fail("time remapping is not available on this layer");
}
layer.timeRemapEnabled = ${a.enabled ? "true" : "false"};
return __adp_json({ ok: true, layer: layer.name, timeRemapEnabled: layer.timeRemapEnabled === true });
`,
  },
  {
    id: "comp.setSettings",
    title: "Set comp settings (bg/shutter/display/motion-blur flags) — partial update",
    domain: "project-items-comps-layers",
    issue: "289",
    permission: "execute",
    mutating: true,
    members: [
      S("CompItem", "bgColor"), S("CompItem", "displayStartTime"),
      S("CompItem", "displayStartFrame"), S("CompItem", "shutterAngle"),
      S("CompItem", "shutterPhase"), S("CompItem", "motionBlur"),
      S("CompItem", "frameBlending"), S("CompItem", "draft3d"),
      S("CompItem", "hideShyLayers"), S("CompItem", "preserveNestedFrameRate"),
      S("CompItem", "dropFrame"),
    ],
    args: ["name", "bgColor", "displayStartTime", "displayStartFrame", "shutterAngle", "shutterPhase",
      "motionBlur", "frameBlending", "draft3d", "hideShyLayers", "preserveNestedFrameRate", "dropFrame"],
    validate: (a) => {
      requireArgs(a, ["name"]);
      const numFields = ["displayStartTime", "displayStartFrame", "shutterAngle", "shutterPhase"];
      const boolFields = ["motionBlur", "frameBlending", "draft3d", "hideShyLayers", "preserveNestedFrameRate", "dropFrame"];
      const set = [...numFields, ...boolFields, "bgColor"].filter((k) => a[k] !== undefined);
      if (set.length === 0) throw new Error("comp.setSettings: at least one setting is required");
      for (const k of numFields) {
        if (a[k] !== undefined && !(typeof a[k] === "number" && Number.isFinite(a[k]))) {
          throw new Error(`comp.setSettings: ${k} must be a finite number`);
        }
      }
      if (a.displayStartFrame !== undefined && (!Number.isInteger(a.displayStartFrame) || a.displayStartFrame < 0)) {
        throw new Error("comp.setSettings: displayStartFrame must be a non-negative integer");
      }
      if (a.shutterAngle !== undefined && (a.shutterAngle < 0 || a.shutterAngle > 360)) {
        throw new Error("comp.setSettings: shutterAngle must be in 0..360");
      }
      for (const k of boolFields) {
        if (a[k] !== undefined && typeof a[k] !== "boolean") {
          throw new Error(`comp.setSettings: ${k} must be a boolean`);
        }
      }
      if (a.bgColor !== undefined) {
        if (!Array.isArray(a.bgColor) || a.bgColor.length !== 3 ||
            a.bgColor.some((c) => typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1)) {
          throw new Error("comp.setSettings: bgColor must be [r,g,b] with components in 0..1");
        }
      }
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.name)}, CompItem);
${a.bgColor !== undefined ? `comp.bgColor = [${a.bgColor.join(", ")}];` : ""}
${a.displayStartTime !== undefined ? `comp.displayStartTime = ${a.displayStartTime};` : ""}
${a.displayStartFrame !== undefined ? `comp.displayStartFrame = ${a.displayStartFrame};` : ""}
${a.shutterAngle !== undefined ? `comp.shutterAngle = ${a.shutterAngle};` : ""}
${a.shutterPhase !== undefined ? `comp.shutterPhase = ${a.shutterPhase};` : ""}
${a.motionBlur !== undefined ? `comp.motionBlur = ${a.motionBlur ? "true" : "false"};` : ""}
${a.frameBlending !== undefined ? `comp.frameBlending = ${a.frameBlending ? "true" : "false"};` : ""}
${a.draft3d !== undefined ? `comp.draft3d = ${a.draft3d ? "true" : "false"};` : ""}
${a.hideShyLayers !== undefined ? `comp.hideShyLayers = ${a.hideShyLayers ? "true" : "false"};` : ""}
${a.preserveNestedFrameRate !== undefined ? `comp.preserveNestedFrameRate = ${a.preserveNestedFrameRate ? "true" : "false"};` : ""}
${a.dropFrame !== undefined ? `comp.dropFrame = ${a.dropFrame ? "true" : "false"};` : ""}
return __adp_json({
  ok: true, comp: comp.name,
  bgColor: comp.bgColor, displayStartTime: comp.displayStartTime,
  displayStartFrame: comp.displayStartFrame, shutterAngle: comp.shutterAngle,
  shutterPhase: comp.shutterPhase, motionBlur: comp.motionBlur === true,
  frameBlending: comp.frameBlending === true, draft3d: comp.draft3d === true,
  hideShyLayers: comp.hideShyLayers === true,
  preserveNestedFrameRate: comp.preserveNestedFrameRate !== false,
  dropFrame: comp.dropFrame === true
});
`,
  },
  {
    id: "read.compSettings",
    title: "Read comp settings (non-mutating)",
    domain: "project-items-comps-layers",
    issue: "289",
    permission: "execute",
    mutating: false,
    members: [
      S("Item", "name"),
      S("CompItem", "bgColor"), S("CompItem", "displayStartTime"),
      S("CompItem", "displayStartFrame"), S("CompItem", "shutterAngle"),
      S("CompItem", "shutterPhase"), S("CompItem", "motionBlur"),
      S("CompItem", "frameBlending"), S("CompItem", "draft3d"),
      S("CompItem", "hideShyLayers"), S("CompItem", "preserveNestedFrameRate"),
      S("CompItem", "dropFrame"),
    ],
    args: ["name"],
    validate: (a) => requireArgs(a, ["name"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.name)}, CompItem);
return __adp_json({
  ok: true, comp: comp.name,
  bgColor: comp.bgColor, displayStartTime: comp.displayStartTime,
  displayStartFrame: comp.displayStartFrame, shutterAngle: comp.shutterAngle,
  shutterPhase: comp.shutterPhase, motionBlur: comp.motionBlur === true,
  frameBlending: comp.frameBlending === true, draft3d: comp.draft3d === true,
  hideShyLayers: comp.hideShyLayers === true,
  preserveNestedFrameRate: comp.preserveNestedFrameRate !== false,
  dropFrame: comp.dropFrame === true
});
`,
  },
  {
    id: "layer.replaceSource",
    title: "Replace an AV layer's source AVItem",
    domain: "project-items-comps-layers",
    issue: "289",
    permission: "execute",
    mutating: true,
    members: [S("AVLayer", "replaceSource"), S("AVLayer", "source")],
    args: ["compName", "layerName", "footageName", "fixExpressions"],
    validate: (a) => {
      requireArgs(a, ["compName", "layerName", "footageName", "fixExpressions"]);
      if (typeof a.fixExpressions !== "boolean") throw new Error("layer.replaceSource: fixExpressions must be a boolean");
    },
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, CompItem);
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var footage = __adp_findItem(${js(a.footageName)}, null);
if (!(footage instanceof CompItem) && !(footage instanceof FootageItem)) {
  __adp_fail("replaceSource source must be a CompItem or FootageItem");
}
layer.replaceSource(footage, ${a.fixExpressions ? "true" : "false"});
return __adp_json({
  ok: true, layer: layer.name,
  source: layer.source === null ? null : String(layer.source.name)
});
`,
  },
  {
    id: "render.duplicateQueueItem",
    title: "Duplicate a render queue item for a comp",
    domain: "animation-effects-render",
    issue: "289",
    permission: "execute",
    mutating: true,
    members: [S("RenderQueueItem", "duplicate"), S("RenderQueueItem", "comp"), S("RenderQueue", "items")],
    args: ["compName"],
    validate: (a) => requireArgs(a, ["compName"]),
    source: (a) => `${PRELUDE}
var rq = app.project.renderQueue;
var found = null;
var count = 0;
for (var i = 1; i <= rq.items.length; i++) {
  var it = rq.items[i];
  if (it.comp !== null && it.comp.name === ${js(a.compName)}) { found = it; count++; }
}
if (count === 0) __adp_fail("no queued item for comp '" + ${js(a.compName)} + "'");
if (count > 1) __adp_fail("ambiguous: " + count + " queued items for comp '" + ${js(a.compName)} + "'");
var d = found.duplicate();
return __adp_json({
  ok: true, index: d.index, comp: String(d.comp.name),
  timeSpanStart: d.timeSpanStart, timeSpanDuration: d.timeSpanDuration,
  remaining: rq.items.length
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
