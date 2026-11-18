/**
 * Test runner for diagnostics tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs            # runs every *.test.mjs in this directory
 *
 * Everything here is automated-test / fake-level evidence: records are
 * constructed and validated in-process. No After Effects is involved;
 * real-host collection evidence is recorded separately per the repo
 * verification taxonomy (see ../EVIDENCE.md).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
