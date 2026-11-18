/**
 * Test runner for scripting-adapters tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs            # runs every *.test.mjs in this directory
 *
 * Everything here is automated-test / fake-level evidence: generated
 * adapter sources run against fake-app.mjs in node:vm — NOT After
 * Effects. Real-host verification stays BLOCKED on an owned AE
 * session; see README.md.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
