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
  DISPATCH_OUTCOMES,
  DISPATCH_SCHEMA,
  isDispatchArgValue,
  outcomeRequiresReconciliation,
  resolveDispatchOperation,
  validateDispatchRequest,
  validateDispatchResult,
  type DispatchRequest,
  type DispatchResult,
} from "../src/dispatch.ts";
import { findOperation } from "../src/operations.ts";

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

describe("outcomeRequiresReconciliation — UNKNOWN non-resend", () => {
  test("only unknown requires reconciliation", () => {
    for (const o of DISPATCH_OUTCOMES) {
      expect(outcomeRequiresReconciliation(o)).toBe(o === "unknown");
    }
  });
});
