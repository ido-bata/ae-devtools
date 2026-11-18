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
import { consentScopeFor, evalConsentArgs } from "../trusted-execution/permissions.mjs";

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
    args: evalConsentArgs(source, null),
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

/**
 * assertSliceOutcomes — verifies that a recorded slice actually proved the
 * dev loop, not merely ran. Returns a list of human-readable violations
 * (empty = pass). Value-agnostic: works for the fake host (version
 * "99.9.9-fake") and real AE alike — it asserts outcome classes and state
 * transitions, never host-specific literals.
 *
 * Contract asserted:
 *   connect.state / project.state / fix.rerun / verify.counter.{1,2}
 *     -> COMPLETED, each consuming exactly one transport send
 *   verify.counter results -> "1" then "2" (shared live session state)
 *   error.capture           -> FAILED with a host-reported error name
 *   consent.tampered        -> BLOCKED, sends flat (refused pre-send)
 *   consent.denied          -> REFUSED-BEFORE-SEND, sends flat
 */
export function assertSliceOutcomes(steps) {
  const violations = [];
  const byLabel = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step && typeof step.label === "string" && !byLabel.has(step.label)) {
      byLabel.set(step.label, step);
    }
  }
  const step = (label) => byLabel.get(label);
  const check = (label, ok, detail) => {
    if (!ok) violations.push(`${label}: ${detail}`);
  };
  const sentOnce = (label) => {
    const s = step(label);
    check(label, s !== undefined, "step missing");
    if (s === undefined) return;
    if (typeof s.sendsBefore === "number" && typeof s.sendsAfter === "number") {
      check(label, s.sendsAfter === s.sendsBefore + 1,
        `expected exactly one transport send, saw ${s.sendsBefore} -> ${s.sendsAfter}`);
    }
  };

  for (const label of ["connect.state", "project.state", "fix.rerun",
    "verify.counter.1", "verify.counter.2"]) {
    const s = step(label);
    check(label, s !== undefined, "step missing");
    if (s === undefined) continue;
    check(label, s.outcome === "COMPLETED", `expected COMPLETED, got ${s.outcome}`);
    sentOnce(label);
  }

  const connect = step("connect.state");
  if (connect) {
    check("connect.state", typeof connect.result === "string" && connect.result.length > 0,
      "expected a non-empty version string result");
  }
  const project = step("project.state");
  if (project) {
    check("project.state", /^-?\d+$/.test(String(project.result ?? "")),
      `expected a numeric numItems result, got ${JSON.stringify(project.result)}`);
  }

  const errored = step("error.capture");
  if (errored) {
    check("error.capture", errored.outcome === "FAILED",
      `expected FAILED, got ${errored.outcome}`);
    check("error.capture", typeof errored.error?.name === "string" && errored.error.name.length > 0,
      "expected a host-reported error name");
    sentOnce("error.capture");
  }

  const c1 = step("verify.counter.1");
  const c2 = step("verify.counter.2");
  if (c1) check("verify.counter.1", c1.result === "1", `expected counter "1", got ${JSON.stringify(c1.result)}`);
  if (c2) check("verify.counter.2", c2.result === "2", `expected counter "2", got ${JSON.stringify(c2.result)}`);

  const tampered = step("consent.tampered");
  if (tampered) {
    check("consent.tampered", tampered.outcome === "BLOCKED",
      `expected BLOCKED (consent scope refused pre-send), got ${tampered.outcome}`);
    if (typeof tampered.sendsBefore === "number" && typeof tampered.sendsAfter === "number") {
      check("consent.tampered", tampered.sendsAfter === tampered.sendsBefore,
        `expected no transport send, saw ${tampered.sendsBefore} -> ${tampered.sendsAfter}`);
    }
  }

  const denied = step("consent.denied");
  if (denied) {
    check("consent.denied", denied.outcome === "REFUSED-BEFORE-SEND",
      `expected REFUSED-BEFORE-SEND, got ${denied.outcome}`);
    if (typeof denied.sendsBefore === "number" && typeof denied.sendsAfter === "number") {
      check("consent.denied", denied.sendsAfter === denied.sendsBefore,
        `expected no transport send, saw ${denied.sendsBefore} -> ${denied.sendsAfter}`);
    }
  }

  return violations;
}
