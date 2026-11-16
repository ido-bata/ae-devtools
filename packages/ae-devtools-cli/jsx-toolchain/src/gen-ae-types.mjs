#!/usr/bin/env node
/**
 * gen-ae-types.mjs — generate ae-api.d.ts from the scripting inventory
 * (Issue #52).
 *
 * inventories/scripting/generated/symbols.json records 656 symbols
 * (48 classes, 49 enums, members with kind/access but almost no
 * signatures). This generator emits honest declarations: every member
 * is `any`-typed, methods are `(...args: any[]) => any`. The value is
 * coverage of NAMES (typo protection, discoverability), not signature
 * checking — absence of a signature is stated, not hidden.
 *
 *   node src/gen-ae-types.mjs [symbols.json] [out.d.ts]
 *
 * Defaults: ../../inventories/scripting/generated/symbols.json and
 * src/ae-api.d.ts next to this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const symbolsPath = resolve(process.argv[2] ?? join(HERE, "..", "..", "..", "..", "inventories", "scripting", "generated", "symbols.json"));
const outPath = resolve(process.argv[3] ?? join(HERE, "ae-api.d.ts"));

const data = JSON.parse(readFileSync(symbolsPath, "utf8"));

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ident = (s) => (IDENT.test(s) ? s : JSON.stringify(s));

// Group members by owner. owner "app" is the Application singleton;
// owner "global" holds global functions; class names are types.
const byOwner = new Map();
for (const sym of data.symbols ?? []) {
  const owner = sym.owner ?? "global";
  if (!byOwner.has(owner)) byOwner.set(owner, []);
  byOwner.get(owner).push(sym);
}

const classNames = new Set((data.classes ?? []).map((c) => c.name));
const baseOf = new Map((data.classes ?? []).map((c) => [c.name, c.baseClass]));

const lines = [];
lines.push("/**");
lines.push(" * ae-api.d.ts — GENERATED from inventories/scripting/generated/symbols.json.");
lines.push(" * Regenerate: node packages/ae-devtools-cli/jsx-toolchain/src/gen-ae-types.mjs");
lines.push(" *");
lines.push(" * HONEST SCOPE: the inventory records symbol NAMES, kinds and access");
lines.push(" * but almost no signatures. Every member is `any`-typed; methods take");
lines.push(" * `...args: any[]`. This file catches typos and gives discovery — it");
lines.push(" * does NOT check argument types or return shapes. Inventory classes are");
lines.push(" * emitted as `declare class` (not `interface`) because ExtendScript");
lines.push(" * exposes them as host constructor functions: `instanceof CompItem` and");
lines.push(" * `new KeyframeEase(...)` are real host behavior (Issue #97). The");
lines.push(" * `constructor(...args: any[])` is an over-approximation — the");
lines.push(" * inventory has no signature data, so arity is not checked.");
lines.push(" * ExtendScript builtins ($, File, Folder, BridgeTalk, Socket, XML,");
lines.push(" * JSON-if-present) are NOT covered here; see ae-globals.d.ts for the");
lines.push(" * hand-maintained extras.");
lines.push(" */");
lines.push("");

// ---- classes / owner interfaces -------------------------------------
const emitted = new Set();
const emitInterface = (name, members, { isClass }) => {
  if (emitted.has(name)) return;
  emitted.add(name);
  const base = isClass ? baseOf.get(name) : null;
  const extendsClause = base && classNames.has(base) ? ` extends ${ident(base)}` : "";
  // Classes get a value side: ExtendScript host classes are constructor
  // functions, so `instanceof`/`new` must typecheck (Issue #97). The
  // rest-args constructor is deliberate — no signature data exists.
  lines.push(`${isClass ? "declare class" : "interface"} ${ident(name)}${extendsClause} {`);
  if (isClass) lines.push("  constructor(...args: any[]);");
  const seen = new Set();
  for (const m of members) {
    const key = m.member;
    if (seen.has(key)) continue;
    seen.add(key);
    const prop = IDENT.test(key) ? key : `[${JSON.stringify(key)}: string]`;
    // Attribute vs method: methods are callable; attributes are values.
    // Access (read/write) is not expressible without signatures — any.
    if (m.kind === "method") {
      lines.push(`  ${prop}(...args: any[]): any;`);
    } else {
      lines.push(`  ${prop}: any;`);
    }
  }
  lines.push("}");
  lines.push("");
};

// Emit base classes first so `extends` references resolve.
const ordered = [...classNames].sort((a, b) => {
  const da = (baseOf.get(a) ? 1 : 0) - (baseOf.get(b) ? 1 : 0);
  return da !== 0 ? da : a.localeCompare(b);
});
for (const name of ordered) {
  // 'app' is both a class row and the singleton owner — emit it once,
  // below, as AeAppApi + `declare const app`.
  if (name === "app") continue;
  emitInterface(name, byOwner.get(name) ?? [], { isClass: true });
}
// 'app' owner → the Application singleton type + const.
if (byOwner.has("app")) {
  emitInterface("AeAppApi", byOwner.get("app"), { isClass: false });
  lines.push("declare const app: AeAppApi;");
  lines.push("");
}
// 'System' class doubles as the `system` global in ExtendScript.
if (classNames.has("System")) {
  lines.push("declare const system: System;");
  lines.push("");
}
// Remaining owners that are not classes (rare) still get interfaces.
for (const [owner, members] of byOwner) {
  if (owner === "app" || owner === "global" || classNames.has(owner)) continue;
  emitInterface(`Ae_${owner}`, members, { isClass: false });
}

// ---- enums ----------------------------------------------------------
for (const e of data.enums ?? []) {
  const vals = (e.values ?? []).filter((v) => IDENT.test(v.value ?? v.name ?? ""));
  if (vals.length === 0) continue;
  lines.push(`declare enum ${ident(e.name)} {`);
  for (const v of vals) {
    const n = v.value ?? v.name;
    lines.push(typeof v.numericValue === "number" ? `  ${n} = ${v.numericValue},` : `  ${n},`);
  }
  lines.push("}");
  lines.push("");
}

// ---- global functions -----------------------------------------------
const fns = (byOwner.get("global") ?? []).filter((s) => s.kind === "global-function");
for (const f of fns) {
  if (!IDENT.test(f.member)) continue;
  lines.push(`declare function ${f.member}(...args: any[]): any;`);
}
if (fns.length) lines.push("");

writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(`wrote ${outPath} (${data.symbols?.length ?? 0} symbols, ${classNames.size} classes, ${(data.enums ?? []).length} enums)`);
