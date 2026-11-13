/**
 * 23d1/after-effects-mcp adapter.
 *
 * Tool surface: `defineTool(server, "ae_*", config, handler)` registrations in
 * src/tools/*.ts (7 files). The handler queues ExtendScript through
 * `runJsx(...)` from src/bridge.js — the JSX source is an inline template
 * literal in the same file, so definition and implementation citations both
 * resolve in the registration file (review D3).
 *
 * Access is classified on the handler body (which contains the JSX template
 * literal verbatim, so AE-side mutations are visible to the classifier) plus
 * the per-tool ACCESS_OVERRIDES where the generic tiers cannot decide
 * (arbitrary-script dispatcher, render vs queue-item add, temp probe items).
 * `readOnly: true` in the config is recorded as the registration's claim, not
 * used as the classifier's input (review D1: derive from actual behaviour).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyBody, type ClassifyExtras } from "../classify.ts";
import { semanticFor } from "../normalize.ts";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOLS_DIR = "src/tools";
const ROUTE = "MCP stdio → runJsx bridge (src/bridge.js) → ExtendScript in AE";

const EXTRAS: ClassifyExtras = {
  read: [
    /readFileSync\s*\(/,
    /statSync\s*\(/,
    /existsSync\s*\(/,
    /copyFileSync\s*\(/,
    /AEMCP\.serialize\w*\s*\(/,
    /app\.effects\b/,
    /app\.fonts\b/,
    /\.keyTime\s*\(/,
    /app\.project\.dirty\b/,
  ],
  write: [
    /\bAEMCP\.setKeys\s*\(/,
    /mkdirSync\s*\(/,
    /writeFileSync\s*\(/,
    /rmSync\s*\(/,
    /\bremoveKey\s*\(/,
  ],
  execute: [/findMenuCommandId\s*\(/],
};

/**
 * Per-tool overrides where the generic tiers cannot decide the real behaviour.
 * Every basis quotes verified source evidence (review D2).
 */
const ACCESS_OVERRIDES: Record<string, { access: Access; basis: string }> = {
  "ae_run_script": {
    access: "unknown",
    basis:
      "dispatcher: the `script` argument is arbitrary ExtendScript passed straight to runJsx(args.script) (setValue/remove(...) and read-only returns alike); access depends on the argument and is not decidable at registration time",
  },
  "ae_render": {
    access: "write",
    basis:
      "always mutates the render queue: `app.project.renderQueue.items.add(comp)`, sets `item.timeSpanStart` / `output.file = new File(...)`, then — unless `queueOnly` — calls `app.project.renderQueue.render()`; the queue item is project content, the render itself is a host action",
  },
  "ae_save_frame": {
    access: "execute",
    basis:
      "renders one frame with `comp.saveFrameToPng(time, file)` into a local PNG (mkdirSync/copyFileSync are file output only); no project content is changed despite the registration declaring readOnly: true",
  },
  "ae_render_templates": {
    access: "write",
    basis:
      "TEMP-OBJECT write with net content unchanged: borrows a queue item via `app.project.renderQueue.items.add(comps[0])` to read `probe.templates`, then `probe.remove()` before returning (registration declares readOnly: true; the probe is the only mutation)",
  },
  "ae_open_project": {
    access: "execute",
    basis:
      "host lifecycle: closes the current project (`app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)`) and loads another — `app.open(file)` or `app.newProject()`; replaces the loaded document rather than editing items in it",
  },
  "ae_save_project": {
    access: "write",
    basis:
      "persists the project document with `app.project.save(new File(ARGS.path))` / `app.project.save()` (Save As when `path` is given) — writes project content to disk",
  },
};

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Top-level keys of an `inputSchema: { ... }` object literal. */
function schemaKeys(src: string, from: number, until: number): string[] {
  const at = src.indexOf("inputSchema:", from);
  if (at < 0 || at > until) return [];
  const open = src.indexOf("{", at);
  if (open < 0 || open > until) return [];
  const keys: string[] = [];
  let depth = 0;
  for (let i = open; i < until && i < src.length; i++) {
    const ch = src[i] ?? "";
    if (ch === '"') {
      // skip strings (describe() text contains braces/colons)
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      i = j;
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
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 80));
    if (m && m[1]) {
      keys.push(m[1]);
      i += m[0].length - 1;
    }
  }
  return [...new Set(keys)];
}

function extractOne(def: ToolDef): OperationRow[] {
  const root = resolveSourceRoot(def).root;
  const dir = join(root, TOOLS_DIR);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  const rows: OperationRow[] = [];
  for (const file of files) {
    const rel = `${TOOLS_DIR}/${file}`;
    const src = readFileSync(join(dir, file), "utf8");

    let at = src.indexOf("defineTool(");
    while (at >= 0) {
      const end = src.indexOf("defineTool(", at + 1);
      const entry = src.slice(at, end < 0 ? src.length : end);

      const nameMatch = /defineTool\(\s*server,\s*"([^"]+)"/.exec(entry);
      if (!nameMatch || !nameMatch[1]) throw new Error(`${def.id} ${rel}: unnamed defineTool registration`);
      const toolName = nameMatch[1];
      const nameIdx = at + nameMatch.index + nameMatch[0].indexOf('"');
      const definitionLine = lineOf(src, nameIdx);

      const asyncIdx = entry.indexOf("async");
      const handlerStart = asyncIdx >= 0 ? at + asyncIdx : at;
      const handlerBody = src.slice(handlerStart, end < 0 ? src.length : end);

      const args = schemaKeys(src, nameIdx, handlerStart);
      const declaresReadOnly = /readOnly:\s*true/.test(entry);

      const ov = ACCESS_OVERRIDES[toolName];
      const cls = classifyBody(handlerBody, EXTRAS);
      const access = ov?.access ?? cls.access;
      let basis = ov?.basis ?? cls.basis;
      if (declaresReadOnly) basis += " (registration declares readOnly: true)";
      if (!ov && access === "write" && !declaresReadOnly && !/runJsx\s*\(/.test(handlerBody)) {
        basis = `LOCAL-ONLY write: ${basis}`;
      }

      const usesJsx = /runJsx\s*\(/.test(handlerBody);
      const implIdx = usesJsx ? handlerBody.search(/runJsx\s*\(/) : 0;

      const row: OperationRow = {
        toolId: def.id,
        name: toolName,
        args,
        access,
        accessBasis: basis,
        route: usesJsx ? ROUTE : "MCP stdio → local Node handler in src/tools (no AE host invocation)",
        semanticId: semanticFor(toolName),
        status: "source-verified",
        definitionFile: rel,
        definitionLine,
        implementationFile: rel,
        implementationLine: lineOf(src, handlerStart + implIdx),
      };

      for (const [f, l] of [
        [row.definitionFile, row.definitionLine],
        [row.implementationFile, row.implementationLine],
      ] as const) {
        const c = checkCitation(root, f, l);
        if (!c.ok) throw new Error(`${def.id} ${toolName}: ${f}:${l}: ${c.reason}`);
      }
      rows.push(row);

      at = end;
    }
  }
  if (rows.length === 0) throw new Error(`${def.id}: no defineTool registrations found in ${TOOLS_DIR}`);
  return rows;
}

export function extract(): OperationRow[] {
  const def = TOOL_DEFS.find((t) => t.id === "23d1/after-effects-mcp");
  if (!def) throw new Error("23d1/after-effects-mcp: not in registry");
  return extractOne(def);
}
