/**
 * transport tests — createA8nTransport against a fake `ae`. Covers
 * envelope decode, host-result -> trusted-codec reply mapping, the
 * proved-not-sent / timeout / pin-mismatch boundaries. Fake-level only;
 * no AE involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createA8nTransport, EVAL_METHOD } from "../transport.mjs";
import { loadTrustedCodec } from "../../trusted-execution/runner.mjs";
import { createFakeAe, namedError } from "./fake-ae.mjs";

const codec = loadTrustedCodec();
const PIN_VERSION = "99.9.9-fake";

function envelope(overrides = {}) {
  return codec.stringify({
    v: 1,
    kind: "extendscript.eval",
    requestId: "req-t1",
    operationId: "op.eval",
    pin: { sessionId: "s", aeVersion: PIN_VERSION, dispatchId: "d" },
    source: "String(app.version)",
    ...overrides,
  });
}

test("happy path: source dispatched via ae.call, ok reply echoes requestId and result", async () => {
  const ae = createFakeAe();
  const t = createA8nTransport({ ae });
  const replyText = await t.send(envelope());
  assert.equal(ae.calls.length, 1);
  assert.equal(ae.calls[0].name, EVAL_METHOD);
  assert.equal(ae.calls[0].params.source, "String(app.version)");
  assert.equal(ae.calls[0].params.requestId, "req-t1");
  assert.equal(typeof ae.calls[0].options.timeoutMs, "number");
  const reply = codec.parse(replyText);
  assert.equal(reply.requestId, "req-t1");
  assert.equal(reply.ok, true);
  assert.equal(reply.result, PIN_VERSION);
});

test("host evalError maps to error.aeError reply (FAILED shape)", async () => {
  const ae = createFakeAe();
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope({ source: "__missing;" })));
  assert.equal(reply.requestId, "req-t1");
  assert.equal(reply.ok, undefined);
  assert.equal(reply.error.aeError.name, "ReferenceError");
});

test("TimeoutError from ae.call returns null (UNKNOWN, never resent)", async () => {
  const ae = createFakeAe({ fail: () => namedError("TimeoutError", "did not answer") });
  const t = createA8nTransport({ ae });
  assert.equal(await t.send(envelope()), null);
});

test("ScriptNotSentError maps to refusal reply (proved non-dispatch)", async () => {
  const ae = createFakeAe({ fail: () => namedError("ScriptNotSentError", "never invoked") });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "ScriptNotSentError");
});

test("HostNotOwnedError maps to refusal, not error", async () => {
  const ae = createFakeAe({ fail: () => namedError("HostNotOwnedError", "attached host") });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "HostNotOwnedError");
});

test("generic host error maps to error.aeError reply", async () => {
  const ae = createFakeAe({ fail: () => namedError("HostError", "ae said no") });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.error.aeError.name, "HostError");
  assert.match(reply.error.aeError.message, /ae said no/);
});

test("pin aeVersion mismatch refuses before ae.call", async () => {
  const ae = createFakeAe({ version: "26.5.3" });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "SESSION_PIN_MISMATCH");
  assert.equal(ae.calls.length, 0);
});

test("pin aeVersion unverifiable refuses before ae.call (fail-closed, Issue #219)", async () => {
  const ae = createFakeAe();
  ae.info = () => { throw new Error("probe unavailable"); };
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "SESSION_PIN_UNVERIFIED");
  // requestId echo is load-bearing: runner.mjs classifies a refusal
  // without it as UNKNOWN/UNATTRIBUTABLE_REPLY (mayHaveMutated) instead
  // of REFUSED — pin that distinction here (Issue #248).
  assert.equal(reply.requestId, "req-t1");
  assert.equal(ae.calls.length, 0);
});

test("pin unverifiable covers missing info, non-string and empty live version (Issue #248)", async () => {
  const noInfo = createFakeAe();
  delete noInfo.info;
  const t1 = createA8nTransport({ ae: noInfo });
  const refused = codec.parse(await t1.send(envelope()));
  assert.equal(refused.refusal.code, "SESSION_PIN_UNVERIFIED");
  assert.equal(noInfo.calls.length, 0);

  const nonString = createFakeAe();
  nonString.info = () => ({ version: 26 });
  const t2 = createA8nTransport({ ae: nonString });
  const refused2 = codec.parse(await t2.send(envelope()));
  assert.equal(refused2.refusal.code, "SESSION_PIN_UNVERIFIED");
  assert.equal(nonString.calls.length, 0);

  const emptyVersion = createFakeAe({ version: "" });
  const t3 = createA8nTransport({ ae: emptyVersion });
  const refused3 = codec.parse(await t3.send(envelope()));
  assert.equal(refused3.refusal.code, "SESSION_PIN_UNVERIFIED");
  assert.equal(emptyVersion.calls.length, 0);
});

test("versionless pin refuses before ae.call — no drift check is not a pass (Issue #248)", async () => {
  const ae = createFakeAe({ version: PIN_VERSION });
  const t = createA8nTransport({ ae });
  for (const pin of [
    { sessionId: "s", dispatchId: "d" },          // no aeVersion key
    { sessionId: "s", aeVersion: null, dispatchId: "d" },
    { sessionId: "s", aeVersion: "", dispatchId: "d" },
  ]) {
    const reply = codec.parse(await t.send(envelope({ pin })));
    assert.equal(reply.refusal.code, "SESSION_PIN_UNVERIFIED", JSON.stringify(pin));
  }
  assert.equal(ae.calls.length, 0);
});

test("pin match dispatches; absent pin skips the check", async () => {
  const ae = createFakeAe({ version: "26.5.3" });
  const t = createA8nTransport({ ae });
  const pinned = codec.parse(await t.send(envelope({
    pin: { sessionId: "s", aeVersion: "26.5.3", dispatchId: "d" },
  })));
  assert.equal(pinned.ok, true);
  const noPin = codec.parse(await t.send(envelope({ pin: null })));
  assert.equal(noPin.ok, true);
  assert.equal(ae.calls.length, 2);
});

test("unparseable request text returns null", async () => {
  const ae = createFakeAe();
  const t = createA8nTransport({ ae });
  assert.equal(await t.send("not json"), null);
  assert.equal(ae.calls.length, 0);
});

test("envelope without string source returns an error reply", async () => {
  const ae = createFakeAe();
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope({ source: 42 })));
  assert.equal(reply.error.aeError.name, "TransportError");
  assert.equal(ae.calls.length, 0);
});

test("non-object host result returns an error reply", async () => {
  const ae = {
    info: () => ({ version: PIN_VERSION }),
    async call() { return "garbage"; },
  };
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.error.aeError.name, "TransportError");
});

test("valueText fallback used when resultJson absent", async () => {
  const ae = {
    info: () => ({ version: PIN_VERSION }),
    async call(name, params) {
      return { requestId: params.requestId, ok: true, valueText: "42", valueType: "number" };
    },
  };
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.ok, true);
  assert.equal(reply.result, "42");
});

// --- cause-chain classification (real ae-a8n wraps errors in AfterEffectsError) ---

function wrappedError(name, message, causeName, extra = {}) {
  const inner = namedError(causeName, `${causeName} detail`);
  Object.assign(inner, extra);
  const outer = new Error(`${name}: ${message}`);
  outer.name = name;
  outer.cause = inner;
  return outer;
}

test("TimeoutError inside an AfterEffectsError cause chain returns null (UNKNOWN)", async () => {
  const ae = createFakeAe({
    fail: () => wrappedError("AfterEffectsError", "op failed", "TimeoutError"),
  });
  const t = createA8nTransport({ ae });
  assert.equal(await t.send(envelope()), null);
});

test("ScriptNotSentError inside a cause chain maps to refusal", async () => {
  const ae = createFakeAe({
    fail: () => wrappedError("AfterEffectsError", "op was not sent", "ScriptNotSentError"),
  });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "ScriptNotSentError");
});

test("MacSessionError inside a cause chain maps to refusal (pre-send)", async () => {
  const ae = createFakeAe({
    fail: () => wrappedError("AfterEffectsError", "no session", "MacSessionError"),
  });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "MacSessionError");
});

test("ScriptInvocationError returns null (UNKNOWN — delivery unconfirmed)", async () => {
  const ae = createFakeAe({
    fail: () => wrappedError("AfterEffectsError", "osascript failed", "ScriptInvocationError"),
  });
  const t = createA8nTransport({ ae });
  assert.equal(await t.send(envelope()), null);
});

test("ScriptInvocationError with -1743 maps to refusal (event denied, proved non-dispatch)", async () => {
  const inner = namedError("ScriptInvocationError", "osascript exited 1: -1743 event not permitted");
  inner.stderr = "execution error: Not authorized to send Apple events to After Effects. (-1743)";
  const outer = new Error("wrapped");
  outer.name = "AfterEffectsError";
  outer.cause = inner;
  const ae = createFakeAe({ fail: () => outer });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.refusal.code, "ScriptNotSentError");
});

test("host-reported failure inside a cause chain maps to FAILED with the AE error name", async () => {
  const hostError = namedError("ReferenceError", "x is undefined");
  hostError.line = 3;
  hostError.aeError = -2700;
  hostError.kind = "runtime";
  const outer = new Error("extension.call failed in After Effects");
  outer.name = "AfterEffectsError";
  outer.cause = hostError;
  const ae = createFakeAe({ fail: () => outer });
  const t = createA8nTransport({ ae });
  const reply = codec.parse(await t.send(envelope()));
  assert.equal(reply.error.aeError.name, "ReferenceError");
  assert.equal(reply.error.aeError.line, 3);
});

test("host result echoing a different requestId returns null (unattributable)", async () => {
  const ae = {
    info: () => ({ version: PIN_VERSION }),
    async call(name, params) {
      return { requestId: "req-other", ok: true, resultJson: '"pwned"' };
    },
  };
  const t = createA8nTransport({ ae });
  assert.equal(await t.send(envelope()), null);
});

test("host result missing requestId returns null (unattributable)", async () => {
  const ae = {
    info: () => ({ version: PIN_VERSION }),
    async call() {
      return { ok: true, resultJson: '"x"' };
    },
  };
  const t = createA8nTransport({ ae });
  assert.equal(await t.send(envelope()), null);
});
