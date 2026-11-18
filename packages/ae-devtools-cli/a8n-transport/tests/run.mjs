/**
 * Test runner for a8n-transport tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs
 *
 * Everything here is automated-test / fake-level evidence: the `ae` peer is
 * a node:vm stub, not After Effects. Real-host evidence lives in
 * real-run.mjs output (evidence/*.json) per the repo verification taxonomy.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
