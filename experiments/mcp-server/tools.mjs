/**
 * tools.mjs — the four dev-loop MCP tools (Issue #20, CAP051 slice).
 *
 * Thin wrappers over experiments/dev-loop/devloop.mjs — the ONLY
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
import { discover, inspect, execute, verify } from "../dev-loop/devloop.mjs";

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
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function isBadOutcome(payload) {
  const outcome = payload?.outcome ?? payload?.status ?? null;
  return ["refused", "failed", "BLOCKED", "UNKNOWN"].includes(outcome) || payload?.error !== undefined;
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
  return {
    kind: session.kind,
    evidenceLevel: session.evidenceLevel,
    ...(session.meta ?? {}),
  };
}

let requestCounter = 0;

/**
 * @param {string} name — tool name
 * @param {object} args — tool arguments
 * @param {{getSession: () => Promise<object>}} ctx — lazy session accessor;
 *   only ae_execute/ae_verify (and only after the consent pre-gate passes)
 *   call it, so discover/inspect/denied calls never open a session.
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
      const result = await execute({
        opId: args.opId,
        args: args.args ?? {},
        runner: session.runner,
        pin: session.pin,
        projectIdentity: "mcp-devtools",
        consentProvider: async () => ({ approved: true }),
        trustedScriptOptIn: true,
        scriptProvenance: "mcp-server",
        requestId: `req-mcp-${++requestCounter}`,
        confirmDestructive: args.confirmDestructive === true,
        confirmRender: args.confirmRender === true,
      });
      return toolResult({
        schema: MCP_SCHEMA,
        session: sessionBlock(session),
        outcome: result.outcome ?? result.status ?? null,
        result,
      }, isBadOutcome(result));
    }
    case "ae_verify": {
      if (args.consent !== "grant") {
        return toolResult(consentRefusal("ae_verify", args.consent), true);
      }
      const session = await ctx.getSession();
      const result = await verify({
        readOpId: typeof args.readOpId === "string" && args.readOpId.length > 0 ? args.readOpId : "read.projectSummary",
        readArgs: args.args ?? {},
        runner: session.runner,
        pin: session.pin,
        projectIdentity: "mcp-devtools",
        consentProvider: async () => ({ approved: true }),
        trustedScriptOptIn: true,
        scriptProvenance: "mcp-server",
        requestId: `req-mcp-${++requestCounter}`,
      });
      return toolResult({
        schema: MCP_SCHEMA,
        session: sessionBlock(session),
        outcome: result.outcome ?? result.status ?? null,
        result,
      }, isBadOutcome(result));
    }
    default:
      return toolResult({ schema: MCP_SCHEMA, error: `unhandled tool '${name}'` }, true);
  }
}
