/**
 * test-harness.mjs — shared runner for the per-module `tests/run.mjs`
 * entry points (Issue #185).
 *
 * Each module keeps its own `tests/run.mjs` because CI and `npm test`
 * invoke them per directory, but the boilerplate — enumerate
 * `*.test.mjs`, spawn `node --test` per file, aggregate the verdict —
 * lives here exactly once.
 *
 *   import { runTestDir } from "../../scripts/test-harness.mjs";
 *   runTestDir(dirname(fileURLToPath(import.meta.url)));
 *
 * Or directly: `node scripts/test-harness.mjs <tests-dir>`.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Run every `*.test.mjs` in `dir` under `node --test`.
 * Sets process.exitCode to 1 if any file fails; never throws for test
 * failures (spawn errors still surface via nonzero status).
 */
export function runTestDir(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();

  let failed = 0;
  for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(process.execPath, ["--test", join(dir, file)], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      failed++;
      console.error(`FAILED: ${file}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
  console.log(`\n${files.length - failed}/${files.length} test files green`);
  return failed;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/test-harness.mjs <tests-dir>");
    process.exit(2);
  }
  runTestDir(resolve(dir));
}
