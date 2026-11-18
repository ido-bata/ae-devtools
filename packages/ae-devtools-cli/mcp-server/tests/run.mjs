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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
