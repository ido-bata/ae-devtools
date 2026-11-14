/**
 * runner tests — the safe-ExtendScript pipeline: consent gate before
 * send, codec envelope, reply identity check, outcome classification,
 * duplicate/UNKNOWN quarantine, host-reported error pass-through.
 * Fake-level only; transport is an injected fake, no AE involved.
 *
 * Regression coverage for the PR #42 re-review findings:
 *   R1 consent must bind the ACTUAL executed source — a consent scope
 *      computed over different args must not authorize this source;
 *   R2 permission:"read" must never reach the eval path (arbitrary code
 *      execution is not a read);
 *   R3 a reply whose requestId does not match the sent request is
 *      unattributable → UNKNOWN, never COMPLETED;
 *   R4 a dispatched requestId is single-use; UNKNOWN outcomes are
 *      quarantined and visible via isQuarantined().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsxRunner, loadTrustedCodec, MAX_SOURCE_BYTES } from "../runner.mjs";
import { consentScopeFor } from "../permissions.mjs";

const codec = loadTrustedCodec();

/**
 * Fake transport. `reply` may be:
 *   - an object → codec.stringify({...reply, requestId: <sent id>})
 *   - a string  → sent verbatim (for unparseable-reply tests)
 *   - null + {hang:true} → never resolves (deadline test)
 * The echoed requestId mirrors the host contract: replies MUST carry the
 * requestId they answer.
 */
function makeTransport(reply, { hang = false, echoRequestId = true } = {}) {
  const calls = [];
  return {
    calls,
    send(text) {
      calls.push(text);
      if (hang) return new Promise(() => {});
      if (typeof reply === "string") return Promise.resolve(reply);
      if (reply == null) return Promise.resolve(null);
      let requestId = null;
      try { requestId = codec.parse(text).requestId; } catch { /* ignore */ }
      const body = echoRequestId && requestId ? { ...reply, requestId } : reply;
      return Promise.resolve(codec.stringify(body));
    },
  };
}

const PIN = { sessionId: "sess-test", aeVersion: "26.5.3", dispatchId: "disp-test" };
const SOURCE = "app.project.items.length";
const REQ = "req-test-1";

function consentFor(source = SOURCE, dispatchArgs = null, scopePin = PIN) {
  return consentScopeFor({
    pin: scopePin,
    operationId: "op.eval",
    args: { source, dispatchArgs },
    projectIdentity: "proj-A",
  });
}

function validInput(source = SOURCE, extra = {}) {
  return {
    source,
    pin: PIN,
    operationId: "op.eval",
    consent: { scope: consentFor(source) },
    projectIdentity: "proj-A",
    trustedScriptOptIn: true,
    scriptProvenance: "test-fixture",
    requestId: REQ,
    ...extra,
  };
}

test("happy path: consent pass → send → COMPLETED with decoded result", async () => {
  const result = { aeRef: { type: "AVLayer", name: "L1", path: [0, 2] } };
  const transport = makeTransport({ ok: true, result });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(r.contractOutcome, "completed");
  assert.equal(r.requestState, "ACKED");
  assert.equal(transport.calls.length, 1);
  // codec.parse runs inside node:vm — result objects are cross-realm, so
  // compare structurally via JSON rather than deepStrictEqual prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(r.result)), result);
  assert.equal(r.requestId, REQ);
});

test("request envelope is codec-serialized with kind/pin/source", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  await runner.runScript(validInput());
  const sent = codec.parse(transport.calls[0]);
  assert.equal(sent.kind, "extendscript.eval");
  assert.equal(sent.v, 1);
  assert.equal(sent.source, SOURCE);
  assert.equal(sent.pin.sessionId, "sess-test");
  assert.equal(sent.pin.dispatchId, "disp-test");
  assert.equal(sent.requestId, REQ);
});

test("missing consent → BLOCKED before send (transport untouched)", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  const input = validInput();
  delete input.consent;
  const r = await runner.runScript(input);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.stage, "consent");
  assert.equal(r.refusal.code, "CONSENT_REQUIRED");
  assert.equal(transport.calls.length, 0);
  assert.equal(r.mayHaveMutated, false);
});

test("missing trustedScriptOptIn → BLOCKED before send", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  const input = validInput();
  input.trustedScriptOptIn = false;
  const r = await runner.runScript(input);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.refusal.code, "CONSENT_REQUIRED");
  assert.equal(transport.calls.length, 0);
});

test("consent scope mismatch → BLOCKED CONSENT_SCOPE_MISMATCH, no send", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  const input = validInput();
  input.consent = { scope: consentFor(SOURCE, null, { sessionId: "sess-OTHER" }) };
  const r = await runner.runScript(input);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.refusal.code, "CONSENT_SCOPE_MISMATCH");
  assert.equal(transport.calls.length, 0);
});

// --- R1: consent must bind the executed source -------------------------

test("R1: consent computed over a different source does not authorize this source", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  // Caller presents consent for "app.project.items.length" but asks to run
  // different code while smuggling matching args — must still refuse.
  const input = validInput("app.project.items.add(null)");
  input.consent = { scope: consentFor(SOURCE) }; // scope binds SOURCE, not the actual source
  const r = await runner.runScript(input);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(transport.calls.length, 0);
});

test("R1: caller-supplied args cannot decouple consent from the executed source", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  const EVIL = "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)";
  // Consent was honestly computed — but over args that omit the source.
  const scope = consentScopeFor({
    pin: PIN, operationId: "op.eval",
    args: { note: "approved read" }, projectIdentity: "proj-A",
  });
  const r = await runner.runScript(validInput(EVIL, {
    consent: { scope },
    args: { note: "approved read" },
  }));
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(transport.calls.length, 0);
});

// --- R2: permission read must not reach eval ----------------------------

test("R2: permission:'read' is refused — eval is never a read", async () => {
  const transport = makeTransport({ ok: true, result: 42 });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput(SOURCE, { permission: "read" }));
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(transport.calls.length, 0);
});

test("R2: permission:'write' is refused — eval class is execute-only", async () => {
  const transport = makeTransport({ ok: true, result: 42 });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput(SOURCE, { permission: "write" }));
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(transport.calls.length, 0);
});

// --- R3: reply identity must match the sent request ---------------------

test("R3: reply with a different requestId is UNKNOWN, not COMPLETED", async () => {
  const transport = makeTransport({ ok: true, result: 1, requestId: "req-SOMEONE-ELSE" }, { echoRequestId: false });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.retry, "quarantine");
});

test("R3: reply without requestId is UNKNOWN (unattributable)", async () => {
  const transport = makeTransport({ ok: true, result: 1 }, { echoRequestId: false });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "UNATTRIBUTABLE_REPLY");
});

// --- R4: duplicate requestId + UNKNOWN quarantine ------------------------

test("R4: reusing a dispatched requestId is BLOCKED before send", async () => {
  const transport = makeTransport({ ok: true, result: 1 });
  const runner = createJsxRunner({ transport, codec });
  const first = await runner.runScript(validInput());
  assert.equal(first.outcome, "COMPLETED");
  const second = await runner.runScript(validInput());
  assert.equal(second.outcome, "BLOCKED");
  assert.equal(second.refusal.code, "DUPLICATE_REQUEST");
  assert.equal(transport.calls.length, 1);
});

test("R4: UNKNOWN outcomes quarantine the requestId; isQuarantined reports it", async () => {
  const transport = makeTransport(null, { hang: true });
  const runner = createJsxRunner({ transport, codec, deadlineMs: 30 });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(runner.isQuarantined(REQ), true);
  assert.equal(runner.isQuarantined("req-never-sent"), false);
});

// --- outcome / error paths ----------------------------------------------

test("host aeError reply → FAILED with host-reported line/file preserved", async () => {
  const aeError = codec.error("EvalError", "boom at line 3", 3, "probe.jsx");
  const transport = makeTransport({ error: aeError });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "FAILED");
  assert.equal(r.contractOutcome, "failed");
  assert.equal(r.error.name, "EvalError");
  assert.equal(r.error.message, "boom at line 3");
  assert.equal(r.error.line, 3);
  assert.equal(r.error.file, "probe.jsx");
  assert.equal(r.error.hostReported, true);
});

test("host refusal reply → REFUSED", async () => {
  const transport = makeTransport({ refusal: { code: "HOST_BUSY", message: "modal open" } });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "REFUSED");
  assert.equal(r.contractOutcome, "refused");
  assert.equal(r.refusal.code, "HOST_BUSY");
});

test("deadline → UNKNOWN, retry quarantine, exactly one send (no resend)", async () => {
  const transport = makeTransport(null, { hang: true });
  const runner = createJsxRunner({ transport, codec, deadlineMs: 30 });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "NO_REPLY_BEFORE_DEADLINE");
  assert.equal(r.mayHaveMutated, true);
  assert.equal(r.retry, "quarantine");
  assert.equal(transport.calls.length, 1);
});

test("unparseable reply → UNKNOWN UNATTRIBUTABLE_REPLY", async () => {
  const transport = makeTransport("this is not json {{{");
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "UNATTRIBUTABLE_REPLY");
  assert.equal(r.retry, "quarantine");
});

test("shape-less reply → UNKNOWN UNATTRIBUTABLE_REPLY", async () => {
  const transport = makeTransport({ surprise: true });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "UNATTRIBUTABLE_REPLY");
});

test("empty source → BLOCKED validate, no consent eval, no send", async () => {
  const transport = makeTransport({ ok: true });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput("   "));
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.stage, "validate");
  assert.equal(r.refusal.code, "EMPTY_SOURCE");
  assert.equal(transport.calls.length, 0);
});

test("oversized source → BLOCKED validate", async () => {
  const transport = makeTransport({ ok: true });
  const runner = createJsxRunner({ transport, codec });
  const big = "x".repeat(MAX_SOURCE_BYTES + 1);
  const r = await runner.runScript(validInput(big));
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.refusal.code, "SOURCE_TOO_LARGE");
  assert.equal(transport.calls.length, 0);
});

test("transport throw → UNKNOWN (indistinguishable from no reply)", async () => {
  const transport = { calls: [], send() { throw new Error("socket reset"); } };
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.retry, "quarantine");
});

test("caller-chosen requestId is preserved on the envelope and result", async () => {
  const transport = makeTransport({ ok: true, result: null });
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput(SOURCE, { requestId: "req-fixed-1" }));
  assert.equal(r.requestId, "req-fixed-1");
  assert.equal(codec.parse(transport.calls[0]).requestId, "req-fixed-1");
});
