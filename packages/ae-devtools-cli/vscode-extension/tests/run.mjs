/**
 * run.mjs — vscode-extension tests (Issue #152). Fake level only.
 *
 *   node tests/run.mjs
 *
 * Automated-test / fake-level evidence: the controller runs against the
 * codec-faithful fake host through the same callTool/dev-loop path as
 * the MCP server. No vscode API and no After Effects are involved.
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith(".test.mjs") && f !== "run.mjs").sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, ["--test", join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
