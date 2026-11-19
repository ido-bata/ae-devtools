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
  "AEGP_ItemSuite9.AEGP_GetTypeName",
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

export type NativeIntakeArgConstraint = {
  kind: "integer";
  /** Inclusive bounds on the integer value. */
  min: number;
  max: number;
};

/** operationId → exact arg-name → constraint map. Absent = zero-arg op. */
export const NATIVE_INTAKE_ARG_SCHEMAS: Readonly<
  Record<string, Readonly<Record<string, NativeIntakeArgConstraint>>>
> = {
  "AEGP_ItemSuite9.AEGP_GetTypeName": {
    itemType: { kind: "integer", min: 1, max: 4 },
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
    const v = args[k];
    if (spec.kind === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        errors.push(`argument "${k}" must be an integer`);
      } else if (v < spec.min || v > spec.max) {
        errors.push(`argument "${k}" must be in [${spec.min}, ${spec.max}]`);
      }
    }
  }
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
