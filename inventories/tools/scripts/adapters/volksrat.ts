/**
 * VolksRat71/after-effects-mcp-vision adapter.
 *
 * Surface: 15 tool definitions in the `TOOLS` array of cep/server/tools.js.
 * Each tool's `command` enum selects sub-operations that are dispatched by
 * cep/server/mcp.js's createToolRegistry to ops implemented as ExtendScript
 * functions in cep/host/ae/ops-*.jsx (__mcp_queryOps / __mcp_mutateOps /
 * __mcp_captureOps / __mcp_diagnosticOps / __mcp_buildOps / __mcp_layoutOps).
 *
 * Route: MCP over HTTP is served inside the CEP panel (cep/server/mcp.js,
 * hand-rolled JSON-RPC 2.0, no SDK) → callHost(op, args) → __mcp_exec in
 * cep/host/ae/ops.jsx, which dispatches to the op table and wraps "mutating"
 * ops in an undo group (the `__mcp_mutating` table in ops.jsx).
 *
 * Citations: definition = the tool's `name: 'ae_*'` line in
 * cep/server/tools.js; implementation = the op function's `case`-like
 * property line (`name: function (args)`) in the ops-*.jsx file the registry
 * dispatches to. When one tool spans several op functions (ae_query's
 * sessionInfo/tree/find/...), the representative op the tool mostly routes to
 * is cited and the basis names the full command set. Both file+line pairs
 * resolve in their own file (review D3).
 *
 * Access: the project itself classifies host-vs-mutating ops — the
 * `__mcp_mutating` table (cep/host/ae/ops.jsx:72) is the undo-group decision.
 * For this inventory the access class is derived from the *op function
 * bodies* (read = reads and returns; write = mutates project content;
 * execute = render/file output, project load, host reload) with the mutating
 * table recorded as corroborating evidence, never used as the classifier's
 * only input (review D1). Tools whose command enum spans both read and write
 * sub-ops are `unknown` with the dispatcher basis — never rounded to write.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "VolksRat71/after-effects-mcp-vision";
const DEF_FILE = "cep/server/tools.js";

const ROUTE =
  "MCP over HTTP (JSON-RPC in cep/server/mcp.js, served inside the CEP panel) → callHost(op) → __mcp_exec dispatch (cep/host/ae/ops.jsx) → ExtendScript in AE";

interface ToolSpec {
  /** Representative host op function this tool routes to. */
  op: string;
  opsFile: string;
  args: string[];
  access: Access;
  basis: string;
}

/**
 * The 15 tools with the op each one's commands resolve through. Sub-commands
 * whose behaviour differs from the representative op are called out in the
 * basis. Command sets come from each tool's inputSchema `command` enum.
 */
const TOOLS: ToolSpec[] = [
  {
    op: "tree",
    opsFile: "cep/host/ae/ops-query.jsx",
    args: ["command", "tool", "compId", "layerId", "name", "type", "scope", "path", "paths", "depth", "includeValues", "time", "includeExtents", "limit", "includeIneligible"],
    access: "unknown",
    basis:
      "dispatcher on command: sessionInfo/tree/find/propertyKeys/propertyValues/selection/bounds/describe/media are all reads (ops-query.jsx: queries project/comps/layers/properties/selection and returns JSON; __mcp_mutating does not list the query ops) — but no single op implements every branch; read applies to every enumerated command, so the row is honest-unknown at the tool granularity rather than blanket-read",
  },
  {
    op: "set",
    opsFile: "cep/host/ae/ops-mutate.jsx",
    args: ["command", "writes"],
    access: "write",
    basis:
      "write: `set` (ops-mutate.jsx:80) walks the `writes` batch and assigns property values / expressions with setValue / expression assignment ('the whole batch is a single undo step'); command=values writes values, command=expressions writes expressions — both branches mutate project content (listed in __mcp_mutating)",
  },
  {
    op: "keyframes",
    opsFile: "cep/host/ae/ops-mutate.jsx",
    args: ["layerId", "path", "add", "remove", "ease"],
    access: "write",
    basis:
      "write via mixed read: `keyframes` (ops-mutate.jsx:171) adds/removes keyframes with setValueAtTime and removes existing keys, reads back the full key list for the response — 'add and remove apply in the same call; removals are processed first' — the add/remove branches mutate project content (listed in __mcp_mutating)",
  },
  {
    op: "layers",
    opsFile: "cep/host/ae/ops-mutate.jsx",
    args: ["command", "compId", "layerId", "name", "text", "color", "width", "height", "index", "parentLayerId", "enabled", "locked", "selected", "label", "shy", "guideLayer", "solo", "comment", "path"],
    access: "unknown",
    basis:
      "dispatcher on command: createText/createBoxText/createSolid/createShape/createNull/delete/duplicate/rename/select/setEnabled/setAudioEnabled/setLocked/reparent/reorder/setCollapse/applyPreset/organise — the create/delete branches mutate project content and select changes UI selection, but every command funnels into the single `layers` op (ops-mutate.jsx:267) whose access is not decidable at registration time; listed in __mcp_mutating",
  },
  {
    op: "effects",
    opsFile: "cep/host/ae/ops-mutate.jsx",
    args: ["command", "layerId", "matchName", "name"],
    access: "unknown",
    basis:
      "dispatcher on command: list/listAvailable are reads, apply/remove mutate the layer's effect parade — all four branches dispatch through the same `effects` op (ops-mutate.jsx:374), so access is not decidable at registration time; listed in __mcp_mutating",
  },
  {
    op: "project",
    opsFile: "cep/host/ae/ops-mutate.jsx",
    args: ["command", "name", "width", "height", "duration", "frameRate", "pixelAspect", "path", "importAs", "itemId", "compId", "overwrite", "discardUnsaved", "itemIds", "folderId", "parentFolderId", "sequence", "folder", "projectName"],
    access: "unknown",
    basis:
      "dispatcher on command: createComp/import/addToComp/deleteItem/renameItem/createFolder/moveToFolder/replaceFootage mutate the project; save/new/open/close are project-file lifecycle; collect copies footage and saves a collected .aep — all route through one `project` op (ops-mutate.jsx:764), so access is not decidable at registration time; __mcp_mutating marks the op mutating EXCEPT command save/collect, which run outside the undo group",
  },
  {
    op: "capture",
    opsFile: "cep/host/ae/ops-capture.jsx",
    args: ["command", "compId", "layerId", "time", "startTime", "endTime", "count", "columns", "longEdge"],
    access: "execute",
    basis:
      "image output: `capture` (ops-capture.jsx:53) renders comp pixels (frame/sequence/isolated) into PNG files — 'Captures composite onto mid grey… LOOK at what is actually rendered'; the ops code borrows comp.resolutionFactor and layer solo flags and restores them, which __mcp_mutating lists as mutating ONLY for undo safety ('if one throws mid-flight, the undo group is what gets the user back') — net project content unchanged, treated as a frame-output (execute) per ae-a8n `comp.renderFrame` precedent",
  },
  {
    op: "masks",
    opsFile: "cep/host/ae/ops-mutate.jsx",
    args: ["command", "index", "layerId", "maskIndex", "maskName", "newName", "name", "left", "top", "width", "height", "time", "inverted", "feather", "expansion", "vertices", "closed", "keys", "keysPath", "keysPointer", "fps", "timeBase", "timeOffset", "hold", "mode"],
    access: "unknown",
    basis:
      "dispatcher on command: add/setRect/setPath/setPathKeys/setMode/rename/reorder/setFeather write mask shapes and keys ('A 505-frame roto mask is one call'), list and remove read/delete and re-list — every branch funnels into the single `masks` op (ops-mutate.jsx:425), so access is not decidable at registration time; listed in __mcp_mutating",
  },
  {
    op: "timing",
    opsFile: "cep/host/ae/ops-build.jsx",
    args: ["command", "layerId", "compId", "inPoint", "outPoint", "startTime", "stretch", "duration", "frameRate", "width", "height", "workAreaStart", "workAreaDuration", "time", "comment", "protectedRegion", "enabled", "enableForComp", "path"],
    access: "unknown",
    basis:
      "dispatcher on command: setLayer/setComp/addMarker/setTimeRemap/setMotionBlur/separateDimensions write timing/state, readMarkers reads markers — all route through the single `timing` op (ops-build.jsx:132), so access is not decidable at registration time; listed in __mcp_mutating",
  },
  {
    op: "shapes",
    opsFile: "cep/host/ae/ops-build.jsx",
    args: ["command", "compId", "kind", "name", "width", "height", "roundness", "points", "outerRadius", "innerRadius", "vertices", "closed", "fill", "stroke", "strokeWidth", "position", "layerId", "groupIndex", "start", "end", "copies", "offset", "amount", "radius", "dash", "gap"],
    access: "write",
    basis:
      "write via create/addOperator branches: `shapes` (ops-build.jsx:250) creates shape layers with vector geometry (rect/ellipse/polygon/star/path) and returns the created properties' matchName `paths` map for later animating — creation of new project content dominates; listed in __mcp_mutating",
  },
  {
    op: "compose",
    opsFile: "cep/host/ae/ops-build.jsx",
    args: ["command", "compId", "layerId", "layerIds", "name", "moveAttributes", "matteLayerId", "type", "mode", "parentLayerId", "keepPosition", "enabled"],
    access: "write",
    basis:
      "structural writes: `compose` (ops-build.jsx:512) precomposes layers into a nested comp, sets track mattes, blend modes, parents and 3D — every command mutates project structure; listed in __mcp_mutating",
  },
  {
    op: "render",
    opsFile: "cep/host/ae/ops-build.jsx",
    args: ["command", "compId", "outputPath", "omTemplate", "rsTemplate", "startTime", "endTime", "overwrite", "jobs", "renderImmediately"],
    access: "execute",
    basis:
      "render output: `render` (ops-build.jsx:793) renders comps to files through the render queue (command render/batch) or hands off to Media Encoder (queueInAME); listTemplates reads template names — 'Rendering never changes the project: batch removes its queue items and restores paused ones even when a render fails'; DELIBERATELY excluded from __mcp_mutating ('render and projectFile are left out entirely') and from the undo group",
  },
  {
    op: "stack",
    opsFile: "cep/host/ae/ops-layout.jsx",
    args: ["command", "compId", "layerId", "layerIds", "toLayerId", "to", "align", "relativeTo", "axis", "by", "direction", "columns", "gap", "x", "y", "padding", "paddingX", "paddingY", "step", "from", "order", "time", "mode"],
    access: "unknown",
    basis:
      "dispatcher on command: measure is a bounds read, but anchor/align/distribute/stack/pin/fit/stagger all reposition/resize layers ('This is the reflow primitive') — every command routes through the layout ops (ops-layout.jsx measure/anchor/align/distribute/stack/pin/fit/stagger), so access is not decidable at registration time; every branch except measure is listed in __mcp_mutating",
  },
  {
    op: "textAnimator",
    opsFile: "cep/host/ae/ops-build.jsx",
    args: ["command", "layerId", "name", "properties", "basedOn", "shape", "units"],
    access: "unknown",
    basis:
      "dispatcher on command: add creates a text animator with a range selector (write), list and remove read/delete — all route through the single `textAnimator` op (ops-build.jsx:581), so access is not decidable at registration time; listed in __mcp_mutating",
  },
  {
    op: "template",
    opsFile: "cep/host/ae/ops-build.jsx",
    args: ["command", "compId", "layerId", "path", "name", "overwrite"],
    access: "unknown",
    basis:
      "dispatcher on command: expose adds a property to the comp's Essential Graphics panel (write), exportMogrt writes a .mogrt file, listExposed reads — all route through the single `template` op (ops-build.jsx:736), so access is not decidable at registration time; listed in __mcp_mutating",
  },
];

/** The tool registry file also registers ae_diagnostics; keep it a row. */
const DIAGNOSTICS: ToolSpec = {
  op: "problems",
  opsFile: "cep/host/ae/ops-diagnostics.jsx",
  args: ["command", "maxLayers", "offset", "limit"],
  access: "unknown",
  basis:
    "dispatcher on command: problems scans missing footage/substituted fonts/broken expressions (read of project state via ops-diagnostics.jsx:84 problems()), reloadHost re-reads the ExtendScript host from disk (host lifecycle — 'CEP loads it once per extension start'), effectEnums reads effect enums in a scratch project (the project marks it mutating with a long ceiling) — access depends on the command and is not decidable at registration time",
};

/** Find `name: function` inside a `var __mcp_xxxOps = {` table. */
function opLine(opsSrc: string, op: string): number {
  const re = new RegExp(`(^|[^\\w$])${op}\\s*:\\s*function`);
  const m = re.exec(opsSrc);
  if (!m || m.index === undefined) return -1;
  let line = 1;
  for (let i = 0; i < m.index; i += 1) if (opsSrc.charCodeAt(i) === 10) line += 1;
  return line;
}

/** semanticId — provisional normalization; #11 owns the final grammar. */
function semanticFor(name: string): string {
  switch (name) {
    case "ae_query":
      return "tool.query-project";
    case "ae_set":
      return "tool.set-property";
    case "ae_animate":
      return "keyframe.set";
    case "ae_layers":
      return "layer.layer-op";
    case "ae_effects":
      return "effect.layer-op";
    case "ae_project":
      return "project.op";
    case "ae_capture":
      return "view.capture-frames";
    case "ae_masks":
      return "mask.layer-op";
    case "ae_timing":
      return "time.timing-op";
    case "ae_shapes":
      return "shape.create";
    case "ae_compose":
      return "comp.compose-op";
    case "ae_render":
      return "render.queue-op";
    case "ae_layout":
      return "tool.layout-op";
    case "ae_text":
      return "text.text-animator-op";
    case "ae_template":
      return "mogrt.template-op";
    case "ae_diagnostics":
      return "tool.diagnostics";
    default:
      return `tool.${name.replace(/^ae_/, "").replace(/_/g, "-")}`;
  }
}

function rowFor(def: ToolDef, spec: ToolSpec, opsSources: Map<string, string>): OperationRow {
  const root = resolveSourceRoot(def).root;
  const defSrc = readFileSync(join(root, DEF_FILE), "utf8");

  // Definition line: the `name: 'ae_*'` string for THIS tool. Match by tool id
  // derived from the spec (each spec corresponds to one ae_* name).
  const toolName = TOOL_NAME_BY_OP.get(spec.op);
  if (!toolName) throw new Error(`${TOOL_ID}: no tool name mapped for op ${spec.op}`);
  const nameRe = new RegExp(`name:\\s*'${toolName}'`);
  const nm = nameRe.exec(defSrc);
  if (!nm || nm.index === undefined) {
    throw new Error(`${TOOL_ID}: tool name ${toolName} not found in ${DEF_FILE}`);
  }
  let defLine = 1;
  for (let i = 0; i < nm.index; i += 1) if (defSrc.charCodeAt(i) === 10) defLine += 1;

  const opsSrc = opsSources.get(spec.opsFile);
  if (!opsSrc) throw new Error(`${TOOL_ID}: ops source not loaded: ${spec.opsFile}`);
  const implLine = opLine(opsSrc, spec.op);
  if (implLine < 0) throw new Error(`${TOOL_ID}: op ${spec.op} not found in ${spec.opsFile}`);

  const row: OperationRow = {
    toolId: TOOL_ID,
    name: toolName,
    args: spec.args,
    access: spec.access,
    accessBasis: spec.basis,
    route: ROUTE,
    semanticId: semanticFor(toolName),
    status: "source-verified",
    definitionFile: DEF_FILE,
    definitionLine: defLine,
    implementationFile: spec.opsFile,
    implementationLine: implLine,
  };

  const a = checkCitation(root, row.definitionFile, row.definitionLine);
  if (!a.ok) throw new Error(`${TOOL_ID} ${toolName}: ${a.reason}`);
  const b = checkCitation(root, row.implementationFile, row.implementationLine);
  if (!b.ok) throw new Error(`${TOOL_ID} ${toolName}: ${b.reason}`);
  return row;
}

const TOOL_NAME_BY_OP = new Map<string, string>([
  ["tree", "ae_query"],
  ["set", "ae_set"],
  ["keyframes", "ae_animate"],
  ["layers", "ae_layers"],
  ["effects", "ae_effects"],
  ["project", "ae_project"],
  ["capture", "ae_capture"],
  ["masks", "ae_masks"],
  ["timing", "ae_timing"],
  ["shapes", "ae_shapes"],
  ["compose", "ae_compose"],
  ["render", "ae_render"],
  ["stack", "ae_layout"],
  ["textAnimator", "ae_text"],
  ["template", "ae_template"],
  ["problems", "ae_diagnostics"],
]);

export function extract(): OperationRow[] {
  const def = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;

  const opsSources = new Map<string, string>();
  for (const f of new Set([...TOOLS, DIAGNOSTICS].map((t) => t.opsFile))) {
    opsSources.set(f, readFileSync(join(root, f), "utf8"));
  }

  const rows = [...TOOLS, DIAGNOSTICS].map((spec) => rowFor(def, spec, opsSources));
  if (rows.length === 0) throw new Error(`${TOOL_ID}: no tools extracted`);
  return rows;
}
