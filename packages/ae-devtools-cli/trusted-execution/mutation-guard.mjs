/**
 * mutation-guard.mjs — CAP027 groundwork (Issue #14).
 *
 * Reference implementation of design note §3: snapshot identity
 * descriptors, project-identity scoping, and retry policy. Pure functions
 * over plain data; the "snapshot" is a plain tree standing in for the AE
 * project — real host-object walking is a later, transport-bound unit.
 *
 * Evidence level: automated-test / fake only.
 */

/**
 * Resolve an aeRef descriptor against a project snapshot.
 *
 * Snapshot shape (plain data):
 *   { projectIdentity: "<id>",
 *     items: [ { type: "<tag>", name: "<str>", contentHash?: "<str>",
 *                items?: [...] }, ... ] }
 * `descriptor.path` indexes into `items` arrays level by level
 * (path[0] → root item index, path[1] → its first child index, ...).
 *
 * @returns {{status:"resolved",node:object}|{status:"refused",reason:"INVALID_REFERENCE"|"STALE_REFERENCE",detail:string}}
 *   A descriptor whose *shape* violates the aeRef contract (codec §2:
 *   type + name + index path, optional contentHash) is INVALID_REFERENCE —
 *   a caller bug, refused before any lookup. A well-formed descriptor that
 *   fails to resolve against the current snapshot is STALE_REFERENCE —
 *   never a best-effort re-resolution (design §3).
 */
export function resolveDescriptor(descriptor, snapshot) {
  const invalid = (detail) => ({ status: "refused", reason: "INVALID_REFERENCE", detail });
  const ref = descriptor?.aeRef;
  if (ref === null || ref === undefined || typeof ref !== "object" || Array.isArray(ref)) {
    return invalid("not an aeRef descriptor");
  }
  if (typeof ref.type !== "string" || ref.type.length === 0) {
    return invalid("aeRef.type must be a non-empty string");
  }
  if (typeof ref.name !== "string") {
    return invalid("aeRef.name must be a string");
  }
  if (!Array.isArray(ref.path)) {
    return invalid("aeRef.path must be an array of indices");
  }
  for (const idx of ref.path) {
    if (!Number.isInteger(idx) || idx < 0) {
      return invalid(`aeRef.path entry ${JSON.stringify(idx)} is not a non-negative integer`);
    }
  }
  if (ref.contentHash !== undefined && typeof ref.contentHash !== "string") {
    return invalid("aeRef.contentHash must be a string");
  }
  if (!Array.isArray(snapshot?.items)) {
    return { status: "refused", reason: "STALE_REFERENCE", detail: "snapshot has no items" };
  }
  let level = snapshot.items;
  let node = null;
  for (let i = 0; i < ref.path.length; i++) {
    const idx = ref.path[i];
    if (idx >= level.length) {
      return {
        status: "refused",
        reason: "STALE_REFERENCE",
        detail: `path index ${idx} out of range at depth ${i}`,
      };
    }
    node = level[idx];
    if (i < ref.path.length - 1) {
      if (!Array.isArray(node?.items)) {
        return {
          status: "refused",
          reason: "STALE_REFERENCE",
          detail: `path descends into non-container at depth ${i}`,
        };
      }
      level = node.items;
    }
  }
  if (ref.path.length === 0) {
    return { status: "refused", reason: "STALE_REFERENCE", detail: "empty index path" };
  }
  if (node === null || typeof node !== "object") {
    return { status: "refused", reason: "STALE_REFERENCE", detail: "path resolved to nothing" };
  }
  if (node.type !== ref.type) {
    return {
      status: "refused",
      reason: "STALE_REFERENCE",
      detail: `type mismatch: descriptor ${ref.type} vs snapshot ${node.type}`,
    };
  }
  if (node.name !== ref.name) {
    return {
      status: "refused",
      reason: "STALE_REFERENCE",
      detail: `name mismatch: descriptor ${JSON.stringify(ref.name)} vs snapshot ${JSON.stringify(node.name)}`,
    };
  }
  if (ref.contentHash !== undefined) {
    if (node.contentHash === undefined) {
      return {
        status: "refused",
        reason: "STALE_REFERENCE",
        detail: "descriptor carries contentHash but snapshot node has none",
      };
    }
    if (node.contentHash !== ref.contentHash) {
      return {
        status: "refused",
        reason: "STALE_REFERENCE",
        detail: "content hash mismatch — object changed since descriptor was issued",
      };
    }
  }
  return { status: "resolved", node };
}

/**
 * Guard a mutating dispatch: the target descriptor must resolve in the
 * *current* snapshot, and the dispatch's project identity must match the
 * snapshot's. Consent scope (permissions.mjs) is checked separately —
 * this guard answers "is the target still what the caller meant".
 *
 * @returns {{status:"pass",node:object}|{status:"refused",reason:string,detail:string}}
 */
export function guardMutation({ descriptor, snapshot, projectIdentity }) {
  if (snapshot?.projectIdentity == null) {
    return { status: "refused", reason: "PROJECT_UNKNOWN", detail: "snapshot carries no project identity" };
  }
  if (projectIdentity == null) {
    return { status: "refused", reason: "PROJECT_UNKNOWN", detail: "dispatch carries no project identity" };
  }
  if (projectIdentity !== snapshot.projectIdentity) {
    return {
      status: "refused",
      reason: "PROJECT_MISMATCH",
      detail: `dispatch project ${projectIdentity} != snapshot project ${snapshot.projectIdentity}`,
    };
  }
  return resolveDescriptor(descriptor, snapshot);
}

/**
 * Retry policy for an operation manifest row.
 *
 * Design §3 / probe outcome model: `UNKNOWN` is quarantined and never
 * resent for ANY operation — `idempotent: false` additionally bars even a
 * deliberate re-issue without new authorization. This function only
 * classifies; it never performs a retry.
 *
 * @param {{outcome:string, idempotent?:boolean}} input
 * @returns {"quarantine"|"new-request-after-reauth"}
 */
export function retryDecision({ outcome, idempotent }) {
  if (outcome === "UNKNOWN") return "quarantine";
  if (outcome === "BLOCKED" || outcome === "REFUSED" || outcome === "not-sent" || outcome === "refused") {
    // Terminal pre-dispatch outcomes may be re-issued only as a NEW request
    // after new authorization and state check (catalog contract §5).
    return "new-request-after-reauth";
  }
  // COMPLETED / FAILED / completed / failed: new intent required.
  return "quarantine";
}
