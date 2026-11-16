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
 * Defaults: ../../../../inventories/scripting/generated/symbols.json
 * (repo checkout required — the inventory is not published) and
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
// Per-class host-behavior metadata recorded by the inventory extractor:
// `instanceofCaveat` ("throws-undefined" | "always-false") marks classes
// whose `instanceof` is broken on the host; `baseOnly` marks abstract
// bases that are not directly constructible.
const classMeta = new Map((data.classes ?? []).map((c) => [c.name, c]));

const lines = [];
lines.push("/**");
lines.push(" * ae-api.d.ts — GENERATED from inventories/scripting/generated/symbols.json.");
lines.push(" * Regenerate: node packages/ae-devtools-cli/jsx-toolchain/src/gen-ae-types.mjs");
lines.push(" *");
lines.push(" * HONEST SCOPE: the inventory records symbol NAMES, kinds and access");
lines.push(" * but almost no signatures. Every member is `any`-typed; methods take");
lines.push(" * `...args: any[]`. This file catches typos and gives discovery — it");
lines.push(" * does NOT check argument types or return shapes. Every inventory");
lines.push(" * class is an `interface` plus — only where the host really supports");
lines.push(" * `instanceof` — a structural `declare const` value side. The");
lines.push(" * inventory's `instanceofCaveat` marks classes whose `instanceof`");
lines.push(" * throws or always returns false (AVItem, Collection, FootageSource,");
lines.push(" * Item, Layer, PropertyBase): those get NO value side, so");
lines.push(" * `x instanceof Item` is a type error instead of a narrowing promise");
lines.push(" * the host cannot keep. `baseOnly` abstract bases get a CALL");
lines.push(" * signature (no construct signature): `instanceof` typechecks and");
lines.push(" * narrows, `new X()` does not. Other classes get a construct");
lines.push(" * signature, so `new X(...)` typechecks — an over-approximation,");
lines.push(" * since the inventory has no signature data (arity and");
lines.push(" * constructibility are not checked). The `app`/`system` globals are");
lines.push(" * declared once in ae-globals.d.ts; this file provides only the");
lines.push(" * `AeAppApi`/`System` types.");
lines.push(" * ExtendScript builtins ($, File, Folder, BridgeTalk, Socket, XML,");
lines.push(" * JSON-if-present) are NOT covered here; see ae-globals.d.ts for the");
lines.push(" * hand-maintained extras.");
lines.push(" */");
lines.push("");

// ---- classes / owner interfaces -------------------------------------
const emitted = new Set();
const emitSymbol = (name, members, { isClass }) => {
  if (emitted.has(name)) return;
  emitted.add(name);
  const meta = isClass ? classMeta.get(name) : null;
  const base = isClass ? baseOf.get(name) : null;
  const extendsClause = base && classNames.has(base) ? ` extends ${ident(base)}` : "";
  // Every inventory entry is emitted as an `interface` (type side only)
  // so `extends` always resolves — `declare class X extends <interface>`
  // is rejected by tsc (TS2689) when skipLibCheck is off.
  lines.push(`interface ${ident(name)}${extendsClause} {`);
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
  // Value side, emitted only where the host really provides one.
  // `instanceofCaveat` classes get NONE: `x instanceof Item` is a type
  // error here, matching the host where it throws / always returns
  // false. The remaining classes get a structural const so `instanceof`
  // typechecks and narrows:
  //   - normal classes: a construct signature, so `new X(...)` also
  //     typechecks (over-approximation — the inventory has no signature
  //     data, so arity/constructibility are not checked);
  //   - `baseOnly` abstract bases: a CALL signature instead, so
  //     `instanceof` works but `new X()` is a type error (the host does
  //     not construct base classes). The residual white lie is that
  //     `X(...)` calls typecheck — documented, not hidden.
  if (isClass && !meta?.instanceofCaveat) {
    const sig = meta?.baseOnly
      ? `(...args: any[]): ${ident(name)}`
      : `new (...args: any[]): ${ident(name)}`;
    lines.push(`declare const ${ident(name)}: { prototype: ${ident(name)}; ${sig} };`);
    lines.push("");
  }
};

// Emit base classes first so `extends` references resolve.
const ordered = [...classNames].sort((a, b) => {
  const da = (baseOf.get(a) ? 1 : 0) - (baseOf.get(b) ? 1 : 0);
  return da !== 0 ? da : a.localeCompare(b);
});
for (const name of ordered) {
  // 'app' is both a class row and the singleton owner — emit it once,
  // below, as the AeAppApi interface (the `app` global itself lives in
  // ae-globals.d.ts).
  if (name === "app") continue;
  emitSymbol(name, byOwner.get(name) ?? [], { isClass: true });
}
// 'app' owner → the Application singleton TYPE. The `app`/`system`
// global bindings are declared once in ae-globals.d.ts, which layers
// the hand-maintained AeApp/AeSystem shapes on top of these types.
if (byOwner.has("app")) {
  emitSymbol("AeAppApi", byOwner.get("app"), { isClass: false });
}
// 'System' class is emitted above with the other classes; ae-globals.d.ts
// declares `const system: AeSystem` where `AeSystem extends System`.
// Remaining owners that are not classes (rare) still get interfaces.
for (const [owner, members] of byOwner) {
  if (owner === "app" || owner === "global" || classNames.has(owner)) continue;
  emitSymbol(`Ae_${owner}`, members, { isClass: false });
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
