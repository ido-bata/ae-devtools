/**
 * run.mjs — vscode-extension tests (Issue #152). Fake level only.
 *
 *   node tests/run.mjs
 *
 * Automated-test / fake-level evidence: the controller runs against the
 * codec-faithful fake host through the same callTool/dev-loop path as
 * the MCP server. No vscode API and no After Effects are involved.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestDir } from "../../scripts/test-harness.mjs";

runTestDir(dirname(fileURLToPath(import.meta.url)));
