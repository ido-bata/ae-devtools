/**
 * Regenerates generated/catalog.json from the read-only inventories.
 * `--check` compares without writing and exits 1 on drift (CI gate).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, loadRepoInputs } from "./inputs.ts";
import { buildCatalog, serializeCatalog } from "../src/generate.ts";

const outPath = join(REPO_ROOT, "packages/capability-catalog/generated/catalog.json");
const inputs = loadRepoInputs();
const manifest = buildCatalog(inputs);
const fresh = serializeCatalog(manifest);

if (process.argv.includes("--check")) {
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (existing !== fresh) {
    console.error("catalog.json is stale: run `bun run generate` and review the diff");
    process.exit(1);
  }
  console.error(`catalog.json matches a fresh build (${manifest.records.length} records)`);
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, fresh);
  console.error(`wrote catalog.json (${manifest.records.length} records)`);
}
