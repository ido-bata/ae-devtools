/**
 * Test runner for cep-extension tests: zero dependencies, node:test.
 *
 *   node tests/run.mjs            # runs every *.test.mjs in this directory
 *
 * Everything here is automated-test / fake-level evidence: scaffolds are
 * generated into temp dirs and inspected as text. No After Effects is
 * involved; real-host load evidence is recorded separately per the repo
 * verification taxonomy (see ../EVIDENCE.md).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
