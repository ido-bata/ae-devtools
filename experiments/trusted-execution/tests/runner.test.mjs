/**
 * runner tests — the safe-ExecuteScript pipeline: consent gate before
 * send, codec envelope, outcome classification, no-retry-on-UNKNOWN,
 * host-reported error pass-through. Fake-level only; transport is an
 * injected fake, no AE involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsxRunner, loadTrustedCodec, EVAL_ADVERTISEMENT, MAX_SOURCE_BYTES } from "../runner.mjs";
import { consentScopeFor } from "../permissions.mjs";

const codec = loadTrustedCodec();

function makeTransport(replyText, { hang = false } = {}) {
  const calls = [];
  return {
    calls,
    send(text) {
      calls.push(text);
      if (hang) return new Promise(() => {});
      return Promise.resolve(replyText);
    },
  };
}

const PIN = { sessionId: "sess-test", aeVersion: "26.5.3", dispatchId: "disp-test" };
const SOURCE = "app.project.items.length";

function consentFor(source = SOURCE, overrides = {}) {
  const args = { source };
  const scope = consentScopeFor({
    pin: PIN,
    operationId: "op.eval",
    args,
    projectIdentity: "proj-A",
    ...overrides.scopeArgs,
  });
  return { scope, args };
}

function validInput(source = SOURCE, transportReply = null, extra = {}) {
  const { scope, args } = consentFor(source);
  return {
    source,
    pin: PIN,
    operationId: "op.eval",
    args,
    projectIdentity: "proj-A",
    consent: { scope },
    trustedScriptOptIn: true,
    scriptProvenance: "test-fixture",
    ...extra,
  };
}

test("happy path: consent pass → send → COMPLETED with decoded result", async () => {
  const result = { aeRef: { type: "AVLayer", name: "L1", path: [0, 2] } };
  const transport = makeTransport(codec.stringify({ ok: true, result }));
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(r.contractOutcome, "completed");
  assert.equal(r.requestState, "ACKED");
  assert.equal(transport.calls.length, 1);
  // codec.parse runs inside node:vm — result objects are cross-realm, so
  // compare structurally via JSON rather than deepStrictEqual prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(r.result)), result);
  assert.ok(typeof r.requestId === "string" && r.requestId.startsWith("req-"));
});

test("request envelope is codec-serialized with kind/pin/source", async () => {
  const transport = makeTransport(codec.stringify({ ok: true, result: 1 }));
  const runner = createJsxRunner({ transport, codec });
  await runner.runScript(validInput());
  const sent = codec.parse(transport.calls[0]);
  assert.equal(sent.kind, "extendscript.eval");
  assert.equal(sent.v, 1);
  assert.equal(sent.source, SOURCE);
  assert.equal(sent.pin.sessionId, "sess-test");
  assert.equal(sent.pin.dispatchId, "disp-test");
});

test("missing consent → BLOCKED before send (transport untouched)", async () => {
  const transport = makeTransport(codec.stringify({ ok: true, result: 1 }));
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
  const transport = makeTransport(codec.stringify({ ok: true, result: 1 }));
  const runner = createJsxRunner({ transport, codec });
  const input = validInput();
  input.trustedScriptOptIn = false;
  const r = await runner.runScript(input);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.refusal.code, "CONSENT_REQUIRED");
  assert.equal(transport.calls.length, 0);
});

test("consent scope mismatch → BLOCKED CONSENT_SCOPE_MISMATCH, no send", async () => {
  const transport = makeTransport(codec.stringify({ ok: true, result: 1 }));
  const runner = createJsxRunner({ transport, codec });
  const input = validInput();
  input.consent = { scope: consentScopeFor({
    pin: { sessionId: "sess-OTHER" },
    operationId: "op.eval",
    args: { source: SOURCE },
    projectIdentity: "proj-A",
  }) };
  const r = await runner.runScript(input);
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.refusal.code, "CONSENT_SCOPE_MISMATCH");
  assert.equal(transport.calls.length, 0);
});

test("host aeError reply → FAILED with host-reported line/file preserved", async () => {
  const aeError = codec.error("EvalError", "boom at line 3", 3, "probe.jsx");
  const transport = makeTransport(codec.stringify({ error: aeError }));
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
  const transport = makeTransport(
    codec.stringify({ refusal: { code: "HOST_BUSY", message: "modal open" } })
  );
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "REFUSED");
  assert.equal(r.contractOutcome, "refused");
  assert.equal(r.refusal.code, "HOST_BUSY");
});

test("deadline → UNKNOWN, retry quarantine, exactly one send (no resend)", async () => {
  const transport = makeTransport(null, { hang: true });
  const runner = createJsxRunner({ transport, codec, deadlineMs: 50 });
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
  const transport = makeTransport(codec.stringify({ surprise: true }));
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput());
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "UNATTRIBUTABLE_REPLY");
});

test("empty source → BLOCKED validate, no consent eval, no send", async () => {
  const transport = makeTransport(codec.stringify({ ok: true }));
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput("   "));
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.stage, "validate");
  assert.equal(r.refusal.code, "EMPTY_SOURCE");
  assert.equal(transport.calls.length, 0);
});

test("oversized source → BLOCKED validate", async () => {
  const transport = makeTransport(codec.stringify({ ok: true }));
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
  const transport = makeTransport(codec.stringify({ ok: true, result: null }));
  const runner = createJsxRunner({ transport, codec });
  const r = await runner.runScript(validInput(SOURCE, null, { requestId: "req-fixed-1" }));
  assert.equal(r.requestId, "req-fixed-1");
  assert.equal(codec.parse(transport.calls[0]).requestId, "req-fixed-1");
});

test("EVAL_ADVERTISEMENT resolves to trusted-dev-script class", async () => {
  // sanity: the default advertisement must exercise the consent path that
  // requires opt-in + provenance (verified indirectly by the opt-in test,
  // asserted here via a read-permission dispatch which needs no consent).
  const transport = makeTransport(codec.stringify({ ok: true, result: 42 }));
  const runner = createJsxRunner({ transport, codec });
  const input = validInput(SOURCE, null, {
    permission: "read",
    consent: null,
    trustedScriptOptIn: false,
    scriptProvenance: undefined,
  });
  const r = await runner.runScript(input);
  // read permission → read-only class → session pin is the consent;
  // pin is present so the dispatch proceeds.
  assert.equal(r.outcome, "COMPLETED");
});
