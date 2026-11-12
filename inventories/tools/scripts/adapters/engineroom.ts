/**
 * Engine-Room-Games/after-effects-mcp adapter.
 *
 * Surface: the `OpSchemas` map in packages/shared/src/schemas.ts — every MCP
 * tool is one op key there. The same file's `OpMutation` map classifies every
 * op as "write" | "read" | "server" WITH NO DEFAULT (a comment states an
 * unclassified op must fail the build — tests/unit/write-queue.mjs enforces
 * table parity), and `InternalOpMutation` classifies the private `_`-prefixed
 * ops the server itself sends. tools/descriptions.ts adds per-tool docs and
 * tools/annotations.ts derives MCP annotations from OpMutation.
 *
 * Route: MCP stdio server (packages/mcp-server/src/server.ts) → HTTP/WS bridge
 * to the CEP panel (bridge/httpClient, wsClient, writeQueue serializes writes
 * behind one mutex) → ExtendScript in AE. Ops classified "server" never reach
 * the bridge (they are the server's own files/jobs/guides).
 * run_jsx/run_batch accept caller-supplied ExtendScript/op lists.
 *
 * Citations: definition = the op's key line inside `OpSchemas` in
 * packages/shared/src/schemas.ts; implementation = the classifier entry for
 * the same op in `OpMutation` in the SAME file (the point where the project
 * itself declares the behaviour class that its write queue, undo grouping and
 * annotations all use — the closest single source of truth for "what this op
 * does", with tool behaviour elaborated by tools/descriptions.ts). Both
 * file+line pairs resolve inside the same file (review D3).
 *
 * Access: mapped from the project's own OpMutation table, which we verified
 * matches the behaviour the descriptions and op implementations state
 * (review D1: derive from actual behaviour, record the basis). Mapping:
 *   read    -> read   (bridge read; also screenshots — "read-only despite
 *                      being the slowest thing here", borrow/restore in a
 *                      finally, net project content unchanged)
 *   write   -> write
 *   server  -> split: ops that only read server-local state (ae_guide,
 *              check_setup, list_known_issues, get_job/await_job/cancel_job)
 *              are `read`; ops that write files or install (setup_panel,
 *              init_project, log_issue, mark_issue_reported, archive_issue)
 *              are `write` with a LOCAL-ONLY-style basis; run_jsx and
 *              run_batch stay `unknown`(arbitrary caller code) — the project
 *              marks them "write; assume the worst", which we record as a
 *              claim on the write axis while the honest per-call class is
 *              unknown, per review D1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "Engine-Room-Games/after-effects-mcp";
const SCHEMAS_FILE = "packages/shared/src/schemas.ts";

const ROUTE_BRIDGE =
  "MCP stdio (packages/mcp-server/src/server.ts) → HTTP/WS bridge to the CEP panel (writeQueue serializes writes) → ExtendScript in AE";
const ROUTE_SERVER =
  "MCP stdio → server-local state in packages/mcp-server (never reaches the AE bridge)";

/**
 * Server ops ("never reaches the bridge") split into honest classes per the
 * repo's own READ_ONLY_SERVER_OPS table (tools/policy.ts) and the op bodies.
 */
const SERVER_OP_ACCESS: Record<string, { access: Access; note: string }> = {
  ae_guide: {
    access: "read",
    note: "serves a bundled guide topic from packages/mcp-server/src/generated/content.ts — server-local read, no AE contact",
  },
  check_setup: {
    access: "read",
    note: "inspects panel/bridge install state and reports — read-only per READ_ONLY_SERVER_OPS 'keep'",
  },
  list_known_issues: {
    access: "read",
    note: "reads the issue journal from disk — server-local read, no AE contact",
  },
  get_job: {
    access: "read",
    note: "reads a job record the server holds; READ_ONLY_SERVER_OPS drops it from read-only mode only because 'nothing can read' there, not because it writes",
  },
  await_job: {
    access: "read",
    note: "blocks on a job the server tracks (await_job) and returns its record; takes no action itself",
  },
  cancel_job: {
    access: "execute",
    note: "TERMINATES a running aerender/batch process owned by the server ('cancel_job is how a stuck one is released'); a host-side lifecycle action — killing a render process, not a project-content edit",
  },
  setup_panel: {
    access: "write",
    note: "LOCAL-ONLY write: installs the After Effects panel on disk and 'can change Adobe's debug preference' (READ_ONLY_SERVER_OPS) — filesystem/config write, no AE bridge contact",
  },
  init_project: {
    access: "write",
    note: "LOCAL-ONLY write: 'writes a project folder to disk' (READ_ONLY_SERVER_OPS)",
  },
  log_issue: {
    access: "write",
    note: "LOCAL-ONLY write: 'writes to the issue journal on disk' (READ_ONLY_SERVER_OPS)",
  },
  mark_issue_reported: {
    access: "write",
    note: "LOCAL-ONLY write: 'rewrites an issue journal entry on disk' (READ_ONLY_SERVER_OPS)",
  },
  archive_issue: {
    access: "write",
    note: "LOCAL-ONLY write: 'rewrites an issue journal entry on disk' (READ_ONLY_SERVER_OPS)",
  },
};

/** Ops whose per-call class is not decidable from the registration. */
const UNKNOWN_OPS: Record<string, string> = {
  run_jsx:
    "dispatcher: runs caller-supplied ExtendScript (code or scriptPath) via the bridge ('the script is the caller's and may do anything. Assume the worst' — the table entry is the project's worst-case claim, not a per-call fact); access depends on the caller's script and is not decidable at registration time",
  run_batch:
    "dispatcher: runs an array of caller-chosen op/args steps, each with its own access class ('can do anything a destructive op can' — same worst-case claim); access depends on the step list and is not decidable at registration time",
  render_queue:
    "dispatcher: saves the project when needed (write), then renders queued items in a separate aerender process reading the .aep on disk, and unticks rendered queue items as one undo step — a mixed save+render+queue-write action, summarised as write by the project's table; the render itself is host work",
};

interface OpRow {
  name: string;
  access: Access;
  accessBasis: string;
  route: string;
}

/**
 * Args for each op: keys of the zod object bound to the op's `XxxYyy` schema
 * constant. Resolution: find `op: SchemaConst,` in OpSchemas, then find
 * `export const SchemaConst = z` further up in the file and collect the
 * object-literal keys of the first z.object({...}) that follows.
 */
function opArgs(src: string, schemaConst: string): string[] {
  // Anchor at the `export const <Const>` declaration (falling back to a bare
  // `const <Const>` for wrapper-composed schemas) and take the FIRST z-object
  // in that declaration's scope. crossField(<other>, rules) compositions have
  // no z-object of their own, so follow the referenced inner const once.
  const declRe = new RegExp(`export const ${schemaConst}\\b`);
  const decl = declRe.exec(src);
  if (decl && decl.index !== undefined) {
    const keys = objectKeysAfter(decl.index);
    if (keys.length > 0) return keys;
    const inner = new RegExp(`${schemaConst} = crossField\\(\\s*(\\w+)`).exec(src.slice(decl.index));
    if (inner && inner[1] && inner[1] !== schemaConst) return opArgs(src, inner[1]);
    return keys;
  }
  const bareRe = new RegExp(`const ${schemaConst}\\b`);
  const bare = bareRe.exec(src);
  if (bare && bare.index !== undefined) return objectKeysAfter(bare.index);
  return [];
}

let SRC: string = "";

/** Keys of the first z-object in the declaration starting at `at`: handles
 * `z.object({`, the chained `z\n  .object({` form, and crossField(...) wrappers.
 * Line comments are stripped before scanning (apostrophes inside them would
 * otherwise break quote tracking). */
function objectKeysAfter(at: number): string[] {
  const end0 = SRC.indexOf("export const", at + 10);
  const scope = end0 > at ? SRC.slice(at, end0) : SRC.slice(at, at + 4000);
  const stripped = scope.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const open = stripped.search(/z\s*\.object\s*\(/);
  if (open < 0) return [];
  const brace = stripped.indexOf("{", open);
  if (brace < 0) return [];
  let depth = 0;
  let end = -1;
  let inQuote: string | null = null;
  for (let i = brace; i < stripped.length; i += 1) {
    const ch = stripped[i] ?? "";
    if (inQuote) {
      if (ch === "\\") i += 1;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];

  // Keys of the z.object: lines that start (after indentation) with
  // `identifier:` at the top brace level of the object literal.
  const body = stripped.slice(brace + 1, end);
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s+([a-zA-Z_$][\w$]*)\s*:\s/.exec(line);
    if (m && m[1]) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

export function extract(): OperationRow[] {
  const def: ToolDef | undefined = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;
  const src = readFileSync(join(root, SCHEMAS_FILE), "utf8");
  SRC = src;

  // --- locate OpSchemas and OpMutation map bodies -------------------------
  const schemasStart = src.indexOf("export const OpSchemas = {");
  if (schemasStart < 0) throw new Error(`${TOOL_ID}: OpSchemas not found`);
  const mutationStart = src.indexOf("export const OpMutation = {");
  if (mutationStart < 0) throw new Error(`${TOOL_ID}: OpMutation not found`);
  const mutationEnd = src.indexOf("as const satisfies", mutationStart);
  const opEntries = src.slice(schemasStart, mutationStart);

  const rows: OperationRow[] = [];
  const re = /\n\s{2}([a-z_]+):\s*([A-Z]\w*),/g;
  for (const m of opEntries.matchAll(re)) {
    const op = m[1];
    if (!op) continue;
    const schemaConst = m[2] ?? "";

    const entryRe = new RegExp(`\\n\\s{2}${op}:\\s*"[a-z]+"`);
    const cls = entryRe.exec(src.slice(mutationStart, mutationEnd));
    if (!cls || cls.index === undefined) {
      throw new Error(`${TOOL_ID}: op ${op} has no OpMutation entry`);
    }
    const classLine = mutationStart + cls.index;
    const classified = /"(write|read|server)"/.exec(cls[0])?.[1] ?? "server";

    // Definition: the op key inside OpSchemas (entry start incl. newline),
    // so lineOf counts the same newline the regex matched.
    const defIdx = schemasStart + (m.index ?? 0) + 1; // skip the leading \n
    let defLine = 1;
    for (let i = 0; i < defIdx; i += 1) if (src.charCodeAt(i) === 10) defLine += 1;

    // Args from the schema object the op's constant is bound to.
    const args = opArgs(src, schemaConst);

    // Build the honest row.
    let access: Access;
    let basis: string;
    let route = ROUTE_BRIDGE;

    if (UNKNOWN_OPS[op]) {
      access = "unknown";
      basis = `${UNKNOWN_OPS[op]} (OpMutation classifies the op "${classified}")`;
      if (classified === "server") route = ROUTE_SERVER;
    } else if (classified === "read") {
      access = "read";
      basis =
        "the project's own no-default OpMutation table classifies this op \"read\" — 'reaches the bridge and changes nothing', never queued; its zod schema and tool description show pure state reads";
    } else if (classified === "write") {
      access = "write";
      basis =
        "the project's own no-default OpMutation table classifies this op \"write\" — 'changes the project or the application' and serializes behind the write mutex that owns AE's single undo stack";
    } else {
      const so = SERVER_OP_ACCESS[op];
      if (!so) throw new Error(`${TOOL_ID}: server op ${op} not classified in this adapter`);
      access = so.access;
      basis = `OpMutation classifies this op "server" ('never reaches the bridge at all'); ${so.note}`;
      route = ROUTE_SERVER;
    }

    rows.push({
      toolId: TOOL_ID,
      name: op,
      args,
      access,
      accessBasis: basis,
      route,
      semanticId: semanticFor(op),
      status: "source-verified",
      definitionFile: SCHEMAS_FILE,
      definitionLine: defLine,
      implementationFile: SCHEMAS_FILE,
      implementationLine: lineOfIdx(src, classLine),
    });
  }

  if (rows.length === 0) throw new Error(`${TOOL_ID}: no ops parsed from OpSchemas`);

  for (const row of rows) {
    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${TOOL_ID} ${row.name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${TOOL_ID} ${row.name}: ${b.reason}`);
  }
  return rows;
}

function lineOfIdx(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** semanticId — provisional normalization; #11 owns the final grammar. */
function semanticFor(op: string): string {
  // camelCase/nullary names flow through scripts/normalize.ts aliases already;
  // keep snake ops as tool.<kebab> except the ones we map to shared ids.
  switch (op) {
    case "run_jsx":
      return "system.run-jsx";
    case "run_batch":
      return "system.run-jsx";
    case "screenshot_frame":
      return "view.capture-frame";
    case "screenshot_layer":
      return "view.capture-frame";
    case "list_comps":
      return "project.list-comps";
    case "get_comp":
      return "comp.info";
    case "create_comp":
      return "comp.create";
    case "set_comp":
      return "comp.update-settings";
    case "delete_comp":
      return "comp.delete";
    case "duplicate_comp":
      return "comp.duplicate";
    case "set_active_comp":
      return "comp.set-active";
    case "get_expression":
      return "expression.get";
    case "set_expression":
      return "expression.set";
    case "clear_expression":
      return "expression.remove";
    case "add_keyframe":
      return "keyframe.set";
    case "remove_keyframe":
      return "keyframe.set";
    case "get_keyframes":
      return "tool.get-keyframes";
    case "add_to_render_queue":
      return "render.add-to-render-queue";
    case "list_render_queue":
      return "render.list-render-queue";
    case "remove_render_item":
      return "render.remove-from-render-queue";
    case "render_queue":
      return "render.render-queue";
    case "add_marker":
      return "marker.add";
    case "remove_marker":
      return "marker.add";
    case "get_selection":
      return "layer.get-selection";
    case "get_project_summary":
      return "project.info";
    case "import_footage":
      return "footage.import";
    case "checkpoint_comp":
      return "tool.project-checkpoint";
    case "revert_comp":
      return "tool.project-revert";
    default:
      return `tool.${op.replace(/_/g, "-")}`;
  }
}
