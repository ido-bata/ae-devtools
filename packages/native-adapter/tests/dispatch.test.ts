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
      "AEGP_CompSuite13.AEGP_GetCompBGColor",
      "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame",
      "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime",
      "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor",
      "AEGP_CompSuite13.AEGP_GetCompFrameDuration",
      "AEGP_CompSuite13.AEGP_GetCompFramerate",
      "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit",
      "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase",
      "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart",
      "AEGP_CompSuite13.AEGP_GetShowBlendModes",
      "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName",
      "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
      "AEGP_ItemSuite9.AEGP_GetItemComment",
      "AEGP_ItemSuite9.AEGP_GetItemCurrentTime",
      "AEGP_ItemSuite9.AEGP_GetItemDimensions",
      "AEGP_ItemSuite9.AEGP_GetItemDuration",
      "AEGP_ItemSuite9.AEGP_GetItemFlags",
      "AEGP_ItemSuite9.AEGP_GetItemID",
      "AEGP_ItemSuite9.AEGP_GetItemLabel",
      "AEGP_ItemSuite9.AEGP_GetItemName",
      "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio",
      "AEGP_ItemSuite9.AEGP_GetItemType",
      "AEGP_ItemSuite9.AEGP_GetTypeName",
      "AEGP_ItemSuite9.AEGP_IsItemSelected",
      "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte",
      "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex",
      "AEGP_LayerSuite9.AEGP_GetCompNumLayers",
      "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime",
      "AEGP_LayerSuite9.AEGP_GetLayerDuration",
      "AEGP_LayerSuite9.AEGP_GetLayerFlags",
      "AEGP_LayerSuite9.AEGP_GetLayerID",
      "AEGP_LayerSuite9.AEGP_GetLayerInPoint",
      "AEGP_LayerSuite9.AEGP_GetLayerIndex",
      "AEGP_LayerSuite9.AEGP_GetLayerLabel",
      "AEGP_LayerSuite9.AEGP_GetLayerName",
      "AEGP_LayerSuite9.AEGP_GetLayerObjectType",
      "AEGP_LayerSuite9.AEGP_GetLayerQuality",
      "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality",
      "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID",
      "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer",
      "AEGP_LayerSuite9.AEGP_IsLayer2D",
      "AEGP_LayerSuite9.AEGP_IsLayer3D",
      "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn",
      "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte",
      "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn",
      "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ProjSuite6.AEGP_GetProjectBitDepth",
      "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay",
      "AEGP_ProjSuite6.AEGP_ProjectIsDirty",
      "AEGP_RQItemSuite4.AEGP_GetComment",
      "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
      "AEGP_RQItemSuite4.AEGP_GetElapsedTime",
      "AEGP_RQItemSuite4.AEGP_GetLogType",
      "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
      "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
      "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
      "AEGP_RQItemSuite4.AEGP_GetRenderState",
      "AEGP_RQItemSuite4.AEGP_GetStartedTime",
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

describe("aeRefItem arg — Issue #270 Stage 3 identity descriptor", () => {
  const IN = "AEGP_ItemSuite9.AEGP_GetItemName";
  const good = {
    projectIndex: 0,
    item: { aeRef: { type: "comp", name: "Plate", path: [0] } },
  };
  test("well-formed descriptor passes shape validation", () => {
    expect(validateNativeIntakeArgs(IN, good)).toEqual([]);
    for (const t of ["folder", "comp", "footage"]) {
      const a = { projectIndex: 1, item: { aeRef: { type: t, name: "x", path: [2] } } };
      expect(validateNativeIntakeArgs(IN, a)).toEqual([]);
    }
  });
  test("arg key set is exact — missing/extra refuse", () => {
    expect(validateNativeIntakeArgs(IN, { projectIndex: 0 })).not.toEqual([]);
    expect(validateNativeIntakeArgs(IN, { ...good, extra: 1 })).not.toEqual([]);
    expect(validateNativeIntakeArgs(IN, { projectIndex: 0, item: good.item, x: 1 }))
      .not.toEqual([]);
  });
  test("aeRef wrapper and inner shape are exact", () => {
    const bad = [
      { projectIndex: 0, item: { type: "comp", name: "P", path: [0] } }, // no wrapper
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", path: [0], contentHash: "h" } } },
      { projectIndex: 0, item: { aeRef: { type: "solid", name: "P", path: [0] } } },
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "", path: [0] } } },
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", path: [] } } },
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", path: [0, 1] } } },
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", path: [-1] } } },
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", path: [0.5] } } },
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", path: "0" } } },
      { projectIndex: -1, item: good.item },
      { projectIndex: 1.5, item: good.item },
      { projectIndex: 0, item: "not-an-object" },
    ];
    for (const a of bad) {
      expect(validateNativeIntakeArgs(IN, a)).not.toEqual([]);
    }
  });
  test("shape pass is not resolution — descriptor semantics stay host-side", () => {
    // A descriptor naming a nonexistent item still passes shape checks;
    // STALE_REFERENCE is the plug-in's verdict, not this validator's.
    const ghost = {
      projectIndex: 0,
      item: { aeRef: { type: "comp", name: "DoesNotExist", path: [999] } },
    };
    expect(validateNativeIntakeArgs(IN, ghost)).toEqual([]);
  });
});

describe("aeRefItem v2 identity fields — Issue #270 identity slice", () => {
  const IN = "AEGP_ItemSuite9.AEGP_GetItemName";
  const ID = "AEGP_ItemSuite9.AEGP_GetItemID";
  const ENUM = "AEGP_ItemSuite9.AEGP_GetFirstProjItem";
  const base = { type: "comp", name: "Plate", path: [0] };
  const wrap = (aeRef: Record<string, unknown>) =>
    ({ projectIndex: 0, item: { aeRef } });

  test("identity-bearing descriptor passes shape validation", () => {
    expect(validateNativeIntakeArgs(IN, wrap({
      ...base, itemId: 5001, projectName: "Shot01", projectPath: "/a.aep",
    }))).toEqual([]);
    // projectPath may be empty (untitled project)
    expect(validateNativeIntakeArgs(IN, wrap({
      ...base, itemId: 0, projectName: "", projectPath: "",
    }))).toEqual([]);
    // optional fields are independently omittable
    expect(validateNativeIntakeArgs(IN, wrap({ ...base, itemId: 4294967295 })))
      .toEqual([]);
    expect(validateNativeIntakeArgs(IN, wrap({ ...base, projectName: "P" })))
      .toEqual([]);
  });
  test("GetItemID shares the aeRefItem arg contract", () => {
    expect(validateNativeIntakeArgs(ID, wrap(base))).toEqual([]);
    expect(validateNativeIntakeArgs(ID, wrap({ ...base, itemId: 7 }))).toEqual([]);
    expect(validateNativeIntakeArgs(ID, { projectIndex: 0 })).not.toEqual([]);
  });
  test("GetFirstProjItem paging args are exact and bounded", () => {
    expect(validateNativeIntakeArgs(ENUM,
      { projectIndex: 0, offset: 0, limit: 1 })).toEqual([]);
    expect(validateNativeIntakeArgs(ENUM,
      { projectIndex: 3, offset: 64, limit: 32 })).toEqual([]);
    for (const bad of [
      { projectIndex: 0, offset: 0 },                    // missing limit
      { projectIndex: 0, offset: 0, limit: 0 },          // limit < 1
      { projectIndex: 0, offset: 0, limit: 33 },         // limit > 32
      { projectIndex: 0, offset: -1, limit: 8 },         // negative offset
      { projectIndex: 0, offset: 0, limit: 8, x: 1 },    // extra arg
      { projectIndex: 0, offset: 0, limit: 1.5 },        // fractional
      { offset: 0, limit: 8 },                           // missing projectIndex
    ]) {
      expect(validateNativeIntakeArgs(ENUM, bad)).not.toEqual([]);
    }
  });
  test("v2 field bounds and types refuse", () => {
    const bad = [
      wrap({ ...base, itemId: -1 }),
      wrap({ ...base, itemId: 4294967296 }),
      wrap({ ...base, itemId: 1.5 }),
      wrap({ ...base, itemId: "7" }),
      wrap({ ...base, itemId: null }),
      wrap({ ...base, projectName: 5 }),
      wrap({ ...base, projectPath: true }),
      wrap({ ...base, generation: 1 }),                  // unknown key
      wrap({ ...base, name: "A".repeat(1025) }),         // >1024 UTF-8 bytes
      { projectIndex: 0, item: { aeRef: { type: "comp", name: "P", itemId: 7 } } }, // missing path
    ];
    for (const a of bad) {
      expect(validateNativeIntakeArgs(IN, a)).not.toEqual([]);
      expect(validateNativeIntakeArgs(ID, a)).not.toEqual([]);
    }
    // multibyte name: 600 × 'é' = 1200 UTF-8 bytes > 1024
    expect(validateNativeIntakeArgs(IN, wrap({
      ...base, name: "é".repeat(600),
    }))).not.toEqual([]);
    // 500 × 'é' = 1000 bytes ≤ 1024 passes
    expect(validateNativeIntakeArgs(IN, wrap({
      ...base, name: "é".repeat(500),
    }))).toEqual([]);
  });
});

describe("comp:<aeRefItem> arg — Issue #318 CompSuite13 getters", () => {
  const FR = "AEGP_CompSuite13.AEGP_GetCompFramerate";
  const BG = "AEGP_CompSuite13.AEGP_GetCompBGColor";
  const good = {
    projectIndex: 0,
    comp: { aeRef: { type: "comp", name: "Clip", path: [0], itemId: 6001 } },
  };
  test("well-formed comp descriptor passes shape validation", () => {
    expect(validateNativeIntakeArgs(FR, good)).toEqual([]);
    expect(validateNativeIntakeArgs(BG, good)).toEqual([]);
    // legacy positional form also passes shape — resolution is host-side
    expect(validateNativeIntakeArgs(FR, {
      projectIndex: 2,
      comp: { aeRef: { type: "comp", name: "C", path: [3] } },
    })).toEqual([]);
  });
  test("arg key set is exact — wrong/missing/extra keys refuse", () => {
    for (const bad of [
      { projectIndex: 0 },                        // missing comp
      { projectIndex: 0, comp: good.comp, extra: 1 }, // extra arg
      { comp: good.comp },                        // missing projectIndex
      { projectIndex: 0, item: good.comp },       // wrong key name
      { projectIndex: 0, comp: "Clip" },          // non-descriptor
      { projectIndex: 0, comp: { aeRef: { type: "comp", name: "C" } } }, // no path
    ]) {
      expect(validateNativeIntakeArgs(FR, bad)).not.toEqual([]);
    }
  });
  test("non-comp aeRef types pass shape — host corroborates live type", () => {
    // The validator proves shape only; a "footage" descriptor is
    // well-formed here and fails STALE_REFERENCE host-side when the
    // live item type does not match.
    expect(validateNativeIntakeArgs(FR, {
      projectIndex: 0,
      comp: { aeRef: { type: "footage", name: "F", path: [0] } },
    })).toEqual([]);
  });
});

describe("layer:<aeRefLayer> arg — Issue #318 LayerSuite9 getters", () => {
  const LID = "AEGP_LayerSuite9.AEGP_GetLayerID";
  const LIDX = "AEGP_LayerSuite9.AEGP_GetLayerIndex";
  const LTIME = "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime";
  const LMATTE = "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte";
  const CIDX = "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex";
  const CNUM = "AEGP_LayerSuite9.AEGP_GetCompNumLayers";
  const compRef = {
    aeRef: {
      type: "comp", name: "Clip", path: [0], itemId: 6001,
      projectName: "Shot01", projectPath: "/tmp/shot01.aep",
    },
  };
  const good = {
    projectIndex: 0,
    layer: {
      aeRef: { type: "layer", name: "Layer One", layerId: 4242, comp: compRef },
    },
  };
  test("well-formed layer descriptor passes shape validation", () => {
    expect(validateNativeIntakeArgs(LID, good)).toEqual([]);
    expect(validateNativeIntakeArgs(LIDX, good)).toEqual([]);
    // full int32 range including negatives is legal
    for (const id of [-2147483648, -1, 0, 2147483647]) {
      const a = { projectIndex: 0, layer: { aeRef: {
        type: "layer", name: "L", layerId: id, comp: compRef } } };
      expect(validateNativeIntakeArgs(LID, a)).toEqual([]);
    }
  });
  test("comp-scoped ops use the comp aeRefItem contract", () => {
    expect(validateNativeIntakeArgs(CNUM, {
      projectIndex: 0, comp: compRef,
    })).toEqual([]);
    expect(validateNativeIntakeArgs(CIDX, {
      projectIndex: 0, comp: compRef, layerIndex: 3,
    })).toEqual([]);
    for (const bad of [
      { projectIndex: 0, comp: compRef },                    // CIDX missing layerIndex
      { projectIndex: 0, comp: compRef, layerIndex: -1 },
      { projectIndex: 0, comp: compRef, layerIndex: 1.5 },
      { projectIndex: 0, layer: good.layer },                // wrong arg key
    ]) {
      expect(validateNativeIntakeArgs(CIDX, bad)).not.toEqual([]);
    }
  });
  test("timeMode / fillMustBeActive are required bounded integers", () => {
    for (const tm of [0, 1]) {
      expect(validateNativeIntakeArgs(LTIME, { ...good, timeMode: tm }))
        .toEqual([]);
    }
    expect(validateNativeIntakeArgs(LMATTE, { ...good, fillMustBeActive: 1 }))
      .toEqual([]);
    for (const bad of [
      { ...good },                                            // missing timeMode
      { ...good, timeMode: 2 },
      { ...good, timeMode: -1 },
      { ...good, timeMode: 0.5 },
      { ...good, timeMode: "0" },
      { ...good, fillMustBeActive: 1 },                      // on LTIME → extra arg
    ]) {
      expect(validateNativeIntakeArgs(LTIME, bad)).not.toEqual([]);
    }
    for (const bad of [
      { ...good },                                            // missing fillMustBeActive
      { ...good, fillMustBeActive: 2 },
      { ...good, fillMustBeActive: true },
    ]) {
      expect(validateNativeIntakeArgs(LMATTE, bad)).not.toEqual([]);
    }
  });
  test("aeRefLayer inner shape is exact — keys, type, id, name", () => {
    const wrap = (inner: Record<string, unknown>) =>
      ({ projectIndex: 0, layer: { aeRef: inner } });
    const base = { type: "layer", name: "L", layerId: 1, comp: compRef };
    for (const bad of [
      { projectIndex: 0, layer: { type: "layer", name: "L", layerId: 1, comp: compRef } }, // no wrapper
      wrap({ type: "comp", name: "L", layerId: 1, comp: compRef }),   // wrong type tag
      wrap({ type: "layer", name: "", layerId: 1, comp: compRef }),   // empty name
      wrap({ type: "layer", name: "L", layerId: 2147483648, comp: compRef }),
      wrap({ type: "layer", name: "L", layerId: -2147483649, comp: compRef }),
      wrap({ type: "layer", name: "L", layerId: 1.5, comp: compRef }),
      wrap({ type: "layer", name: "L", layerId: "1", comp: compRef }),
      wrap({ type: "layer", name: "L", layerId: 1 }),                  // missing comp
      wrap({ type: "layer", name: "L", comp: compRef }),              // missing layerId
      wrap({ ...base, extra: 1 }),                                    // extra inner key
      wrap({ ...base, comp: { aeRef: { type: "comp", name: "C" } } }),// comp missing path
      wrap({ ...base, comp: "Clip" }),                                // comp not descriptor
      { projectIndex: 0, layer: "Layer One" },                        // arg not object
      { projectIndex: 0 },                                            // missing layer
    ]) {
      expect(validateNativeIntakeArgs(LID, bad)).not.toEqual([]);
    }
  });
  test("shape pass is not resolution — ghost ids stay host-side", () => {
    const ghost = { projectIndex: 0, layer: { aeRef: {
      type: "layer", name: "Ghost", layerId: 999999,
      comp: { aeRef: { type: "comp", name: "Nope", path: [42], itemId: 1 } },
    } } };
    expect(validateNativeIntakeArgs(LID, ghost)).toEqual([]);
  });
});

describe("project:<aeRefProject> / rqItem:<aeRefRQItem> args — Issue #318 Stage 4", () => {
  const PD = "AEGP_ProjSuite6.AEGP_ProjectIsDirty";
  const RS = "AEGP_RQItemSuite4.AEGP_GetRenderState";
  const RQENUM = "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex";
  const compRef = { aeRef: {
    type: "comp", name: "ClipA", path: [0], itemId: 6101,
    projectName: "Shot01", projectPath: "/tmp/shot01.aep",
  } };
  test("aeRefProject shape is exact — keys, type, index, name, path", () => {
    const wrap = (inner: Record<string, unknown>) =>
      ({ project: { aeRef: inner } });
    const good = { type: "project", index: 0, name: "Shot01", path: "/tmp/s.aep" };
    expect(validateNativeIntakeArgs(PD, wrap(good))).toEqual([]);
    expect(validateNativeIntakeArgs(PD,
      wrap({ ...good, path: "" }))).toEqual([]); // unsaved project
    for (const bad of [
      { project: good },                                                  // no aeRef wrapper
      wrap({ type: "item", index: 0, name: "S", path: "/p" }),            // wrong type
      wrap({ type: "project", index: -1, name: "S", path: "/p" }),
      wrap({ type: "project", index: 1000001, name: "S", path: "/p" }),
      wrap({ type: "project", index: 0.5, name: "S", path: "/p" }),
      wrap({ type: "project", index: 0, name: "", path: "/p" }),          // empty name
      wrap({ type: "project", index: 0, name: "S" }),                     // missing path
      wrap({ type: "project", index: 0, name: "S", path: "/p", x: 1 }),   // extra key
      wrap({ type: "project", index: 0, name: "S", path: 7 }),            // path not str
      { projectIndex: 0 },                                                // missing project
    ]) {
      expect(validateNativeIntakeArgs(PD, bad)).not.toEqual([]);
    }
  });
  test("aeRefRQItem shape is exact — comp binding + fingerprint", () => {
    const wrap = (inner: Record<string, unknown>) =>
      ({ projectIndex: 0, rqItem: { aeRef: inner } });
    const good = { type: "rqItem", index: 0, comp: compRef,
                   status: 2, numOutputModules: 1 };
    expect(validateNativeIntakeArgs(RS, wrap(good))).toEqual([]);
    for (const bad of [
      wrap({ type: "rqItem", index: 0, status: 2, numOutputModules: 1 }), // missing comp
      wrap({ ...good, type: "item" }),
      wrap({ ...good, index: -1 }),
      wrap({ ...good, status: 2147483648 }),
      wrap({ ...good, status: -2147483649 }),
      wrap({ ...good, numOutputModules: -1 }),
      wrap({ ...good, numOutputModules: 1.5 }),
      wrap({ ...good, extra: true }),
      wrap({ ...good, comp: { aeRef: { type: "comp", name: "C" } } }),   // comp missing path
      { rqItem: { aeRef: good } },                                       // missing projectIndex
    ]) {
      expect(validateNativeIntakeArgs(RS, bad)).not.toEqual([]);
    }
  });
  test("RQ enumeration args are bounded {offset, limit}", () => {
    expect(validateNativeIntakeArgs(RQENUM, { offset: 0, limit: 32 })).toEqual([]);
    for (const bad of [
      { offset: 0 }, { offset: 0, limit: 0 }, { offset: 0, limit: 33 },
      { offset: -1, limit: 1 }, { offset: 0, limit: 1, x: 1 },
    ]) {
      expect(validateNativeIntakeArgs(RQENUM, bad)).not.toEqual([]);
    }
  });
});
