/**
 * JUNKDOGE-JOE/after-effects-mcp adapter (ae-mcp).
 *
 * Surface: 16 MCP tool modules under plugin/host/mcp/tools/ — each file
 * exports `{ definition, call(args, context, deps) }` and tools.js aggregates
 * them (the TOOL_MODULES list there is the /mcp tools/list order). One tool
 * per module; names are `ae_*`.
 *
 * Route: the CEP panel host (plugin/host/server.js) exposes MCP over HTTP;
 * clients/ae-mcp-jkdg is a stdio→HTTP shim. Tools that reach After Effects
 * call `deps.executeJsx({ code })` (template files under jsx/templates/) or
 * the native AEGP plane (`deps.nativeInvoke`); the rest are host-process or
 * filesystem operations.
 *
 * Citations: definition = the `name: 'ae_*'` line of the module's
 * `const definition = {...}`; implementation = the `async function call(...)`
 * line (exec-recover delegates to exec.js `call`, so its implementation
 * citation points into tools/exec.js). Both pairs resolve in their own file
 * (review D3).
 *
 * Access: the module bodies are dispatchers into checkpoint stores, the tool
 * library, the workspace capability and the JSX bridge — the generic tiers
 * rarely see the real effect, so every row carries an explicit override with
 * the located source behaviour (review D1). The project's own
 * `VERB_ANNOTATIONS` (plugin/host/mcp/annotations.js) is recorded as a claim,
 * never used as the classifier's input.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "JUNKDOGE-JOE/after-effects-mcp";
const TOOLS_DIR = "plugin/host/mcp/tools";

const ROUTE_JSX = "MCP over HTTP (CEP host plugin/host/server.js) → deps.executeJsx (jsx/templates) → ExtendScript in AE";
const ROUTE_NATIVE = "MCP over HTTP (CEP host) → deps.nativeInvoke (native AEGP plane)";
const ROUTE_HOST = "MCP over HTTP (CEP host) → host-process state in plugin/host (no AE script)";
const ROUTE_FS = "MCP over HTTP (CEP host) → local filesystem (checkpoints / tool library / skills)";

/**
 * Every tool module's real behaviour, derived from reading the module body:
 * what it dispatches to, and the side-effect class of that dispatch.
 * The `impl` field relocates the implementation citation when the behaviour
 * lives in another module than the registration.
 */
interface ToolSpec {
  file: string;
  args: string[];
  access: Access;
  basis: string;
  route: string;
  /** Implementation citation when the behaviour lives elsewhere. */
  impl?: [file: string, line: number];
}

const TOOLS: ToolSpec[] = [
  {
    file: "status.js",
    args: ["depth", "expect"],
    access: "read",
    basis:
      "depth=ping/status reads the same-process CEP host status object (deps.getStatus / deps.getClients; baseStatus() at :35); depth=diagnose additionally probes AE by running the diagnose.jsx template read-only (`nativeProjectGraphEffect: 'preserve'`) and reports responsiveness — no project content is mutated in any branch",
    route: ROUTE_HOST,
  },
  {
    file: "exec.js",
    args: ["code", "undo_group_name", "checkpoint_label", "timeout_sec", "checkpoint_continue"],
    access: "unknown",
    basis:
      "dispatcher: autoCheckpoint(...) saves a .aep snapshot then `code` — arbitrary caller-supplied ExtendScript — is dispatched through deps.executeJsx (exec.js:621+); both read-only and project writes flow through the same path, so access depends on the caller's script and is not decidable at registration time",
    route: ROUTE_JSX,
  },
  {
    file: "exec-recover.js",
    args: ["recoveryId", "code", "retryMode", "undo_group_name", "checkpoint_label", "timeout_sec"],
    access: "unknown",
    basis:
      "dispatcher: re-dispatches a saved or corrected arbitrary ExtendScript via exec.js `recover` (module.exports = { definition, call: execTool.recover }); retryMode 'restore' reverts the project to the recorded checkpoint first, 'continue' keeps current state — access depends on the caller's script and is not decidable at registration time",
    route: ROUTE_JSX,
    impl: ["plugin/host/mcp/tools/exec.js", 575],
  },
  {
    file: "preview-frame.js",
    args: ["comp_id", "time", "times", "range", "capture_id", "index", "layout", "grid_max_side", "compare", "out_dir", "include_base64", "scale"],
    access: "execute",
    basis:
      "renders composition pixels to PNG files via the AE `saveFrameToPng` path (renderTemplate TEMPLATE at :246, `prepare the desired layer state before capture`; files written under out_dir / temp previews) — an image-output action; the description states 'This tool leaves Guide and layer visibility settings unchanged', and VERB_ANNOTATIONS records readOnlyHint true, but the render/file output is host work, not a project-content read",
    route: ROUTE_JSX,
  },
  {
    file: "read.js",
    args: ["target", "comp", "layer", "property", "page", "sort", "target_", "filter", "depth", "sampleTime", "format"],
    access: "read",
    basis:
      "structured reflection through the persistent JSX engine: 'Reads are paginated, sortable, filterable, and never create checkpoints, undo groups, or mutations' (read.js:4), validated closed request shape, traversal/filtering/ordering/pagination owned by jsx/templates/read.perf.jsx — read-only",
    route: ROUTE_JSX,
  },
  {
    file: "checkpoint.js",
    args: ["action", "label", "limit"],
    access: "write",
    basis:
      "dispatcher: action=list enumerates existing .aep checkpoint files (read); action=create calls createCheckpoint(...) (checkpoint-ops.js) which SAVES a project snapshot — a project-file write; the two branches are not separable at registration time and the create branch dominates (VERB_ANNOTATIONS records readOnlyHint false)",
    route: ROUTE_FS,
  },
  {
    file: "revert.js",
    args: ["checkpoint_id", "branch_before_revert"],
    access: "execute",
    basis:
      "host lifecycle: reverts the open project to a saved checkpoint by running revert_open.jsx / revert_close.jsx templates through deps.executeJsx (runTemplate at :50, `projectRestorePhase`), optionally branching current state first — swaps the loaded document rather than editing project items; the checkpoint the templates load is written by ae_checkpoint, not by this tool",
    route: ROUTE_JSX,
  },
  {
    file: "validate-expressions.js",
    args: ["comp_id", "layer_ids", "prop", "sample_times", "max_results"],
    access: "read",
    basis:
      "force-evaluates expressions via the validate_expressions.jsx template (`renderTemplate(TEMPLATE, ...)` at :72) and reports errors/samples — nativeProjectGraphEffect 'preserve', result parsed and returned; no project content is changed (VERB_ANNOTATIONS records readOnlyHint true)",
    route: ROUTE_JSX,
  },
  {
    file: "native-exec.js",
    args: [],
    access: "unknown",
    basis:
      "dispatcher: runs one bounded linear program of curated native AEGP primitives through invokeNativeProgram (native-program.js) — 'Programs containing writes require one stable operationKey…read-only programs must omit both fields'; the program's ops decide read vs write at runtime and are not decidable at registration time",
    route: ROUTE_NATIVE,
  },
  {
    file: "tool-search.js",
    args: ["query", "name"],
    access: "read",
    basis:
      "searches the Tool Library (defaultLibrary / deps.getToolLibrary) by case-insensitive text or exact artifact id and returns matches — a local store read, no AE contact (VERB_ANNOTATIONS records readOnlyHint true)",
    route: ROUTE_FS,
  },
  {
    file: "tool-use.js",
    args: ["name", "args"],
    access: "unknown",
    basis:
      "dispatcher: replays a Tool Library artifact by rendering its stored script (store.renderPlan(plan) at :70) and dispatching it via deps.executeJsx — the artifact's content decides read vs write and is not decidable at registration time (library artifacts can run arbitrary ExtendScript)",
    route: ROUTE_JSX,
  },
  {
    file: "tool-save.js",
    args: ["name", "create", "update", "content", "argsSchema", "status", "newName", "description"],
    access: "write",
    basis:
      "persists a reusable tool artifact in the local Tool Library (store.saveArtifact(prepared.artifact) at :238 via library(deps)) and records the save in the activity log — a local-filesystem write; never contacts AE",
    route: ROUTE_FS,
  },
  {
    file: "skill-use.js",
    args: ["name", "args", "execute"],
    access: "unknown",
    basis:
      "dispatcher: lists or renders saved skills (read) and, when execute:true, runs a JSX skill's script via deps.executeJsx (skill-use.js:164) — the skill's content decides read vs write and is not decidable at registration time",
    route: ROUTE_JSX,
  },
  {
    file: "instances.js",
    args: ["action", "instance_id", "project_path", "work_dir", "save_policy"],
    access: "unknown",
    basis:
      "dispatcher: action=list discovers local AE instances (read), but start/stop spawn or terminate an After Effects process via deps.instances(action, args, context) — the action argument decides read vs process lifecycle at runtime and is not decidable at registration time",
    route: ROUTE_HOST,
  },
  {
    file: "workspace.js",
    args: ["action", "instance_id", "project_path", "context_id", "target_context_id", "observation_id", "confirm", "access", "work_dir"],
    access: "write",
    basis:
      "binds a task to an AE project and manages the write-access capability (deps.workspace('bind'|'transfer'|'reconcile', …) at :37; ownership bound for a panel turn, access read→write upgrades gated by the approval gate) — host capability state, not project content; the bound context_id enables later writes, so a plain read/write split would overstate the read branch",
    route: ROUTE_HOST,
  },
  {
    file: "read-job.js",
    args: ["action", "checkpoint_id", "requests", "job_id", "offset", "limit"],
    access: "read",
    basis:
      "submits bounded ae_read / ae_previewFrame requests against an EXISTING checkpoint ('No arbitrary scripts', jobs.submit) and returns paginated snapshot results — read-only by construction (readOnlyHint true in its own annotations)",
    route: ROUTE_FS,
  },
];

/** Name of the tool a module registers (`name: 'ae_*'`). */
function toolNameOf(src: string, rel: string): { name: string; nameLine: number } {
  const m = /name:\s*'([a-zA-Z0-9_]+)'/.exec(src);
  if (!m || !m[1] || m.index === undefined) {
    throw new Error(`${TOOL_ID} ${rel}: no name: '<tool>' in the definition object`);
  }
  let line = 1;
  for (let i = 0; i < m.index; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return { name: m[1], nameLine: line };
}

/** Line of the call() implementation (or a chosen alternative site). */
function callLineOf(src: string): { index: number; line: number } {
  const m = /(?:async\s+)?function\s+call\s*\(/.exec(src);
  const index = m?.index ?? 0;
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return { index, line };
}

function lineAt(file: string, want: number): number {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  if (want < 1 || want > lines.length) {
    throw new Error(`${TOOL_ID}: hardcoded line ${want} out of range for ${file}`);
  }
  return want;
}

/**
 * semanticId: normalized by scripts/normalize.ts, with ae_ prefixes stripped.
 * These MCP verbs are host-plumbing primitives (checkpoint/exec/workspace)
 * rather than Adobe API surfaces; the derived `tool.*` / `system.*` ids below
 * are provisional and #11 owns the final grammar.
 */
function semanticFor(name: string): string {
  switch (name) {
    case "ae_status":
      return "system.health";
    case "ae_read":
      return "tool.read-tree";
    case "ae_readJob":
      return "tool.read-tree";
    case "ae_exec":
    case "ae_execRecover":
    case "ae_nativeExec":
      return "system.run-jsx";
    case "ae_previewFrame":
      return "view.capture-frame";
    case "ae_checkpoint":
      return "tool.project-checkpoint";
    case "ae_revert":
      return "tool.project-revert";
    case "ae_validateExpressions":
      return "tool.validate-expressions";
    case "ae_toolSearch":
      return "tool.tool-library-search";
    case "ae_toolUse":
      return "system.run-jsx";
    case "ae_toolSave":
      return "tool.tool-library-save";
    case "ae_skillUse":
      return "system.run-jsx";
    case "ae_instances":
      return "app.instance-lifecycle";
    case "ae_workspace":
      return "tool.workspace-bind";
    default:
      return `system.${name.replace(/^ae_/, "").replace(/_/g, "-")}`;
  }
}

export function extract(): OperationRow[] {
  const def: ToolDef | undefined = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;

  const rows: OperationRow[] = [];
  for (const spec of TOOLS) {
    const rel = `${TOOLS_DIR}/${spec.file}`;
    const abs = join(root, rel);
    const src = readFileSync(abs, "utf8");
    const { name, nameLine } = toolNameOf(src, rel);

    let implementationFile = rel;
    let implementationLine = callLineOf(src).line;
    if (spec.impl) {
      implementationFile = spec.impl[0];
      implementationLine = lineAt(join(root, implementationFile), spec.impl[1]);
    }

    const row: OperationRow = {
      toolId: TOOL_ID,
      name,
      args: spec.args,
      access: spec.access,
      accessBasis: spec.basis,
      route: spec.route,
      semanticId: semanticFor(name),
      status: "source-verified",
      definitionFile: rel,
      definitionLine: nameLine,
      implementationFile,
      implementationLine,
    };

    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${TOOL_ID} ${name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${TOOL_ID} ${name}: ${b.reason}`);
    rows.push(row);
  }

  if (rows.length === 0) throw new Error(`${TOOL_ID}: no tool modules parsed`);
  return rows;
}
