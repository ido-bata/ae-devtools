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
  assert.throws(() => consentScopeFor({ pin: null, operationId: "op", args: {} }), /session pin/);
  assert.throws(
    () => consentScopeFor({ pin: PIN, operationId: "", args: {} }),
    /operation id/,
  );
  assert.throws(
    () => consentScopeFor({ pin: PIN, operationId: undefined, args: {} }),
    /operation id/,
  );
});

test("malformed consent, pin and dispatch input are typed refusals — never throws", () => {
  const base = {
    advertisement: ROWS.writeRow,
    permission: "write",
    pin: PIN,
    operationId: "ae.operation.comp.create",
    args: {},
    projectIdentity: "proj-A",
  };

  // Dispatch input itself malformed.
  for (const input of [null, undefined, "x", 42]) {
    const r = authorizeExecution(input);
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "MALFORMED_REQUEST");
  }

  // Session pin malformed → CONSENT_REQUIRED, not an exception.
  for (const pin of [null, {}, { sessionId: 7 }, { sessionId: "" }, "sess-1"]) {
    const r = authorizeExecution({ ...base, pin });
    assert.equal(r.status, "refused", JSON.stringify(pin));
    assert.equal(r.reason, "CONSENT_REQUIRED", JSON.stringify(pin));
  }

  // Operation id missing → CONSENT_REQUIRED, not an exception.
  for (const operationId of [undefined, null, "", 42]) {
    const r = authorizeExecution({ ...base, operationId });
    assert.equal(r.status, "refused", JSON.stringify(operationId));
    assert.equal(r.reason, "CONSENT_REQUIRED", JSON.stringify(operationId));
  }

  // Consent tokens with malformed scope shapes → CONSENT_REQUIRED.
  // sameScope must never see these (it would throw on missing sessionPin).
  const badScopes = [
    ["consent null", null],
    ["consent scalar", "yes"],
    ["scope missing", {}],
    ["scope scalar", { scope: "proj-A" }],
    ["scope array", { scope: [] }],
    ["sessionPin missing", { scope: { operationId: "op", argumentHash: "h", projectIdentity: "p" } }],
    ["sessionPin null", { scope: { sessionPin: null, operationId: "op", argumentHash: "h", projectIdentity: "p" } }],
    ["sessionPin no sessionId", { scope: { sessionPin: {}, operationId: "op", argumentHash: "h", projectIdentity: "p" } }],
    ["operationId missing", { scope: { sessionPin: { sessionId: "s" }, argumentHash: "h", projectIdentity: "p" } }],
    ["argumentHash missing", { scope: { sessionPin: { sessionId: "s" }, operationId: "op", projectIdentity: "p" } }],
    ["projectIdentity missing", { scope: { sessionPin: { sessionId: "s" }, operationId: "op", argumentHash: "h" } }],
    ["projectIdentity wrong type", { scope: { sessionPin: { sessionId: "s" }, operationId: "op", argumentHash: "h", projectIdentity: 7 } }],
  ];
  for (const [label, consent] of badScopes) {
    const r = authorizeExecution({ ...base, consent });
    assert.equal(r.status, "refused", label);
    assert.equal(r.reason, "CONSENT_REQUIRED", label);
  }
});

test("canonical argument hash: non-finite and non-JSON values never collide", () => {
  // JSON.stringify collapses NaN/±Infinity to null and drops undefined —
  // the consent hash must keep them distinct or consent for one value
  // would silently cover another.
  const distinct = [
    ["NaN", { a: NaN }],
    ["Infinity", { a: Infinity }],
    ["-Infinity", { a: -Infinity }],
    ["null", { a: null }],
    ["zero", { a: 0 }],
    ["one", { a: 1 }],
  ];
  const hashes = new Map(distinct.map(([label, args]) => [label, argumentHash(args)]));
  for (const [l1, h1] of hashes) {
    for (const [l2, h2] of hashes) {
      if (l1 !== l2) assert.notEqual(h1, h2, `${l1} collides with ${l2}`);
    }
  }
  // undefined/function/symbol/bigint are distinct from null and from each
  // other, and from the "key absent" shape.
  assert.notEqual(argumentHash({ a: undefined }), argumentHash({}));
  assert.notEqual(argumentHash({ a: undefined }), argumentHash({ a: null }));
  assert.notEqual(argumentHash([undefined]), argumentHash([]));
  assert.notEqual(argumentHash([undefined]), argumentHash([null]));
  assert.notEqual(argumentHash({ f: () => {} }), argumentHash({ f: null }));
  assert.notEqual(argumentHash({ f: () => {} }), argumentHash({}));
  assert.notEqual(argumentHash({ b: 1n }), argumentHash({ b: "1" }));
  assert.notEqual(argumentHash({ b: 1n }), argumentHash({ b: 1 }));
  // Non-plain objects do not collapse to "{}".
  assert.notEqual(argumentHash({ d: new Date(0) }), argumentHash({ d: {} }));
  assert.equal(canonicalJson(NaN), "#num:NaN#");
  assert.equal(canonicalJson(Infinity), "#num:+Infinity#");
  assert.equal(canonicalJson(-Infinity), "#num:-Infinity#");
  // Sentinels cannot be forged by string values (strings stay quoted).
  assert.equal(canonicalJson("#num:NaN#"), '"#num:NaN#"');
  assert.notEqual(canonicalJson("#num:NaN#"), canonicalJson(NaN));
  // -0 stays JSON-equivalent to 0 (wire semantics).
  assert.equal(canonicalJson(-0), canonicalJson(0));
});

test("consent scope equality is checked, not authenticity — forged-but-well-formed scope passes (fake-level boundary)", () => {
  // This layer validates that the presented scope *equals* the required
  // scope. It does NOT verify who issued the token — issuance/signature
  // verification is production authorization (ADR-0005 / ae-a8n #97-#99),
  // deliberately absent here. This test pins that boundary so a future
  // change cannot silently imply production-grade consent.
  const base = {
    advertisement: ROWS.writeRow,
    permission: "write",
    pin: PIN,
    operationId: "ae.operation.comp.create",
    args: { name: "Main" },
    projectIdentity: "proj-A",
  };
  // A hand-built scope that happens to equal the required scope passes —
  // nothing here verifies issuance. That is the documented fake-level
  // boundary, pinned so it cannot silently become an implied guarantee.
  const forgedScope = consentScopeFor({
    pin: base.pin,
    operationId: base.operationId,
    args: base.args,
    projectIdentity: base.projectIdentity,
  });
  const result = authorizeExecution({ ...base, consent: { scope: forgedScope, forged: true } });
  assert.deepEqual(result, { status: "pass" });
});

test("every class has a declared consent requirement", () => {
  for (const cls of EXECUTION_CLASSES) {
    assert.ok(CONSENT_REQUIREMENT[cls], `no consent requirement for ${cls}`);
  }
});
