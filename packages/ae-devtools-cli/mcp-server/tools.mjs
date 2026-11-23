/**
 * tools.mjs — the four dev-loop MCP tools (Issue #20, CAP051 slice).
 *
 * Thin wrappers over ../dev-loop/devloop.mjs — the ONLY
 * dispatch path is runOperation() underneath execute()/verify(). This
 * file adds no permission path:
 *
 *   ae_discover — list executable ops + honest evidence levels
 *                 (registry metadata; never opens a session)
 *   ae_inspect  — op schema/metadata (never executes, never opens a
 *                 session)
 *   ae_execute  — dispatch via devloop.execute → runOperation.
 *                 Requires arguments.consent === "grant" (default deny,
 *                 checked BEFORE the session is opened so a denied call
 *                 cannot launch AE). Destructive ops additionally need
 *                 confirmDestructive:true and render ops confirmRender:
 *                 true — enforced by runOperation itself; this layer only
 *                 forwards the flags untouched.
 *   ae_verify   — post-execution read-back via devloop.verify (default
 *                 read.projectSummary; mutating readOpIds are refused
 *                 by the core). Same consent contract as ae_execute.
 *
 * UNKNOWN outcomes are never retried: each tools/call is exactly one
 * dispatch; the trusted runner quarantines UNKNOWN requestIds and this
 * layer never re-issues them.
 *
 * Every result payload carries the session/registry evidence level —
 * fake/mock results are never presented as real-host verification.
 */
import { discover, inspect, execute, verify, sessionStatus, DEVLOOP_SCHEMA } from "../dev-loop/devloop.mjs";
import { failureOutcome, normalizedOutcome, isUnknownOutcome } from "../dev-loop/outcomes.mjs";
import { recordFromExecuteResult } from "../dev-loop/failure-record.mjs";
import { supervisionSnapshotForSession } from "../dev-loop/supervision.mjs";

export const MCP_SCHEMA = "ae-devtools.mcp/v1";

const OBJECT = { type: "object" };
const STRING = { type: "string" };
const BOOLEAN = { type: "boolean" };

export const TOOLS = [
  {
    name: "ae_discover",
    description:
      "List executable After Effects operations with honest metadata (mutating/destructive/confirm gates, arg names, evidence levels). Registry metadata only — nothing is dispatched.",
    inputSchema: {
      ...OBJECT,
      properties: { domain: { ...STRING, description: "Optional domain filter, e.g. project-items-comps-layers" } },
      additionalProperties: false,
    },
  },
  {
    name: "ae_inspect",
    description:
      "Return one operation's schema/metadata (id, permission, mutating, destructive, requiresConfirm, args, claimed inventory members). Never executes and never opens a session.",
    inputSchema: {
      ...OBJECT,
      properties: { opId: { ...STRING, description: "Registry operation id, e.g. item.addComp" } },
      required: ["opId"],
      additionalProperties: false,
    },
  },
  {
    name: "ae_execute",
    description:
      "Dispatch a registry operation through the canonical trusted-execution path. Requires consent:\"grant\"; destructive ops also require confirmDestructive:true, render ops confirmRender:true. Default is deny — no consent argument means refusal before any session opens.",
    inputSchema: {
      ...OBJECT,
      properties: {
        opId: { ...STRING, description: "Registry operation id" },
        args: { ...OBJECT, description: "Operation arguments per ae_inspect schema", default: {} },
        consent: { ...STRING, description: 'Must be exactly "grant" to permit dispatch', enum: ["grant"] },
        confirmDestructive: { ...BOOLEAN, description: "Required true for destructive ops (e.g. project.new, item.remove)" },
        confirmRender: { ...BOOLEAN, description: "Required true for render ops (render.renderQueued)" },
      },
      required: ["opId", "consent"],
      additionalProperties: false,
    },
  },
  {
    name: "ae_verify",
    description:
      "Post-execution read-back: re-reads observable state via a read-only registry op (default read.projectSummary). Reports host-observed state — never infers success from a write outcome. Requires consent:\"grant\".",
    inputSchema: {
      ...OBJECT,
      properties: {
        readOpId: { ...STRING, description: "Read-only op id (default read.projectSummary)", default: "read.projectSummary" },
        args: { ...OBJECT, description: "Arguments for the read op", default: {} },
        consent: { ...STRING, description: 'Must be exactly "grant" to permit dispatch', enum: ["grant"] },
      },
      required: ["consent"],
      additionalProperties: false,
    },
  },
  {
    name: "ae_session",
    description:
      "Report session/API metadata: configured session kind, whether a session is open/opening/failed/closed in this server process, and the evidence level of an open session. Metadata only — never opens a session and never dispatches.",
    inputSchema: { ...OBJECT, properties: {}, additionalProperties: false },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

// Outcome normalization is shared with the CLI diagnostics block and
// the VSCode collector (dev-loop/outcomes.mjs, Issue #181): adapter
// `status` spellings and the failure-beats-COMPLETED rule are handled
// identically on every surface — the previous local check only looked
// at `outcome ?? status` and reported adapter-level failures as
// COMPLETED/isError:false. The `error`-field rule lives in
// failureOutcome too (Issue #196): any non-nullish value is failure
// evidence; `error: null` is not — the old local `!== undefined` patch
// produced exactly that false positive.
function isBadOutcome(result) {
  return failureOutcome(result) !== null;
}

// diagnostics/collectors.mjs is loaded lazily and only on the failure
// path: a damaged/partial install degrades to an honest "unavailable"
// diagnostics block instead of keeping the whole MCP server from
// starting (same discipline as devtools-cli/diagnostics.mjs).
let collectorsPromise = null;
function diagnosticsCollectors() {
  collectorsPromise ??= import("../diagnostics/collectors.mjs").then((m) => ({
    fromAeError: m.fromAeError,
    fromTransportOutcome: m.fromTransportOutcome,
  }));
  return collectorsPromise;
}

/**
 * Failure → canonical ae-devtools.diagnostics/v1 record for the tool
 * payload (Issue #196): the SAME recordFromExecuteResult mapping the
 * CLI evidence block and the VSCode Problems collector use, so an
 * ae_execute/ae_verify failure carries identical diagnostics.records
 * semantics on every surface. Returns null when the result is not
 * failure-shaped; an "unavailable" block when the packaged
 * diagnostics/ module cannot be loaded.
 */
async function failureDiagnostics({ result, session, requestId }) {
  const state = failureOutcome(result);
  if (state === null) return null;
  try {
    const collectors = await diagnosticsCollectors();
    // Durable supervision snapshot (Issue #408): read-only consume of
    // the ae-a8n supervision contract; attached sessions get the same
    // view — this never mutates the host.
    const supervision = supervisionSnapshotForSession(session);
    const record = recordFromExecuteResult({
      result,
      outcome: state,
      session: { kind: session.kind, pin: session.pin },
      requestId,
      supervision,
      collectors,
    });
    return record === null
      ? null
      : {
          status: "ok",
          records: [record],
          ...(supervision !== null ? { supervision } : {}),
        };
  } catch (e) {
    return { status: "unavailable", reason: String(e?.message ?? e), records: [] };
  }
}

function consentRefusal(opLabel, consent) {
  return {
    schema: MCP_SCHEMA,
    status: "refused",
    stage: "consent",
    reason: "CONSENT_NOT_GRANTED",
    detail: `${opLabel} requires consent:"grant"; got ${JSON.stringify(consent ?? null)}. Default is deny — this refusal happened before any session was opened.`,
    dispatched: false,
    evidenceLevel: "no dispatch — consent gate",
  };
}

function sessionBlock(session) {
  // meta first: session-supplied fields must not override the honest
  // top-level kind/evidenceLevel (Issue #226). `policy` is the
  // session-imposed dispatch scope (Issue #366) — attached sessions
  // record exactly which mutating ops were granted at open time.
  return {
    ...(session.meta ?? {}),
    kind: session.kind,
    evidenceLevel: session.evidenceLevel,
    policy: session.policy ?? null,
  };
}

let requestCounter = 0;

/**
 * @param {string} name — tool name
 * @param {object} args — tool arguments
 * @param {{getSession: () => Promise<object>,
 *   onRequestEvent?: (ev:{requestId:string,method:string|null,event:string})=>*}} ctx
 *   — lazy session accessor; only ae_execute/ae_verify (and only after
 *   the consent pre-gate passes) call it, so discover/inspect/denied
 *   calls never open a session. `onRequestEvent` is an optional sink
 *   for run-guard request lifecycle events (Issue #198); surfaces
 *   without a marker simply omit it.
 */
export async function callTool(name, args = {}, ctx = {}) {
  if (!TOOL_NAMES.has(name)) {
    return toolResult({ schema: MCP_SCHEMA, error: `unknown tool '${name}'`, knownTools: [...TOOL_NAMES] }, true);
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return toolResult({ schema: MCP_SCHEMA, error: "arguments must be a JSON object" }, true);
  }

  switch (name) {
    case "ae_discover": {
      const d = discover({ domain: typeof args.domain === "string" ? args.domain : null });
      return toolResult({
        schema: MCP_SCHEMA,
        evidenceLevel: "registry metadata — no dispatch",
        ...d,
      });
    }
    case "ae_inspect": {
      if (typeof args.opId !== "string" || args.opId.length === 0) {
        return toolResult({ schema: MCP_SCHEMA, error: "ae_inspect requires arguments.opId (string)" }, true);
      }
      const i = inspect(args.opId);
      return toolResult({
        schema: MCP_SCHEMA,
        evidenceLevel: "metadata only — nothing executed",
        ...i,
      });
    }
    case "ae_execute": {
      if (typeof args.opId !== "string" || args.opId.length === 0) {
        return toolResult({ schema: MCP_SCHEMA, error: "ae_execute requires arguments.opId (string)" }, true);
      }
      if (args.consent !== "grant") {
        return toolResult(consentRefusal(`ae_execute('${args.opId}')`, args.consent), true);
      }
      const session = await ctx.getSession();
      // consent === "grant" was verified before the session opened; the
      // provider exists because runOperation requires one for EVERY
      // dispatch — it is not an approval of its own.
      const requestId = `req-mcp-${++requestCounter}`;
      // Request lifecycle → run-guard marker when the surface keeps one
      // (a8n sessions, Issue #198). "timeout" is recorded only for a
      // wire UNKNOWN outcome — the same recoverable-state rule the CLI
      // uses; these events are residue visibility, never authority.
      ctx.onRequestEvent?.({ requestId, method: args.opId, event: "dispatched" });
      const result = await execute({
        opId: args.opId,
        args: args.args ?? {},
        runner: session.runner,
        pin: session.pin,
        projectIdentity: session.hostProjectGuard ?? "mcp-devtools",
        hostProjectGuard: session.hostProjectGuard ?? null,
        hostProjectGuardRequired: session.hostProjectGuardRequired === true,
        consentProvider: async () => ({ approved: true }),
        consentAudit: ctx.consentAudit ?? null,
        trustedScriptOptIn: true,
        scriptProvenance: "mcp-server",
        requestId,
        sessionPolicy: session.policy ?? null,
        // Attached-session target re-validation (Issue #366).
        targetGuard: session.targetGuard ?? null,
        confirmDestructive: args.confirmDestructive === true,
        confirmRender: args.confirmRender === true,
      });
      ctx.onRequestEvent?.({
        requestId, method: args.opId,
        event: isUnknownOutcome(result) ? "timeout" : "resolved",
      });
      const diagnostics = await failureDiagnostics({ result, session, requestId });
      return toolResult({
        schema: MCP_SCHEMA,
        session: sessionBlock(session),
        outcome: normalizedOutcome(result),
        result,
        ...(diagnostics !== null ? { diagnostics } : {}),
      }, isBadOutcome(result));
    }
    case "ae_verify": {
      if (args.consent !== "grant") {
        return toolResult(consentRefusal("ae_verify", args.consent), true);
      }
      const session = await ctx.getSession();
      const readOpId = typeof args.readOpId === "string" && args.readOpId.length > 0 ? args.readOpId : "read.projectSummary";
      const requestId = `req-mcp-${++requestCounter}`;
      ctx.onRequestEvent?.({ requestId, method: readOpId, event: "dispatched" });
      const result = await verify({
        readOpId,
        readArgs: args.args ?? {},
        runner: session.runner,
        pin: session.pin,
        projectIdentity: session.hostProjectGuard ?? "mcp-devtools",
        hostProjectGuard: session.hostProjectGuard ?? null,
        hostProjectGuardRequired: session.hostProjectGuardRequired === true,
        consentProvider: async () => ({ approved: true }),
        consentAudit: ctx.consentAudit ?? null,
        trustedScriptOptIn: true,
        scriptProvenance: "mcp-server",
        requestId,
      });
      ctx.onRequestEvent?.({
        requestId, method: readOpId,
        event: isUnknownOutcome(result) ? "timeout" : "resolved",
      });
      const diagnostics = await failureDiagnostics({ result, session, requestId });
      return toolResult({
        schema: MCP_SCHEMA,
        session: sessionBlock(session),
        outcome: normalizedOutcome(result),
        result,
        ...(diagnostics !== null ? { diagnostics } : {}),
      }, isBadOutcome(result));
    }
    case "ae_session": {
      const peek = typeof ctx.peekSession === "function" ? ctx.peekSession() : {};
      return toolResult({
        schema: MCP_SCHEMA,
        evidenceLevel: "metadata only — this call never opens a session",
        ...sessionStatus({
          session: peek.session ?? null,
          sessionKind: ctx.sessionKind ?? null,
          opening: peek.opening === true,
          failed: peek.failed === true,
        }),
        api: { mcp: MCP_SCHEMA, devLoop: DEVLOOP_SCHEMA },
      });
    }
    default:
      return toolResult({ schema: MCP_SCHEMA, error: `unhandled tool '${name}'` }, true);
  }
}
