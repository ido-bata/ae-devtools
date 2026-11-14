/**
 * execute.mjs — vertical slice: registry operation → trusted runner → host.
 *
 * This is the ONLY supported way to dispatch a registry operation. It
 * exists so callers (MCP tools, agent loop, VSCode commands) never see
 * raw JSX source or the bridge envelope (AGENTS bridge rules):
 *
 *   runOperation({ opId, args, runner, pin, projectIdentity,
 *                  consentProvider, ... })
 *
 * Guarantees delegated to experiments/trusted-execution/runner.mjs
 * (PR #42): consent bound to the exact executed {source, dispatchArgs},
 * permission fixed to "execute", single-use requestIds, reply identity
 * echo, deadline, UNKNOWN quarantine — all per-runner-instance only.
 *
 * What this layer adds:
 *   - op lookup + argument validation BEFORE any consent evaluation
 *   - consent scope computed HERE (consentScopeFor) so a provider can
 *     only approve or refuse the exact scope — it cannot mint a scope
 *     for different args (approval independence, Issue #38 criteria)
 *   - consentProvider is REQUIRED for every operation, including
 *     read-only ones: adapter ops are execute-class dispatches and an
 *     absent provider is a refusal, never an implicit approval
 *   - destructive/mutating metadata is surfaced on the result so
 *     callers (agent-loop dirty-state gating, UI confirmations) can
 *     act on it — it is NOT itself an approval gate; destructive ops
 *     currently ride the same execute consent class. Wiring destructive
 *     ops to a stronger gate is a recorded non-claim (Issue #15).
 *   - host result string is JSON.parsed node-side (ExtendScript result
 *     is a string produced by __adp_json; native JSON inside the host
 *     is not required)
 */

import { consentScopeFor } from "../trusted-execution/permissions.mjs";
import { getOperation, buildSource } from "./registry.mjs";

function refused(reason, detail, extra = {}) {
  return { status: "refused", stage: "adapter", reason, detail, ...extra };
}

/**
 * @param {object} input
 *   opId            — registry operation id (e.g. "item.addComp")
 *   args            — operation arguments (validated by the op schema)
 *   runner          — createJsxRunner() instance (shared for quarantine/dedup)
 *   pin             — {sessionId, aeVersion?, dispatchId?} session pin
 *   projectIdentity — project the dispatch acts on
 *   consentProvider — async ({opId, args, source, scope}) => {approved:true}|{approved:false, reason?}
 *                     REQUIRED. It approves the exact scope computed here;
 *                     returning anything but {approved:true} refuses.
 *   trustedScriptOptIn / scriptProvenance — forwarded to the runner
 *                     (required by the trusted-dev-script consent class)
 *   requestId       — optional caller-chosen id
 */
export async function runOperation(input = {}) {
  const { opId, args = {}, runner, pin, projectIdentity } = input;

  let op = null;
  try {
    op = typeof opId === "string" ? getOperation(opId) : null;
  } catch { /* getOperation throws on unknown ids */ }
  if (!op) {
    return refused("UNKNOWN_OPERATION", `no registry operation '${opId}'`);
  }
  if (!runner || typeof runner.runScript !== "function") {
    return refused("RUNNER_REQUIRED", "a createJsxRunner() instance is required");
  }

  // Argument validation + source generation happen before consent —
  // a malformed op never reaches the approval surface.
  let source;
  try {
    source = buildSource(opId, args);
  } catch (err) {
    return refused("INVALID_ARGS", err instanceof Error ? err.message : String(err), { opId });
  }

  // Consent scope is computed here so the provider approves exactly
  // this dispatch — it cannot substitute different args or source.
  let scope;
  try {
    scope = consentScopeFor({
      pin,
      operationId: opId,
      args: { source, dispatchArgs: args },
      projectIdentity,
    });
  } catch (err) {
    return refused("CONSENT_SCOPE_FAILED", err instanceof Error ? err.message : String(err), { opId });
  }

  if (typeof input.consentProvider !== "function") {
    return refused("CONSENT_PROVIDER_REQUIRED",
      "every registry dispatch requires an injected consentProvider; absence is a refusal, not an approval", { opId });
  }
  const decision = await input.consentProvider({ opId, args, source, scope });
  if (!decision || decision.approved !== true) {
    return {
      status: "refused", stage: "consent", reason: "CONSENT_DENIED",
      detail: decision?.reason ?? "consentProvider did not approve this dispatch",
      opId,
    };
  }

  const outcome = await runner.runScript({
    source,
    pin,
    operationId: opId,
    args,
    projectIdentity,
    consent: { scope },
    // Mutating ops declare partial-mutation possibility so a FAILED
    // outcome surfaces mayHaveMutated for dirty-state gating (#38).
    mayMutatePartial: op.mutating === true,
    trustedScriptOptIn: input.trustedScriptOptIn,
    scriptProvenance: input.scriptProvenance,
    requestId: input.requestId,
  });

  // Decode the host's JSON-string result for callers. A non-JSON or
  // absent result is reported verbatim — never fabricated.
  let result = outcome.result;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { /* keep raw string */ }
  }

  return {
    ...outcome,
    opId,
    mutating: op.mutating === true,
    destructive: op.destructive === true,
    result,
  };
}
