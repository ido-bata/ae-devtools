/**
 * Test runner for dev-loop tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs            # runs every *.test.mjs in this directory
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
