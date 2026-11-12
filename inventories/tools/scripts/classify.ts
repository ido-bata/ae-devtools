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
  /** Additional strong mutation calls (tier: write). */
  write?: RegExp[];
  /** Additional host lifecycle actions (tier: execute). */
  execute?: RegExp[];
  /** Additional dialogs/selection actions (tier: execute, UI). */
  executeUi?: RegExp[];
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

/** Tier 1 execute: dialogs, quit, menu commands, UI selection — win over writes. */
const EXECUTE_UI_PATTERNS: RegExp[] = [
  /\b(?:alert|prompt|confirm)\s*\(/,
  /\bapp\.quit\s*\(/,
  /\bexecuteCommand\s*\(/,
  /\.selected\s*=/,
];

/** Tier 1 write: strong mutation calls on project content. */
const WRITE_STRONG_PATTERNS: RegExp[] = [
  "addComp|addSolid|addText|addShape|addNull|addCamera|addLight|addFootage|addLayer|addProperty|addEffect|addMask|addTrackMatte",
  "setValue|setValueAtKey|setValuesAtTimes|setTemporalEaseAtKey|setInterpolationTypeAtKey|setSpatialTangentAtKey",
  "remove|duplicate|importFile|newProject",
  "saveAs|save\\b|setSettings|setSetting|createFolder|items\\.add\\w*",
].map((p) => new RegExp(`\\b(?:${p})\\s*\\(`));

/** Tier 3 execute: host lifecycle/UI actions that are not content writes. */
const EXECUTE_LIFECYCLE_PATTERNS: RegExp[] = [
  /app\.open\s*\(/,
  /\.close\s*\(/,
  /\bopenInViewer\s*\(/,
  /\bsaveFrameToPng\s*\(/,
  /\$\.\s*setenv\s*\(/,
  /\bapp\.activate\s*\(/,
];

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

/**
 * Classify an implementation body (the source that performs the work).
 * Returns `unknown` when no rule fires — never `write`.
 *
 * Tier order: strong write call -> UI execute -> lifecycle execute ->
 * accessor-chain assignment -> read. A body that both creates content and
 * flips a selection is a write; a body that only changes selection is
 * execute (D1-a).
 */
export function classifyBody(body: string, extras: ClassifyExtras = {}): Classification {
  const src = stripNoise(body);
  const locals = plainLocals(src);

  const strong = firstMatch([...WRITE_STRONG_PATTERNS, ...(extras.write ?? [])], src);
  if (strong) {
    return { access: "write", basis: `mutates project content: \`${quote(strong[0])}\`` };
  }

  const ui = firstMatch([...EXECUTE_UI_PATTERNS, ...(extras.executeUi ?? [])], src);
  if (ui) {
    return {
      access: "execute",
      basis: `invokes host/UI action \`${quote(ui[0])}\`; no project-content mutation in the located body`,
    };
  }

  const lifecycle = firstMatch([...EXECUTE_LIFECYCLE_PATTERNS, ...(extras.execute ?? [])], src);
  if (lifecycle) {
    return {
      access: "execute",
      basis: `invokes host lifecycle/UI action \`${quote(lifecycle[0])}\`; no project-content mutation in the located body`,
    };
  }

  for (const m of src.matchAll(new RegExp(HOST_ASSIGN, "g"))) {
    const base = m[1];
    if (base && locals.has(base)) continue;
    if (base === "params" || base === "args" || base === "options") continue;
    return { access: "write", basis: `assigns through a host accessor chain: \`${quote(m[0])}\`` };
  }

  const read = firstMatch([...READ_PATTERNS, ...(extras.read ?? [])], src);
  if (read) {
    return { access: "read", basis: `reads host state: \`${quote(read[0])}\`` };
  }

  return {
    access: "unknown",
    basis: "no recognised read/write/execute pattern in the located implementation body",
  };
}

function firstMatch(patterns: RegExp[], src: string): RegExpMatchArray | null {
  for (const p of patterns) {
    const m = src.match(p);
    if (m) return m;
  }
  return null;
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
