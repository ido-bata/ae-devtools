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
import { closeSessionWithTimeout } from "../dev-loop/session-close.mjs";
import { createSurfaceGuard } from "../dev-loop/surface-guard.mjs";
import { recordsFromExecuteResult, buildPublishPlan } from "./diagnostics.mjs";
import { buildAttachConfig, writeLaunchJson } from "../vscode-debugger/src/gen.mjs";
import { validateLaunchJson, hasErrors } from "../vscode-debugger/src/schema.mjs";
import { runPreflight } from "../vscode-debugger/src/preflight.mjs";

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
 * @param {number} [options.closeTimeoutMs] — bound for session.close()
 *   (default: the shared dev-loop close timeout, Issue #196)
 * @param {string} [options.runsDir] — run-guard marker dir for a8n
 *   sessions (default: devtools-cli RUNS_DIR; Issue #198 residue
 *   markers — surface "vscode", no attestation, reap/recover refuse)
 */
export function createController(options = {}) {
  const {
    session: sessionKind = "fake",
    aeA8nRoot,
    installDir,
    ui = DENY_ALL_UI,
    sessionFactory = openSession,
    closeTimeoutMs,
    runsDir,
  } = options;

  // Run-guard residue markers for a8n sessions only (Issue #198, 案 C)
  // — same contract as the MCP server: marker on session open, request
  // lifecycle events per dispatch, NO session.process attestation, so
  // reap/recover keep refusing (fail-closed). Fake sessions get none.
  const guard = createSurfaceGuard({
    surface: "vscode", sessionKind, dir: runsDir,
  });

  let sessionPromise = null;
  let resolvedSession = null;
  let sessionFailed = false;
  const getSession = () => {
    sessionPromise ??= (async () => {
      // Marker BEFORE open: a launch that dies mid-open still leaves
      // an attributable residue record.
      await guard.begin();
      try {
        const s = await sessionFactory(sessionKind, { aeA8nRoot, installDir });
        guard.mark(s);
        resolvedSession = s;
        return s;
      } catch (e) {
        guard.failOpen();
        throw e;
      }
    })();
    sessionPromise.catch(() => { sessionFailed = true; });
    return sessionPromise;
  };

  async function tool(name, args) {
    const res = await callTool(name, args ?? {}, {
      getSession,
      sessionKind,
      peekSession: () => ({
        session: resolvedSession,
        opening: sessionPromise !== null && resolvedSession === null && !sessionFailed,
        failed: sessionFailed,
      }),
      onRequestEvent: (ev) => guard.request(ev),
    });
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
  async function withDiagnostics(payload) {
    const inner = payload?.result;
    if (!inner || typeof inner !== "object") return payload;
    // payload.session is the serialized sessionBlock (kind/evidenceLevel/
    // meta) — it carries no pin. The live session object does; without it
    // the diagnostics record loses the sessionId/dispatchId binding that
    // CLI and MCP records have (Issue #219).
    const live = await getSession().catch(() => null);
    const records = recordsFromExecuteResult(inner, {
      session: live !== null && typeof live === "object" && "pin" in live
        ? { kind: live.kind, pin: live.pin }
        : payload.session,
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

    /** Session/API metadata — reports open-session state; never opens one. */
    sessionStatus() {
      return tool("ae_session", {});
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

    /**
     * ae-devtools.debug.setup (Issue #154): generate/merge the
     * attach-only launch.json via the packaged vscode-debugger (#53)
     * and re-validate the document. Attach-only by contract — launch
     * requests bypass the owned-session dispatch path and are never
     * emitted.
     */
    debugSetup({ projectDir, hostAppSpecifier, engineName = "main" } = {}) {
      if (typeof hostAppSpecifier !== "string" || hostAppSpecifier.length === 0) {
        return {
          schema: EXTENSION_SCHEMA,
          command: "ae-devtools.debug.setup",
          status: "refused",
          stage: "usage",
          reason: "USAGE",
          detail: "debug.setup requires hostAppSpecifier (set ae-devtools.debug.hostAppSpecifier — the authoritative string is shown by the Adobe.extendscript-debug app picker)",
          dispatched: false,
        };
      }
      try {
        const config = buildAttachConfig({ hostAppSpecifier, engineName });
        const written = writeLaunchJson(projectDir ?? process.cwd(), config);
        // writeLaunchJson already contract-validated the merged doc
        // (fail-closed on our config); re-check the emitted config here
        // so the command result carries the diagnostics explicitly.
        const diagnostics = validateLaunchJson({
          version: "0.2.0",
          configurations: [written.config],
        });
        return {
          schema: EXTENSION_SCHEMA,
          command: "ae-devtools.debug.setup",
          status: hasErrors(diagnostics) ? "failed" : "ok",
          path: written.path,
          merged: written.merged,
          preservedComments: written.preservedComments,
          config: written.config,
          diagnostics,
          note: "attach-only configuration; dispatch of the debugged script stays on the owned-session transport — the debugger attaches to breakpoints/errors in what the session evaluates",
        };
      } catch (e) {
        return {
          schema: EXTENSION_SCHEMA,
          command: "ae-devtools.debug.setup",
          status: "refused",
          stage: "adapter",
          reason: "WRITE_FAILED",
          detail: e?.message ?? String(e),
          dispatched: false,
        };
      }
    },

    /**
     * ae-devtools.debug.attach (Issue #154): attach preflight via the
     * packaged vscode-debugger. Fail closed — only
     * `ready-owned-session` is attachable; every other verdict returns
     * guidance, never an attach claim. `debugCompletionClaimed` is
     * always false upstream.
     */
    debugAttach({ hostAppSpecifier, ownedPid, preflightDeps } = {}) {
      const pid = ownedPid == null || ownedPid === ""
        ? null
        : Number(ownedPid);
      if (pid !== null && !Number.isInteger(pid)) {
        return {
          schema: EXTENSION_SCHEMA,
          command: "ae-devtools.debug.attach",
          status: "refused",
          stage: "usage",
          reason: "USAGE",
          detail: "ownedPid must be an integer pid or empty",
          dispatched: false,
        };
      }
      const preflight = runPreflight({
        specifier: typeof hostAppSpecifier === "string" && hostAppSpecifier.length > 0 ? hostAppSpecifier : null,
        ownedPid: pid,
        deps: preflightDeps ?? {},
      });
      return {
        schema: EXTENSION_SCHEMA,
        command: "ae-devtools.debug.attach",
        status: preflight.attachAttemptable ? "ok" : "blocked",
        preflight,
        guidance: preflight.attachAttemptable
          ? "Preflight attests a single owned AE instance (attestation-grade). Start the Adobe.extendscript-debug attach session from the generated launch.json; real attach remains UNVERIFIED until observed."
          : "Attach is not claimed. Resolve the preflight reasons (owned AE session via ae-a8n, single unambiguous instance, correct hostAppSpecifier), then re-run. Debugger attach never bypasses the owned-session dispatch path.",
      };
    },

    /** Close the shared session if one was opened. Safe to call always.
     *  Bounded by the shared dev-loop close timeout (Issue #196) — a
     *  hung close reports {closed:false, error} instead of pinning
     *  deactivate() forever. Finalizes the a8n run-guard marker:
     *  "closed" removes it, "close-failed" keeps it as residue
     *  (Issue #198). */
    async close() {
      if (sessionPromise === null) return { closed: false };
      let closeFailed = false;
      try {
        const s = await sessionPromise;
        const r = await closeSessionWithTimeout(s, { timeoutMs: closeTimeoutMs });
        if (r.ok === false) {
          closeFailed = true;
          return { closed: false, error: r.error };
        }
        return { closed: true };
      } catch {
        closeFailed = true;
        return { closed: false, error: "session close failed" };
      } finally {
        guard.end(closeFailed ? "close-failed" : "closed");
        sessionPromise = null;
      }
    },
  };
}
