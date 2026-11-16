/**
 * run.mjs — mcp-server tests (Issue #20, CAP051 slice). Fake level only.
 *
 *   node tests/run.mjs
 *
 * Everything here is automated-test / fake-level evidence: the server is
 * exercised in-process over PassThrough streams plus one spawned stdio
 * smoke test against the codec-faithful fake host. No After Effects is
 * involved; real-host evidence would require --session a8n on an owned
 * AE session and is recorded separately (see ../README.md).
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
