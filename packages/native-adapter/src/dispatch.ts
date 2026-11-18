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
 * True when `value` belongs to the ES3-serializable set: null,
 * boolean, finite number, string, array of serializables, or plain
 * object with serializable values. `undefined`, functions, symbols,
 * non-finite numbers, and non-plain objects are rejected — inside the
 * ES3 host there is no `JSON` to silently collapse them.
 */
export function isDispatchArgValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isDispatchArgValue);
      if (!isPlainObject(value)) return false;
      return Object.values(value).every(isDispatchArgValue);
    default:
      return false;
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
 * ambiguous. Such outcomes are NEVER auto-retried: the client records
 * the request artifact and requires manual reconciliation. Only
 * `not-sent` (environment-proven non-dispatch) and terminal
 * `refused`/`completed`/`failed`-without-mutation are unambiguous —
 * and even those are re-issued as NEW requests, never resent.
 */
export function outcomeRequiresReconciliation(outcome: DispatchOutcome): boolean {
  return outcome === "unknown";
}
