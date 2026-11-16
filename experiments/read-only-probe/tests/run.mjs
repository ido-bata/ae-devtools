/**
 * Test runner for the read-only-probe tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs            # runs every *.test.mjs in this directory
 *
 * Graphical/real host tests are NOT here: everything in tests/ is
 * automated-test evidence against fake responders. Real-host evidence
 * lives in evidence/ and EVIDENCE.md and is labelled per run.
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
process.exitCode = failed ? 1 : 0;
console.log(`\n${files.length - failed}/${files.length} test files green`);
