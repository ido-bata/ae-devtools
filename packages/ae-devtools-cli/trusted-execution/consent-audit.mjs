/*
 * consent-audit.mjs — durable consent-decision audit log (Issue #277,
 * CAP052 audit chain).
 *
 * Records WHO/WHAT/WHEN a consentProvider decided — for BOTH approved
 * and refused outcomes — as append-only JSONL. This closes the gap
 * where dispatch-store records the dispatch identity but nothing
 * durably records the consent decision itself, and where a consent
 * refusal leaves no trace at all.
 *
 * Contract:
 *   - append-only: events are never overwritten or compacted; process
 *     restart simply keeps appending to the same file
 *   - minimal fields only: decision, opId, scope fingerprint,
 *     dispatch identity key, requestId, timestamps. NEVER script
 *     source, raw arguments, tokens, secrets, operator identity
 *     claims, or unverified free-text reasons
 *   - an audit record is NOT an authorization proof: it complements
 *     dispatch-store (dispatch identity/outcome) but does not replace
 *     ae-a8n-owned consent-token authenticity or host-side
 *     authorization (explicit non-claims, runner.mjs header)
 *   - concurrency: each event is a single appendFileSync line write;
 *     POSIX O_APPEND keeps concurrent appends from interleaving for
 *     line-sized payloads. Correlation is by content (dispatchKey /
 *     requestId / scopeHash), never by position
 *
 * Evidence level: automated-test / contract only. No AE involved.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const CONSENT_AUDIT_SCHEMA = "ae-devtools.consent-audit/v1";
export const CONSENT_AUDIT_FILE = "consent-audit.jsonl";

const DECISIONS = new Set(["approved", "refused"]);
const SHA256_RE = /^[0-9a-f]{64}$/;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * Stable fingerprint of a consent scope — sha256 over canonical JSON.
 * Binds the audit event to exactly the scope the provider approved or
 * refused WITHOUT storing the scope's argument material (argumentHash
 * is already a hash upstream; session pin ids are pseudonymous).
 */
export function scopeFingerprint(scope) {
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
}

function iso() {
  return new Date().toISOString();
}

function validateEntry(entry) {
  if (!DECISIONS.has(entry.decision)) {
    throw new Error(`consent-audit: decision must be approved|refused, got ${JSON.stringify(entry.decision)}`);
  }
  if (typeof entry.opId !== "string" || entry.opId.length === 0) {
    throw new Error("consent-audit: opId is required");
  }
  if (typeof entry.scopeHash !== "string" || !SHA256_RE.test(entry.scopeHash)) {
    throw new Error("consent-audit: scopeHash must be a sha256 hex fingerprint");
  }
  if (entry.dispatchKey !== undefined && entry.dispatchKey !== null) {
    if (typeof entry.dispatchKey !== "string" || !SHA256_RE.test(entry.dispatchKey)) {
      throw new Error("consent-audit: dispatchKey must be a sha256 hex identity");
    }
  }
  for (const k of ["requestId"]) {
    if (entry[k] !== undefined && entry[k] !== null && typeof entry[k] !== "string") {
      throw new Error(`consent-audit: ${k} must be a string or null`);
    }
  }
}

function toRecord(entry) {
  return {
    schema: CONSENT_AUDIT_SCHEMA,
    at: iso(),
    decision: entry.decision,
    opId: entry.opId,
    scopeHash: entry.scopeHash,
    dispatchKey: entry.dispatchKey ?? null,
    requestId: entry.requestId ?? null,
    mutating: entry.mutating === true,
    destructive: entry.destructive === true,
  };
}

function parseLine(line, lineNo) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    throw new Error(`consent-audit: corrupt record at line ${lineNo}`);
  }
  if (rec === null || typeof rec !== "object" || rec.schema !== CONSENT_AUDIT_SCHEMA) {
    throw new Error(`consent-audit: unexpected record shape at line ${lineNo}`);
  }
  return rec;
}

/**
 * @param {object} deps
 *   dir — directory holding consent-audit.jsonl (created if absent)
 * @returns {{ file: string,
 *   recordConsentDecision(entry): object,
 *   readConsentDecisions(): object[] }}
 *
 * recordConsentDecision(entry) — entry must carry:
 *   decision   — "approved" | "refused" (required)
 *   opId       — registry operation id (required, non-empty string)
 *   scopeHash  — scopeFingerprint() output, 64 lowercase hex (required)
 *   dispatchKey— dispatchIdentity() output, 64 lowercase hex (optional
 *                but expected; correlates with dispatch-store records)
 *   requestId  — caller-chosen dispatch request id (optional)
 *   mutating / destructive — op classification booleans (optional)
 * `at` (ISO timestamp) and `schema` are stamped by the store, not the
 * caller, so event time cannot be forged by the recording layer.
 * Throws on I/O failure or malformed entry — callers decide the
 * failure semantics (execute.mjs fails closed on the approved path).
 */
export function createConsentAudit({ dir } = {}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("consent-audit: dir is required");
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CONSENT_AUDIT_FILE);

  function recordConsentDecision(entry = {}) {
    validateEntry(entry);
    const record = toRecord(entry);
    // Single append write: O_APPEND keeps concurrent writers from
    // interleaving line payloads; no fsync — crash-loss semantics are
    // the same as every other audit log on this platform (best effort
    // durability, never claimed as transactional).
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  function readConsentDecisions() {
    return readConsentAuditFile(file);
  }

  return { file, recordConsentDecision, readConsentDecisions };
}

/**
 * Deferred store: same recordConsentDecision contract, but the
 * directory is only created on the FIRST recorded decision — surfaces
 * that may never dispatch (MCP server idle, read-only commands) must
 * not mint an audit directory as a side effect of startup.
 */
export function lazyConsentAudit(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("consent-audit: dir is required");
  }
  let store = null;
  return {
    get file() { return store === null ? join(dir, CONSENT_AUDIT_FILE) : store.file; },
    recordConsentDecision(entry) {
      if (store === null) store = createConsentAudit({ dir });
      return store.recordConsentDecision(entry);
    },
    readConsentDecisions() {
      if (store === null) store = createConsentAudit({ dir });
      return store.readConsentDecisions();
    },
  };
}

/**
 * Reader for paths outside a store instance (diagnose, tests). Throws
 * on corrupt lines — a partial audit log must never be silently
 * truncated into a "clean" history.
 */
export function readConsentAuditFile(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const records = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    records.push(parseLine(lines[i], i + 1));
  }
  return records;
}
