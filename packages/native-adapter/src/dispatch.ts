/**
 * Native-dispatch envelope contract — CAP039 groundwork (Issue #17).
 *
 * This module defines the transport-agnostic request/result envelope an
 * external devtools adapter would use to dispatch ONE concrete registry
 * operation (`<Suite>.<member>` from `src/operations.ts`) into a pinned
 * AE session once the adapter↔host handshake
 * (`ae-devtools/native-adapter-handshake/v2`, `src/negotiate.ts`) has
 * returned `compatible`.
 *
 * What this is NOT:
 *
 * - NOT a transport. ADR-0005 D7 assigns execution transport / IPC /
 *   serialization / execution authorization / timeout / UNKNOWN
 *   non-resend to ae-a8n; ae-devtools must not grow its own dispatch
 *   path or consent path. This envelope is the devtools-owned API
 *   surface only — the shape messages take, not the wire that carries
 *   them.
 * - NOT authorization. `authorizationRef` is an opaque handle to a
 *   grant issued by the owning runtime; this contract never mints,
 *   stores, or validates consent tokens (trusted-execution.md §1,
 *   ae-a8n #97–#99).
 * - NOT dispatch. No code path here sends anything to AE. With the
 *   committed registry every operation derives `inventory-only` or
 *   `implemented-unverified`, so `dispatchableOperationForRequest`
 *   refuses every concrete request today — that is the honest state,
 *   not a bug.
 *
 * Semantics reused verbatim from canonical sources:
 *
 * - Outcome vocabulary: trusted-execution.md §4 mapped onto the
 *   catalog spelling — `completed | refused | failed | unknown |
 *   not-sent`. `unknown` means possibly-dispatched with no definitive
 *   reply: never auto-retried, `mayHaveMutated` recorded.
 * - Argument codec: the ES3 serializable set of
 *   trusted-execution.md §2 (null, boolean, finite number, string,
 *   array, plain object). Host objects are never arguments; identity
 *   descriptors are a CAP027 concern, not this envelope's.
 * - Session pin: the read-only probe pinning semantics
 *   (`sessionId` + `aeVersion`) — a result is only meaningful against
 *   the session it was produced in.
 *
 * Normative description: specs/ae-capability-coverage/contracts/native-dispatch.md
 */

import {
  findOperation,
  isDispatchableEntry,
  type OperationEntry,
} from "./operations.ts";

export const DISPATCH_SCHEMA = "ae-devtools/native-dispatch/v1" as const;
export type DispatchSchema = typeof DISPATCH_SCHEMA;

/**
 * Verification-lane intake allowlist (Issue #267 Slice A,
 * `native-channel.md`). This is the fixed read-only set the opt-in
 * NativeProbe channel will execute inside the host-dispatched idle
 * context — it is NOT the `dispatchable` gate. Membership here never
 * promotes a registry entry: `resolveDispatchOperation` still refuses
 * every committed operation, and `verifiedOnRealHost` /
 * `externalDispatchVerified` stay false until authorized real-host
 * evidence exists (Issue #223). The C++ mirror lives in
 * `native_intake.cpp` (`S_ALLOWLIST`); keep the two in sync — the
 * guard test in `tests/dispatch.test.ts` pins registry membership.
 */
export const NATIVE_INTAKE_OPERATIONS = [
  "AEGP_ProjSuite6.AEGP_GetNumProjects",
  "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
  "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
  "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
  "AEGP_UtilitySuite6.AEGP_HostIsActivated",
  "AEGP_ItemSuite9.AEGP_GetTypeName",
  "AEGP_ItemSuite9.AEGP_GetItemName",
  "AEGP_ItemSuite9.AEGP_GetItemID",
  "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
  /* Issue #318 / #64: CompSuite13 read-only getters. All share the
     {projectIndex, comp:<aeRefItem type=comp>} contract — the comp
     handle is derived host-side via AEGP_GetCompFromItem, never taken
     from the wire. GetCompShutterFrameRange is excluded (A_Time input
     arg — arg-bearing ops are a separate slice). */
  "AEGP_CompSuite13.AEGP_GetCompFramerate",
  "AEGP_CompSuite13.AEGP_GetCompFrameDuration",
  "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart",
  "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration",
  "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime",
  "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame",
  "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor",
  "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName",
  "AEGP_CompSuite13.AEGP_GetShowBlendModes",
  "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples",
  "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit",
  "AEGP_CompSuite13.AEGP_GetCompBGColor",
  "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase",
  /* Issue #318 / #63: ItemSuite9 read-only detail getters taking
     AEGP_ItemH — same {projectIndex, item:<aeRefItem>} contract as
     GetItemName; the resolved handle is used directly. */
  "AEGP_ItemSuite9.AEGP_GetItemType",
  "AEGP_ItemSuite9.AEGP_GetItemFlags",
  "AEGP_ItemSuite9.AEGP_IsItemSelected",
  "AEGP_ItemSuite9.AEGP_GetItemLabel",
  "AEGP_ItemSuite9.AEGP_GetItemDuration",
  "AEGP_ItemSuite9.AEGP_GetItemCurrentTime",
  "AEGP_ItemSuite9.AEGP_GetItemDimensions",
  "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio",
  "AEGP_ItemSuite9.AEGP_GetItemComment",
  /* Issue #318 / #64 layer slice: AEGP_LayerSuite9. The layer handle is
     never taken from the wire — `layer` is an aeRefLayer descriptor
     {type:"layer", name, layerId, comp:{aeRef:<comp item descriptor>}};
     the host resolves the comp descriptor through the shared item
     resolver, derives compH via AEGP_GetCompFromItem, then scans the
     comp's layers by live AEGP_GetLayerID + name corroboration.
     GetCompNumLayers/GetCompLayerByIndex are comp-scoped; the latter
     is descriptor issuance (emits a ready-to-use aeRefLayer). */
  "AEGP_LayerSuite9.AEGP_GetCompNumLayers",
  "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex",
  "AEGP_LayerSuite9.AEGP_GetLayerIndex",
  "AEGP_LayerSuite9.AEGP_GetLayerName",
  "AEGP_LayerSuite9.AEGP_GetLayerFlags",
  "AEGP_LayerSuite9.AEGP_GetLayerQuality",
  "AEGP_LayerSuite9.AEGP_GetLayerObjectType",
  "AEGP_LayerSuite9.AEGP_IsLayer3D",
  "AEGP_LayerSuite9.AEGP_IsLayer2D",
  "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime",
  "AEGP_LayerSuite9.AEGP_GetLayerInPoint",
  "AEGP_LayerSuite9.AEGP_GetLayerDuration",
  "AEGP_LayerSuite9.AEGP_GetLayerID",
  "AEGP_LayerSuite9.AEGP_GetLayerLabel",
  "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality",
  "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID",
  "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn",
  "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn",
  "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte",
  "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte",
  "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer",
  "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
  "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
] as const;
export type NativeIntakeOperation = (typeof NATIVE_INTAKE_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// Per-operation intake argument schema (Issue #270 Stage 1)
// ---------------------------------------------------------------------------
//
// The envelope's `args` codec (isDispatchArgValue) only proves the value is
// ES3-serializable; it says nothing about what a given operation accepts.
// Each intake-allowlisted operation carries an explicit argument contract
// here — the devtools-side canonical statement of it. The C++ mirror lives
// in `native_intake.cpp` (`S_ALLOWLIST` arg specs); the two must stay in
// sync, and `tests/dispatch.test.ts` pins the shapes.
//
// Rules encoded by `validateNativeIntakeArgs`:
//
// - An operation with NO schema entry is zero-argument: `args` must be
//   absent or `null`. Any other value refuses `MALFORMED_REQUEST`.
// - An operation WITH a schema requires `args` to be a plain object whose
//   key set is EXACTLY the schema's keys — missing and extra fields both
//   refuse. There is no positional/array form and no partial application.
// - Every declared field must satisfy its constraint. Stage 1 defines only
//   bounded integers (AEGP enum/scalar arguments); identity-bearing
//   arguments (host handles such as AEGP_ItemH) are NOT expressible here —
//   they require the CAP027 identity-descriptor work and stay refused.
//
// `AEGP_ItemSuite9.AEGP_GetTypeName(AEGP_ItemType item_type, ...)` takes the
// item-type enum as `A_short`. Per AE_GeneralPlug.h the defined values are
// NONE=0, FOLDER=1, COMP=2, SOLID_defunct=3, FOOTAGE=4 (NUM_TYPES1=5).
// NONE is not a valid GetTypeName input (the probe already treats it that
// way), so the permitted range is the defined non-NONE span [1, 4].
// SOLID_defunct is a defined enum value: it is passed through and the
// host-defined name is returned; whether real AE still names it is a
// real-host question this fake-level contract does not settle.

export type NativeIntakeArgConstraint =
  | {
      kind: "integer";
      /** Inclusive bounds on the integer value. */
      min: number;
      max: number;
    }
  | {
      /* Issue #270 identity slice (contract native-channel.md §7b): a
         project-item identity descriptor in the trusted-codec `aeRef`
         wire form —
         {"aeRef":{"type","name","path":[i],"itemId"?,"projectName"?,
         "projectPath"?}}. `type` is one of the native-mapped tags
         "folder"|"comp"|"footage" (AEGP_ItemType 1|2|4); `path` is
         exactly one top-level project-item index
         (AEGP_GetFirstProjItem/GetNextProjItem order — folder children
         are not enumerable through AEGP_ItemSuite9, so deeper paths are
         refused); `itemId` is the live AEGP_GetItemID value and, when
         present, is the authoritative selector (path is then ignored);
         `projectName`/`projectPath` corroborate the project binding.
         `contentHash` and any other inner key are NOT accepted — the
         host-side resolver cannot verify them, so their presence is
         MALFORMED_REQUEST rather than silently ignored. The descriptor
         is validated for shape here; resolution (id/path + project +
         type/name corroboration) happens host-side and failure is
         STALE_REFERENCE. */
      kind: "aeRefItem";
    }
  | {
      /* Issue #318 layer slice (contract native-channel.md §7d): a
         layer identity descriptor in the trusted-codec `aeRefLayer`
         wire form —
         {"aeRef":{"type":"layer","name":"<str>","layerId":<int32>,
         "comp":{"aeRef":{<item descriptor>}}}}.
         `layerId` is the live AEGP_GetLayerID value (full int32 range)
         and is the authoritative selector; `name` corroborates;
         `comp` is the REQUIRED parent-comp binding — the same §7b
         item-descriptor arg shape, whose `type` must be "comp" at
         resolution time. All four inner keys are required and no
         others are accepted. Shape only — resolution (comp → itemH →
         compH → layer scan) is host-side and failure is
         STALE_REFERENCE. */
      kind: "aeRefLayer";
    };

/** operationId → exact arg-name → constraint map. Absent = zero-arg op. */
export const NATIVE_INTAKE_ARG_SCHEMAS: Readonly<
  Record<string, Readonly<Record<string, NativeIntakeArgConstraint>>>
> = {
  "AEGP_ItemSuite9.AEGP_GetTypeName": {
    itemType: { kind: "integer", min: 1, max: 4 },
  },
  "AEGP_ItemSuite9.AEGP_GetItemName": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  /* GetItemID shares the aeRefItem arg shape — it is descriptor
     issuance: resolve the descriptor, then return the canonical
     identity-bearing aeRef (live itemId + project name/path). */
  "AEGP_ItemSuite9.AEGP_GetItemID": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  /* GetFirstProjItem as discovery/enumeration: paged ready-to-use
     descriptors. limit mirrors the C++ ENUM_LIMIT_MAX bound. */
  "AEGP_ItemSuite9.AEGP_GetFirstProjItem": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    offset: { kind: "integer", min: 0, max: 1000000 },
    limit: { kind: "integer", min: 1, max: 32 },
  },
  /* CompSuite13 getters (Issue #318 / #64): `comp` is the same §7b
     aeRef item descriptor; the descriptor's `type` must be "comp" for
     resolution to succeed (type corroboration is fail-closed
     host-side). */
  "AEGP_CompSuite13.AEGP_GetCompFramerate": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompFrameDuration": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetShowBlendModes": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompBGColor": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  /* ItemSuite9 detail getters (Issue #318 / #63): identical arg
     contract to GetItemName — {projectIndex, item:<aeRefItem>}. */
  "AEGP_ItemSuite9.AEGP_GetItemType": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemFlags": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_IsItemSelected": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemLabel": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemDuration": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemCurrentTime": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemDimensions": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  "AEGP_ItemSuite9.AEGP_GetItemComment": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    item: { kind: "aeRefItem" },
  },
  /* LayerSuite9 (Issue #318 layer slice): `comp` is the §7b aeRef item
     descriptor for comp-scoped ops; `layer` is the §7d aeRefLayer
     descriptor for layer-handle getters. */
  "AEGP_LayerSuite9.AEGP_GetCompNumLayers": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
  },
  "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    comp: { kind: "aeRefItem" },
    layerIndex: { kind: "integer", min: 0, max: 1000000 },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerIndex": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerName": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerFlags": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerQuality": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerObjectType": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_IsLayer3D": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_IsLayer2D": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  /* timeMode is AEGP_LTimeMode {LayerTime=0, CompTime=1} — bounded
     integer, never defaulted silently (mirrors the C++ spec). */
  "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
    timeMode: { kind: "integer", min: 0, max: 1 },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerInPoint": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
    timeMode: { kind: "integer", min: 0, max: 1 },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerDuration": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
    timeMode: { kind: "integer", min: 0, max: 1 },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerID": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerLabel": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
  "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
    fillMustBeActive: { kind: "integer", min: 0, max: 1 },
  },
  "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer": {
    projectIndex: { kind: "integer", min: 0, max: 1000000 },
    layer: { kind: "aeRefLayer" },
  },
};

function isPlainArgsObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate `args` against the intake argument contract for `operationId`.
 * Returns the list of problems; empty means the plug-in-side codec would
 * accept it. This is the devtools-side mirror of the C++ check — both must
 * refuse the same inputs before any AEGP call. Only meaningful for
 * `NATIVE_INTAKE_OPERATIONS` members; other ids are refused outright.
 */
export function validateNativeIntakeArgs(
  operationId: unknown,
  args: unknown,
): string[] {
  const errors: string[] = [];
  if (typeof operationId !== "string" ||
      !(NATIVE_INTAKE_OPERATIONS as readonly string[]).includes(operationId)) {
    return ["operation is not in the native intake allowlist"];
  }
  const schema = NATIVE_INTAKE_ARG_SCHEMAS[operationId];
  const noArgs = args === undefined || args === null;
  if (!schema) {
    if (!noArgs) errors.push("operation takes no arguments; args must be absent or null");
    return errors;
  }
  if (noArgs) {
    errors.push("operation requires an args object");
    return errors;
  }
  if (!isPlainArgsObject(args)) {
    errors.push("args must be a plain object keyed by argument name");
    return errors;
  }
  const keys = Object.keys(schema);
  const given = Object.keys(args);
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  for (const k of keys) {
    if (!has(args, k)) errors.push(`missing required argument "${k}"`);
  }
  for (const k of given) {
    if (!has(schema, k)) errors.push(`unexpected argument "${k}"`);
  }
  if (errors.length > 0) return errors;
  for (const k of keys) {
    const spec = schema[k];
    if (!spec) continue;
    const v = args[k];
    if (spec.kind === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        errors.push(`argument "${k}" must be an integer`);
      } else if (v < spec.min || v > spec.max) {
        errors.push(`argument "${k}" must be in [${spec.min}, ${spec.max}]`);
      }
    } else if (spec.kind === "aeRefItem") {
      errors.push(...validateAeRefItemArg(k, v));
    } else if (spec.kind === "aeRefLayer") {
      errors.push(...validateAeRefLayerArg(k, v));
    }
  }
  return errors;
}

/* Shape-check an `aeRefItem` descriptor (contract §7b):
   {"aeRef":{"type","name","path",...}} where the required keys are
   type/name/path and the only permitted optional keys are itemId,
   projectName, projectPath. Any other inner key — including
   contentHash — refuses. This proves wire shape only; id/path/project
   resolution and name/type corroboration are the plug-in's job and
   their failure is STALE_REFERENCE, not malformed. */
const AEREF_REQUIRED_KEYS = ["type", "name", "path"];
const AEREF_OPTIONAL_KEYS = ["itemId", "projectName", "projectPath"];
const AEREF_MAX_NAME_BYTES = 1024;
const AEREF_MAX_STR_CHARS = 4096;
const AEREF_MAX_ITEM_ID = 4294967295;
const utf8 = new TextEncoder();

function validateAeRefItemArg(argName: string, v: unknown): string[] {
  const errors: string[] = [];
  const bad = (m: string): string => {
    errors.push(`argument "${argName}": ${m}`);
    return m;
  };
  if (!isPlainArgsObject(v)) return [bad("must be an object")];
  const outerKeys = Object.keys(v);
  if (outerKeys.length !== 1 || outerKeys[0] !== "aeRef") {
    return [bad('must be exactly {"aeRef": {...}}')];
  }
  const ref = v.aeRef;
  if (!isPlainArgsObject(ref)) return [bad("aeRef must be a plain object")];
  const refKeys = Object.keys(ref);
  for (const k of refKeys) {
    if (!AEREF_REQUIRED_KEYS.includes(k) && !AEREF_OPTIONAL_KEYS.includes(k)) {
      bad(`aeRef carries unsupported key "${k}" (contentHash unsupported)`);
    }
  }
  for (const k of AEREF_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(ref, k)) {
      bad(`aeRef requires "${k}"`);
    }
  }
  if (errors.length > 0) return errors;
  if (ref.type !== "folder" && ref.type !== "comp" && ref.type !== "footage") {
    bad('aeRef.type must be "folder" | "comp" | "footage"');
  }
  if (typeof ref.name !== "string" || ref.name.length === 0 ||
      utf8.encode(ref.name).length > AEREF_MAX_NAME_BYTES) {
    bad("aeRef.name must be a non-empty string ≤ 1024 UTF-8 bytes");
  }
  if (!Array.isArray(ref.path) || ref.path.length !== 1 ||
      !Number.isInteger(ref.path[0]) || (ref.path[0] as number) < 0 ||
      (ref.path[0] as number) > 1000000) {
    bad("aeRef.path must be [<non-negative integer>] — one top-level item index");
  }
  if (ref.itemId !== undefined &&
      (typeof ref.itemId !== "number" || !Number.isInteger(ref.itemId) ||
       ref.itemId < 0 || ref.itemId > AEREF_MAX_ITEM_ID)) {
    bad("aeRef.itemId must be an integer in [0, 4294967295]");
  }
  if (ref.projectName !== undefined &&
      (typeof ref.projectName !== "string" ||
       utf8.encode(ref.projectName).length > AEREF_MAX_STR_CHARS)) {
    bad("aeRef.projectName must be a string ≤ 4096 UTF-8 bytes");
  }
  if (ref.projectPath !== undefined &&
      (typeof ref.projectPath !== "string" ||
       utf8.encode(ref.projectPath).length > AEREF_MAX_STR_CHARS)) {
    bad("aeRef.projectPath must be a string ≤ 4096 UTF-8 bytes");
  }
  return errors;
}

const AEREFLAYER_ID_MIN = -2147483648;
const AEREFLAYER_ID_MAX = 2147483647;

/* Shape-check an `aeRefLayer` descriptor (contract §7d):
   {"aeRef":{"type":"layer","name","layerId","comp"}} — exactly those
   four inner keys. `comp` recursively uses the §7b item-descriptor
   shape (its "comp" type tag is corroborated host-side, not trusted
   here). Shape only; resolution failure is STALE_REFERENCE. */
function validateAeRefLayerArg(argName: string, v: unknown): string[] {
  const errors: string[] = [];
  const bad = (m: string): string => {
    errors.push(`argument "${argName}": ${m}`);
    return m;
  };
  if (!isPlainArgsObject(v)) return [bad("must be an object")];
  const outerKeys = Object.keys(v);
  if (outerKeys.length !== 1 || outerKeys[0] !== "aeRef") {
    return [bad('must be exactly {"aeRef": {...}}')];
  }
  const ref = v.aeRef;
  if (!isPlainArgsObject(ref)) return [bad("aeRef must be a plain object")];
  const refKeys = Object.keys(ref).sort();
  const want = ["comp", "layerId", "name", "type"];
  if (refKeys.length !== want.length ||
      refKeys.some((k, i) => k !== want[i])) {
    return [bad('aeRef must carry exactly "type","name","layerId","comp"')];
  }
  if (ref.type !== "layer") bad('aeRef.type must be "layer"');
  if (typeof ref.name !== "string" || ref.name.length === 0 ||
      utf8.encode(ref.name).length > AEREF_MAX_NAME_BYTES) {
    bad("aeRef.name must be a non-empty string ≤ 1024 UTF-8 bytes");
  }
  if (typeof ref.layerId !== "number" || !Number.isInteger(ref.layerId) ||
      ref.layerId < AEREFLAYER_ID_MIN || ref.layerId > AEREFLAYER_ID_MAX) {
    bad("aeRef.layerId must be an integer in [-2147483648, 2147483647]");
  }
  errors.push(...validateAeRefItemArg(`${argName}.comp`, ref.comp));
  return errors;
}

/** Outcome vocabulary — trusted-execution.md §4 / catalog spelling. */
export const DISPATCH_OUTCOMES = [
  "completed",
  "refused",
  "failed",
  "unknown",
  "not-sent",
] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

/**
 * Pinned session identity a dispatch is bound to. Semantic equality
 * with the host-attested session is enforced host-side; the envelope
 * only carries the claim.
 */
export type DispatchSessionPin = {
  sessionId: string;
  aeVersion: string;
  sdkRelease?: { identifier: string; distribution: string };
};

export type DispatchRequest = {
  schema: DispatchSchema;
  /** Client-generated correlation/idempotency key; echoed in the result. */
  requestId: string;
  session: DispatchSessionPin;
  /** Registry operation id `"<Suite>.<member>"`. */
  operationId: string;
  /** ES3-serializable arguments (trusted-execution.md §2 set). */
  args?: unknown;
  /**
   * Opaque reference to an authorization grant issued by the owning
   * runtime (ae-a8n). Never a token this contract defines or verifies.
   */
  authorizationRef?: string;
};

export type DispatchResult = {
  schema: DispatchSchema;
  requestId: string;
  outcome: DispatchOutcome;
  /** Machine-readable refusal class when `outcome === "refused"`. */
  refusalCode?: string;
  /** Serializable payload when `outcome === "completed"`. */
  result?: unknown;
  /**
   * True when the host cannot prove the operation did not mutate
   * state — set on `unknown` and on `failed` where atomicity is
   * unproven. The client must not auto-retry; manual reconciliation
   * is required (trusted-execution.md §4).
   */
  mayHaveMutated?: boolean;
  /**
   * Registry ids of the `op ` records the host emitted for this
   * request — the linkage into `native-probe-result/v1` evidence.
   * Absent means no in-host call evidence was collected.
   */
  opCalls?: string[];
  /** Human-readable detail; never load-bearing for decisions. */
  detail?: string;
};

// ---------------------------------------------------------------------------
// Argument codec — ES3 serializable set (trusted-execution.md §2)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Depth/node budgets for `isDispatchArgValue`. Untrusted input must be
 * rejected safely: cyclic structures would recurse forever, deep
 * nesting would overflow the stack, and huge inputs would burn CPU.
 * Both limits are far beyond any legitimate AEGP argument shape.
 */
export const DISPATCH_ARG_MAX_DEPTH = 64;
export const DISPATCH_ARG_MAX_NODES = 100_000;

/**
 * True when `value` belongs to the ES3-serializable set: null,
 * boolean, finite number, string, array of serializables, or plain
 * object with serializable values. `undefined`, functions, symbols,
 * non-finite numbers, and non-plain objects are rejected — inside the
 * ES3 host there is no `JSON` to silently collapse them.
 *
 * Defensive against hostile input: cycles are detected via the current
 * recursion path (shared DAG references remain valid), depth and total
 * node count are bounded, and any exception thrown while inspecting
 * the value (e.g. a throwing getter or revoked Proxy) rejects rather
 * than propagates.
 */
export function isDispatchArgValue(value: unknown): boolean {
  const path = new Set<object>();
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > DISPATCH_ARG_MAX_NODES) return false;
    if (v === null) return true;
    switch (typeof v) {
      case "boolean":
      case "string":
        return true;
      case "number":
        return Number.isFinite(v);
      case "object": {
        if (depth >= DISPATCH_ARG_MAX_DEPTH) return false;
        if (path.has(v)) return false; /* cycle on the current path */
        if (Array.isArray(v)) {
          path.add(v);
          try {
            for (const e of v) {
              if (!visit(e, depth + 1)) return false;
            }
            return true;
          } finally {
            path.delete(v);
          }
        }
        if (!isPlainObject(v)) return false;
        path.add(v);
        try {
          for (const e of Object.values(v)) {
            if (!visit(e, depth + 1)) return false;
          }
          return true;
        } finally {
          path.delete(v);
        }
      }
      default:
        return false;
    }
  };
  try {
    return visit(value, 0);
  } catch {
    return false; /* hostile object (throwing getter, revoked Proxy) */
  }
}

// ---------------------------------------------------------------------------
// Fail-closed operation resolution
// ---------------------------------------------------------------------------

export type DispatchRefusal =
  | "malformed-request"
  | "unknown-operation"
  | "operation-not-dispatchable";

/**
 * Resolve a request's `operationId` against the committed registry.
 * Fail-closed in the same order as `negotiate()`: shape first, then
 * existence, then the three-axis dispatchable derivation. A request
 * for an `implemented-unverified` or `inventory-only` entry refuses —
 * negotiation compatibility is point-in-time and never substitutes
 * for per-operation evidence.
 */
export function resolveDispatchOperation(
  operationId: unknown,
): { ok: true; entry: OperationEntry } | { ok: false; refusal: DispatchRefusal } {
  if (typeof operationId !== "string" || operationId.length === 0) {
    return { ok: false, refusal: "malformed-request" };
  }
  const entry = findOperation(operationId);
  if (!entry) return { ok: false, refusal: "unknown-operation" };
  if (!isDispatchableEntry(entry)) {
    return { ok: false, refusal: "operation-not-dispatchable" };
  }
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// Validators — shape + vocabulary only, never truth
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function validateDispatchSessionPin(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["session is not an object"];
  if (!isNonEmptyString(value.sessionId)) errors.push("session.sessionId must be a non-empty string");
  if (!isNonEmptyString(value.aeVersion)) errors.push("session.aeVersion must be a non-empty string");
  if (value.sdkRelease !== undefined) {
    if (!isRecord(value.sdkRelease) ||
        !isNonEmptyString(value.sdkRelease.identifier) ||
        !isNonEmptyString(value.sdkRelease.distribution)) {
      errors.push("session.sdkRelease must carry identifier and distribution strings");
    }
  }
  return errors;
}

/**
 * Validate an untrusted value as a `DispatchRequest`. Returns the list
 * of problems; empty means structurally valid. Registry-state
 * enforcement is `resolveDispatchOperation`'s job — this checks shape
 * and the argument codec only.
 */
export function validateDispatchRequest(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["request is not an object"];
  if (value.schema !== DISPATCH_SCHEMA) {
    errors.push(`schema ${JSON.stringify(value.schema)} is not ${DISPATCH_SCHEMA}`);
  }
  if (!isNonEmptyString(value.requestId)) errors.push("requestId must be a non-empty string");
  errors.push(...validateDispatchSessionPin(value.session).map((e) => `session: ${e}`));
  if (typeof value.operationId !== "string" || value.operationId.length === 0) {
    errors.push("operationId must be a non-empty string");
  }
  if (value.args !== undefined && !isDispatchArgValue(value.args)) {
    errors.push("args must be in the ES3-serializable set (null/boolean/finite number/string/array/plain object)");
  }
  if (value.authorizationRef !== undefined && !isNonEmptyString(value.authorizationRef)) {
    errors.push("authorizationRef must be a non-empty string when present");
  }
  return errors;
}

/**
 * Validate an untrusted value as a `DispatchResult`. Shape and
 * vocabulary only — a `completed` outcome here is a claim, not
 * evidence; promotion still requires the probe-result artifact rules
 * in `native-probe-result.md`.
 */
export function validateDispatchResult(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["result is not an object"];
  if (value.schema !== DISPATCH_SCHEMA) {
    errors.push(`schema ${JSON.stringify(value.schema)} is not ${DISPATCH_SCHEMA}`);
  }
  if (!isNonEmptyString(value.requestId)) errors.push("requestId must be a non-empty string");
  if (typeof value.outcome !== "string" ||
      !(DISPATCH_OUTCOMES as readonly string[]).includes(value.outcome)) {
    errors.push(`outcome must be one of ${DISPATCH_OUTCOMES.join("|")}`);
  }
  if (value.refusalCode !== undefined && !isNonEmptyString(value.refusalCode)) {
    errors.push("refusalCode must be a non-empty string when present");
  }
  if (value.result !== undefined && !isDispatchArgValue(value.result)) {
    errors.push("result must be in the ES3-serializable set");
  }
  if (value.mayHaveMutated !== undefined && typeof value.mayHaveMutated !== "boolean") {
    errors.push("mayHaveMutated must be a boolean when present");
  }
  if (value.opCalls !== undefined) {
    if (!Array.isArray(value.opCalls) || !value.opCalls.every(isNonEmptyString)) {
      errors.push("opCalls must be an array of non-empty strings when present");
    }
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    errors.push("detail must be a string when present");
  }
  // Cross-field rules from trusted-execution.md §4.
  if (value.outcome === "refused" && value.refusalCode === undefined) {
    errors.push("outcome=refused requires refusalCode");
  }
  if (value.outcome === "completed" && value.result === undefined) {
    errors.push("outcome=completed requires result");
  }
  if ((value.outcome === "unknown" || value.outcome === "failed") &&
      value.mayHaveMutated === undefined) {
    errors.push(`outcome=${String(value.outcome)} requires mayHaveMutated (true when atomicity is unproven)`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Retry semantics — trusted-execution.md §3/§4
// ---------------------------------------------------------------------------

/**
 * True when the outcome leaves the request's effect on AE state
 * ambiguous — `unknown` always, and `failed` when the result reports
 * `mayHaveMutated: true` (atomicity unproven). Such outcomes are NEVER
 * auto-retried: the client records the request artifact and requires
 * manual reconciliation. Only `not-sent` (environment-proven
 * non-dispatch) and terminal `refused`/`completed`/`failed`-without-
 * mutation are unambiguous — and even those are re-issued as NEW
 * requests, never resent.
 *
 * `mayHaveMutated` is only meaningful for `failed`/`unknown` results
 * (the validator requires it there); callers pass the result's flag
 * through. For `unknown` the flag is advisory — reconciliation is
 * required regardless of its value.
 */
export function outcomeRequiresReconciliation(
  outcome: DispatchOutcome,
  mayHaveMutated?: boolean,
): boolean {
  return outcome === "unknown" || (outcome === "failed" && mayHaveMutated === true);
}
