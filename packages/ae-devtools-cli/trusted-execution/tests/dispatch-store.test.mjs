/**
 * dispatch-store tests — cross-instance dedup/quarantine (Issue #255).
 *
 * Fake-level only: transports are injected fakes, the store is a real
 * filesystem store in a tmpdir. What is proven:
 *   - dispatch identity is stable per (pin, operation, args, project)
 *     and distinct across any of them;
 *   - an UNKNOWN outcome quarantines the identity for EVERY runner
 *     sharing the store — including a fresh store instance on the same
 *     dir (process-restart simulation);
 *   - completed/failed identities do not block legitimate re-dispatch;
 *   - corrupt records and store I/O failure refuse fail-closed;
 *   - runners without a store keep the pre-#255 instance-local behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsxRunner, loadTrustedCodec } from "../runner.mjs";
import { createDispatchStore, dispatchIdentity, DISPATCH_STORE_SCHEMA } from "../dispatch-store.mjs";
import { consentScopeFor } from "../permissions.mjs";

const codec = loadTrustedCodec();
const PIN = { sessionId: "sess-x", aeVersion: "26.5", dispatchId: "disp-x" };
const SOURCE = "app.project.items.length";

function tmpStore() {
  return mkdtempSync(join(tmpdir(), "dispatch-store-"));
}

function makeTransport(reply) {
  const calls = [];
  return {
    calls,
    send(text) {
      calls.push(text);
      if (reply === null) return Promise.resolve(null); // no reply -> UNKNOWN
      let requestId = null;
      try { requestId = codec.parse(text).requestId; } catch { /* ignore */ }
      return Promise.resolve(codec.stringify({ ...reply, requestId }));
    },
  };
}

function consentFor(source = SOURCE, dispatchArgs = null, pin = PIN) {
  return consentScopeFor({
    pin,
    operationId: "op.eval",
    args: { source, dispatchArgs },
    projectIdentity: "proj-A",
  });
}

function inputFor(source = SOURCE, extra = {}) {
  return {
    source,
    pin: PIN,
    operationId: "op.eval",
    consent: { scope: consentFor(source) },
    projectIdentity: "proj-A",
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    ...extra,
  };
}

const identityOf = (source = SOURCE, extra = {}) =>
  dispatchIdentity({
    pin: extra.pin ?? PIN,
    operationId: extra.operationId ?? "op.eval",
    args: { source, dispatchArgs: extra.args ?? null },
    projectIdentity: extra.projectIdentity ?? "proj-A",
  });

test("dispatchIdentity: stable, and distinct per pin/op/args/project", () => {
  const base = identityOf();
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(identityOf(), base, "same input -> same identity");
  assert.notEqual(identityOf("other source"), base);
  assert.notEqual(identityOf(SOURCE, { args: { x: 1 } }), base);
  assert.notEqual(identityOf(SOURCE, { operationId: "op.other" }), base);
  assert.notEqual(identityOf(SOURCE, { projectIdentity: "proj-B" }), base);
  assert.notEqual(identityOf(SOURCE, { pin: { ...PIN, sessionId: "sess-y" } }), base);
});

test("store lifecycle: in-flight -> settled states gate correctly", async () => {
  const dir = tmpStore();
  try {
    const store = createDispatchStore({ dir });
    const key = identityOf();
    assert.equal((await store.lookup(key)).status, "none");

    const g1 = await store.begin(key, { requestId: "r1" });
    assert.equal(g1.allowed, true);
    // second begin while in-flight -> refused (one in-flight per identity)
    const g2 = await store.begin(key, { requestId: "r2" });
    assert.equal(g2.allowed, false);
    assert.equal(g2.reason, "DISPATCH_UNRESOLVED");

    await store.settle(key, { requestId: "r1", outcome: "UNKNOWN" });
    const g3 = await store.begin(key, { requestId: "r3" });
    assert.equal(g3.allowed, false);
    assert.equal(g3.reason, "DISPATCH_QUARANTINED");

    // explicit resolution is the only way back
    const res = await store.resolve(key, { note: "operator verified host state" });
    assert.equal(res.resolved, true);
    const g4 = await store.begin(key, { requestId: "r4" });
    assert.equal(g4.allowed, true);

    // completed does not block
    await store.settle(key, { requestId: "r4", outcome: "COMPLETED" });
    const g5 = await store.begin(key, { requestId: "r5" });
    assert.equal(g5.allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two runner instances sharing a store: UNKNOWN quarantines across instances", async () => {
  const dir = tmpStore();
  try {
    const storeA = createDispatchStore({ dir });
    const transportA = makeTransport(null); // no reply -> UNKNOWN
    const runnerA = createJsxRunner({ transport: transportA, codec, dispatchStore: storeA });
    const r1 = await runnerA.runScript(inputFor(SOURCE, { requestId: "req-a" }));
    assert.equal(r1.outcome, "UNKNOWN");
    assert.equal(transportA.calls.length, 1);

    // Fresh runner + fresh store instance on the same dir = process
    // restart simulation. Same logical dispatch must be refused BEFORE
    // send — transport B sees zero calls.
    const storeB = createDispatchStore({ dir });
    const transportB = makeTransport({ ok: true, result: "should-not-send" });
    const runnerB = createJsxRunner({ transport: transportB, codec, dispatchStore: storeB });
    const r2 = await runnerB.runScript(inputFor(SOURCE, { requestId: "req-b" }));
    assert.equal(r2.outcome, "BLOCKED");
    assert.equal(r2.refusal.code, "DISPATCH_QUARANTINED");
    assert.equal(transportB.calls.length, 0, "quarantined identity must not reach the host");

    // A distinct identity is unaffected.
    const r3 = await runnerB.runScript(inputFor("app.project.name", { requestId: "req-c" }));
    assert.equal(r3.outcome, "COMPLETED");
    assert.equal(transportB.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completed identity re-dispatches; in-flight residue blocks", async () => {
  const dir = tmpStore();
  try {
    const store = createDispatchStore({ dir });
    const t1 = makeTransport({ ok: true, result: 1 });
    const r1 = createJsxRunner({ transport: t1, codec, dispatchStore: store });
    const ok = await r1.runScript(inputFor(SOURCE, { requestId: "req-1" }));
    assert.equal(ok.outcome, "COMPLETED");

    // same identity, new runner: allowed (completed does not quarantine)
    const t2 = makeTransport({ ok: true, result: 2 });
    const r2 = createJsxRunner({ transport: t2, codec, dispatchStore: createDispatchStore({ dir }) });
    const ok2 = await r2.runScript(inputFor(SOURCE, { requestId: "req-2" }));
    assert.equal(ok2.outcome, "COMPLETED");
    assert.equal(t2.calls.length, 1);

    // simulate crash mid-dispatch: hand-write an in-flight record
    const key = identityOf("crash.source");
    const crashPath = join(dir, `${key}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(crashPath, JSON.stringify({
      schema: DISPATCH_STORE_SCHEMA, key, state: "in-flight",
      requestId: "ghost", operationId: "op.eval", dispatchedAt: new Date().toISOString(),
    }));
    const t3 = makeTransport({ ok: true });
    const r3 = createJsxRunner({ transport: t3, codec, dispatchStore: createDispatchStore({ dir }) });
    const blocked = await r3.runScript(inputFor("crash.source", { requestId: "req-3" }));
    assert.equal(blocked.outcome, "BLOCKED");
    assert.equal(blocked.refusal.code, "DISPATCH_UNRESOLVED");
    assert.equal(t3.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt record refuses fail-closed; store I/O error refuses before send", async () => {
  const dir = tmpStore();
  try {
    const key = identityOf();
    writeFileSync(join(dir, `${key}.json`), "{not json", "utf8");
    const t = makeTransport({ ok: true });
    const runner = createJsxRunner({ transport: t, codec, dispatchStore: createDispatchStore({ dir }) });
    const r = await runner.runScript(inputFor(SOURCE, { requestId: "req-x" }));
    assert.equal(r.outcome, "BLOCKED");
    assert.equal(r.refusal.code, "DISPATCH_STORE_CORRUPT");
    assert.equal(t.calls.length, 0);

    // store whose begin() throws (I/O failure) -> DISPATCH_STORE_ERROR
    const failingStore = {
      begin: async () => { throw new Error("EACCES: store dir unwritable"); },
      settle: async () => { throw new Error("unreachable"); },
    };
    const t2 = makeTransport({ ok: true });
    const runner2 = createJsxRunner({ transport: t2, codec, dispatchStore: failingStore });
    const r2 = await runner2.runScript(inputFor("other.source", { requestId: "req-y" }));
    assert.equal(r2.outcome, "BLOCKED");
    assert.equal(r2.refusal.code, "DISPATCH_STORE_ERROR");
    assert.equal(t2.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no store configured -> pre-#255 instance-local behavior unchanged", async () => {
  const transport = makeTransport(null);
  const runner = createJsxRunner({ transport, codec }); // no dispatchStore
  const r1 = await runner.runScript(inputFor(SOURCE, { requestId: "req-1" }));
  assert.equal(r1.outcome, "UNKNOWN");
  // instance quarantine still applies to the SAME runner...
  const r2 = await runner.runScript(inputFor(SOURCE, { requestId: "req-2" }));
  assert.equal(r2.outcome, "UNKNOWN"); // sent again — different requestId; instance dedup is per-requestId
  assert.equal(transport.calls.length, 2);
  // ...but a second runner instance shares nothing (documented limit)
  const transport2 = makeTransport(null);
  const runner2 = createJsxRunner({ transport: transport2, codec });
  const r3 = await runner2.runScript(inputFor(SOURCE, { requestId: "req-3" }));
  assert.equal(r3.outcome, "UNKNOWN");
  assert.equal(transport2.calls.length, 1, "without a store the second instance re-sends — the documented gap #255 closes when configured");
});

test("transport.dispatchStore is picked up without a runner option", async () => {
  const dir = tmpStore();
  try {
    const store = createDispatchStore({ dir });
    const t1 = makeTransport(null);
    t1.dispatchStore = store;
    const runner = createJsxRunner({ transport: t1, codec });
    const r = await runner.runScript(inputFor(SOURCE, { requestId: "req-t" }));
    assert.equal(r.outcome, "UNKNOWN");
    const t2 = makeTransport({ ok: true });
    t2.dispatchStore = createDispatchStore({ dir });
    const runner2 = createJsxRunner({ transport: t2, codec });
    const r2 = await runner2.runScript(inputFor(SOURCE, { requestId: "req-t2" }));
    assert.equal(r2.refusal?.code, "DISPATCH_QUARANTINED");
    assert.equal(t2.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
