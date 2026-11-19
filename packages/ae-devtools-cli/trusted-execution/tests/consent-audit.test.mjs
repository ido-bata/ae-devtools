import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { loadTrustedCodec, createJsxRunner } from "../runner.mjs";
import { createConsentAudit, readConsentAuditFile, scopeFingerprint, CONSENT_AUDIT_SCHEMA } from "../consent-audit.mjs";
import { dispatchIdentity } from "../dispatch-store.mjs";
import { consentScopeFor, evalConsentArgs } from "../permissions.mjs";
import { runOperation } from "../../scripting-adapters/execute.mjs";
import { createAdapterFakeApp } from "../../scripting-adapters/fake-app.mjs";
import { fakeHostContext } from "../../scripting-adapters/fake-host.mjs";

const codec = loadTrustedCodec();
const PIN = { sessionId: "sess-audit", aeVersion: "26.5.3", dispatchId: "disp-a" };
const PROJECT = "proj-A";

function tmpdir_() { return mkdtempSync(join(tmpdir(), "consent-audit-")); }

function makeHostTransport(app) {
  return {
    send(text) {
      const env = codec.parse(text);
      const ctx = vm.createContext(fakeHostContext(app));
      try {
        const result = vm.runInContext("(function(){\n" + env.source + "\n})()", ctx);
        return Promise.resolve(codec.stringify({ ok: true, result, requestId: env.requestId }));
      } catch (err) {
        return Promise.resolve(codec.stringify({
          ok: false,
          error: { name: err?.name ?? "Error", message: String(err?.message ?? err) },
          requestId: env.requestId,
        }));
      }
    },
  };
}

function baseInput(app, audit, extra = {}) {
  const transport = makeHostTransport(app);
  const runner = createJsxRunner({ transport, codec });
  return {
    runner, pin: PIN, projectIdentity: PROJECT,
    trustedScriptOptIn: true, scriptProvenance: "audit-test",
    consentAudit: audit, ...extra,
  };
}

test("approved decision is durably recorded and correlates with dispatch", async () => {
  const dir = tmpdir_();
  const audit = createConsentAudit({ dir });
  const app = createAdapterFakeApp();
  const transport = makeHostTransport(app);
  const runner = createJsxRunner({ transport, codec });
  const r = await runOperation({
    opId: "read.projectSummary", args: {},
    runner, pin: PIN, projectIdentity: PROJECT,
    consentProvider: async () => ({ approved: true }),
    consentAudit: audit, requestId: "req-audit-1",
    trustedScriptOptIn: true, scriptProvenance: "audit-test",
  });
  assert.equal(r.outcome, "COMPLETED");
  const records = audit.readConsentDecisions();
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.schema, CONSENT_AUDIT_SCHEMA);
  assert.equal(rec.decision, "approved");
  assert.equal(rec.opId, "read.projectSummary");
  assert.equal(rec.requestId, "req-audit-1");
  assert.match(rec.scopeHash, /^[0-9a-f]{64}$/);
  assert.match(rec.dispatchKey, /^[0-9a-f]{64}$/);
  // dispatchKey must equal the identity the dispatch-store would use
  // for the same dispatch (correlation across the two audit surfaces).
  const { buildSource } = await import("../../scripting-adapters/registry.mjs");
  const realKey = dispatchIdentity({
    pin: PIN, operationId: "read.projectSummary",
    args: evalConsentArgs(buildSource("read.projectSummary", {}), {}),
    projectIdentity: PROJECT,
  });
  assert.equal(rec.dispatchKey, realKey);
  // Minimal-fields contract: no source/args/reason/operator identity.
  const raw = JSON.stringify(rec);
  assert.ok(!raw.includes("app.project"), "audit must not contain script source");
  assert.ok(!("reason" in rec), "free-text provider reason must not be stored");
  assert.ok(!("operator" in rec) && !("user" in rec), "no fabricated operator identity");
});

test("refused decision is recorded; pre-consent refusals produce NO audit event", async () => {
  const dir = tmpdir_();
  const audit = createConsentAudit({ dir });
  const app = createAdapterFakeApp();
  const t = baseInput(app, audit);

  // consentProvider denies → refused decision IS audited.
  const denied = await runOperation({
    opId: "item.addComp",
    args: { name: "C", width: 1, height: 1, pixelAspect: 1, duration: 1, frameRate: 30 },
    consentProvider: async () => ({ approved: false, reason: "operator said no — secret reason text" }),
    ...t,
  });
  assert.equal(denied.reason, "CONSENT_DENIED");
  let records = audit.readConsentDecisions();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "refused");
  assert.ok(!JSON.stringify(records[0]).includes("secret reason"), "provider reason text must not leak into audit");

  // Pre-consent refusals: no decision occurred → no audit event.
  await runOperation({ opId: "no.such.op", args: {}, consentProvider: async () => ({ approved: true }), ...t });
  await runOperation({
    opId: "item.addComp",
    args: { name: "C" }, // missing required args
    consentProvider: async () => ({ approved: true }), ...t,
  });
  await runOperation({
    opId: "project.close", args: {},
    consentProvider: async () => ({ approved: true }), ...t, // destructive gate fires before provider
  });
  await runOperation({
    opId: "read.projectSummary", args: {},
    consentProvider: async () => ({ approved: true }), ...t,
    consentAudit: { bogus: true }, // malformed audit sink
  });
  records = audit.readConsentDecisions();
  assert.equal(records.length, 1, "only the real consent decision may be audited");
});

test("approved-path audit failure refuses pre-dispatch (fail closed, nothing sent)", async () => {
  const dir = tmpdir_();
  const failingAudit = {
    recordConsentDecision() { throw new Error("disk full"); },
  };
  const app = createAdapterFakeApp();
  const transport = makeHostTransport(app);
  const runner = createJsxRunner({ transport, codec });
  let sent = 0;
  const counting = { send: (t) => { sent++; return transport.send(t); } };
  const runner2 = createJsxRunner({ transport: counting, codec });
  void runner;
  const r = await runOperation({
    opId: "read.projectSummary", args: {},
    runner: runner2, pin: PIN, projectIdentity: PROJECT,
    consentProvider: async () => ({ approved: true }),
    consentAudit: failingAudit,
    trustedScriptOptIn: true, scriptProvenance: "audit-test",
  });
  assert.equal(r.reason, "CONSENT_AUDIT_UNAVAILABLE");
  assert.equal(r.status, "refused");
  assert.equal(sent, 0, "no dispatch may leave the process when approval audit fails");
});

test("refused-path audit failure still returns the consent refusal, honestly marked", async () => {
  const failingAudit = { recordConsentDecision() { throw new Error("read-only fs"); } };
  const app = createAdapterFakeApp();
  const t = baseInput(app, failingAudit);
  const r = await runOperation({
    opId: "read.projectSummary", args: {},
    consentProvider: async () => ({ approved: false, reason: "no" }),
    ...t,
  });
  assert.equal(r.reason, "CONSENT_DENIED");
  assert.equal(r.consentAudit.recorded, false);
  assert.match(r.consentAudit.error, /read-only fs/);
});

test("append-only: restart keeps history; concurrent records never interleave or vanish", async () => {
  const dir = tmpdir_();
  const audit1 = createConsentAudit({ dir });
  const fp = scopeFingerprint(consentScopeFor({ pin: PIN, operationId: "op.x", args: {}, projectIdentity: PROJECT }));
  const key = "a".repeat(64);
  for (let i = 0; i < 3; i++) {
    audit1.recordConsentDecision({ decision: i % 2 ? "refused" : "approved", opId: "op.x", scopeHash: fp, dispatchKey: key, requestId: `r${i}` });
  }
  // "Restart": a fresh store instance over the same dir sees all events.
  const audit2 = createConsentAudit({ dir });
  assert.equal(audit2.readConsentDecisions().length, 3);
  // Concurrent appends: every event survives intact as its own line.
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    Promise.resolve().then(() => audit2.recordConsentDecision({
      decision: "approved", opId: "op.x", scopeHash: fp, dispatchKey: key, requestId: `c${i}`,
    }))));
  const records = readConsentAuditFile(audit2.file);
  assert.equal(records.length, 23);
  assert.equal(new Set(records.map((r) => r.requestId)).size, 23, "no event lost or duplicated");
});

test("entry validation rejects malformed records; corrupt file is loud, not silent", async () => {
  const dir = tmpdir_();
  const audit = createConsentAudit({ dir });
  assert.throws(() => audit.recordConsentDecision({ decision: "maybe", opId: "x", scopeHash: "a".repeat(64) }), /decision/);
  assert.throws(() => audit.recordConsentDecision({ decision: "approved", opId: "", scopeHash: "a".repeat(64) }), /opId/);
  assert.throws(() => audit.recordConsentDecision({ decision: "approved", opId: "x", scopeHash: "nothex" }), /scopeHash/);
  audit.recordConsentDecision({ decision: "approved", opId: "x", scopeHash: "b".repeat(64) });
  // Corrupt the file: reader must throw, never return a partial "clean" log.
  writeFileSync(audit.file, '{"schema":"ae-devtools.consent-audit/v1","decision":"approved"\n');
  assert.throws(() => audit.readConsentDecisions(), /corrupt record/);
});

test("scopeFingerprint is stable across key order and binds scope contents", () => {
  const a = consentScopeFor({ pin: PIN, operationId: "op.x", args: { b: 1, a: 2 }, projectIdentity: PROJECT });
  const b = consentScopeFor({ pin: PIN, operationId: "op.x", args: { a: 2, b: 1 }, projectIdentity: PROJECT });
  assert.equal(scopeFingerprint(a), scopeFingerprint(b));
  const c = consentScopeFor({ pin: PIN, operationId: "op.y", args: { a: 2, b: 1 }, projectIdentity: PROJECT });
  assert.notEqual(scopeFingerprint(a), scopeFingerprint(c));
});

test("UNKNOWN outcome still leaves its approved audit event (decision ≠ result)", async () => {
  const dir = tmpdir_();
  const audit = createConsentAudit({ dir });
  const app = createAdapterFakeApp();
  // Transport that never replies → runner deadline → UNKNOWN.
  const hanging = { send: () => new Promise(() => {}) };
  const runner = createJsxRunner({ transport: hanging, codec, deadlineMs: 30 });
  const r = await runOperation({
    opId: "read.projectSummary", args: {},
    runner, pin: PIN, projectIdentity: PROJECT,
    consentProvider: async () => ({ approved: true }),
    consentAudit: audit, requestId: "req-unknown-1",
    trustedScriptOptIn: true, scriptProvenance: "audit-test",
  });
  assert.equal(r.outcome, "UNKNOWN");
  const records = audit.readConsentDecisions();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "approved");
  assert.equal(records[0].requestId, "req-unknown-1");
});

