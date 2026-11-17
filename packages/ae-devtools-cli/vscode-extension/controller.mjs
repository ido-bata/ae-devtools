/**
 * controller.mjs — VSCode-command-facing controller for the dev-loop
 * core (Issue #152, CAP050 slice 1).
 *
 * Thin wrapper: every operation delegates to the SAME surface the MCP
 * server uses — `callTool` over `dev-loop`/`runOperation` with a lazily
 * opened session from `mcp-server/session.mjs`. This module adds NO
 * dispatch path and NO permission path of its own:
 *
 *   discover / inspect — registry metadata, never open a session
 *   execute            — UI consent confirmations are collected HERE,
 *                        then forwarded as consent:"grant" +
 *                        confirmDestructive/confirmRender to the
 *                        canonical gates in runOperation. A declined
 *                        confirmation is a structured refusal and the
 *                        session is never opened.
 *   verify             — same consent contract as execute.
 *
 * The controller is vscode-free: the extension entry injects the real
 * `vscode` UI, tests inject a fake. `ui.confirm` must resolve true only
 * on an explicit affirmative user action.
 */
import { callTool } from "../mcp-server/tools.mjs";
import { openSession } from "../mcp-server/session.mjs";
import { recordsFromExecuteResult, buildPublishPlan } from "./diagnostics.mjs";

export const EXTENSION_SCHEMA = "ae-devtools.vscode-extension/v1";

const DENY_ALL_UI = {
  async confirm() { return false; },
  async info() {},
  async error() {},
};

function uiDeclined(detail) {
  return {
    schema: EXTENSION_SCHEMA,
    status: "refused",
    stage: "ui-confirm",
    reason: "DECLINED_BY_USER",
    detail,
    dispatched: false,
    evidenceLevel: "no dispatch — UI confirmation gate",
  };
}

/**
 * @param {object} options
 * @param {"fake"|"a8n"} [options.session="fake"]
 * @param {string} [options.aeA8nRoot]
 * @param {string} [options.installDir]
 * @param {{confirm:Function, info?:Function, error?:Function}} [options.ui]
 * @param {Function} [options.sessionFactory] — (kind, opts) => session;
 *   defaults to mcp-server/session.mjs openSession. Injected by tests.
 */
export function createController(options = {}) {
  const {
    session: sessionKind = "fake",
    aeA8nRoot,
    installDir,
    ui = DENY_ALL_UI,
    sessionFactory = openSession,
  } = options;

  let sessionPromise = null;
  const getSession = () => {
    sessionPromise ??= sessionFactory(sessionKind, { aeA8nRoot, installDir });
    return sessionPromise;
  };

  async function tool(name, args) {
    const res = await callTool(name, args ?? {}, { getSession });
    // callTool wraps the payload as MCP text content; unwrap it so
    // commands/tests see the honest payload (session.evidenceLevel
    // included) directly instead of a JSON string inside content[].
    const text = res?.content?.[0]?.text;
    let payload = {};
    try { payload = typeof text === "string" ? JSON.parse(text) : {}; } catch { payload = {}; }
    const { schema: sourceSchema = null, ...rest } = payload;
    return {
      schema: EXTENSION_SCHEMA,
      command: name,
      isError: res?.isError === true,
      sourceSchema,
      ...rest,
    };
  }

  /**
   * Attach a diagnostics publish plan (ae-devtools.diagnostics/v1
   * records → Problems-panel items) to execute/verify payloads.
   * Collection is read-only observation of the outcome — it never
   * changes dispatch, consent, or retry behavior.
   */
  function withDiagnostics(payload) {
    const inner = payload?.result;
    if (!inner || typeof inner !== "object") return payload;
    const records = recordsFromExecuteResult(inner, {
      session: payload.session,
      requestId: inner.requestId,
    });
    if (records.length === 0) return payload;
    return { ...payload, diagnostics: buildPublishPlan(records) };
  }

  return {
    /** Registry metadata only — never opens a session. */
    discover(args = {}) {
      return tool("ae_discover", args);
    },

    /** Op schema/metadata — never executes, never opens a session. */
    inspect(opId) {
      return tool("ae_inspect", { opId });
    },

    /**
     * Dispatch through the canonical path after explicit UI confirms.
     * Order: inspect (metadata gates) → destructive confirm → render
     * confirm → consent confirm → ae_execute. Any decline stops before
     * the session opens.
     */
    async execute({ opId, args = {} } = {}) {
      if (typeof opId !== "string" || opId.length === 0) {
        return {
          schema: EXTENSION_SCHEMA,
          status: "refused",
          stage: "adapter",
          reason: "USAGE",
          detail: "ae-devtools.execute requires an operation id",
          dispatched: false,
        };
      }
      const meta = await callTool("ae_inspect", { opId }, {});
      const metaText = meta?.content?.[0]?.text;
      let op = null;
      try { op = metaText ? (JSON.parse(metaText).op ?? null) : null; } catch { op = null; }
      if (!op) {
        return {
          schema: EXTENSION_SCHEMA,
          command: "ae_execute",
          status: "refused",
          stage: "adapter",
          reason: "UNKNOWN_OPERATION",
          detail: `no registered operation '${opId}'`,
          dispatched: false,
        };
      }

      let confirmDestructive = false;
      let confirmRender = false;
      if (op.destructive === true) {
        confirmDestructive = await ui.confirm({
          title: `Destructive operation: ${opId}`,
          detail: `'${opId}' changes or removes project/AE state and may not be undoable. Members: ${(op.members ?? []).join(", ") || "n/a"}.`,
          modal: true,
        });
        if (!confirmDestructive) {
          return uiDeclined(`destructive confirmation declined for '${opId}'`);
        }
      }
      if (op.requiresConfirm === "render") {
        confirmRender = await ui.confirm({
          title: `Render operation: ${opId}`,
          detail: `'${opId}' starts a real render (files written, long-running, UNKNOWN-unsafe). Verify queue contents and output ownership first.`,
          modal: true,
        });
        if (!confirmRender) {
          return uiDeclined(`render confirmation declined for '${opId}'`);
        }
      }
      const consent = await ui.confirm({
        title: `Dispatch ${opId} on ${sessionKind} session?`,
        detail: `Session kind '${sessionKind}' — evidence level is NOT upgraded by this command. consent:"grant" is forwarded to the canonical consent gate; the core still enforces scope/confirm rules.`,
        modal: true,
      });
      if (!consent) {
        return uiDeclined(`consent declined for '${opId}'`);
      }

      const res = await tool("ae_execute", {
        opId,
        args,
        consent: "grant",
        confirmDestructive,
        confirmRender,
      });
      return withDiagnostics(res);
    },

    /** Post-execution read-back; same consent contract as execute. */
    async verify() {
      const consent = await ui.confirm({
        title: "Verify observable AE state?",
        detail: "Runs a read-only registry op (default read.projectSummary) through the canonical dispatch path with consent:\"grant\".",
        modal: true,
      });
      if (!consent) {
        return uiDeclined("verify consent declined");
      }
      return withDiagnostics(await tool("ae_verify", { consent: "grant" }));
    },

    /** Close the shared session if one was opened. Safe to call always. */
    async close() {
      if (sessionPromise === null) return { closed: false };
      try {
        const s = await sessionPromise;
        await s.close?.();
        return { closed: true };
      } catch {
        return { closed: false, error: "session close failed" };
      } finally {
        sessionPromise = null;
      }
    },
  };
}
