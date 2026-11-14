/**
 * Generates generated/coverage-claims.json — the adapter→catalog claim
 * feed (Issue #15/#16). Each registry op claims inventory member ids;
 * the capability catalog consumes this file to mark those members
 * `adapter-present` + `automated-fake` — NEVER `verified-real-host`.
 *
 *   node scripts/coverage-claims.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../registry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "generated", "coverage-claims.json");

const claims = {};
for (const op of OPERATIONS) {
  for (const m of op.members) {
    // provisional.ae.scripting.X.y -> ae.scripting.X.y (catalog id shape)
    const catalogId = m.replace(/^provisional\./, "");
    (claims[catalogId] ??= { ops: [], evidence: "fake/mock only" }).ops.push(op.id);
  }
}
const doc = {
  schema: "ae-devtools.adapter-coverage-claims/v1",
  generatedFrom: "experiments/scripting-adapters/registry.mjs",
  evidenceLevel: "fake/mock only",
  realHostVerified: 0,
  claims,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`coverage-claims: ${Object.keys(claims).length} member claims from ${OPERATIONS.length} ops`);
