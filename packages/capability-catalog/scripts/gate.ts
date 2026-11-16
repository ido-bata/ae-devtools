/**
 * Drift gate against the COMMITTED manifest: exits 1 on any violation.
 * Without supplied SDK rows the SDK verdict is `unknown`, never "no drift".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadRepoInputs } from "./inputs.ts";
import { runDriftGate } from "../src/drift.ts";
import type { CatalogManifest } from "../src/generate.ts";

const manifestPath = join(REPO_ROOT, "packages/capability-catalog/generated/catalog.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CatalogManifest;
const inputs = loadRepoInputs();

const result = runDriftGate({ manifest, imports: inputs });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error(`gate FAILED: ${result.violations.length} violation(s)`);
  process.exit(1);
}
console.error("gate green (SDK verdict is 'unknown' unless SDK-derived rows are supplied)");
