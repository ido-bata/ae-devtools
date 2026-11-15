/**
 * schema.mjs — unified AE diagnostics record (Issue #37, CAP061).
 *
 * One record model for every reachable failure/diagnostic source:
 * script exceptions, expression errors, panel logs, native crashes,
 * plugin load failures, render failures and transport outcomes.
 *
 * Invariants (enforced here, not just documented):
 *   - recordVersion is exact-match; unknown versions are refused, never
 *     coerced (same discipline as the conformance evidence record).
 *   - kind/severity are closed enums; anything else is refused.
 *   - message is required and non-empty.
 *   - source positions are optional but, when present, must be
 *     well-formed. Absent fields stay absent — a collector may NOT
 *     fabricate a position it did not observe. `hostReported` marks
 *     positions that came from the host (e.g. aeError line/file)
 *     versus positions inferred client-side.
 *   - occurredAt must be a parseable timestamp; callers pass ISO-8601.
 *
 * Node >= 22, zero dependencies. This module is transport-agnostic and
 * AE-free: it validates and normalizes records; collection paths are in
 * collectors.mjs.
 */

export const DIAGNOSTICS_RECORD_VERSION = "ae-devtools.diagnostics/v1";

export const DIAGNOSTIC_KINDS = Object.freeze([
  "script-exception",
  "expression-error",
  "panel-log",
  "native-crash",
  "plugin-load-failure",
  "render-failure",
  "transport-outcome",
]);

export const DIAGNOSTIC_SEVERITIES = Object.freeze(["error", "warning", "info"]);

export const SOURCE_ASSET_KINDS = Object.freeze([
  "jsx-script",
  "panel-asset",
  "plugin-binary",
  "manifest",
  "render-output",
  "transport",
  "unknown",
]);

export class DiagnosticsSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiagnosticsSchemaError";
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isOptionalString(v) {
  return v === undefined || typeof v === "string";
}

function isOptionalPositiveInt(v) {
  return v === undefined || (Number.isInteger(v) && v >= 1);
}

/**
 * Validate a diagnostics record. Returns the record unchanged on success;
 * throws DiagnosticsSchemaError on any violation. Validation is strict:
 * unknown top-level fields are allowed (forward compatibility) but known
 * fields must be well-formed.
 */
export function validateDiagnosticsRecord(record) {
  if (!isPlainObject(record)) {
    throw new DiagnosticsSchemaError("record must be a plain object");
  }
  if (record.recordVersion !== DIAGNOSTICS_RECORD_VERSION) {
    throw new DiagnosticsSchemaError(
      `recordVersion must be "${DIAGNOSTICS_RECORD_VERSION}", got ${JSON.stringify(record.recordVersion)}`
    );
  }
  if (!DIAGNOSTIC_KINDS.includes(record.kind)) {
    throw new DiagnosticsSchemaError(
      `kind must be one of ${DIAGNOSTIC_KINDS.join("|")}, got ${JSON.stringify(record.kind)}`
    );
  }
  if (!DIAGNOSTIC_SEVERITIES.includes(record.severity)) {
    throw new DiagnosticsSchemaError(
      `severity must be one of ${DIAGNOSTIC_SEVERITIES.join("|")}, got ${JSON.stringify(record.severity)}`
    );
  }
  if (!isNonEmptyString(record.message)) {
    throw new DiagnosticsSchemaError("message must be a non-empty string");
  }
  if (!isNonEmptyString(record.collector)) {
    throw new DiagnosticsSchemaError("collector must be a non-empty string");
  }
  if (!isNonEmptyString(record.occurredAt) || Number.isNaN(Date.parse(record.occurredAt))) {
    throw new DiagnosticsSchemaError("occurredAt must be a parseable timestamp");
  }

  if (record.source !== undefined) {
    const s = record.source;
    if (!isPlainObject(s)) {
      throw new DiagnosticsSchemaError("source must be a plain object when present");
    }
    if (!SOURCE_ASSET_KINDS.includes(s.assetKind)) {
      throw new DiagnosticsSchemaError(
        `source.assetKind must be one of ${SOURCE_ASSET_KINDS.join("|")}, got ${JSON.stringify(s.assetKind)}`
      );
    }
    if (!isOptionalString(s.path)) {
      throw new DiagnosticsSchemaError("source.path must be a string when present");
    }
    if (!isOptionalPositiveInt(s.line)) {
      throw new DiagnosticsSchemaError("source.line must be a positive integer when present");
    }
    if (!isOptionalPositiveInt(s.column)) {
      throw new DiagnosticsSchemaError("source.column must be a positive integer when present");
    }
    if (!isOptionalString(s.symbol)) {
      throw new DiagnosticsSchemaError("source.symbol must be a string when present");
    }
    if (s.hostReported !== undefined && typeof s.hostReported !== "boolean") {
      throw new DiagnosticsSchemaError("source.hostReported must be a boolean when present");
    }
    // A position claim without any positional field is meaningless but
    // not harmful; a line/column claim requires the assetKind, which is
    // already enforced. No further fabrication check is possible at this
    // layer — collector discipline covers it (see README).
  }

  if (record.session !== undefined) {
    if (!isPlainObject(record.session)) {
      throw new DiagnosticsSchemaError("session must be a plain object when present");
    }
    for (const k of ["sessionId", "aeVersion", "dispatchId"]) {
      if (record.session[k] !== undefined && typeof record.session[k] !== "string") {
        throw new DiagnosticsSchemaError(`session.${k} must be a string when present`);
      }
    }
  }

  if (record.requestId !== undefined && typeof record.requestId !== "string") {
    throw new DiagnosticsSchemaError("requestId must be a string when present");
  }
  if (record.outcome !== undefined && typeof record.outcome !== "string") {
    throw new DiagnosticsSchemaError("outcome must be a string when present");
  }
  if (record.artifactHashes !== undefined) {
    if (!isPlainObject(record.artifactHashes)) {
      throw new DiagnosticsSchemaError("artifactHashes must be a plain object when present");
    }
    for (const [name, hash] of Object.entries(record.artifactHashes)) {
      if (!isNonEmptyString(name) || !isNonEmptyString(hash)) {
        throw new DiagnosticsSchemaError("artifactHashes entries must be non-empty strings");
      }
    }
  }
  if (record.evidence !== undefined && !["fake", "real-host", "source-reviewed"].includes(record.evidence)) {
    throw new DiagnosticsSchemaError("evidence must be fake|real-host|source-reviewed when present");
  }
  return record;
}

/**
 * Build a minimal valid record. Fields not supplied stay absent —
 * callers must not fill them with placeholders.
 */
export function makeDiagnosticsRecord(fields) {
  return validateDiagnosticsRecord({
    recordVersion: DIAGNOSTICS_RECORD_VERSION,
    occurredAt: new Date().toISOString(),
    ...fields,
  });
}
