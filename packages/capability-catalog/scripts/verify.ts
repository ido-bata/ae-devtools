/**
 * CI verification: (1) committed manifest is byte-identical to a fresh build
 * from the current inventories, (2) the drift gate reports no violations.
 * Exit non-zero on either failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadRepoInputs } from "./inputs.ts";
import { buildCatalog, serializeCatalog, type CatalogManifest } from "../src/generate.ts";
import { runDriftGate } from "../src/drift.ts";

const manifestPath = join(REPO_ROOT, "packages/capability-catalog/generated/catalog.json");
const inputs = loadRepoInputs();
const fresh = serializeCatalog(buildCatalog(inputs));
const committed = readFileSync(manifestPath, "utf8");

if (fresh !== committed) {
  console.error("STALE: committed catalog.json differs from a fresh build of the inventories");
  process.exit(1);
}
console.error("manifest byte-identical to a fresh build");

const manifest = JSON.parse(committed) as CatalogManifest;
const result = runDriftGate({ manifest, imports: inputs });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error(`gate FAILED: ${result.violations.length} violation(s)`);
  process.exit(1);
}
console.error("gate green (SDK verdict stays 'unknown' without supplied SDK rows)");
