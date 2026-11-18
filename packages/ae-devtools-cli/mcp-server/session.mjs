/**
 * session.mjs — session wiring for the MCP server (Issue #20).
 *
 * Delegates to the shared opener in dev-loop/session-open.mjs (Issue
 * #183) — the same session-kind dispatch the devtools CLI uses, so
 * fake/a8n selection and a8n-transport-missing handling cannot drift
 * between surfaces. The MCP layer adds NO session type and NO
 * permission path of its own; the raw `slice` handle is stripped here
 * because tool payloads must not serialize transport internals.
 *
 * Reused by vscode-extension/controller.mjs — the VSCode surface gets
 * the identical session contract through this module.
 */
import { openSession as openSharedSession } from "../dev-loop/session-open.mjs";

/**
 * @param {"fake"|"a8n"} kind
 * @param {object} options — { aeA8nRoot, installDir } forwarded to the
 *   a8n opener only; ignored for fake.
 * @returns {Promise<{kind:string, evidenceLevel:string, runner:object,
 *   pin:object, close:function, meta?:object}>}
 */
export async function openSession(kind = "fake", options = {}) {
  const { slice: _slice, ...session } = await openSharedSession(kind, options);
  return session;
}
