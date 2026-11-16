/**
 * devloop.mjs — MCP/VSCode developer-loop core (Issue #20, CAP049+).
 *
 * Thin orchestration over EXISTING contracts — no parallel permission
 * path is created here:
 *   discover()  — registry ops + catalog records, honest evidence levels
 *   inspect()   — op schema/metadata (never executes)
 *   execute()   — delegates to scripting-adapters runOperation(), which
 *                 is the ONLY dispatch path (consent scope, required
 *                 consentProvider, confirmDestructive/confirmRender
 *                 gates, trusted runner, codec, quarantine)
 *   verify()    — post-execution read-back via read.projectSummary or
 *                 caller-supplied read op; reports observed state, never
 *                 assumes success from the write outcome alone
 *
 * VSCode commands and MCP tools are intended to be thin wrappers over
 * these functions — callers never see JSX source or wire envelopes.
 */

import { OPERATIONS, getOperation, registryReport } from "../scripting-adapters/registry.mjs";
import { runOperation } from "../scripting-adapters/execute.mjs";

export const DEVLOOP_SCHEMA = "ae-devtools.dev-loop/v1";

/** List executable operations with honest metadata. Unimplemented
 *  inventory members are NOT listed as executable — discovery shows
 *  ops only; coverage gaps live in the catalog/domain reports. */
export function discover({ domain = null } = {}) {
  const ops = OPERATIONS.filter((o) => !domain || o.domain === domain);
  return {
    schema: DEVLOOP_SCHEMA,
    operationCount: ops.length,
    evidence: registryReport().evidence,
    operations: ops.map((o) => ({
      id: o.id,
      domain: o.domain,
      mutating: o.mutating,
      destructive: o.destructive === true,
      requiresConfirm: o.requiresConfirm ?? null,
      // Copies, not references: dev-loop ships in the published package
      // and long-lived consumers (the MCP stdio server) must not be able
      // to mutate the shared registry through the returned arrays.
      args: [...o.args],
      memberCount: o.members.length,
    })),
  };
}

/** Operation detail for inspect — schema + claimed members + gates. */
export function inspect(opId) {
  let op;
  try { op = getOperation(opId); } catch {
    return { status: "unknown-operation", opId };
  }
  return {
    status: "ok",
    op: {
      id: op.id, domain: op.domain, permission: op.permission,
      mutating: op.mutating, destructive: op.destructive === true,
      requiresConfirm: op.requiresConfirm ?? null,
      args: [...op.args], members: [...op.members],
    },
  };
}

/** Execute via the canonical path. All safety inputs are forwarded
 *  untouched — this function adds NO approval of its own. */
export async function execute(input = {}) {
  // `?? {}` covers null — runOperation's destructuring would throw a
  // TypeError on null instead of producing its structured refusal.
  return runOperation(input ?? {});
}

/**
 * Verify: re-read observable state after execute. Default read op is
 * read.projectSummary; callers may pass any read-only opId. The result
 * is the host-reported state — verification never infers success from
 * the write outcome.
 */
export async function verify(input = {}) {
  // Destructure inside the body (not the parameter list) so verify(null)
  // reaches the structured refusal path instead of throwing a TypeError.
  const {
    runner, pin, projectIdentity, consentProvider, trustedScriptOptIn,
    scriptProvenance, readOpId = "read.projectSummary", readArgs = {}, requestId,
  } = input ?? {};
  const op = (() => { try { return getOperation(readOpId); } catch { return null; } })();
  if (!op || op.mutating) {
    // Same refusal shape as scripting-adapters/execute.mjs refused():
    // {status, stage, reason, detail, opId?}. The detail distinguishes
    // an unknown op id from a mutating one — they need different fixes.
    const detail = op === null
      ? `readOpId '${readOpId}' is not a registered operation`
      : `readOpId '${readOpId}' is a mutating op; verify requires a read-only op`;
    return { status: "refused", stage: "adapter", reason: "VERIFY_REQUIRES_READ_OP", detail, opId: readOpId };
  }
  return runOperation({
    opId: readOpId, args: readArgs, runner, pin, projectIdentity,
    consentProvider, trustedScriptOptIn, scriptProvenance, requestId,
  });
}
