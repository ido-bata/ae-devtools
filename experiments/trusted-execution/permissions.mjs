/**
 * permissions.mjs — CAP025 permission classes + consent scope (Issue #14).
 *
 * Reference implementation of design note §1–§3, transport-independent:
 * pure functions over plain data. It assumes the catalog dispatch gate
 * (`assertDispatchAllowed` in packages/capability-catalog) has already
 * passed — this module adds the *class* layer on top: which consent a
 * dispatch owes, and whether the presented consent covers exactly this
 * dispatch.
 *
 * Evidence level: automated-test / fake only. No transport, no token
 * issuance, no AE.
 *
 * Consent authenticity boundary: `authorizeExecution` checks consent
 * *scope equality* only. A consent token here is unauthenticated plain
 * data — issuance, signing and verification against a trusted authority
 * are out of scope (ADR-0005 / ae-a8n #97–#99). A structurally valid but
 * forged scope passes this layer by design; this module is the fake-level
 * reference for the rule, not production authorization.
 */
import { createHash } from "node:crypto";

export const EXECUTION_CLASSES = [
  "read-only",
  "intentional-write",
  "trusted-dev-script",
];

/** Catalog `Permission` values this module reasons about (handshake.ts). */
export const PERMISSIONS = ["read", "write", "execute", "build-test", "host-callback"];

/**
 * Resolve the execution class a dispatch exercises, from the advertised
 * capability record and the permission the dispatch declares.
 *
 * @param {object} advertisement  CapabilityAdvertisement-shaped row
 *   ({ access, risk: { trust }, execution: { class } }) — the fields the
 *   handshake advertises plus catalog axes the note maps onto.
 * @param {string} permission     declared Permission for this dispatch
 * @returns {string|null} one of EXECUTION_CLASSES, or null when the
 *   permission/class combination has no defined consent rule (fail closed).
 */
export function executionClassFor(advertisement, permission) {
  if (!advertisement || typeof advertisement !== "object") return null;
  const trust = advertisement.risk?.trust;
  const execClass = advertisement.execution?.class;

  if (permission === "read") {
    // Reads are read-only regardless of the row's wider access class.
    return "read-only";
  }
  if (permission === "write") {
    const access = advertisement.access;
    if (access === "write" || access === "read-write") return "intentional-write";
    return null; // write permission on a non-write row: undefined, refuse
  }
  if (permission === "execute") {
    // Only ExtendScript execution maps to trusted-dev-script today; native
    // execute paths (aegp-native etc.) have no consent rule yet — fail closed.
    if (execClass === "extendscript" || trust === "privileged-dev-code") {
      return "trusted-dev-script";
    }
    return null;
  }
  return null; // build-test / host-callback / unknown: no generic dispatch consent
}

/** Consent each class owes (design note §1 table, Consent column). */
export const CONSENT_REQUIREMENT = {
  "read-only": "session-pin",
  "intentional-write": "per-dispatch",
  "trusted-dev-script": "explicit-opt-in",
};

// ---------------------------------------------------------------------
// Consent scope: (session pin, operation id, argument hash, project)
// ---------------------------------------------------------------------

/**
 * Deterministic encoding for hashing. Every JS value maps to a distinct
 * preimage — values JSON.stringify would collapse (NaN/±Infinity → null,
 * undefined/function → dropped or "") get `#`-sentinels that cannot be
 * produced by any other type: strings are always `"`-quoted, objects `{`,
 * arrays `[`, and the JSON literals/null/finite numbers never start with
 * `#`. Non-plain objects (Date, host objects, class instances) collapse
 * to a type-tag sentinel rather than "{}" — two different Dates still
 * collide with each other, which is acceptable for consent hashing (they
 * cannot cross the codec boundary anyway).
 *
 * `-0` encodes as `0`, matching JSON wire semantics: over the wire -0 and
 * 0 are the same value.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "#num:NaN#";
      if (value === Infinity) return "#num:+Infinity#";
      if (value === -Infinity) return "#num:-Infinity#";
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      return "#undef#";
    case "bigint":
      return "#bigint:" + value.toString() + "#";
    case "function":
    case "symbol":
      return "#nondata:" + typeof value + "#";
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map(canonicalJson).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return "#object:" + Object.prototype.toString.call(value) + "#";
      }
      const keys = Object.keys(value).sort();
      return (
        "{" +
        keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") +
        "}"
      );
    }
  }
  // Unreachable for the typeof domain; kept so the function is total.
  return "#unknown#";
}

export function argumentHash(args) {
  return createHash("sha256").update(canonicalJson(args ?? null)).digest("hex");
}

/**
 * The consent scope a dispatch must present. Session pin binds
 * {sessionId, aeVersion, dispatchId} — the probe's pinned identity.
 * `projectIdentity` is required for write classes (design §3): consent
 * issued against project A never applies after project change.
 */
export function consentScopeFor({ pin, operationId, args, projectIdentity }) {
  if (!pin || typeof pin.sessionId !== "string" || pin.sessionId.length === 0) {
    throw new Error("consent scope requires a session pin with sessionId");
  }
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new Error("consent scope requires a non-empty operation id");
  }
  return {
    sessionPin: {
      sessionId: pin.sessionId,
      aeVersion: pin.aeVersion ?? null,
      dispatchId: pin.dispatchId ?? null,
    },
    operationId,
    argumentHash: argumentHash(args),
    projectIdentity: projectIdentity ?? null,
  };
}

/**
 * Shape check for a *presented* consent scope — the trust boundary the
 * catalog gate calls "structurally malformed refuses rather than throws".
 * A scope that is not exactly this shape is malformed consent, not a
 * mismatch: callers get CONSENT_REQUIRED, never an exception.
 */
function isConsentScopeShape(scope) {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return false;
  const pin = scope.sessionPin;
  if (pin === null || typeof pin !== "object" || Array.isArray(pin)) return false;
  if (typeof pin.sessionId !== "string" || pin.sessionId.length === 0) return false;
  if (typeof scope.operationId !== "string" || scope.operationId.length === 0) return false;
  if (typeof scope.argumentHash !== "string" || scope.argumentHash.length === 0) return false;
  if (scope.projectIdentity !== null && typeof scope.projectIdentity !== "string") return false;
  return true;
}

function sameScope(a, b) {
  return (
    a.sessionPin.sessionId === b.sessionPin.sessionId &&
    a.sessionPin.aeVersion === b.sessionPin.aeVersion &&
    a.sessionPin.dispatchId === b.sessionPin.dispatchId &&
    a.operationId === b.operationId &&
    a.argumentHash === b.argumentHash &&
    a.projectIdentity === b.projectIdentity
  );
}

// ---------------------------------------------------------------------
// Dispatch authorization (post-catalog-gate layer)
// ---------------------------------------------------------------------

/**
 * @param {object} input
 *   advertisement — catalog advertisement row (see executionClassFor)
 *   permission     — Permission the dispatch declares
 *   pin            — session pin the dispatch targets {sessionId, aeVersion?, dispatchId?}
 *   operationId    — catalog operation/capability id being dispatched
 *   args           — dispatch arguments (hashed into the consent scope)
 *   projectIdentity— identity of the project the dispatch acts on
 *   consent        — presented consent token: { scope, optIn? } or null
 *   trustedScriptOptIn — explicit operator opt-in for trusted-dev-script
 * @returns {{status:"pass"}|{status:"refused",reason:string,detail:string}}
 */
export function authorizeExecution(input) {
  const refuse = (reason, detail) => ({ status: "refused", reason, detail });

  if (input === null || typeof input !== "object") {
    return refuse("MALFORMED_REQUEST", "dispatch input is not an object");
  }

  const cls = executionClassFor(input.advertisement, input.permission);
  if (cls === null) {
    return refuse(
      "UNSUPPORTED_CLASS",
      `no consent rule for permission=${input.permission} on this capability`,
    );
  }

  const requirement = CONSENT_REQUIREMENT[cls];
  if (requirement === "session-pin") {
    // Read-only: the session pin itself is the consent. A dispatch that
    // cannot name its pin has no target identity — refuse.
    if (!input.pin || typeof input.pin.sessionId !== "string" || input.pin.sessionId.length === 0) {
      return refuse("CONSENT_REQUIRED", "read-only dispatch requires a session pin");
    }
    return { status: "pass" };
  }

  // Write classes: consent must cover exactly this dispatch's scope.
  // A malformed pin or operation id is a typed refusal, never a throw —
  // same fail-closed discipline as the catalog gate's malformed-response.
  let scope;
  try {
    scope = consentScopeFor({
      pin: input.pin,
      operationId: input.operationId,
      args: input.args,
      projectIdentity: input.projectIdentity,
    });
  } catch (err) {
    return refuse("CONSENT_REQUIRED", err instanceof Error ? err.message : String(err));
  }

  if (cls === "trusted-dev-script") {
    // Explicit opt-in is a separate flag, never implied by consent shape.
    if (input.trustedScriptOptIn !== true) {
      return refuse(
        "CONSENT_REQUIRED",
        "trusted-dev-script requires an explicit operator opt-in flag",
      );
    }
    if (typeof input.scriptProvenance !== "string" || input.scriptProvenance.length === 0) {
      return refuse(
        "CONSENT_REQUIRED",
        "trusted-dev-script requires a script provenance declaration",
      );
    }
  }

  if (input.consent == null || typeof input.consent !== "object") {
    return refuse("CONSENT_REQUIRED", `${cls} dispatch requires a consent token`);
  }
  const presented = input.consent.scope;
  if (!isConsentScopeShape(presented)) {
    return refuse("CONSENT_REQUIRED", "consent token carries no well-formed scope");
  }
  if (!sameScope(scope, presented)) {
    return refuse(
      "CONSENT_SCOPE_MISMATCH",
      "consent scope does not match this dispatch (session/operation/args/project)",
    );
  }
  if (cls === "intentional-write" && scope.projectIdentity === null) {
    return refuse(
      "CONSENT_REQUIRED",
      "intentional-write requires a project identity in the consent scope",
    );
  }
  return { status: "pass" };
}
