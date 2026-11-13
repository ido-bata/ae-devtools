/**
 * ido-bata/Ae_LayerNote adapter (CEP extension).
 *
 * Surface: the CEP bridge handler exports in src/jsx/aeft/cep-bridge.ts —
 * `handleGetXxx` functions dispatched from the panel over CEP's evalScript
 * (src/js/lib/cep-bridge.ts on the JS side calls these). The JSX-side
 * implementation of each handler lives in src/jsx/aeft/ae-api.ts; the
 * re-exports in src/jsx/aeft/aeft.ts map handler names 1:1.
 *
 * Route: CEP panel JS (src/js/lib/cep-bridge.ts) → evalScript →
 * aeft.ts re-export → cep-bridge.ts handler → ae-api.ts implementation
 * running in ExtendScript inside AE.
 *
 * Citations: definition = the `export const handleXxx = (` line in
 * cep-bridge.ts; implementation = the `export const xxx = (` line of the
 * AEAPI function the handler calls in ae-api.ts. Both file+line pairs resolve
 * in their own file (review D3).
 *
 * Access: classified by reading each ae-api.ts implementation body (review
 * D1). LayerNote is consumer-oriented: mostly reads (layers, comments,
 * expressions, project info) plus two expression writes and one temp-apply
 * probe. `testExpression` temporarily assigns property.expression then
 * restores the original in both the success and the error path — net content
 * unchanged, recorded as such rather than a blanket write.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "ido-bata/Ae_LayerNote";
const DEF_FILE = "src/jsx/aeft/cep-bridge.ts";
const IMPL_FILE = "src/jsx/aeft/ae-api.ts";
const A_EFT_FILE = "src/jsx/aeft/aeft.ts";

const ROUTE =
  "CEP panel JS (src/js/lib/cep-bridge.ts) → evalScript → cep-bridge.ts handler → ae-api.ts implementation in ExtendScript";

interface HandlerSpec {
  /** handler export name in cep-bridge.ts */
  handler: string;
  /** AEAPI implementation function in ae-api.ts */
  impl: string;
  /** dispatchTS response event */
  event: string;
  args: string[];
  access: Access;
  basis: string;
}

const HANDLERS: HandlerSpec[] = [
  {
    handler: "handleGetSelectedLayers",
    impl: "getSelectedLayers",
    event: "layersResponse",
    args: [],
    access: "read",
    basis: "iterates comp layers and returns those with layer.selected true (ae-api.ts:18-42); reads comment/name/index, no mutation",
  },
  {
    handler: "handleGetAllLayers",
    impl: "getAllLayers",
    event: "allLayersResponse",
    args: [],
    access: "read",
    basis: "walks comp.layer(i) for 1..numLayers and returns LayerInfo objects; read-only projection",
  },
  {
    handler: "handleGetLayerById",
    impl: "getLayerById",
    event: "layerByIdResponse",
    args: ["layerId"],
    access: "read",
    basis: "looks one layer up by index and returns its info; read-only",
  },
  {
    handler: "handleGetLayerComment",
    impl: "getLayerComment",
    event: "layerCommentResponse",
    args: ["layerId"],
    access: "read",
    basis: "returns layer.comment for the addressed layer (ae-api.ts:120); reads a comment string, mutates nothing",
  },
  {
    handler: "handleSetLayerComment",
    impl: "setLayerComment",
    event: "layerCommentSetResponse",
    args: ["layerId", "comment"],
    access: "write",
    basis: "assigns layer.comment = comment on comp.layer(layerIndex) (ae-api.ts:142-158) — persists a layer metadata write into the project",
  },
  {
    handler: "handleGetPropertyExpression",
    impl: "getPropertyExpression",
    event: "propertyExpressionResponse",
    args: ["propertyPath"],
    access: "read",
    basis: "returns property.expression || '' for the resolved property path (ae-api.ts:165-177); a read of the expression text",
  },
  {
    handler: "handleSetPropertyExpression",
    impl: "setPropertyExpression",
    event: "propertyExpressionSetResponse",
    args: ["propertyPath", "expression"],
    access: "write",
    basis: "assigns property.expression = expression on the resolved property (ae-api.ts:181-197) — writes the expression into project content",
  },
  {
    handler: "handleValidateExpression",
    impl: "validateExpression",
    event: "expressionValidationResponse",
    args: ["expression"],
    access: "read",
    basis: "pure syntax/semantic linter over the passed expression string (errors/warnings arrays; ae-api.ts:201+) — never touches AE state",
  },
  {
    handler: "handleTestExpression",
    impl: "testExpression",
    event: "expressionTestResponse",
    args: ["propertyPath", "expression"],
    access: "write",
    basis:
      "TEMP-OBJECT write with net content unchanged: temporarily assigns property.expression = expression to force runtime evaluation, then restores the original expression on BOTH the success path and the catch path (ae-api.ts:952-978 `property.expression = originalExpression; // Restore original`); a transient project write, restored in the same call",
  },
  {
    handler: "handleGetAllExpressions",
    impl: "getAllExpressions",
    event: "allExpressionsResponse",
    args: [],
    access: "read",
    basis: "walks project/comp/properties collecting expressions into ExpressionInfo objects (ae-api.ts:441); read-only traversal",
  },
  {
    handler: "handleSearchExpressions",
    impl: "searchExpressions",
    event: "searchExpressionsResponse",
    args: ["pattern", "isRegex"],
    access: "read",
    basis: "filters collected expressions by substring or regex and returns matches; read-only",
  },
  {
    handler: "handleGetLayerProperties",
    impl: "getLayerProperties",
    event: "layerPropertiesResponse",
    args: ["layerId"],
    access: "read",
    basis: "returns PropertyInfo[] for the layer's properties (ae-api.ts:530); a read projection",
  },
  {
    handler: "handleGetPropertyInfo",
    impl: "getPropertyInfo",
    event: "propertyInfoResponse",
    args: ["propertyPath"],
    access: "read",
    basis: "returns one property's info object (name, matchName, type, value, expression); read-only",
  },
  {
    handler: "handleGetProjectInfo",
    impl: "getProjectInfo",
    event: "projectInfoResponse",
    args: [],
    access: "read",
    basis: "reads app.project file/numItems/activeItem and returns a projection (ae-api.ts:807-831); read-only",
  },
  {
    handler: "handleGetCompositionInfo",
    impl: "getCompositionInfo",
    event: "compositionInfoResponse",
    args: [],
    access: "read",
    basis: "reads the active comp's name/dimensions/duration/frameRate/workArea/numLayers/bgColor (ae-api.ts:835-859); read-only",
  },
  {
    handler: "handleGetExpressionsStats",
    impl: "getExpressionsStats",
    event: "expressionsStatsResponse",
    args: [],
    access: "read",
    basis: "aggregates the collected expression list into counts/longest/layer names (ae-api.ts:862); read-only aggregation",
  },
];

/**
 * Host-side utilities exported from src/jsx/aeft/aeft.ts (no CEP bridge
 * handler; called directly from the panel JS or debug entry points).
 */
const HOST_UTILS: HandlerSpec[] = [
  {
    handler: "debugAlert",
    impl: "debugAlert",
    event: "alert dialog",
    args: ["message"],
    access: "execute",
    basis: "raises an ExtendScript alert(String(message)) modal dialog in the AE UI (aeft.ts:89); no project content is touched",
  },
  {
    handler: "scanFolder",
    impl: "scanFolder",
    event: "file listing",
    args: ["folderPath"],
    access: "read",
    basis: "Folder(folderPath).getFiles() enumeration returning file names (aeft.ts:96); a local-filesystem read, AE project untouched",
  },
  {
    handler: "writeTextFile",
    impl: "writeTextFile",
    event: "file write",
    args: ["filePath", "data"],
    access: "write",
    basis: "LOCAL-ONLY write: new File(path).open('w') + f.write(data) persists a text file on disk (aeft.ts:119) — local filesystem only, AE project content unchanged",
  },
];

/** semanticId — provisional normalization; #11 owns the final grammar. */
function semanticFor(handler: string): string {
  switch (handler) {
    case "handleGetSelectedLayers":
      return "layer.get-selection";
    case "handleGetAllLayers":
      return "comp.list-layers";
    case "handleGetLayerById":
      return "layer.get-layer";
    case "handleGetLayerComment":
      return "layer.get-comment";
    case "handleSetLayerComment":
      return "layer.set-comment";
    case "handleGetPropertyExpression":
      return "expression.get";
    case "handleSetPropertyExpression":
      return "expression.set";
    case "handleValidateExpression":
      return "expression.validate";
    case "handleTestExpression":
      return "expression.test";
    case "handleGetAllExpressions":
      return "expression.list-all";
    case "handleSearchExpressions":
      return "expression.search";
    case "handleGetLayerProperties":
      return "layer.list-properties";
    case "handleGetPropertyInfo":
      return "tool.get-property";
    case "handleGetProjectInfo":
      return "project.info";
    case "handleGetCompositionInfo":
      return "comp.info";
    case "handleGetExpressionsStats":
      return "expression.stats";
    default:
      return `tool.${handler.replace(/^handle/, "").replace(/_/g, "-").toLowerCase()}`;
  }
}

function lineOfExport(src: string, name: string): number {
  const re = new RegExp(`export const ${name}\\b`);
  const m = re.exec(src);
  if (!m || m.index === undefined) throw new Error(`${TOOL_ID}: export ${name} not found`);
  let line = 1;
  for (let i = 0; i < m.index; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

export function extract(): OperationRow[] {
  const def: ToolDef | undefined = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;
  const defSrc = readFileSync(join(root, DEF_FILE), "utf8");
  const implSrc = readFileSync(join(root, IMPL_FILE), "utf8");
  const eftSrc = readFileSync(join(root, A_EFT_FILE), "utf8");

  const rows: OperationRow[] = [];
  for (const spec of [...HANDLERS, ...HOST_UTILS]) {
    // Handlers live in cep-bridge.ts; host utils are exported directly from aeft.ts.
    const inBridge = spec.handler.startsWith("handle");
    const definitionFile = inBridge ? DEF_FILE : A_EFT_FILE;
    const definitionLine = lineOfExport(inBridge ? defSrc : eftSrc, spec.handler);
    const implFile = spec.impl === "debugAlert" || spec.impl === "scanFolder" || spec.impl === "writeTextFile" ? A_EFT_FILE : IMPL_FILE;
    const implementationLine = lineOfExport(implFile === A_EFT_FILE ? eftSrc : implSrc, spec.impl);

    const row: OperationRow = {
      toolId: TOOL_ID,
      name: spec.handler.replace(/^handle/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
      args: spec.args,
      access: spec.access,
      accessBasis: spec.basis,
      route: inBridge ? `${ROUTE} (dispatchTS '${spec.event}')` : `CEP panel JS → evalScript → aeft.ts host utility (ExtendScript, '${spec.event}')`,
      semanticId: semanticFor(spec.handler),
      status: "source-verified",
      definitionFile,
      definitionLine,
      implementationFile: implFile,
      implementationLine,
    };

    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${TOOL_ID} ${spec.handler}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${TOOL_ID} ${spec.handler}: ${b.reason}`);
    rows.push(row);
  }

  if (rows.length === 0) throw new Error(`${TOOL_ID}: no handlers parsed`);
  return rows;
}
