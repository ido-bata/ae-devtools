/**
 * dispatch-store.mjs — cross-instance dispatch dedup/quarantine store
 * (Issue #255, spec FR-07).
 *
 * The runner's requestId single-use and UNKNOWN quarantine live in
 * instance memory: a second createJsxRunner() on the same transport —
 * or a restarted process — could re-send a dispatch whose outcome was
 * never proven. This module is the durable half: a filesystem store
 * keyed by a stable DISPATCH IDENTITY, shared by every runner that
 * opts in.
 *
 * Dispatch identity (single owner — runner.mjs computes it via
 * dispatchIdentity()):
 *
 *   { sessionPin: {sessionId, aeVersion, dispatchId},
 *     operationId, argumentHash(evalConsentArgs(source, args)),
 *     projectIdentity }
 *
 * i.e. exactly the consent-scope material, hashed with the SAME
 * canonicalJson/argumentHash machinery permissions.mjs owns — no
 * second hash, no drift. Entries are scoped to the session pin, so
 * unrelated sessions/runs can never collide.
 *
 * Backend: one JSON file per identity under `dir`
 * (`<dir>/<identityHash>.json`), written tmp+rename (atomic on POSIX).
 * Per-identity files mean no read-modify-write of a shared map — the
 * documented concurrency model is single-writer per session; two
 * processes writing the SAME identity concurrently is outside the
 * contract (last writer wins, both were attempting the same dispatch).
 *
 * Record states and their gate semantics:
 *
 *   in-flight  — recorded BEFORE send; no settled outcome yet.
 *                A fresh in-flight record blocks re-dispatch (one
 *                in-flight per identity). An in-flight record FOUND at
 *                lookup means a previous dispatch never settled —
 *                crash/mid-send — and is treated as unresolved:
 *                fail-closed, it blocks until explicitly resolved.
 *   completed  — settled COMPLETED. Does NOT block re-dispatch: an
 *                identical read/verify may legitimately run again; the
 *                record is updated, never treated as quarantine.
 *   failed     — settled FAILED (host proved non-mutation or reported
 *                error). Same non-blocking semantics as completed.
 *   unknown    — settled UNKNOWN. QUARANTINE: blocks re-dispatch of
 *                this identity until `resolve()` is called explicitly.
 *                This is the FR-07 guarantee across instances.
 *   resolved   — explicit operator resolution of a quarantine;
 *                non-blocking, like completed/failed.
 *
 * Corruption: an unreadable/malformed record file is NOT "no record" —
 * it blocks (fail closed). A missing dir/file means "no record".
 *
 * Failure handling: every method is async and surfaces I/O errors to
 * the caller; the runner decides the policy (refuse for dispatches it
 * cannot prove safe — see runner.mjs).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// canonicalJson/argumentHash are the SAME machinery the consent scope
// hashes with — the dispatch identity must never drift from it.
// permissions.mjs does not import this module: no cycle.
import { argumentHash as argumentHashLocal, canonicalJson as canonicalJsonLocal } from "./permissions.mjs";

export const DISPATCH_STORE_SCHEMA = "ae-devtools.dispatch-store/v1";

/** States that BLOCK a new dispatch of the same identity. */
export const BLOCKING_STATES = new Set(["in-flight", "unknown"]);

/**
 * Default store location — same convention as session-guard's
 * RUNS_DIR: tmpdir survives process restarts (the cross-instance case
 * this store exists for) without persisting forever. Override with
 * AE_DEVTOOLS_DISPATCH_STORE_DIR (tests, or a deployment that wants a
 * durable user-cache location).
 */
export function defaultDispatchStoreDir() {
  return process.env.AE_DEVTOOLS_DISPATCH_STORE_DIR
    ?? join(tmpdir(), "ae-devtools-dispatch-store");
}

/**
 * Stable dispatch identity for one runScript input. Hash of the
 * canonical consent-scope material — see header. Returns a hex string;
 * safe as a filename.
 *
 * @param {object} input — { pin, operationId, args (already the
 *   evalConsentArgs payload), projectIdentity }
 */
export function dispatchIdentity({ pin, operationId, args, projectIdentity }) {
  const material = {
    sessionPin: {
      sessionId: pin?.sessionId ?? null,
      aeVersion: pin?.aeVersion ?? null,
      dispatchId: pin?.dispatchId ?? null,
    },
    operationId: operationId ?? null,
    argumentHash: args === undefined ? null : argumentHashLocal(args),
    projectIdentity: projectIdentity ?? null,
  };
  return createHash("sha256").update(canonicalJsonLocal(material)).digest("hex");
}

function recordPath(dir, key) {
  // key is a sha256 hex from dispatchIdentity — filename-safe by
  // construction; still assert so a future caller cannot traverse.
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`dispatch-store: refusing non-identity key ${JSON.stringify(key)}`);
  }
  return join(dir, `${key}.json`);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * @param {object} opts
 *   dir  — store directory (required; callers use
 *          defaultDispatchStoreDir() or an explicit test dir)
 *   now  — clock injection for tests (default Date.now)
 */
export function createDispatchStore({ dir, now = () => Date.now() } = {}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("createDispatchStore: dir is required");
  }
  mkdirSync(dir, { recursive: true });

  function iso() {
    return new Date(now()).toISOString();
  }

  /**
   * Read the record for `key`.
   * @returns {Promise<{status:"none"|"ok"|"corrupt", record?:object}>}
   */
  async function lookup(key) {
    const path = recordPath(dir, key);
    if (!existsSync(path)) return { status: "none" };
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record === null || typeof record !== "object" || record.schema !== DISPATCH_STORE_SCHEMA) {
        return { status: "corrupt" };
      }
      return { status: "ok", record };
    } catch {
      return { status: "corrupt" };
    }
  }

  /**
   * Gate + record a dispatch BEFORE it is sent.
   *
   * @param {string} key — dispatchIdentity() output
   * @param {object} meta — { requestId, operationId }
   * @returns {Promise<{allowed:true, record:object}|
   *   {allowed:false, reason:string, state:string|null}>}
   *   Throws on store I/O failure — the runner maps that to a
   *   fail-closed refusal (a dispatch it cannot dedup-prove is not sent).
   */
  async function begin(key, { requestId, operationId = null } = {}) {
    const found = await lookup(key);
    if (found.status === "corrupt") {
      return {
        allowed: false,
        reason: "DISPATCH_STORE_CORRUPT",
        state: null,
        detail: "dispatch-store record is unreadable; refusing rather than risking a double-dispatch",
      };
    }
    if (found.status === "ok" && BLOCKING_STATES.has(found.record.state)) {
      return {
        allowed: false,
        reason: found.record.state === "unknown" ? "DISPATCH_QUARANTINED" : "DISPATCH_UNRESOLVED",
        state: found.record.state,
        detail: `identity already has a ${found.record.state} dispatch (requestId ${found.record.requestId ?? "?"}); resolve it explicitly before re-dispatching`,
        record: found.record,
      };
    }
    const record = {
      schema: DISPATCH_STORE_SCHEMA,
      key,
      state: "in-flight",
      requestId: typeof requestId === "string" ? requestId : null,
      operationId,
      dispatchedAt: iso(),
      settledAt: null,
      outcome: null,
      resolution: null,
    };
    atomicWriteJson(recordPath(dir, key), record);
    return { allowed: true, record };
  }

  /**
   * Settle an in-flight dispatch with its classified outcome.
   * outcome: "COMPLETED" | "FAILED" | "UNKNOWN" (wire spelling, same as
   * the runner's classified.outcome). Anything unrecognized settles as
   * "unknown" — fail-closed, never silently completed.
   *
   * Best-effort by contract: the dispatch already happened, so a write
   * failure cannot un-send it — it throws so the runner can record the
   * degradation honestly on the result.
   */
  async function settle(key, { requestId, outcome } = {}) {
    const state =
      outcome === "COMPLETED" ? "completed"
      : outcome === "FAILED" ? "failed"
      : "unknown";
    const found = await lookup(key);
    const prior = found.status === "ok" ? found.record : {};
    const record = {
      ...prior,
      schema: DISPATCH_STORE_SCHEMA,
      key,
      state,
      requestId: typeof requestId === "string" ? requestId : (prior.requestId ?? null),
      dispatchedAt: prior.dispatchedAt ?? null,
      settledAt: iso(),
      outcome: typeof outcome === "string" ? outcome : null,
    };
    atomicWriteJson(recordPath(dir, key), record);
    return record;
  }

  /**
   * Explicitly resolve a quarantined/unresolved identity — the ONLY way
   * a blocked identity becomes dispatchable again. Records who/when;
   * the resolution itself is the audit trail.
   */
  async function resolve(key, { note = null } = {}) {
    const found = await lookup(key);
    if (found.status !== "ok") {
      return { resolved: false, reason: found.status === "corrupt" ? "corrupt" : "no-record" };
    }
    const record = {
      ...found.record,
      state: "resolved",
      settledAt: found.record.settledAt ?? iso(),
      resolution: { at: iso(), note: typeof note === "string" ? note : null },
    };
    atomicWriteJson(recordPath(dir, key), record);
    return { resolved: true, record };
  }

  /** Test/diagnostic helper: remove one identity's record. */
  async function clear(key) {
    const path = recordPath(dir, key);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  return { dir, lookup, begin, settle, resolve, clear };
}
