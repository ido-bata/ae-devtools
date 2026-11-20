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
 * Guarantees delegated to packages/ae-devtools-cli/trusted-execution/runner.mjs
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

import { consentScopeFor, evalConsentArgs } from "../trusted-execution/permissions.mjs";
import { dispatchIdentity } from "../trusted-execution/dispatch-store.mjs";
import { scopeFingerprint } from "../trusted-execution/consent-audit.mjs";
import { getOperation, buildSource } from "./registry.mjs";

function refused(reason, detail, extra = {}) {
  return { status: "refused", stage: "adapter", reason, detail, ...extra };
}

/**
 * buildSource emits a FUNCTION BODY (top-level `return`). trustedEval
 * evaluates exactly once as a program, so the dispatch boundary wraps
 * the body in an IIFE — the consent-bound source IS the executed text.
 * Exported so audit/correlation code hashes the same string the host
 * runs (single owner for the body→program conversion).
 */
export function toProgramSource(body) {
  return `(function(){\n${body}\n})()`;
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
  source = toProgramSource(source);

  // Consent scope is computed here so the provider approves exactly
  // this dispatch — it cannot substitute different args or source.
  let scope;
  try {
    scope = consentScopeFor({
      pin,
      operationId: opId,
      args: evalConsentArgs(source, args),
      projectIdentity,
    });
  } catch (err) {
    return refused("CONSENT_SCOPE_FAILED", err instanceof Error ? err.message : String(err), { opId });
  }

  if (typeof input.consentProvider !== "function") {
    return refused("CONSENT_PROVIDER_REQUIRED",
      "every registry dispatch requires an injected consentProvider; absence is a refusal, not an approval", { opId });
  }
  // Destructive ops need an explicit per-call confirmation IN ADDITION
  // to consent — consent approves the scope, this flag acknowledges the
  // operation class. It is a UX/safety gate, not an approval authenticity
  // mechanism (that remains a #14 non-claim).
  // Consent audit (Issue #277, CAP052): when a consentAudit store is
  // supplied, BOTH the provider's approved and refused decisions are
  // durably recorded before the outcome returns. Pre-consent refusals
  // above (unknown op / bad args / missing provider / confirm gates)
  // are NOT audit events — no decision occurred. A malformed audit
  // sink is itself a refusal: auditing that cannot be trusted must
  // not silently pass.
  const consentAudit = input.consentAudit ?? null;
  if (consentAudit !== null && typeof consentAudit.recordConsentDecision !== "function") {
    return refused("CONSENT_AUDIT_INVALID",
      "consentAudit must expose recordConsentDecision(entry)", { opId });
  }

  if (op.requiresConfirm === "render" && input.confirmRender !== true) {
    return refused("RENDER_CONFIRMATION_REQUIRED",
      `'${opId}' starts a real render (files, long-running, UNKNOWN-unsafe); pass confirmRender:true only after verifying queue contents and output ownership`, { opId });
  }
  if (op.destructive === true && input.confirmDestructive !== true) {
    return refused("DESTRUCTIVE_CONFIRMATION_REQUIRED",
      `'${opId}' is destructive; pass confirmDestructive:true after operator confirmation`, { opId });
  }

  const decision = await input.consentProvider({ opId, args, source, scope });
  const approved = decision !== null && typeof decision === "object" && decision.approved === true;

  // Audit the decision itself — approved AND refused. The entry carries
  // fingerprints/ids only: no source, no raw args, no provider reason
  // text (unverified free text is not audit material), no operator
  // identity claims. dispatchKey correlates the decision with the
  // dispatch-store record when a store is configured on the runner.
  let auditRecorded = null;
  let auditError = null;
  if (consentAudit !== null) {
    const entry = {
      decision: approved ? "approved" : "refused",
      opId,
      scopeHash: scopeFingerprint(scope),
      dispatchKey: dispatchIdentity({
        pin, operationId: opId,
        args: evalConsentArgs(source, args), projectIdentity,
      }),
      requestId: typeof input.requestId === "string" ? input.requestId : null,
      mutating: op.mutating === true,
      destructive: op.destructive === true,
    };
    try {
      await consentAudit.recordConsentDecision(entry);
      auditRecorded = true;
    } catch (err) {
      auditRecorded = false;
      auditError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!approved) {
    // Refusal audit failure is degradation, not a dispatch blocker —
    // the decision already happened and nothing was sent. Surface the
    // loss honestly on the outcome instead of pretending it recorded.
    return {
      status: "refused", stage: "consent", reason: "CONSENT_DENIED",
      detail: decision?.reason ?? "consentProvider did not approve this dispatch",
      opId,
      ...(auditRecorded === false ? { consentAudit: { recorded: false, error: auditError } } : {}),
    };
  }
  if (auditRecorded === false) {
    // Fail closed: an approval we cannot audit must not dispatch.
    // This is a pre-dispatch refusal — nothing was sent, no retry.
    return refused("CONSENT_AUDIT_UNAVAILABLE",
      `consent approved but audit record failed: ${auditError}`,
      { opId });
  }

  // Attached-session target re-validation (Issue #366): for a mutating
  // op on a session that supplied `targetGuard`, re-prove the target
  // identity AFTER consent approval and IMMEDIATELY before dispatch —
  // consent can sit with a human for minutes, so an earlier check
  // would be stale. The guard resolves {ok:true} or
  // {ok:false, code, detail}; anything else (throw, malformed result)
  // refuses — fail-closed, nothing is sent. Read ops never invoke it.
  if (op.mutating === true && typeof input.targetGuard === "function") {
    let guard = null;
    try {
      guard = await input.targetGuard();
    } catch (err) {
      guard = {
        ok: false,
        code: "TARGET_GUARD_ERROR",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (guard === null || typeof guard !== "object" || guard.ok !== true) {
      return refused(
        "ATTACHED_TARGET_GUARD",
        `target re-validation refused the mutating dispatch: ` +
          `${guard?.detail ?? "guard returned no verdict"}`,
        { opId, guardCode: typeof guard?.code === "string" ? guard.code : null },
      );
    }
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
  // A runner that replies with no outcome object is a transport-level
  // failure, not a completed dispatch — report it structurally instead
  // of dereferencing `outcome.result` into a TypeError (Issue #226).
  if (outcome === null || typeof outcome !== "object") {
    return {
      status: "failed", stage: "transport", reason: "EMPTY_RUNNER_RESULT",
      detail: `runner.runScript returned ${outcome === null ? "null" : typeof outcome} for '${opId}'`,
      opId,
    };
  }

  // Decode the host's JSON-string result for callers. A non-JSON or
  // absent result is reported verbatim — never fabricated.
  let result = outcome.result;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { /* keep raw string */ }
  }
  // Adapter payload contract: __adp_json emits {ok:true,...} on success.
  // An explicit ok:false is a host-level logical failure even though the
  // dispatch itself completed — surface it, never report bare COMPLETED.
  // The reported `outcome` is normalized to FAILED here (Issue #196) so
  // every consumer (CLI evidence, MCP payload, VSCode summary) agrees;
  // the wire-level truth stays visible via status/adapterError/result.
  const adapterFailed = result !== null && typeof result === "object" && result.ok === false;
  if (adapterFailed) {
    return {
      ...outcome,
      opId,
      mutating: op.mutating === true,
      destructive: op.destructive === true,
      outcome: "FAILED",
      status: "failed",
      adapterError: result.error ?? result,
      result,
    };
  }

  return {
    ...outcome,
    opId,
    mutating: op.mutating === true,
    destructive: op.destructive === true,
    result,
  };
}
