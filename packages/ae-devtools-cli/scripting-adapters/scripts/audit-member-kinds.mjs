#!/usr/bin/env node
/*
 * audit-member-kinds.mjs — FakeHost/generated-JSX audit (priority 2).
 *
 * Cross-checks every member an op CLAIMS against two independent
 * sources of truth:
 *
 *   1. inventories/scripting/generated/symbols.json — the documented
 *      kind ("method" vs "attribute") and access mode.
 *   2. The actual generated ExtendScript source — whether the member
 *      name is invoked as `name(` (method call) or assigned as
 *      `.name =` (attribute write).
 *
 * This catches the property/method-confusion and read-only-write
 * classes of bugs fixed in PR #301 and the frameBlending/fontStyle
 * audit findings: claiming a method that is never invoked, calling an
 * attribute as a function, or writing a read-only attribute.
 *
 * Method-invocation and write checks run over the union of sources
 * generated for every arg VARIANT below, because several ops emit
 * different member calls per argument value (e.g. pref.get selects
 * getPrefAsString/Bool/Long/Float via `type`; layer.reorder selects
 * moveToBeginning/moveToEnd via `to`).
 *
 * Write checks scan only the op-specific tail (source minus PRELUDE):
 * PRELUDE helpers build plain result/snapshot objects whose fields
 * (`e.value`, `out.file`, `node.numItems`, ...) are not host
 * attributes and would otherwise be false positives.
 *
 * Limitations (documented, not hidden):
 *   - Member names can collide across owners (e.g. `property`,
 *     `name`, `file`); the check is per-NAME within an op's sources,
 *     so a collision can mask a mismatch. Findings are REVIEW
 *     SIGNALS — verify each against docs before treating as a bug.
 *   - VARIANTS only covers discriminating args known today; a new
 *     arg-conditional member call needs a new entry here.
 *
 * Usage: node scripts/audit-member-kinds.mjs
 * Exit 0 = no findings; exit 1 = findings printed for review.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS, buildSource, PRELUDE } from "../registry.mjs";
import { sampleArgs } from "../tests/sample-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SYMBOLS_JSON = join(here, "..", "..", "..", "..", "inventories", "scripting", "generated", "symbols.json");

if (!existsSync(SYMBOLS_JSON)) {
  console.log("audit-member-kinds: symbols.json not present (published tarball) — skipping");
  process.exit(0);
}

const symbols = JSON.parse(readFileSync(SYMBOLS_JSON, "utf8")).symbols;
const byId = new Map(symbols.map((s) => [s.id, s]));

// Arg-variant overrides: each entry is merged over sampleArgs(op) to
// produce one generated source. Only args that switch which host
// members get exercised need entries.
const VARIANTS = {
  "pref.get": [
    { type: "string", default: "d" },
    { type: "bool", default: true },
    { type: "long", default: 0 },
    { type: "float", default: 0 },
  ],
  "pref.set": [
    { type: "string", value: "v" },
    { type: "bool", value: true },
    { type: "long", value: 1 },
    { type: "float", value: 0.5 },
  ],
  "layer.reorder": [{ to: "top" }, { to: "bottom" }],
};

// Local variable names the generated code uses for plain
// result/snapshot objects (never host objects). Writes through these
// receivers are data-shaping, not host attribute writes.
const ACCUMULATORS = new Set([
  "e", "out", "node", "detail", "acc", "snap", "res", "rec", "row",
  "ent", "tmp",
]);

const findings = [];
const stats = { ops: 0, claims: 0, methods: 0, attributes: 0, sources: 0 };

for (const op of OPERATIONS) {
  const argSets = [sampleArgs(op)];
  for (const v of VARIANTS[op.id] || []) argSets.push({ ...sampleArgs(op), ...v });

  // Union of invoked method names (full source incl. PRELUDE — shared
  // helpers legitimately exercise claimed members like itemByID) and
  // of attribute writes (op tail only — PRELUDE result objects are
  // plain data, not host attributes).
  const called = new Set();
  const written = new Set();
  for (const args of argSets) {
    let src;
    try {
      src = buildSource(op.id, args);
    } catch (e) {
      findings.push({ op: op.id, member: "(buildSource)", issue: `source generation failed: ${e.message}` });
      continue;
    }
    stats.sources++;
    for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
    const tail = src.startsWith(PRELUDE) ? src.slice(PRELUDE.length) : src;
    for (const m of tail.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) {
      // Skip writes to plain result/snapshot objects built by the
      // generated code itself — only host-object receivers count.
      if (!ACCUMULATORS.has(m[1])) written.add(m[2]);
    }
  }
  stats.ops++;

  for (const memberId of op.members) {
    const sym = byId.get(memberId);
    if (!sym) continue; // claim-existence is enforced by the contract test
    stats.claims++;
    const name = sym.member;
    if (sym.kind === "method") stats.methods++;
    else stats.attributes++;

    if (sym.kind === "method" && !called.has(name)) {
      findings.push({
        op: op.id, member: memberId, kind: sym.kind,
        issue: `method '${name}' claimed but never invoked as .${name}() in any generated variant`,
      });
    }
    if (sym.kind === "attribute" && called.has(name)) {
      findings.push({
        op: op.id, member: memberId, kind: sym.kind,
        issue: `attribute '${name}' claimed but invoked as .${name}() — possible property/method confusion`,
      });
    }
    if (sym.kind === "attribute" && sym.access === "read" && written.has(name)) {
      findings.push({
        op: op.id, member: memberId, kind: sym.kind,
        issue: `read-only attribute '${name}' is assigned in generated source`,
      });
    }
  }
}

console.log(`audit-member-kinds: ${stats.ops} ops, ${stats.sources} sources, ${stats.claims} claims (${stats.methods} methods, ${stats.attributes} attributes)`);
if (findings.length === 0) {
  console.log("audit-member-kinds: no findings");
  process.exit(0);
}
for (const f of findings) {
  console.log(`FINDING ${f.op} :: ${f.member}\n  ${f.issue}`);
}
console.log(`audit-member-kinds: ${findings.length} finding(s) — verify each against Adobe docs before treating as a bug`);
process.exit(1);
