/**
 * Access classification from an implementation body (review D1).
 *
 * `access` is derived from what the operation actually does in source, never
 * defaulted to `write`. Every classification carries a basis string that
 * quotes the evidence found in the body.
 *
 * Classes (capability-catalog §2 + `unknown`):
 *   read         — inspects host/project state, returns data, changes nothing
 *   write        — mutates project/item/layer/property content
 *   execute      — runs a host/UI action that is not a project-content write
 *                  (dialogs, lifecycle, menu commands, UI selection, renders)
 *   host-callback— invokes a host-owned callback surface
 *   build-test   — build/test-only surface
 *   unknown      — source does not let us tell; never rounded to write
 *
 * Rule order is execute -> write -> read: a selection change (`.selected =`)
 * must classify as `execute` even though it is an assignment (D1-a), and a
 * body that only reads must never fall into `write` via a local assignment
 * (D1-b: `var info = {...}; info.build = ...` is local, not a host write).
 */

import type { Access } from "./types.ts";

export interface Classification {
  access: Access;
  basis: string;
}

export interface ClassifyExtras {
  /** Additional patterns treated as reads (tool-specific reader helpers). */
  read?: RegExp[];
  write?: RegExp[];
  execute?: RegExp[];
}

/**
 * Assignment through a host accessor chain: `base.prop = ...`,
 * `base["prop"] = ...` or `base.prop.push(...)`. Requires at least one
 * property/index access — a bare `name = ...` is a local binding.
 */
const HOST_ASSIGN =
  /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^[\]]+)\s*\])+\s*(?:=[^=]|\+=|-=|\*=|\.push\s*\(|\.unshift\s*\()/;

/** `var name = <plain data>` — assignments through these are local, not host writes. */
const PLAIN_LOCAL =
  /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\{|\[|-?\d|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|null\b|true\b|false\b|String\s*\(|Number\s*\(|new\s+[A-Za-z_$][\w$.]*\s*\()/;

/** Mutating AE DOM calls that write project content (tried in order). */
const WRITE_PATTERNS: RegExp[] = [
  "addComp|addSolid|addText|addShape|addNull|addCamera|addLight|addFootage|addLayer|addProperty|addEffect|addMask|addTrackMatte",
  "setValue|setValueAtKey|setValuesAtTimes|setTemporalEaseAtKey|setInterpolationTypeAtKey|setSpatialTangentAtKey",
  "remove|duplicate|importFile",
  "setSettings|setSetting|createFolder|items\\.add\\w*",
].map((p) => new RegExp(`\\b(?:${p})\\s*\\(`));

/**
 * Reads of host/project state (tried in order, most specific first so the
 * basis quotes the representative read rather than an incidental one).
 */
const READ_PATTERNS: RegExp[] = [
  "app\\.version",
  "app\\.buildNumber",
  "app\\.project\\.(?:numItems|items|file|dirty|activeItem)",
  "\\.numItems\\b",
  "\\.numLayers\\b",
  "\\.numProperties\\b",
  "\\.numKeys\\b",
  "\\.activeItem\\b",
  "\\.selectedLayers\\b",
  "\\.expression\\b(?!\\s*=)",
  "get\\w+\\s*\\(",
].map((p) => new RegExp(p));

/** Host/UI actions that are not project-content writes (tried in order). */
const EXECUTE_PATTERNS: RegExp[] = [
  /\b(?:alert|prompt|confirm)\s*\(/,
  /\b(?:app\.quit|app\.activate)\s*\(/,
  /\bexecuteCommand\s*\(/,
  /\bopenInViewer\s*\(/,
  /\bsaveFrameToPng\s*\(/,
  /\.selected\s*=/,
];

function stripNoise(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function plainLocals(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(new RegExp(PLAIN_LOCAL, "g"))) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

function quote(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 90);
}

function findExecute(src: string, extras: RegExp[]): RegExpMatchArray | null {
  for (const p of [...EXECUTE_PATTERNS, ...extras]) {
    const m = src.match(p);
    if (m) return m;
  }
  return null;
}

function findWrite(src: string, locals: Set<string>, extras: RegExp[]): RegExpMatchArray | null {
  for (const p of [...WRITE_PATTERNS, ...extras]) {
    const m = src.match(p);
    if (m) return m;
  }
  // Assignment through an accessor chain on a non-plain (host-derived) base.
  for (const m of src.matchAll(new RegExp(HOST_ASSIGN, "g"))) {
    const base = m[1];
    if (base && locals.has(base)) continue;
    if (base === "params" || base === "args" || base === "options") continue;
    return m;
  }
  return null;
}

function findRead(src: string, extras: RegExp[]): RegExpMatchArray | null {
  for (const p of [...READ_PATTERNS, ...extras]) {
    const m = src.match(p);
    if (m) return m;
  }
  return null;
}

/**
 * Classify an implementation body (the source that performs the work).
 * Returns `unknown` when no rule fires — never `write`.
 */
export function classifyBody(body: string, extras: ClassifyExtras = {}): Classification {
  const src = stripNoise(body);
  const locals = plainLocals(src);

  const exec = findExecute(src, extras.execute ?? []);
  if (exec) {
    return {
      access: "execute",
      basis: `invokes host/UI action \`${quote(exec[0])}\`; no project-content mutation in the located body`,
    };
  }

  const write = findWrite(src, locals, extras.write ?? []);
  if (write) {
    return {
      access: "write",
      basis: `mutates project content: \`${quote(write[0])}\``,
    };
  }

  const read = findRead(src, extras.read ?? []);
  if (read) {
    return {
      access: "read",
      basis: `reads host state: \`${quote(read[0])}\``,
    };
  }

  return {
    access: "unknown",
    basis: "no recognised read/write/execute pattern in the located implementation body",
  };
}

/**
 * Explicit classification with a human-recorded basis. Used where the generic
 * rules cannot see the real behaviour (delegation to a helper, a temporary
 * object that is deleted again). The basis must describe the real behaviour.
 */
export function classifyOverride(access: Access, basis: string): Classification {
  if (basis.trim().length < 10) {
    throw new Error(`override basis too short to be evidence: "${basis}"`);
  }
  return { access, basis };
}
