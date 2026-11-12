/**
 * Dakkshin-family adapter: Dakkshin/after-effects-mcp,
 * TheLlamainator/after-effects-mcp and a-y-ibrahim/after-effects-mcp.
 *
 * All three share one design (fork lineage, see registry notes):
 *   src/index.ts `server.tool("name", ...)` handler
 *     → writeCommandFile("<cmd>") / sendBridgeCommand("<cmd>")  (command file)
 *     → CEP panel src/scripts/mcp-bridge-auto.jsx `executeCommand` switch
 *     → `function <impl>(args)` ExtendScript in AE.
 *
 * Citations: definition = the tool's name line in src/index.ts;
 * implementation = the `function <impl>(` line in src/scripts/mcp-bridge-auto.jsx
 * resolved through the dispatch case (`case "<cmd>":` → `result = <impl>(...)`).
 * Both fields are separate and each resolves in its own file (review D3).
 *
 * Access: classified on the ExtendScript function body. Handlers that never
 * queue a command (local help/result/preset/wav utilities) are classified on
 * the handler body with the LOCAL route.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBody, type ClassifyExtras } from "../classify.ts";
import { semanticFor } from "../normalize.ts";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const DEF_FILE = "src/index.ts";
const IMPL_FILE = "src/scripts/mcp-bridge-auto.jsx";
const ROUTE_HOST =
  "MCP stdio → command-file bridge (Documents/LOCALAPPDATA) → CEP panel executeCommand → ExtendScript in AE";
const ROUTE_LOCAL = "MCP stdio → local Node handler in src/index.ts (no AE host invocation)";

/** Registration forms across the three forks (tool name → special handling). */
const FAMILY = ["Dakkshin/after-effects-mcp", "TheLlamainator/after-effects-mcp", "a-y-ibrahim/after-effects-mcp"] as const;

const EXTRAS: ClassifyExtras = {
  read: [
    /readResultsFromTempFile\s*\(/,
    /collectPresetFiles\s*\(/,
    /analyzeWavBuffer\s*\(/,
    /readFileSync\s*\(/,
    /existsSync\s*\(/,
    /statSync\s*\(/,
    /app\.effects\b/,
  ],
  write: [
    /writeFileSync\s*\(/,
    /mkdirSync\s*\(/,
    /atomicWriteSync\s*\(/,
    // AE content mutations: applying a preset file, adding an effect.
    /\bapplyPreset\s*\(/,
    /\baddEffect\w*\s*\(/,
    /\bapplyEffect\w*\s*\(/,
  ],
};

/**
 * Per-tool overrides where the generic rules cannot see the real behaviour.
 * Every basis quotes verified source evidence (review D2).
 */
const ACCESS_OVERRIDES: Record<string, { access: Access; basis: string; localCitation?: boolean }> = {
  // Mixed dispatcher: the `script` argument selects one of 20 allowlisted
  // ExtendScript implementations, reads and writes alike.
  "run-script": {
    access: "unknown",
    basis:
      "dispatcher: the `script` argument selects one of 20 allowlisted ExtendScript commands (createComposition/deleteLayer as well as getProjectInfo/listCompositions); access depends on the argument and is not decidable at registration time",
  },
  "get-help": {
    access: "read",
    basis: "returns static help text from the handler; no state read or written, no AE contact",
  },
  "mcp_aftereffects_get_effects_help": {
    access: "read",
    basis: "returns static effects help text from the handler; no state read or written, no AE contact",
  },
  "get-results": {
    access: "read",
    basis: "readResultsFromTempFile() reads the shared ae_mcp_result.json written by the AE panel and returns it; no mutation",
  },
  "test-animation": {
    access: "write",
    basis:
      "LOCAL-ONLY write: fs.writeFileSync persists a generated .jsx test script to the OS temp dir for manual execution (the embedded script sets an opacity keyframe / position expression when the user runs it); no bridge command queued automatically",
  },
  "list-presets": {
    access: "read",
    basis: "collectPresetFiles scans local .ffx preset directories and returns the matches; no mutation, no AE contact",
  },
  "search-presets": {
    access: "read",
    basis: "filters the locally scanned .ffx preset list by query and returns matches; no mutation, no AE contact",
  },
  "analyze-audio-waveform": {
    access: "read",
    basis:
      "reads a local audio file (WAV natively, other formats transcoded via ffmpeg to a temp file) and returns waveform/peak data; no AE contact and no persistent state change beyond the incidental temp transcode",
  },
  "check-bridge": {
    access: "read",
    basis: "health check: reports bridge panel version, AE version, bridge folder and open project/active comp; reads state only",
  },
  "get-audio-info": {
    access: "read",
    basis: "returns audio metadata, source path, markers and existing audio level keyframes for a layer; reads only",
  },
  "get-layer-clip-frames": {
    access: "read",
    basis: "returns a layer's clip start/end frames, source frame range and duration in frames; reads only",
  },
  "execute-script": {
    access: "unknown",
    basis:
      "dispatcher: the `script` argument is arbitrary ExtendScript eval'd by executeScript() in the bridge (createComposition/remove(...) and read-only returns alike); access depends on the argument and is not decidable at registration time",
  },
  "render-aerender": {
    access: "execute",
    localCitation: true,
    basis:
      "handler saves the project through the bridge and then `spawn(aerenderPath, args, { detached: true, ... })` starts a headless aerender render process — a render/lifecycle action, not a project-content edit by this tool (the save itself is queued as executeScript)",
  },
  "render-status": {
    access: "read",
    basis:
      "reads the in-process `runningRenders` map (pid liveness, state, log tail via tailFile) and returns it; the only mutation is `runningRenders.delete(pid)` for finished local bookkeeping entries, no AE state",
  },
  "relink-footage": {
    access: "write",
    basis:
      "relinkFootage() calls `item.replace(newFile)` — the footage item's source file is replaced, mutating project content",
  },
  "reorder-layer": {
    access: "write",
    basis:
      "reorderLayer() calls `layer.moveToBeginning()` / `moveToEnd()` / `moveBefore(...)` / `moveAfter(...)`, changing the layer stacking order in the comp — project content mutation",
  },
  "precompose-layers": {
    access: "write",
    basis:
      "precomposeLayers() calls `comp.layers.precompose(indices, name, moveAllAttributes)`, moving the selected layers into a new precomposition — project content mutation",
  },
  "render-queue": {
    access: "unknown",
    basis:
      "dispatcher: the `action` argument selects read (default, lists queue items with status/outputPath) or write (`rq.item(1).remove()` clears / `rq.item(args.index).remove()` removes an item); access depends on the argument and is not decidable at registration time",
  },
  "start-render": {
    access: "execute",
    basis:
      "startRender() runs `rq.render()`, AE's render-pipeline action which blocks the host; it edits no project content itself (queue items are added by add-to-render-queue)",
  },
  "see-frame": {
    access: "write",
    basis:
      "TEMP-OBJECT write with net content unchanged: creates `__mcp_tmp__seeframe` via `app.project.items.addComp(...)`, captures frames with `saveFrameToPng(...)` to disk, then `tempComp.remove()` before returning; also writes PNG files outside the project",
  },
  "contact-sheet": {
    access: "write",
    basis:
      "TEMP-OBJECT write with net content unchanged: creates `__mcp_tmp__contact` via `app.project.items.addComp(...)`, renders the sheet with `saveFrameToPng(...)`, then removes the temp comp and imported items before returning; also writes PNG files outside the project",
  },
  "match-reference": {
    access: "write",
    basis:
      "TEMP-OBJECT write with net content unchanged: creates `__mcp_tmp__sbs` / `__mcp_tmp__diff` comps via `app.project.items.addComp(...)`, writes comparison PNGs with `saveFrameToPng(...)`, then removes the temp comps and imported items before returning; also writes PNG files outside the project",
  },
};

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Top-level keys of the zod schema object literal of one registration. */
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
  for (let i = open; i < until && i < src.length; i++) {
    const ch = src[i] ?? "";
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
  for (const name of spreads) {
    const defIdx = src.indexOf(`const ${name} = {`);
    if (defIdx < 0 || defIdx > until) continue;
    keys.push(...schemaKeys(src, defIdx, Math.min(defIdx + 1500, src.length)));
  }
  return [...new Set(keys)];
}

/** Next registration boundary (tools, prompts and resources all end an entry). */
function nextBoundary(src: string, from: number): number {
  const a = src.indexOf("server.tool(", from);
  const b = src.indexOf("server.prompt(", from);
  const c = src.indexOf("server.resource(", from);
  const opts = [a, b, c].filter((n) => n >= 0);
  return opts.length > 0 ? Math.min(...opts) : -1;
}

interface ImplRef {
  file: string;
  line: number;
  body: string;
}

/**
 * Resolve `case "<cmd>":` in the dispatch switch to the implementing
 * `function <name>(` in the same file. Returns null when the case is absent.
 */
function resolveDispatch(implSrc: string, cmd: string): ImplRef | null {
  let caseIdx = implSrc.indexOf(`case "${cmd}":`);
  if (caseIdx < 0) return null;
  // Fall-through: `case "a":` immediately followed by `case "b":` shares one body.
  for (let hop = 0; hop < 4; hop++) {
    const nextCase = implSrc.indexOf('case "', caseIdx + 1);
    if (nextCase < 0) break;
    const segment = implSrc.slice(caseIdx, nextCase);
    const residue = segment.replace(/case\s+"[^"]*"\s*:/g, "").trim();
    if (residue.length > 0) break; // this case has its own body
    caseIdx = nextCase;
  }
  const nextCase = implSrc.indexOf('case "', caseIdx + 1);
  const caseBody = implSrc.slice(caseIdx, nextCase < 0 ? implSrc.length : nextCase);
  const fnMatch = /result\s*=\s*([A-Za-z_$][\w$]*)\s*\(/.exec(caseBody);
  if (!fnMatch || !fnMatch[1]) {
    // Inline case body: cite the case line itself.
    return { file: IMPL_FILE, line: lineOf(implSrc, caseIdx), body: caseBody };
  }
  const seen = new Set<string>();
  let fn = fnMatch[1];
  let fnIdx = implSrc.indexOf(`function ${fn}(`);
  let body = fnIdx < 0 ? caseBody : functionBodyOf(implSrc, fnIdx);
  // One-level (then chained) delegation: `return helper(args);`.
  while (fnIdx >= 0 && !seen.has(fn)) {
    seen.add(fn);
    const delegated = /\breturn\s+([A-Za-z_$][\w$]*)\s*\(\s*args\s*\)\s*;/.exec(body);
    if (!delegated || !delegated[1] || seen.has(delegated[1])) break;
    const nextIdx = implSrc.indexOf(`function ${delegated[1]}(`);
    if (nextIdx < 0) break;
    fn = delegated[1];
    fnIdx = nextIdx;
    body = functionBodyOf(implSrc, fnIdx);
  }
  if (fnIdx < 0) {
    return { file: IMPL_FILE, line: lineOf(implSrc, caseIdx), body: caseBody };
  }
  return { file: IMPL_FILE, line: lineOf(implSrc, fnIdx), body };
}

/** Brace-balanced body of the function starting at `from`. */
function functionBodyOf(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open < 0) return src.slice(from, Math.min(from + 2000, src.length));
  let depth = 0;
  let i = open;
  let inString: string | null = null;
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
  for (; i < src.length; i++) {
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
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth <= 0) break;
    }
  }
  return src.slice(open, i + 1);
}

function extractOne(def: ToolDef): OperationRow[] {
  const root = resolveSourceRoot(def).root;
  const src = readFileSync(join(root, DEF_FILE), "utf8");
  const implSrc = readFileSync(join(root, IMPL_FILE), "utf8");

  const rows: OperationRow[] = [];
  let at = src.indexOf("server.tool(");
  while (at >= 0) {
    const end = nextBoundary(src, at + 1);
    const entry = src.slice(at, end < 0 ? src.length : end);

    const nameMatch = /server\.tool\(\s*"([^"]+)"/.exec(entry);
    if (!nameMatch || !nameMatch[1]) throw new Error(`${def.id}: unnamed server.tool registration`);
    const toolName = nameMatch[1];
    const nameIdx = at + nameMatch.index + nameMatch[0].indexOf('"');
    const definitionLine = lineOf(src, nameIdx);

    const asyncIdx = entry.indexOf("async");
    const handlerStart = asyncIdx >= 0 ? at + asyncIdx : at;
    const handlerBody = src.slice(handlerStart, end < 0 ? src.length : end);

    // Literal command names queued by this handler (may be several).
    const cmds = [
      ...new Set([
        ...[...handlerBody.matchAll(/writeCommandFile\(\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
        ...[...handlerBody.matchAll(/sendBridgeCommand\(\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
      ].filter(Boolean)),
    ];
    const queuesAtAll = /writeCommandFile\s*\(|sendBridgeCommand\s*\(/.test(handlerBody);

    const args = schemaKeys(src, nameIdx, handlerStart < 0 ? src.length : handlerStart);
    const ov = ACCESS_OVERRIDES[toolName];

    let implementationFile: string;
    let implementationLine: number;
    let access: Access;
    let basis: string;
    let route: string;

    if (ov?.localCitation) {
      // Override asks to cite the local handler body (the real effect site).
      implementationFile = DEF_FILE;
      implementationLine = lineOf(src, handlerStart);
      access = ov.access;
      basis = ov.basis;
      route = ROUTE_LOCAL;
    } else if (cmds.length > 0) {
      // Command-file route: classify the ExtendScript side.
      const refs = cmds.map((c) => resolveDispatch(implSrc, c));
      const first = refs[0];
      if (!first) {
        throw new Error(`${def.id} ${toolName}: no dispatch case for "${cmds[0]}" in ${IMPL_FILE}`);
      }
      implementationFile = first.file;
      implementationLine = first.line;
      const bodies = refs.map((r) => r?.body ?? "").join("\n");
      const cls = classifyBody(bodies, EXTRAS);
      access = ov?.access ?? cls.access;
      basis = ov?.basis ?? cls.basis;
      if (cmds.length > 1) {
        basis += ` (handler queues ${cmds.length} commands: ${cmds.join(", ")})`;
      }
      route = ROUTE_HOST;
    } else if (queuesAtAll) {
      // Dynamic command name (no literal) — access not decidable at registration.
      implementationFile = DEF_FILE;
      implementationLine = lineOf(src, handlerStart);
      const cls = classifyBody(handlerBody, EXTRAS);
      access = "unknown";
      basis = `${ov?.basis ?? cls.basis} — command name is a runtime argument, no literal command at the call site`;
      route = ROUTE_LOCAL;
    } else {
      // Local-only handler (help/results/presets/wav utilities).
      implementationFile = DEF_FILE;
      implementationLine = lineOf(src, handlerStart);
      const cls = classifyBody(handlerBody, EXTRAS);
      access = ov?.access ?? cls.access;
      basis = ov?.basis ?? cls.basis;
      route = ROUTE_LOCAL;
    }

    rows.push({
      toolId: def.id,
      name: toolName,
      args,
      access,
      accessBasis: basis,
      route,
      semanticId: semanticFor(toolName),
      status: "source-verified",
      definitionFile: DEF_FILE,
      definitionLine,
      implementationFile,
      implementationLine,
    });
    // The boundary may be a prompt/resource registration — re-search for the next tool.
    at = end < 0 ? -1 : src.indexOf("server.tool(", end);
  }
  if (rows.length === 0) throw new Error(`${def.id}: no server.tool registrations found`);

  for (const row of rows) {
    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${def.id} ${row.name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${def.id} ${row.name}: ${b.reason}`);
  }
  return rows;
}

export function extract(): OperationRow[] {
  const rows: OperationRow[] = [];
  for (const id of FAMILY) {
    const def = TOOL_DEFS.find((t) => t.id === id);
    if (!def) throw new Error(`${id}: not in registry`);
    rows.push(...extractOne(def));
  }
  return rows;
}
