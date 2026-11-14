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
