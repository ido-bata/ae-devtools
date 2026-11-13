/**
 * HeroicSwan/after-effects-mcp adapter.
 *
 * Surface: 48 `server.tool("name", ...)` registrations in
 * src/mcp/tools/index.ts (registerTools).
 *
 * Route: handlers call `call(HostMethods.X)` → broker.invoke (file bridge) →
 * `$.global.__AE_MCP_DISPATCH__` switch in host-scripts/ae-mcp-methods.jsx.
 *
 * Citations: definition = the tool's name line in src/mcp/tools/index.ts;
 * implementation = the `case "<method>":` line in host-scripts/ae-mcp-methods.jsx
 * when the handler reaches a host method, otherwise the handler's `async` line
 * in src/mcp/tools/index.ts (local-only handler). Definition and implementation
 * are separate fields; both resolve in their own file (review D3).
 *
 * Access: classified on the dispatch case body (the ES3 that actually runs in
 * AE), or on the handler body for local-only tools. A `system.runJsx` route is
 * classified on the handler body because the effect comes from the inline JSX
 * the handler generates, not from the dispatch case.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBody, type ClassifyExtras } from "../classify.ts";
import { semanticFor } from "../normalize.ts";
import { TOOL_DEFS, resolveSourceRoot } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "HeroicSwan/after-effects-mcp";
const DEF_FILE = "src/mcp/tools/index.ts";
const IMPL_FILE = "host-scripts/ae-mcp-methods.jsx";
const ROUTE_HOST = "MCP stdio → broker.invoke (file bridge) → ExtendScript dispatch in AE (host-scripts/ae-mcp-methods.jsx)";
const ROUTE_LOCAL = "MCP stdio → local Node handler in src/mcp/tools/index.ts (no AE host method invoked)";

const EXTRAS: ClassifyExtras = {
  // Handlers that only inspect the broker's local heartbeat/instance registry.
  read: [/listInstances\s*\(/, /isAfterEffectsRunning\s*\(/],
};

/**
 * Per-row overrides where the generic rules cannot see the real behaviour
 * (delegation into a helper/module, render-vs-write, local-only handlers).
 * Every basis quotes verified source evidence (review D2).
 */
interface Override {
  access: Access;
  basis: string;
  /** Alternative implementation citation when behaviour lives in another file. */
  implementationFile?: string;
  implementationLine?: number;
}

const ACCESS_OVERRIDES: Record<string, Override> = {
  // ---- host dispatch (src/mcp/tools/index.ts → host-scripts/ae-mcp-methods.jsx) ----
  ae_list_compositions: {
    access: "read",
    basis: "case project.listComps delegates to the project.info dispatch, which iterates app.project compositions and returns them; mutates nothing",
  },
  ae_get_composition: {
    access: "read",
    basis: "compSummary(resolveComp(args)) reads comp settings/layers and returns a summary object; no mutation in the case body",
  },
  ae_get_layer: {
    access: "read",
    basis: "layerSummary(resolveLayer(...)) reads layer state and returns a summary object; no mutation in the case body",
  },
  ae_set_layer_properties: {
    access: "write",
    basis: "applyLayerProps (ae-mcp-methods.jsx:120) assigns position/scale/rotation/opacity via property(...).setValue(...) plus inPoint/outPoint/parent assignments on the layer",
  },
  ae_run_jsx: {
    access: "execute",
    basis: "case system.runJsx compiles caller-supplied ExtendScript with new Function(\"args\", body) and runs it in AE; privileged arbitrary-code execution — the content effect depends on the caller's code, never defaulted to write",
  },
  ae_create_motion_template: {
    access: "write",
    basis: "createMotionTemplate (ae-mcp-methods.jsx:455) creates solid/text/shape layers in the target comp (makeTemplateSolid/makeTemplateText) and sets markers/keyframes",
  },
  ae_render_composition: {
    access: "execute",
    basis: "renderComposition (ae-mcp-methods.jsx:512) adds the comp to app.project.renderQueue and calls render() to write an output file; a render action, classified execute per taxonomy (not a project-content edit)",
  },
  ae_capture_frame: {
    access: "execute",
    basis: "renders a still via cc.saveFrameToPng(t, file) after a temporary comp.time change that is restored on failure/success; file.remove() targets only the stale local preview PNG, not project content",
  },

  // ---- local-only handlers (no AE host method invoked) ----
  ae_reconnect: {
    access: "execute",
    basis: "ensureBridgeConnected({forceKick:true}) injects the bootstrap via AfterFX -r (src/cli/ensure-ae.ts), a host lifecycle action showing AE's Executing-script dialog; no project mutation",
  },
  ae_list_instances: {
    access: "read",
    basis: "reads the broker's local heartbeat registry (broker.listInstances) and returns it; no AE script executed",
  },
  ae_analyze_cuts: {
    access: "read",
    basis: "runs local ffmpeg silencedetect analysis (src/media/smartCuts.ts analyzeSmartCuts) and returns keep/silence segments; no writes in the module, no AE contact",
  },
  ae_transcribe_video: {
    access: "write",
    basis: "LOCAL-ONLY write: fs.writeFileSync persists transcript SRT/VTT/JSON under ~/.ae-mcp/transcripts — local filesystem only, AE project unchanged (no host method invoked)",
  },
  ae_transcript_to_cuts: {
    access: "write",
    basis: "LOCAL-ONLY write: fs.writeFileSync persists the cleaned transcript and SRT under ~/.ae-mcp — local filesystem only, AE project unchanged (no host method invoked)",
  },
  ae_create_editorial_plan: {
    access: "write",
    basis: "LOCAL-ONLY write: fs.writeFileSync persists the generated plan JSON under ~/.ae-mcp/transcripts — local filesystem only; the handler defers AE mutation to later tools",
  },
  ae_audit_editorial_plan: {
    access: "read",
    basis: "auditEditorialPlan inspects the provided plan object and returns findings; handler contains no write and the source states 'without mutating After Effects'",
  },
  ae_list_motion_templates: {
    access: "read",
    basis: "filters the static MOTION_TEMPLATES catalogue by aspect_ratio and returns the matches; no state mutated",
  },
  ae_create_motion_blueprint: {
    access: "write",
    basis: "LOCAL-ONLY write: fs.mkdirSync + fs.writeFileSync persist the blueprint JSON under ~/.ae-mcp/motion — local filesystem only, no AE contact",
  },
  ae_validate_motion_blueprint: {
    access: "read",
    basis: "auditMotionBlueprint runs coherence checks on the provided blueprint and returns results; no persistence, source states 'without mutating After Effects'",
  },
  ae_audit_motion_coverage: {
    access: "read",
    basis: "auditMotionCoverage inspects the provided blueprint and returns coverage findings; no write in the handler",
  },
  ae_repair_motion_blueprint: {
    access: "read",
    basis: "repairMotionVideoBlueprint applies deterministic repairs to the request-local blueprint and returns before/after audits; handler writes no file and never contacts AE (request-scoped object only)",
  },
  ae_create_review: {
    access: "write",
    basis: "LOCAL-ONLY write: createReview → review.ts writeReviews → fs.writeFileSync persists the review item in the local review store — local filesystem only, no AE contact",
  },
  ae_list_reviews: {
    access: "read",
    basis: "reads the local review store (review.ts readReviews) and returns pending/approved/rejected lists; no mutation",
  },
  ae_decide_review: {
    access: "write",
    basis: "LOCAL-ONLY write: decideReview → review.ts writeReviews → fs.writeFileSync persists the decision in the local review store — local filesystem only, no AE contact",
  },
  ae_get_workflow_preferences: {
    access: "read",
    basis: "preferences.ts getWorkflowPreferences reads the local workflow/brand preferences JSON and returns it; no mutation",
  },
  ae_set_workflow_preferences: {
    access: "write",
    basis: "LOCAL-ONLY write: saveWorkflowPreferences → preferences.ts:66 fs.writeFileSync persists workflow/brand preferences — local filesystem only, no AE contact",
  },
  ae_prepare_blender_3d_job: {
    access: "write",
    basis: "LOCAL-ONLY write: createBlenderJob → blenderBridge.ts fs.mkdirSync/fs.writeFileSync create the local exchange folder and job files — local filesystem only, no AE contact",
  },
  ae_verify_blender_job: {
    access: "read",
    basis: "blenderBridge.ts verifyBlenderJob inspects local exchange artifacts (frame count/diff checks) and returns a verification result; no write in the function",
  },
  ae_list_blender_jobs: {
    access: "read",
    basis: "lists local exchange jobs under ~/.ae-mcp/blender-exchange and returns their status; no mutation",
  },
};

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** `KEY: "value"` pairs of the HostMethods table in src/bridge/protocol.ts. */
function hostMethods(root: string): Map<string, string> {
  const src = readFileSync(join(root, "src", "bridge", "protocol.ts"), "utf8");
  const start = src.indexOf("export const HostMethods");
  const end = src.indexOf("} as const", start);
  if (start < 0 || end < 0) throw new Error(`${TOOL_ID}: HostMethods table not found`);
  const block = src.slice(start, end);
  const map = new Map<string, string>();
  for (const m of block.matchAll(/([A-Z0-9_]+):\s*"([^"]+)"/g)) {
    if (m[1] && m[2]) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Top-level keys of the zod schema object literal (3rd argument of
 * `server.tool(name, description, schema, handler)`). String literals —
 * including braces inside the description — are skipped before the schema's
 * opening brace.
 */
function schemaKeys(src: string, from: number, until: number): string[] {
  const skipString = (at: number): number => {
    const quote = src[at];
    let j = at + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === quote) return j + 1;
      else j += 1;
    }
    return j;
  };
  // Find the schema's opening brace: first `{` outside any string between the
  // name and the handler (name/description strings are skipped, so braces in
  // the description text do not count).
  let open = -1;
  for (let i = from; i < until && i < src.length; i++) {
    const ch = src[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(i) - 1;
      continue;
    }
    if (ch === "{") {
      open = i;
      break;
    }
  }
  if (open < 0) return [];
  const keys: string[] = [];
  const spreads: string[] = [];
  let depth = 0;
  let i = open;
  let inString: string | null = null;
  for (; i < until && i < src.length; i++) {
    const ch = src[i] ?? "";
    if (inString) {
      i = skipString(i) - 1;
      inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(i) - 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === "." && src[i + 1] === "." && src[i + 2] === ".") {
      const m = /^\.\.\.([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 60));
      if (m && m[1]) spreads.push(m[1]);
      continue;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 80));
    if (m && m[1]) {
      keys.push(m[1]);
      i += m[0].length - 1;
    }
  }
  // Resolve `...CompRef` style spreads against `const X = { ... }` in the file.
  for (const name of spreads) {
    const defIdx = src.indexOf(`const ${name} = {`);
    if (defIdx < 0) continue;
    keys.push(...schemaKeys(src, defIdx, Math.min(defIdx + 1500, src.length)));
  }
  return [...new Set(keys)];
}

/** Index of the next `server.tool(` after `from`, or -1. */
function nextTool(src: string, from: number): number {
  return src.indexOf("server.tool(", from);
}

/** The `case "<method>":` line in the dispatch file, or -1. */
function caseLine(methodSrc: string, method: string): number {
  const idx = methodSrc.indexOf(`case "${method}":`);
  return idx < 0 ? -1 : lineOf(methodSrc, idx);
}

/** Dispatch case body (from the case label up to the next case label). */
function caseBody(methodSrc: string, method: string): string {
  const idx = methodSrc.indexOf(`case "${method}":`);
  if (idx < 0) return "";
  const next = methodSrc.indexOf('case "', idx + 1);
  return methodSrc.slice(idx, next < 0 ? Math.min(idx + 4000, methodSrc.length) : next);
}

export function extract(): OperationRow[] {
  const def = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;
  const src = readFileSync(join(root, DEF_FILE), "utf8");
  const methodsSrc = readFileSync(join(root, IMPL_FILE), "utf8");
  const methods = hostMethods(root);

  const rows: OperationRow[] = [];
  let at = nextTool(src, 0);
  while (at >= 0) {
    const end = nextTool(src, at + 1);
    const entry = src.slice(at, end < 0 ? src.length : end);

    const nameMatch = /server\.tool\(\s*"([^"]+)"/.exec(entry);
    if (!nameMatch || !nameMatch[1]) throw new Error(`${TOOL_ID}: unnamed server.tool registration`);
    const toolName = nameMatch[1];
    const nameIdx = at + nameMatch.index + nameMatch[0].indexOf('"');
    const definitionLine = lineOf(src, nameIdx);

    // Handler starts at the first `async` in the entry.
    const asyncIdx = entry.indexOf("async");
    const handlerStart = asyncIdx >= 0 ? at + asyncIdx : at;
    const handlerBody = src.slice(handlerStart, end < 0 ? src.length : end);

    // Host method the handler reaches (first HostMethods.X reference).
    const hm = /HostMethods\.([A-Z0-9_]+)/.exec(handlerBody);
    const methodKey = hm?.[1];
    const method = methodKey ? methods.get(methodKey) : undefined;

    let implementationFile: string;
    let implementationLine: number;
    let behavior: string;
    let route: string;
    let basisNote: string | undefined;

    if (method) {
      const cl = caseLine(methodsSrc, method);
      if (cl < 0) throw new Error(`${TOOL_ID} ${toolName}: no dispatch case for ${method} in ${IMPL_FILE}`);
      implementationFile = IMPL_FILE;
      implementationLine = cl;
      behavior =
        method === "system.runJsx"
          ? handlerBody // effect comes from the inline JSX the handler generates
          : caseBody(methodsSrc, method);
      route = ROUTE_HOST;
      if (method === "system.runJsx") {
        basisNote = "effect determined by the handler's inline ExtendScript, not by the dispatch case";
      }
    } else {
      implementationFile = DEF_FILE;
      implementationLine = lineOf(src, handlerStart);
      behavior = handlerBody;
      route = ROUTE_LOCAL;
    }

    const args = schemaKeys(src, nameIdx, handlerStart < 0 ? src.length : handlerStart);
    const ov = ACCESS_OVERRIDES[toolName];
    const cls = ov ?? classifyBody(behavior, EXTRAS);
    const basis = ov ? ov.basis : basisNote ? `${cls.basis} (${basisNote})` : cls.basis;
    const implFile = ov?.implementationFile ?? implementationFile;
    const implLine = ov?.implementationLine ?? implementationLine;

    const row: OperationRow = {
      toolId: TOOL_ID,
      name: toolName,
      args,
      access: cls.access,
      accessBasis: basis,
      route,
      semanticId: semanticFor(toolName),
      status: "source-verified",
      definitionFile: DEF_FILE,
      definitionLine,
      implementationFile: implFile,
      implementationLine: implLine,
    };
    rows.push(row);
    at = end;
  }
  if (rows.length === 0) throw new Error(`${TOOL_ID}: no server.tool registrations found`);

  for (const row of rows) {
    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${TOOL_ID} ${row.name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${TOOL_ID} ${row.name}: ${b.reason}`);
  }
  return rows;
}
