/**
 * ishu86/after-effects-mcp adapter.
 *
 * Surface: the `TOOLS` array in src/stdio-server.ts — each entry declares
 * `name`, an `inputSchema` and a `generator` (a script-generator function
 * under src/ae-integration/generators/).
 *
 * Citations: definition = the tool's `name:` line in stdio-server.ts;
 * implementation = the `export function generateXxx` line in the generator
 * module (a different file — the two locations are kept in separate fields
 * per review D3).
 *
 * Access: classified on the generator body, whose string literals contain the
 * emitted ES3. An assignment in emitted ES3 is a write only when it targets a
 * host-derived object (e.g. `prop.expression = ...`); a read of `.expression`
 * classifies as read (review D1-b).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBody, type ClassifyExtras } from "../classify.ts";
import { semanticFor } from "../normalize.ts";
import { TOOL_DEFS, resolveSourceRoot } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "ishu86/after-effects-mcp";
const DEF_FILE = "src/stdio-server.ts";
const ROUTE = "MCP stdio → FileCommunicator.executeScript (command-file bridge) → ExtendScript in AE";

const EXTRAS: ClassifyExtras = {
  read: [/generateProjectCheck\s*\(/, /generateCompAccess\s*\(/, /generateLayerAccess\s*\(/, /generatePropertyAccess\s*\(/, /escapeString\s*\(/, /wrapInUndoGroup\s*\(/],
};

/**
 * Per-row overrides where the generator body alone does not decide access.
 * Every entry records its source evidence in `accessBasis` (review D2).
 */
const ACCESS_OVERRIDES: Record<string, { access: Access; basis: string }> = {
  // Only a registration site in stdio-server.ts; real implementation is a
  // custom user method — not located at the pinned commit.
  custom_method: {
    access: "unknown",
    basis: "registration-only entry; user-supplied custom method body not present at the pinned commit",
  },
  // Snake-case helper returning an expression string (evidence: success
  // payload contains the expression text). Distinct from camelCase row.
  get_expression: {
    access: "read",
    basis: "returns the property's expression text (success payload carries expression string); no host state mutated",
  },
  // Sets the expression on a property (evidence: "expression set successfully").
  set_expression: {
    access: "write",
    basis: "assigns property.expression in emitted ES3 (success message: expression set successfully)",
  },
  // TEMP-OBJECT write: borrows a queue item (and creates a probe comp when the
  // queue is empty) to read templates, then removes both before returning
  // (renderQueueGenerators.ts generateListRenderTemplates: tempItem.remove() +
  // tc.remove()). Net project content unchanged; write is kept because the
  // borrowing mutation is real and a failure mid-probe leaves state behind.
  list_render_templates: {
    access: "write",
    basis:
      "TEMP-OBJECT write with net content unchanged on the success path: creates probe comp `__rq_template_probe__` + a queue item only when the render queue is empty, reads probe.templates / outputModule(1).templates, then removes the temp item and comp again (generateListRenderTemplates: `tempItem.remove(); tc.remove()`)",
  },
  // Delegates straight to generateSetExpression after template substitution
  // (expressionGenerators.ts:607) — the emitted script assigns property.expression.
  apply_expression_template: {
    access: "write",
    basis:
      "delegates to generateSetExpression with the substituted template text (expressionGenerators.ts:607 generateApplyExpressionTemplate → `expression: expression`), so the emitted ES3 assigns property.expression — a project write",
  },
};

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Keys of a `properties: { ... }` object (top-level of the input schema). */
function schemaKeys(src: string, from: number, until: number): string[] {
  const propsIdx = src.indexOf("properties", from);
  if (propsIdx < 0 || propsIdx > until) return [];
  const open = src.indexOf("{", propsIdx);
  if (open < 0 || open > until) return [];
  const keys: string[] = [];
  let i = open + 1;
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
  while (i < until && i < src.length) {
    const ch = src[i] ?? "";
    if (inString) {
      i = skipString(i);
      inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(i);
      continue;
    }
    if (ch === "}") break; // end of properties object
    if (ch === ",") {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 200));
    if (!m || !m[1]) {
      i += 1;
      continue;
    }
    keys.push(m[1]);
    i += m[0].length;
    // Skip this property's value until the next top-level comma/brace.
    let depth = 0;
    let bracket = 0;
    while (i < until && i < src.length) {
      const c = src[i] ?? "";
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(i);
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        if (depth === 0) break; // properties object closes
        depth -= 1;
      } else if (c === "[") bracket += 1;
      else if (c === "]") bracket -= 1;
      else if (c === "," && depth === 0 && bracket === 0) break;
      i += 1;
    }
  }
  return [...new Set(keys)];
}

/**
 * Balanced body starting at a `function`/arrow declaration: the parameter
 * list (and any object type inside it) is skipped first, so the block after
 * `): string {` is what gets returned — not the parameter type annotation.
 */
function functionBody(src: string, from: number): string {
  let pd = 0; // paren depth before params close
  let seenParen = false;
  let paramsClosed = false;
  let depth = 0; // brace depth inside the body
  let bodyStart = -1;
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
  let i = from;
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
    if (bodyStart < 0) {
      if (ch === "(") {
        pd += 1;
        seenParen = true;
      } else if (ch === ")") {
        pd -= 1;
        if (seenParen && pd === 0) paramsClosed = true;
      } else if (ch === "{" && paramsClosed) {
        bodyStart = i;
        depth = 1;
      } else if (ch === "{" && !paramsClosed) {
        depth += 1; // object type inside the parameter list
      } else if (ch === "}" && !paramsClosed) {
        depth -= 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth <= 0) break;
    }
  }
  if (bodyStart < 0) return src.slice(from, Math.min(from + 500, src.length));
  return src.slice(bodyStart, i + 1);
}

/** Index of `export function <name>` (or `export const <name>`) per generator. */
function generatorIndex(root: string): Map<string, { file: string; line: number; index: number }> {
  const dir = join(root, "src", "ae-integration", "generators");
  const map = new Map<string, { file: string; line: number; index: number }>();
  if (!existsSync(dir)) throw new Error(`${TOOL_ID}: generators dir missing: ${dir}`);
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const rel = `src/ae-integration/generators/${f}`;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/export function (\w+)\s*\(/g)) {
      const name = m[1];
      if (name && !map.has(name)) map.set(name, { file: rel, line: lineOf(src, m.index ?? 0), index: m.index ?? 0 });
    }
  }
  return map;
}

export function extract(): OperationRow[] {
  const def = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;
  const src = readFileSync(join(root, DEF_FILE), "utf8");
  const implIndex = generatorIndex(root);

  const rows: OperationRow[] = [];
  const toolsStart = src.indexOf("const TOOLS:");
  if (toolsStart < 0) throw new Error(`${TOOL_ID}: TOOLS array not found in ${DEF_FILE}`);
  const generatorMatches = [...src.matchAll(/generator:\s*generators\.(\w+)/g)];
  let prevEnd = toolsStart;
  for (const gm of generatorMatches) {
    const genName = gm[1] ?? "";
    const genIdx = gm.index ?? 0;

    // The tool's own `name:` lives between the previous entry and this generator.
    const window = src.slice(prevEnd, genIdx);
    const nameMatch = /name:\s*'([^']+)'|name:\s*"([^"]+)"/.exec(window);
    if (!nameMatch || nameMatch.index === undefined) {
      throw new Error(`${TOOL_ID}: no name found before generator ${genName}`);
    }
    const toolName = nameMatch[1] ?? nameMatch[2] ?? "";
    const nameIdx = prevEnd + nameMatch.index;
    prevEnd = genIdx + gm[0].length;

    const args = schemaKeys(src, nameIdx, genIdx);
    const definitionLine = lineOf(src, nameIdx);

    const impl = implIndex.get(genName);
    let implementationFile = "";
    let implementationLine = 0;
    let status: OperationRow["status"] = "source-verified";
    let note: string | undefined;
    if (!impl) {
      status = "claimed/unverifiable";
      note = `generator ${genName} not located under src/ae-integration/generators/ at the pinned commit`;
    } else {
      implementationFile = impl.file;
      implementationLine = impl.line;
      const implSrc = readFileSync(join(root, impl.file), "utf8");
      const body = functionBody(implSrc, impl.index);
      const cls = classifyBody(body, EXTRAS);
      const ov = ACCESS_OVERRIDES[toolName];
      // Row is pushed below with these values.
      rows.push(buildRow(toolName, args, ov?.access ?? cls.access, ov?.basis ?? cls.basis, status, definitionLine, implementationFile, implementationLine, note));
      continue;
    }
    rows.push(buildRow(toolName, args, "unknown", "implementation not located; access undetermined from source", status, definitionLine, implementationFile, implementationLine, note));
  }

  for (const row of rows) {
    if (row.status !== "source-verified") continue;
    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${TOOL_ID} ${row.name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${TOOL_ID} ${row.name}: ${b.reason}`);
  }
  return rows;
}

function buildRow(
  toolName: string,
  args: string[],
  access: OperationRow["access"],
  basis: string,
  status: OperationRow["status"],
  definitionLine: number,
  implementationFile: string,
  implementationLine: number,
  note?: string,
): OperationRow {
  const row: OperationRow = {
    toolId: TOOL_ID,
    name: toolName,
    args,
    access,
    accessBasis: basis,
    route: ROUTE,
    semanticId: semanticFor(toolName),
    status,
    definitionFile: DEF_FILE,
    definitionLine,
    implementationFile,
    implementationLine,
  };
  if (note) row.note = note;
  return row;
}
