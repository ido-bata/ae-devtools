/**
 * CAP039 groundwork — native-dispatch envelope contract (Issue #17).
 *
 * Proves the transport-agnostic request/result envelope is fail-closed:
 * shape validation, the ES3 argument codec, registry-state resolution
 * (every committed entry refuses today — dispatchable count is 0), and
 * the outcome/retry vocabulary from trusted-execution.md §4.
 *
 * No AE, no plug-in, no transport, no authorization token — contract
 * level only. A structurally `completed` result here is a claim, never
 * evidence.
 */

import { describe, expect, test } from "bun:test";
import {
  DISPATCH_ARG_MAX_DEPTH,
  NATIVE_INTAKE_ARG_SCHEMAS,
  NATIVE_INTAKE_OPERATIONS,
  DISPATCH_OUTCOMES,
  DISPATCH_SCHEMA,
  isDispatchArgValue,
  outcomeRequiresReconciliation,
  resolveDispatchOperation,
  validateDispatchRequest,
  validateDispatchResult,
  validateNativeIntakeArgs,
  type DispatchRequest,
  type DispatchResult,
} from "../src/dispatch.ts";
import {
  findOperation,
  isDispatchableEntry,
} from "../src/operations.ts";

const VALID_REQUEST: DispatchRequest = {
  schema: DISPATCH_SCHEMA,
  requestId: "req-1",
  session: { sessionId: "sess-a", aeVersion: "26.5" },
  operationId: "AEGP_ProjSuite6.AEGP_GetNumProjects",
};

const VALID_RESULT: DispatchResult = {
  schema: DISPATCH_SCHEMA,
  requestId: "req-1",
  outcome: "completed",
  result: { count: 2 },
};

describe("isDispatchArgValue — ES3 serializable set", () => {
  test("accepts the serializable set", () => {
    for (const v of [null, true, 1.5, "s", [], [1, "a", null], {}, { a: [1, { b: "c" }] }]) {
      expect(isDispatchArgValue(v)).toBe(true);
    }
  });
  test("rejects non-serializable values", () => {
    for (const v of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => {}, Symbol("s"), new Date(), /re/]) {
      expect(isDispatchArgValue(v)).toBe(false);
    }
  });
  test("rejects nested non-serializable members", () => {
    expect(isDispatchArgValue({ ok: 1, bad: undefined })).toBe(false);
    expect(isDispatchArgValue([1, Number.NaN])).toBe(false);
  });
  test("rejects cyclic structures without hanging", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(isDispatchArgValue(a)).toBe(false);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(isDispatchArgValue(arr)).toBe(false);
    const indirect: Record<string, unknown> = { b: {} };
    (indirect.b as Record<string, unknown>).back = indirect;
    expect(isDispatchArgValue(indirect)).toBe(false);
  });
  test("accepts shared (DAG) references that are not cycles", () => {
    const shared = { v: 1 };
    expect(isDispatchArgValue({ a: shared, b: shared })).toBe(true);
    const arr: unknown[] = [shared, shared];
    expect(isDispatchArgValue(arr)).toBe(true);
  });
  test("rejects excessive depth and node count", () => {
    let deep: unknown = 1;
    for (let i = 0; i < DISPATCH_ARG_MAX_DEPTH + 5; i++) deep = [deep];
    expect(isDispatchArgValue(deep)).toBe(false);
    const wide: unknown[] = new Array(200_000).fill(0);
    expect(isDispatchArgValue(wide)).toBe(false);
  });
  test("rejects hostile objects that throw during inspection", () => {
    const throwing = {
      get boom(): unknown {
        throw new Error("hostile getter");
      },
    };
    expect(isDispatchArgValue(throwing)).toBe(false);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(isDispatchArgValue(revoked.proxy)).toBe(false);
  });
});

describe("validateDispatchRequest", () => {
  test("accepts a well-formed request", () => {
    expect(validateDispatchRequest(VALID_REQUEST)).toEqual([]);
  });
  test("accepts args in the serializable set and authorizationRef", () => {
    expect(validateDispatchRequest({
      ...VALID_REQUEST,
      args: { index: 0, flag: true },
      authorizationRef: "grant-123",
    })).toEqual([]);
  });
  test("rejects wrong schema, missing ids, bad session", () => {
    expect(validateDispatchRequest({ ...VALID_REQUEST, schema: "other/v9" })).not.toEqual([]);
    expect(validateDispatchRequest({ ...VALID_REQUEST, requestId: "" })).not.toEqual([]);
    expect(validateDispatchRequest({ ...VALID_REQUEST, session: { sessionId: "s" } })).not.toEqual([]);
    expect(validateDispatchRequest({ ...VALID_REQUEST, operationId: "" })).not.toEqual([]);
  });
  test("rejects non-serializable args", () => {
    expect(validateDispatchRequest({ ...VALID_REQUEST, args: { f: () => {} } })).not.toEqual([]);
    expect(validateDispatchRequest({ ...VALID_REQUEST, args: Number.NaN })).not.toEqual([]);
  });
  test("rejects non-object input", () => {
    expect(validateDispatchRequest(null)).not.toEqual([]);
    expect(validateDispatchRequest("x")).not.toEqual([]);
  });
});

describe("resolveDispatchOperation — fail-closed registry gate", () => {
  test("refuses malformed operationId", () => {
    expect(resolveDispatchOperation("")).toEqual({ ok: false, refusal: "malformed-request" });
    expect(resolveDispatchOperation(42)).toEqual({ ok: false, refusal: "malformed-request" });
  });
  test("refuses unknown operation ids", () => {
    expect(resolveDispatchOperation("No.Such.Member")).toEqual({ ok: false, refusal: "unknown-operation" });
  });
  test("refuses every committed entry — dispatchable count is 0", () => {
    // implemented-unverified entry
    const r1 = resolveDispatchOperation("AEGP_ProjSuite6.AEGP_GetNumProjects");
    expect(r1).toEqual({ ok: false, refusal: "operation-not-dispatchable" });
    // inventory-only entry
    const r2 = resolveDispatchOperation("AEGP_ProjSuite6.AEGP_SaveProjectToPath");
    expect(r2).toEqual({ ok: false, refusal: "operation-not-dispatchable" });
    // unsupported-or-unknown entry if any exist
    const unsup = findOperation("PF_Cmd.SELECT") ?? null;
    if (unsup) {
      expect(resolveDispatchOperation(unsup.id)).toEqual({ ok: false, refusal: "operation-not-dispatchable" });
    }
  });
});

describe("validateDispatchResult", () => {
  test("accepts a well-formed completed result", () => {
    expect(validateDispatchResult(VALID_RESULT)).toEqual([]);
  });
  test("accepts refused with code, unknown/failed with mayHaveMutated", () => {
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "refused", refusalCode: "WRONG_TARGET", result: undefined })).toEqual([]);
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "unknown", result: undefined, mayHaveMutated: true })).toEqual([]);
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "failed", result: undefined, mayHaveMutated: false })).toEqual([]);
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "not-sent", result: undefined })).toEqual([]);
  });
  test("rejects bad outcome vocabulary", () => {
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "COMPLETED" })).not.toEqual([]);
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "dispatched" })).not.toEqual([]);
  });
  test("enforces cross-field rules", () => {
    // refused requires refusalCode
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "refused", result: undefined })).not.toEqual([]);
    // completed requires result
    expect(validateDispatchResult({ ...VALID_RESULT, result: undefined })).not.toEqual([]);
    // unknown/failed require mayHaveMutated
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "unknown", result: undefined })).not.toEqual([]);
    expect(validateDispatchResult({ ...VALID_RESULT, outcome: "failed", result: undefined })).not.toEqual([]);
  });
  test("rejects non-serializable result payload", () => {
    expect(validateDispatchResult({ ...VALID_RESULT, result: { cb: () => {} } })).not.toEqual([]);
  });
  test("opCalls must be string array when present", () => {
    expect(validateDispatchResult({ ...VALID_RESULT, opCalls: ["AEGP_ProjSuite6.AEGP_GetNumProjects"] })).toEqual([]);
    expect(validateDispatchResult({ ...VALID_RESULT, opCalls: [42] })).not.toEqual([]);
  });
});

describe("outcomeRequiresReconciliation — UNKNOWN/mutated-FAILED non-resend", () => {
  test("unknown always requires reconciliation", () => {
    expect(outcomeRequiresReconciliation("unknown")).toBe(true);
    expect(outcomeRequiresReconciliation("unknown", false)).toBe(true);
    expect(outcomeRequiresReconciliation("unknown", true)).toBe(true);
  });
  test("failed requires reconciliation only when mayHaveMutated", () => {
    expect(outcomeRequiresReconciliation("failed", true)).toBe(true);
    expect(outcomeRequiresReconciliation("failed", false)).toBe(false);
    expect(outcomeRequiresReconciliation("failed")).toBe(false);
  });
  test("terminal unambiguous outcomes never require reconciliation", () => {
    for (const o of ["completed", "refused", "not-sent"] as const) {
      expect(outcomeRequiresReconciliation(o)).toBe(false);
      expect(outcomeRequiresReconciliation(o, true)).toBe(false);
    }
  });
  test("every declared outcome is classified", () => {
    for (const o of DISPATCH_OUTCOMES) {
      expect(typeof outcomeRequiresReconciliation(o)).toBe("boolean");
    }
  });
});

describe("NATIVE_INTAKE_OPERATIONS — verification lane is not the dispatchable gate", () => {
  test("every intake operation exists in the registry and is implemented", () => {
    for (const id of NATIVE_INTAKE_OPERATIONS) {
      const entry = findOperation(id);
      expect(entry).not.toBeNull();
      expect(entry!.implemented).toBe(true);
    }
  });
  test("intake membership never promotes dispatchability", () => {
    for (const id of NATIVE_INTAKE_OPERATIONS) {
      const entry = findOperation(id)!;
      expect(entry.verifiedOnRealHost).toBe(false);
      expect(entry.externalDispatchVerified ?? false).toBe(false);
      expect(isDispatchableEntry(entry)).toBe(false);
      /* the public gate still refuses every committed operation,
         including intake-allowlisted ones */
      const res = resolveDispatchOperation(id);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.refusal).toBe("operation-not-dispatchable");
    }
  });
  test("intake allowlist contains only implemented read-only getters", () => {
    /* explicit expected set — every entry is a read-only query the
       NativeProbe already calls; mutation candidates stay out until
       the FR-07/US3 permission model exists (#270) */
    expect([...NATIVE_INTAKE_OPERATIONS].sort()).toEqual([
      "AEGP_ItemSuite9.AEGP_GetTypeName",
      "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
      "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
      "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
      "AEGP_UtilitySuite6.AEGP_HostIsActivated",
    ]);
  });
});

describe("NATIVE_INTAKE_ARG_SCHEMAS / validateNativeIntakeArgs — Issue #270 Stage 1", () => {
  const TN = "AEGP_ItemSuite9.AEGP_GetTypeName";
  const ZERO = "AEGP_ProjSuite6.AEGP_GetNumProjects";

  test("schema keys are exactly the intake allowlist members", () => {
    for (const id of Object.keys(NATIVE_INTAKE_ARG_SCHEMAS)) {
      expect((NATIVE_INTAKE_OPERATIONS as readonly string[]).includes(id)).toBe(true);
    }
  });
  test("zero-arg ops accept absent/null args and refuse everything else", () => {
    expect(validateNativeIntakeArgs(ZERO, undefined)).toEqual([]);
    expect(validateNativeIntakeArgs(ZERO, null)).toEqual([]);
    for (const bad of [{}, [], 0, "", { itemType: 2 }, true]) {
      expect(validateNativeIntakeArgs(ZERO, bad)).not.toEqual([]);
    }
  });
  test("arg op requires the exact named-arg object", () => {
    expect(validateNativeIntakeArgs(TN, { itemType: 2 })).toEqual([]);
    expect(validateNativeIntakeArgs(TN, { itemType: 1 })).toEqual([]);
    expect(validateNativeIntakeArgs(TN, { itemType: 4 })).toEqual([]);
    // missing / null / non-object forms
    for (const bad of [undefined, null, {}, [], 2, "2", { other: 2 }]) {
      expect(validateNativeIntakeArgs(TN, bad)).not.toEqual([]);
    }
    // extra fields refuse — no partial/partial-plus application
    expect(validateNativeIntakeArgs(TN, { itemType: 2, extra: 1 })).not.toEqual([]);
  });
  test("itemType range rejects NONE, undefined values, non-integers, wrong types", () => {
    for (const bad of [0, 5, -1, 99, 1.5, "2", true, null]) {
      expect(validateNativeIntakeArgs(TN, { itemType: bad })).not.toEqual([]);
    }
  });
  test("prototype-polluting keys cannot smuggle extra args", () => {
    const args = JSON.parse('{"itemType":2,"constructor":1,"__proto__":{}}');
    expect(validateNativeIntakeArgs(TN, args)).not.toEqual([]);
  });
  test("non-allowlisted operation ids refuse", () => {
    expect(validateNativeIntakeArgs("AEGP_ProjSuite6.AEGP_GetProjectName", null))
      .not.toEqual([]);
    expect(validateNativeIntakeArgs("No.Such.Op", { itemType: 2 })).not.toEqual([]);
  });
});
