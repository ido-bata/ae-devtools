/**
 * Test runner for trusted-execution tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs            # runs every *.test.mjs in this directory
 *
 * Everything here is automated-test / fake-level evidence: the codec runs
 * in node:vm with native JSON removed. No After Effects is involved;
 * real-host evidence, when it exists, is recorded separately per the
 * repo verification taxonomy.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
