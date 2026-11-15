/**
 * verify.ts — drift gate for generated adapter kits (Issue #19, CAP046).
 *
 * Re-renders every template in memory and compares it byte-for-byte
 * with what is on disk. Any drift (hand edit, stale matrix, missed
 * render) exits non-zero. Mirrors the capability-catalog `verify`
 * posture: generated artifacts are checked, never trusted.
 *
 *   bun run verify [matrix.json]
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadCoverageMatrix } from "../src/matrix.ts";
import { renderAllTemplates } from "../src/templates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "..", "..");

const matrixPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(REPO, "inventories", "sdk", "generated", "aggregate.coverage-matrix.json");

const matrix = loadCoverageMatrix(matrixPath);
const files = renderAllTemplates(matrix);

let drift = 0;
for (const file of files) {
  const disk = join(PKG, file.path);
  let actual: string;
  try {
    actual = readFileSync(disk, "utf8");
  } catch {
    console.error(`MISSING ${file.path} — run bun run render`);
    drift += 1;
    continue;
  }
  if (actual !== file.content) {
    console.error(`DRIFT ${file.path} — run bun run render`);
    drift += 1;
  }
}

// The concrete fixture is authored, not generated — it must exist.
const fixture = join(PKG, "templates", "build-test-lifecycle", "fixture.sweetie-checkout.json");
try {
  JSON.parse(readFileSync(fixture, "utf8"));
} catch {
  console.error(`MISSING/INVALID ${fixture}`);
  drift += 1;
}

if (drift > 0) {
  console.error(`verify failed: ${drift} problem(s)`);
  process.exit(1);
}
console.log(`verify ok: ${files.length} kits in sync with coverage matrix`);
