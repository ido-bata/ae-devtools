/**
 * render-templates.ts — regenerate packages/native-adapter/templates/
 * from the canonical coverage matrix (Issue #19, CAP046).
 *
 *   bun run render [matrix.json]
 *
 * Default matrix: <repo>/inventories/sdk/generated/aggregate.coverage-matrix.json
 * Default output root: packages/native-adapter/
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

for (const file of files) {
  const out = join(PKG, file.path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, file.content);
  console.log(`wrote ${file.path}`);
}
console.log(`rendered ${files.length} adapter kits from ${matrixPath}`);
