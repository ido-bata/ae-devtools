/**
 * permissions tests — CAP025/CAP027 groundwork: class resolution, consent
 * scope binding, and fail-closed refusal. Fake-level only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_CLASSES,
  CONSENT_REQUIREMENT,
  argumentHash,
  canonicalJson,
  consentScopeFor,
  executionClassFor,
  authorizeExecution,
} from "../permissions.mjs";

const PIN = { sessionId: "sess-1", aeVersion: "27.0.0", dispatchId: "disp-1" };

const ROWS = {
  readRow: {
    access: "read",
    risk: { trust: "read-only" },
    execution: { class: "extendscript" },
  },
  writeRow: {
    access: "write",
    risk: { trust: "named-operation" },
    execution: { class: "extendscript" },
  },
  rwRow: {
    access: "read-write",
    risk: { trust: "named-operation" },
    execution: { class: "extendscript" },
  },
  devScriptRow: {
    access: "execute",
    risk: { trust: "privileged-dev-code" },
    execution: { class: "extendscript" },
  },
  nativeRow: {
    access: "execute",
    risk: { trust: "native-plugin" },
    execution: { class: "aegp-native" },
  },
};

function consentFor(overrides = {}) {
  const scope = consentScopeFor({
    pin: overrides.pin ?? PIN,
    operationId: overrides.operationId ?? "ae.operation.test.op",
    args: overrides.args ?? { a: 1 },
    projectIdentity: overrides.projectIdentity === undefined ? "proj-A" : overrides.projectIdentity,
  });
  return { scope };
}

test("class resolution follows the permission, not just the row", () => {
  assert.equal(executionClassFor(ROWS.readRow, "read"), "read-only");
  assert.equal(executionClassFor(ROWS.writeRow, "write"), "intentional-write");
  // A read-write row dispatched for read is read-only; for write is intentional-write.
  assert.equal(executionClassFor(ROWS.rwRow, "read"), "read-only");
  assert.equal(executionClassFor(ROWS.rwRow, "write"), "intentional-write");
  assert.equal(executionClassFor(ROWS.devScriptRow, "execute"), "trusted-dev-script");
  // Fail closed: write on a read row, execute on a native row, unknown permission.
  assert.equal(executionClassFor(ROWS.readRow, "write"), null);
  assert.equal(executionClassFor(ROWS.nativeRow, "execute"), null);
  assert.equal(executionClassFor(ROWS.readRow, "host-callback"), null);
  assert.equal(executionClassFor(null, "read"), null);
});

test("read-only passes with a session pin and nothing else", () => {
  const result = authorizeExecution({
    advertisement: ROWS.readRow,
    permission: "read",
    pin: PIN,
    operationId: "ae.scripting.app.version",
  });
  assert.deepEqual(result, { status: "pass" });
  const noPin = authorizeExecution({
    advertisement: ROWS.readRow,
    permission: "read",
    operationId: "ae.scripting.app.version",
  });
  assert.equal(noPin.status, "refused");
  assert.equal(noPin.reason, "CONSENT_REQUIRED");
});

test("intentional-write requires a consent scope matching this exact dispatch", () => {
  const base = {
    advertisement: ROWS.writeRow,
    permission: "write",
    pin: PIN,
    operationId: "ae.operation.comp.create",
    args: { name: "Main" },
    projectIdentity: "proj-A",
  };
  // No consent → refused.
  assert.equal(authorizeExecution(base).reason, "CONSENT_REQUIRED");
  // Consent for a different argument hash → refused (no silent scope creep).
  const wrongArgs = consentFor({ operationId: base.operationId, args: { name: "Other" } });
  const mismatch = authorizeExecution({ ...base, consent: wrongArgs });
  assert.equal(mismatch.status, "refused");
  assert.equal(mismatch.reason, "CONSENT_SCOPE_MISMATCH");
  // Consent for a different project → refused: project A consent never
  // applies after project change (design §3).
  const wrongProject = consentFor({ operationId: base.operationId, args: base.args, projectIdentity: "proj-B" });
  assert.equal(authorizeExecution({ ...base, consent: wrongProject }).reason, "CONSENT_SCOPE_MISMATCH");
  // Exact scope → pass.
  const ok = authorizeExecution({
    ...base,
    consent: consentFor({ operationId: base.operationId, args: base.args }),
  });
  assert.deepEqual(ok, { status: "pass" });
});

test("consent does not survive session re-pin", () => {
  const base = {
    advertisement: ROWS.writeRow,
    permission: "write",
    pin: { ...PIN, sessionId: "sess-2" },
    operationId: "ae.operation.comp.create",
    args: {},
    projectIdentity: "proj-A",
  };
  const staleConsent = consentFor({ pin: PIN, operationId: "ae.operation.comp.create", args: {} });
  const result = authorizeExecution({ ...base, consent: staleConsent });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "CONSENT_SCOPE_MISMATCH");
});

test("intentional-write without project identity is refused", () => {
  const result = authorizeExecution({
    advertisement: ROWS.writeRow,
    permission: "write",
    pin: PIN,
    operationId: "ae.operation.comp.create",
    args: {},
    projectIdentity: null,
    consent: consentFor({ operationId: "ae.operation.comp.create", args: {}, projectIdentity: null }),
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "CONSENT_REQUIRED");
});

test("trusted-dev-script needs opt-in + provenance + scoped consent", () => {
  const base = {
    advertisement: ROWS.devScriptRow,
    permission: "execute",
    pin: PIN,
    operationId: "ae.operation.devscript.run",
    args: { script: "app.version" },
    projectIdentity: "proj-A",
    consent: consentFor({ operationId: "ae.operation.devscript.run", args: { script: "app.version" } }),
    scriptProvenance: "operator-cli",
  };
  // Missing opt-in flag → refused even with perfect consent.
  const noOptIn = authorizeExecution({ ...base, trustedScriptOptIn: false });
  assert.equal(noOptIn.reason, "CONSENT_REQUIRED");
  // Missing provenance → refused.
  const noProv = authorizeExecution({ ...base, trustedScriptOptIn: true, scriptProvenance: null });
  assert.equal(noProv.reason, "CONSENT_REQUIRED");
  // Opt-in + provenance + consent → pass.
  const ok = authorizeExecution({ ...base, trustedScriptOptIn: true });
  assert.deepEqual(ok, { status: "pass" });
});

test("unmapped permission/class combinations fail closed", () => {
  const result = authorizeExecution({
    advertisement: ROWS.nativeRow,
    permission: "execute",
    pin: PIN,
    operationId: "ae.sdk.aegp.pf.outptr",
    args: {},
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "UNSUPPORTED_CLASS");
});

test("argumentHash is canonical: key order does not matter", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(argumentHash({ x: 1, y: [2, { b: 1, a: 0 }] }), argumentHash({ y: [2, { a: 0, b: 1 }], x: 1 }));
});

test("consentScopeFor refuses a pin without sessionId", () => {
  assert.throws(() => consentScopeFor({ pin: {}, operationId: "op", args: {} }), /session pin/);
});

test("every class has a declared consent requirement", () => {
  for (const cls of EXECUTION_CLASSES) {
    assert.ok(CONSENT_REQUIREMENT[cls], `no consent requirement for ${cls}`);
  }
});
