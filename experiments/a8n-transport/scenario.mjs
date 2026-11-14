/**
 * scenario.mjs — the Issue #49 vertical slice, transport-agnostic.
 *
 * Runs against ANY createJsxRunner() instance: the fake transport in tests
 * and the real ae-a8n transport in real-run.mjs execute the same steps, so
 * a green fake run and a green real run differ only in the peer.
 *
 * Steps (all read-only against the AE project — see session.mjs for why):
 *   1. connect/state  — `String(app.version)` completes and echoes a version
 *   2. project state  — `app.project.numItems` completes with a number
 *   3. error capture  — a source that throws inside AE classifies FAILED and
 *                       carries host-reported error fields (never inferred)
 *   4. fix -> rerun   — the corrected source completes; demonstrates the
 *                       error -> fix -> re-execute half of the dev loop
 *   5. state verify   — a `$.global` counter incremented across two dispatches
 *                       proves dispatches share one live AE session
 *   6. consent refusal— a scope computed for DIFFERENT source is refused
 *                       before send (transport send count must not move)
 *   7. consent denial — policy denies a marked source; nothing is sent
 *
 * Consent here is a LOCAL POLICY: the scenario mints the scope itself via
 * consentScopeFor and passes trustedScriptOptIn/scriptProvenance. That
 * exercises the gate mechanics (scope binding, opt-in, provenance) but is
 * NOT authenticated authorization — ae-a8n #97–#99 owns token issuance.
 */
import { consentScopeFor } from "../trusted-execution/permissions.mjs";

export const OPERATION_ID = "op.a8n-transport.eval";
export const PROJECT_IDENTITY = "a8n-transport-slice";

/** Local consent policy: approves everything except sources marked __DENY__. */
export function sliceConsentPolicy({ source } = {}) {
  if (typeof source === "string" && source.includes("__DENY__")) {
    return { approved: false, reason: "policy denied: source carries __DENY__ marker" };
  }
  return { approved: true };
}

function scopeFor(source, pin) {
  return consentScopeFor({
    pin,
    operationId: OPERATION_ID,
    args: { source, dispatchArgs: null },
    projectIdentity: PROJECT_IDENTITY,
  });
}

/**
 * @param {object} deps
 *   runner        — createJsxRunner() instance (real or fake transport)
 *   pin           — {sessionId, aeVersion, dispatchId}
 *   sendCount     — () => number, transport send counter (may be absent)
 *   policy        — consent policy fn (default sliceConsentPolicy)
 */
export async function runVerticalSlice({ runner, pin, sendCount, policy } = {}) {
  if (!runner || typeof runner.runScript !== "function") {
    throw new Error("runVerticalSlice: runner.runScript is required");
  }
  if (!pin || typeof pin.sessionId !== "string" || pin.sessionId.length === 0) {
    throw new Error("runVerticalSlice: pin.sessionId is required");
  }
  const decide = typeof policy === "function" ? policy : sliceConsentPolicy;
  const steps = [];
  const sends = typeof sendCount === "function" ? sendCount : () => null;

  async function dispatch(label, source, { tamperScope, deny } = {}) {
    const before = sends();
    const decision = deny === true
      ? { approved: false, reason: "forced denial for gate proof" }
      : await decide({ source });
    if (!decision || decision.approved !== true) {
      steps.push({
        label, source, outcome: "REFUSED-BEFORE-SEND",
        reason: decision?.reason ?? "consent denied",
        sendsBefore: before, sendsAfter: sends(),
      });
      return null;
    }
    let scope = scopeFor(source, pin);
    if (tamperScope === true) {
      // Consent minted for different source: the runner's internal scope
      // check must refuse before transport.send is ever invoked.
      scope = scopeFor(`${source} /* tampered */`, pin);
    }
    const result = await runner.runScript({
      source,
      pin,
      operationId: OPERATION_ID,
      args: null,
      projectIdentity: PROJECT_IDENTITY,
      consent: { scope },
      trustedScriptOptIn: true,
      scriptProvenance: "a8n-transport-slice",
    });
    steps.push({
      label,
      source,
      outcome: result.outcome,
      contractOutcome: result.contractOutcome,
      requestState: result.requestState,
      result: result.result ?? null,
      error: result.error ?? null,
      refusal: result.refusal ?? null,
      sendsBefore: before,
      sendsAfter: sends(),
    });
    return result;
  }

  // 1-2. connect + state reads.
  const versionStep = await dispatch("connect.state", "String(app.version)");
  const itemsStep = await dispatch("project.state", "String(app.project.numItems)");

  // 3. error capture: reference to an undeclared identifier throws inside AE.
  await dispatch("error.capture", "__a8nSliceUndeclaredIdentifier;");

  // 4. fix -> rerun: the same intent, corrected source.
  await dispatch("fix.rerun", "String(app.project.numItems + 0)");

  // 5. session-state verification: $.global persists across dispatches in
  //    one AE session; two increments must read 1 then 2.
  const counter =
    "$.global.__a8nSliceCounter = (typeof $.global.__a8nSliceCounter === 'undefined' ? 0 : $.global.__a8nSliceCounter) + 1; String($.global.__a8nSliceCounter);";
  await dispatch("verify.counter.1", counter);
  await dispatch("verify.counter.2", counter);

  // 6. tampered consent scope: refused before send.
  await dispatch("consent.tampered", "String(app.version)", { tamperScope: true });

  // 7. policy denial: refused before send, no consent token issued.
  await dispatch("consent.denied", "__DENY__ String(app.version)");

  return { steps, pin };
}
