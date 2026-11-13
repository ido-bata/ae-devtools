/**
 * ae-a8n adapter: the 26 host dispatch methods in host/a8n-host.js.
 *
 * Each row cites the dispatch entry (`methods["<name>"] = function ...`) as
 * both definition and implementation site — for this tool the dispatch entry
 * IS the ES3 implementation body, which is read for access classification.
 * Args are extracted from the body's requireParam/optionalParam calls.
 */

import { classifyBody, classifyOverride, type ClassifyExtras } from "../classify.ts";
import { AE_A8N_ID, TOOL_DEFS, resolveSourceRoot } from "../registry.ts";
import { checkCitation, readLines, type FileLines } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const HOST_FILE = "host/a8n-host.js";
const ROUTE = "ae-a8n file-envelope transport → host/a8n-host.js dispatch → ES3 in After Effects";

const EXTRAS: ClassifyExtras = {
  read: [
    /getProject\s*\(/,
    /findComp\s*\(/,
    /findLayer\s*\(/,
    /effectParade\s*\(/,
    /compInfo\s*\(/,
    /layerInfo\s*\(/,
    /describeProperty\s*\(/,
    /requireProperty\s*\(/,
    /sceneSnapshot\s*\(/,
    /app\.findMenuCommandId\s*\(/,
    /readPngSize\s*\(/,
    /requireWritableValue\s*\(/,
  ],
  write: [
    // Delegates to the helper that adds the effect to the layer's effect parade.
    /applyEffect\s*\(/,
  ],
  execute: [
    /\$\.\s*setenv\s*\(/,
    /app\.open\s*\(/,
    /\.close\s*\(/,
  ],
};

/**
 * Access overrides where the generic rules cannot state the real behaviour.
 * Each basis describes what the body actually does (verified against source).
 */
const OVERRIDES: Record<string, { access: Access; basis: string }> = {
  "comp.renderFrame": {
    access: "execute",
    basis:
      "renders one frame to a PNG file via comp.saveFrameToPng (output file only); comp.resolutionFactor is set to full resolution and restored in finally — project content unchanged",
  },
  "comp.selectLayers": {
    access: "execute",
    basis:
      "changes UI selection state (layer.selected = ...) on comp.layer(j); the project content is unchanged",
  },
  "layer.applyEffect": {
    access: "write",
    basis:
      "delegates to applyEffect(layer, identifier) which adds the effect property to the layer's effect parade (host/a8n-host.js)",
  },
  "app.setEnvironment": {
    access: "execute",
    basis:
      "sets a process-scoped environment variable via $.setenv; nothing is persisted to preferences — project content unchanged",
  },
};

/** Provisional normalized semantic ids (grammar owned by #11 later). */
const SEMANTIC: Record<string, string> = {
  "app.info": "app.version-info",
  "ui.alert": "ui.alert",
  "app.quit": "app.quit",
  "project.open": "project.open",
  "project.close": "project.close",
  "project.info": "project.info",
  "project.comps": "project.list-comps",
  "comp.info": "comp.info",
  "comp.layers": "comp.list-layers",
  "comp.layer": "comp.get-layer",
  "layer.effects": "layer.list-effects",
  "layer.applyEffect": "effect.apply",
  "effect.parameters": "effect.list-parameters",
  "effect.getParameter": "effect.get-parameter",
  "effect.setParameter": "effect.set-parameter",
  "comp.renderFrame": "render.frame",
  "project.createComp": "comp.create",
  "comp.openInViewer": "comp.open-in-viewer",
  "comp.addText": "layer.add-text",
  "comp.selectLayers": "layer.select",
  "layer.setEnabled": "layer.set-enabled",
  "layer.transform": "layer.get-transform",
  "layer.shapePaths": "layer.get-shape-paths",
  "app.setEnvironment": "app.set-environment",
  "menu.find": "menu.find-command",
  "menu.execute": "menu.execute-command",
};

/** Extract declared param names from requireParam/optionalParam/requireNumber calls. */
function extractArgs(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:requireParam|optionalParam|requireNumber|requireNumbers)\s*\(\s*params\s*,\s*"([^"]+)"/g;
  for (const m of body.matchAll(re)) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Extract the balanced body of `methods["x"] = function ... { ... }`.
 *  The declaration line through its first `{` is consumed first, so the
 *  dispatch assignment itself is not part of the body being classified. */
function functionBody(file: FileLines, startLine: number): string {
  const collected: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = startLine - 1; i < file.lines.length; i++) {
    let line = file.lines[i] ?? "";
    if (!opened) {
      const brace = line.indexOf("{");
      if (brace < 0) continue; // declaration wraps before its opening brace
      line = line.slice(brace + 1);
      opened = true;
      depth = 1;
    }
    collected.push(line);
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return collected.join("\n");
}

export function extract(): OperationRow[] {
  const def = TOOL_DEFS.find((t) => t.id === AE_A8N_ID);
  if (!def) throw new Error(`${AE_A8N_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;
  const file = readLines(`${root}/${HOST_FILE}`);

  const rows: OperationRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < file.lines.length; i++) {
    const line = file.lines[i] ?? "";
    const m = line.match(/methods\["([^"]+)"\]\s*=\s*function/);
    if (!m || !m[1]) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);

    const definitionLine = i + 1;
    const body = functionBody(file, definitionLine);
    const override = OVERRIDES[name];
    const cls = override
      ? classifyOverride(override.access, override.basis)
      : classifyBody(body, EXTRAS);
    const semanticId = SEMANTIC[name];
    if (!semanticId) throw new Error(`${AE_A8N_ID}: no semantic id for method ${name}`);

    const row: OperationRow = {
      toolId: AE_A8N_ID,
      name,
      args: extractArgs(body),
      access: cls.access,
      accessBasis: cls.basis,
      route: ROUTE,
      semanticId,
      status: "source-verified",
      definitionFile: HOST_FILE,
      definitionLine,
      implementationFile: HOST_FILE,
      implementationLine: definitionLine,
      note: "dispatch entry and ES3 implementation are the same site; args extracted from requireParam/optionalParam calls in the body",
    };
    // Self-check: the citation must resolve before the row is emitted.
    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${AE_A8N_ID} ${name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${AE_A8N_ID} ${name}: ${b.reason}`);
    rows.push(row);
  }

  if (rows.length !== 26) {
    throw new Error(`${AE_A8N_ID}: expected 26 host methods, extracted ${rows.length}`);
  }
  return rows;
}
