import test from "node:test";
import assert from "node:assert/strict";
import { loadTrustedCodec, createJsxRunner } from "../../trusted-execution/runner.mjs";
import { discover, inspect, execute, verify, sessionStatus } from "../devloop.mjs";
import { createAdapterFakeApp } from "../../scripting-adapters/fake-app.mjs";
import { createFakeHostTransport } from "../../scripting-adapters/fake-host.mjs";

const codec = loadTrustedCodec();
const PIN = { sessionId: "sess-dl", aeVersion: "26.5.3" };

function fixture() {
  const app = createAdapterFakeApp();
  const transport = createFakeHostTransport({ app, codec });
  const runner = createJsxRunner({ transport, codec });
  const consentProvider = async () => ({ approved: true });
  const base = { runner, pin: PIN, projectIdentity: "p", consentProvider,
    trustedScriptOptIn: true, scriptProvenance: "devloop-test" };
  return { app, transport, ...base };
}

test("discover lists ops with honest metadata; unimplemented members not executable", () => {
  const d = discover();
  // Assert internal consistency, not a pinned count — the registry owns
  // the size and grows legitimately.
  assert.equal(d.operationCount, d.operations.length);
  assert.ok(d.operations.every((o) => typeof o.id === "string"));
  assert.equal(new Set(d.operations.map((o) => o.id)).size, d.operations.length);
  assert.equal(d.evidence.realHostVerified, 0);
  const d16 = discover({ domain: "animation-effects-render" });
  assert.equal(d16.operationCount,
    d.operations.filter((o) => o.domain === "animation-effects-render").length);
});

test("inspect returns schema without executing; unknown op reported", () => {
  const i = inspect("item.addComp");
  assert.equal(i.status, "ok");
  assert.ok(i.op.members.length > 0);
  assert.equal(inspect("no.such").status, "unknown-operation");
});

test("discover/inspect hand out copies — mutating results cannot corrupt the registry", () => {
  const d = discover();
  const target = d.operations.find((o) => o.id === "item.addComp");
  target.args.push("__mutated__");
  const again = discover();
  assert.ok(!again.operations.find((o) => o.id === "item.addComp").args.includes("__mutated__"));

  const i = inspect("item.addComp");
  i.op.members.length = 0;
  i.op.args.push("__mutated__");
  const i2 = inspect("item.addComp");
  assert.ok(i2.op.members.length > 0);
  assert.ok(!i2.op.args.includes("__mutated__"));
});

test("sessionStatus reports honest state without opening anything (CAP049)", () => {
  const closed = sessionStatus({ sessionKind: "fake" });
  assert.equal(closed.session.state, "closed");
  assert.equal(closed.session.kind, "fake");
  assert.equal(closed.session.evidenceLevel, undefined);
  assert.equal(closed.session.pin, undefined);

  const opening = sessionStatus({ sessionKind: "a8n", opening: true });
  assert.equal(opening.session.state, "opening");
  assert.equal(opening.session.kind, "a8n");

  const failed = sessionStatus({ sessionKind: "fake", failed: true });
  assert.equal(failed.session.state, "failed");

  const open = sessionStatus({
    session: { kind: "fake", evidenceLevel: "fake/mock only", pin: { sessionId: "s" } },
  });
  assert.equal(open.session.state, "open");
  assert.equal(open.session.evidenceLevel, "fake/mock only");
  assert.deepEqual(open.session.pin, { sessionId: "s" });
  // Fake sessions carry no host meta — host stays null, never fabricated.
  assert.equal(open.session.host, null);
  assert.equal(open.api.devLoop, "ae-devtools.dev-loop/v1");

  // CAP049 version-aware metadata: only opener-attested values surface.
  const attached = sessionStatus({
    session: {
      kind: "a8n-attached",
      evidenceLevel: "verified on real host (attach to a running AE)",
      pin: { sessionId: "a" },
      meta: {
        aeVersion: "27.0x78",
        ownership: "attached",
        aeA8nHead: "c104e39",
        attached: true,
        target: {
          identity: { pid: 56305 },
          projectFile: "/tmp/probe.aep",
          attachApi: "AfterEffects.attach",
        },
      },
    },
  });
  assert.equal(attached.session.host.aeVersion, "27.0x78");
  assert.equal(attached.session.host.ownership, "attached");
  assert.equal(attached.session.host.attached, true);
  assert.deepEqual(attached.session.host.target, {
    pid: 56305,
    projectFile: "/tmp/probe.aep",
    attachApi: "AfterEffects.attach",
  });
  // Closed/failed states never fabricate host identity.
  assert.equal(closed.api.devLoop, "ae-devtools.dev-loop/v1");
  assert.equal(closed.session.host, undefined);
});

test("developer-loop vertical: discover→inspect→execute→verify", async () => {
  const f = fixture();
  assert.equal(inspect("project.new").status, "ok");
  const r1 = await execute({ opId: "project.new", args: {}, confirmDestructive: true, ...f });
  assert.equal(r1.outcome, "COMPLETED");
  const r2 = await execute({ opId: "item.addComp",
    args: { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30 }, ...f });
  assert.equal(r2.outcome, "COMPLETED");
  // verify reads back real fake state through the runner — not inferred
  const v = await verify({ ...f });
  assert.equal(v.outcome, "COMPLETED");
  assert.equal(v.result.count, 1);
  assert.equal(v.result.items[0].name, "C");
});

test("verify refuses mutating ops as read-backs", async () => {
  const f = fixture();
  const v = await verify({ ...f, readOpId: "item.addComp" });
  assert.equal(v.status, "refused");
  assert.equal(v.stage, "adapter");
  assert.equal(v.reason, "VERIFY_REQUIRES_READ_OP");
  assert.match(v.detail, /mutating/);
});

test("verify refuses an unregistered readOpId (unknown op branch)", async () => {
  const f = fixture();
  const v = await verify({ ...f, readOpId: "no.such.op" });
  assert.equal(v.status, "refused");
  assert.equal(v.reason, "VERIFY_REQUIRES_READ_OP");
  assert.match(v.detail, /not a registered operation/);
});

test("execute/verify on null input produce structured refusals, not TypeErrors", async () => {
  const e = await execute(null);
  assert.equal(e.status, "refused");
  assert.equal(e.reason, "UNKNOWN_OPERATION");
  const v = await verify(null);
  // null input → default read op → reaches runOperation, which refuses
  // on the missing runner — still a structured refusal, never a throw.
  assert.equal(v.status, "refused");
  assert.equal(typeof v.reason, "string");
});

test("verify forwards consentAudit — verify dispatches record consent decisions (Issue #403)", async () => {
  const f = fixture();
  const entries = [];
  const consentAudit = {
    recordConsentDecision(entry) { entries.push(entry); },
  };
  const v = await verify({ ...f, consentAudit, requestId: "req-verify-1" });
  assert.equal(v.outcome, "COMPLETED");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].decision, "approved");
  assert.equal(entries[0].opId, "read.projectSummary");
  assert.equal(entries[0].requestId, "req-verify-1");
  assert.equal(entries[0].mutating, false);
});

test("verify surfaces a malformed consentAudit as CONSENT_AUDIT_INVALID (Issue #403)", async () => {
  const f = fixture();
  const v = await verify({ ...f, consentAudit: { bogus: true } });
  assert.equal(v.status, "refused");
  assert.equal(v.reason, "CONSENT_AUDIT_INVALID");
});

test("execute adds no approval path: denial still refuses before transport", async () => {
  const f = fixture();
  const origSend = f.transport.send.bind(f.transport);
  let sent = 0;
  f.transport.send = (t) => { sent++; return origSend(t); };
  const r = await execute({ ...f, opId: "item.addFolder", args: { name: "X" },
    consentProvider: async () => ({ approved: false }) });
  assert.equal(r.stage, "consent");
  assert.equal(sent, 0);
});
