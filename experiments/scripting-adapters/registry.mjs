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
function __adp_findItem(name, typeName) {
  var items = __adp_items();
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (it.name === name) {
      if (typeName === null || it.type === typeName) return it;
      __adp_fail("name '" + name + "' exists but is not a " + typeName);
    }
  }
  __adp_fail("item not found: " + name);
  return null;
}
function __adp_findLayer(comp, name) {
  var layers = comp.layers;
  for (var i = 1; i <= layers.length; i++) {
    if (layers[i].name === name) return layers[i];
  }
  __adp_fail("layer not found in comp '" + comp.name + "': " + name);
  return null;
}
function __adp_json(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
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
    args: ["name", "width", "height", "pixelAspect", "duration"],
    validate: (a) => requireArgs(a, ["name", "width", "height", "pixelAspect", "duration"]),
    source: (a) => `${PRELUDE}
var comp = app.project.items.addComp(${js(a.name)}, ${Number(a.width)}, ${Number(a.height)}, ${Number(a.pixelAspect)}, ${Number(a.duration)});
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
    members: [S("Item", "remove")],
    args: ["name", "type"],
    validate: (a) => requireArgs(a, ["name", "type"]),
    source: (a) => `${PRELUDE}
var it = __adp_findItem(${js(a.name)}, ${js(a.type)});
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
var comp = __adp_findItem(${js(a.compName)}, "CompItem");
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
    validate: (a) => requireArgs(a, ["compName", "layerName", "x", "y"]),
    source: (a) => `${PRELUDE}
var comp = __adp_findItem(${js(a.compName)}, "CompItem");
var layer = __adp_findLayer(comp, ${js(a.layerName)});
var pos = layer.property("Transform").property("Position");
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
var comp = __adp_findItem(${js(a.compName)}, "CompItem");
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
var comp = __adp_findItem(${js(a.compName)}, "CompItem");
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
var comp = __adp_findItem(${js(a.compName)}, "CompItem");
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
    members: [S("Project", "activeItem"), S("AVItem", "name")],
    args: [],
    source: () => `${PRELUDE}
var items = __adp_items();
var list = [];
for (var i = 1; i <= items.length; i++) {
  list.push({ name: items[i].name, type: String(items[i].type), id: items[i].id });
}
var ai = app.project.activeItem;
return __adp_json({
  ok: true,
  count: items.length,
  items: list,
  activeItem: ai === null ? null : { name: ai.name, type: String(ai.type) }
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
