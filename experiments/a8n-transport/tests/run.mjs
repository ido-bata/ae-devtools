/**
 * Test runner for a8n-transport tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs
 *
 * Everything here is automated-test / fake-level evidence: the `ae` peer is
 * a node:vm stub, not After Effects. Real-host evidence lives in
 * real-run.mjs output (evidence/*.json) per the repo verification taxonomy.
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs") && f !== "run.mjs")
  .sort();

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, ["--test", join(here, file)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed++;
    console.error(`FAILED: ${file}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
