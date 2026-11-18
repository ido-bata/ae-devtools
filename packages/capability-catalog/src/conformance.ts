/**
 * Conformance evidence records and the layer-2 release gate — Issue #21,
 * CAP053/CAP055/CAP056, per specs/ae-capability-coverage/design/
 * conformance-evidence.md (Proposed design note).
 *
 * A conformance claim binds to one immutable evidence record. This module
 * defines the record shape, validates it fail-closed, and evaluates the
 * release-gate rule: every in-scope capability × claimed platform cell
 * needs a PASS record at `verified-real-host` whose cited artifact hashes
 * recompute against the release candidate (same-bytes, §3). Absence,
 * BLOCKED, UNKNOWN, FAIL, stale or mismatched evidence is a violation —
 * never a pass.
 *
 * Scope note: `evaluateConformanceClaims` takes the claim set explicitly.
 * The release's claimed capability set is derived by `release-gate.ts`
 * (release-scope declaration ∪ catalog verified-real-host rows); this
 * module only judges the claims it is given.
 */

import { createHash } from "node:crypto";

import type { CapabilityRecord, VerificationAxis } from "./schema.ts";

export const CONFORMANCE_SCHEMA = "ae-devtools.conformance-record/v1" as const;
export const CONFORMANCE_RECORD_VERSION = 1 as const;

export const CONFORMANCE_RESULTS = [
  "NOT_RUN",
  "BLOCKED",
  "PASS",
  "FAIL",
  "UNKNOWN",
] as const;
export type ConformanceResult = (typeof CONFORMANCE_RESULTS)[number];

/** plan §6.2 matrix vocabulary — `unsupported`/`unknown` are NOT results. */
export const RESULT_RANK: Record<ConformanceResult, number> = {
  NOT_RUN: 0,
  BLOCKED: 1,
  UNKNOWN: 2,
  FAIL: 3,
  PASS: 4,
};

export type ConformancePlatform = {
  os: string;
  osVersion: string;
  arch: string;
};

export type ConformanceRecord = {
  schema: typeof CONFORMANCE_SCHEMA;
  recordVersion: typeof CONFORMANCE_RECORD_VERSION;
  capabilityIds: string[];
  platform: ConformancePlatform;
  aeVersion: { version: string; build: string };
  sdkBuild: { hash: string } | null;
  sdkBuildStatus: "hashed" | "not-applicable" | "unverified";
  /** Catalog coverage.verification vocabulary — not a third taxonomy. */
  verification: VerificationAxis;
  result: ConformanceResult;
  catalogBinding: {
    kind: "real-host";
    ref: string;
    platform?: "win32" | "darwin";
  };
  sourceSha: string;
  runId: string;
  /** artifact path -> sha256 hex; every cited artifact must recompute. */
  artifactHashes: Record<string, string>;
  environment: {
    disposableProject: boolean;
    sideEffects: string;
    sessionRef?: string;
  };
  /**
   * CAP054 dimensions (script/native/transport/ownership/timeout/
   * reconnect/undo/render). A PASS claim requires every applicable
   * dimension at PASS; absent dimensions are unassessed, not passed.
   */
  dimensions?: Partial<Record<string, ConformanceResult>>;
  recordedAt: string;
};

const VERIFICATION_VALUES: readonly string[] = [
  "not-run",
  "automated-fake",
  "verified-real-host",
];
const OS_VALUES = ["win32", "darwin"] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Structural validation of one record. Unknown `recordVersion` values are
 * rejected outright — an unrecognized schema is UNKNOWN to the gate, and
 * UNKNOWN never counts as PASS (design note §1).
 */
export function parseConformanceRecord(
  json: unknown,
): { ok: true; record: ConformanceRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const bad = (msg: string) => errors.push(msg);
  if (!isPlainObject(json)) {
    return { ok: false, errors: ["record is not an object"] };
  }
  if (json.schema !== CONFORMANCE_SCHEMA) {
    bad(`schema must be ${CONFORMANCE_SCHEMA}`);
  }
  if (json.recordVersion !== CONFORMANCE_RECORD_VERSION) {
    bad(`recordVersion must be ${CONFORMANCE_RECORD_VERSION}`);
  }
  if (
    !Array.isArray(json.capabilityIds) ||
    json.capabilityIds.length === 0 ||
    !json.capabilityIds.every(nonEmptyString)
  ) {
    bad("capabilityIds must be a non-empty string array");
  } else if (new Set(json.capabilityIds).size !== json.capabilityIds.length) {
    bad("capabilityIds must not contain duplicates");
  }
  const platform = json.platform;
  if (
    !isPlainObject(platform) ||
    !nonEmptyString(platform.os) ||
    !nonEmptyString(platform.osVersion) ||
    !nonEmptyString(platform.arch)
  ) {
    bad("platform must carry os/osVersion/arch strings");
  } else if (!OS_VALUES.includes(platform.os as (typeof OS_VALUES)[number])) {
    // The claim vocabulary is win32|darwin — a record measured on any
    // other OS can never satisfy a claim, so accepting it would only
    // produce evidence that looks usable but is not (Issue #230).
    bad("platform.os must be win32 | darwin");
  }
  const aeVersion = json.aeVersion;
  if (
    !isPlainObject(aeVersion) ||
    !nonEmptyString(aeVersion.version) ||
    !nonEmptyString(aeVersion.build)
  ) {
    bad("aeVersion must carry version and build strings");
  }
  const sdkStatus = json.sdkBuildStatus;
  if (!["hashed", "not-applicable", "unverified"].includes(String(sdkStatus))) {
    bad("sdkBuildStatus must be hashed | not-applicable | unverified");
  }
  if (sdkStatus === "hashed") {
    if (!isPlainObject(json.sdkBuild) || !nonEmptyString(json.sdkBuild.hash)) {
      bad("sdkBuildStatus=hashed requires sdkBuild.hash");
    }
  } else if (json.sdkBuild !== null) {
    bad("sdkBuild must be null unless sdkBuildStatus=hashed");
  }
  if (!VERIFICATION_VALUES.includes(String(json.verification))) {
    bad("verification must be a catalog VerificationAxis");
  }
  if (!CONFORMANCE_RESULTS.includes(json.result as ConformanceResult)) {
    bad(`result must be one of ${CONFORMANCE_RESULTS.join("/")}`);
  }
  const binding = json.catalogBinding;
  if (
    !isPlainObject(binding) ||
    binding.kind !== "real-host" ||
    !nonEmptyString(binding.ref)
  ) {
    bad("catalogBinding must be { kind: 'real-host', ref: string }");
  } else if (
    binding.platform !== undefined &&
    !OS_VALUES.includes(binding.platform as (typeof OS_VALUES)[number])
  ) {
    bad("catalogBinding.platform must be win32 | darwin when present");
  }
  if (!nonEmptyString(json.sourceSha) || !GIT_SHA_RE.test(json.sourceSha)) {
    bad("sourceSha must be a git SHA");
  }
  if (!nonEmptyString(json.runId)) bad("runId must be a non-empty string");
  if (
    !isPlainObject(json.artifactHashes) ||
    Object.keys(json.artifactHashes).length === 0 ||
    !Object.values(json.artifactHashes).every(
      (h) => typeof h === "string" && SHA256_RE.test(h),
    )
  ) {
    bad("artifactHashes must map artifact paths to sha256 hex");
  }
  const env = json.environment;
  if (
    !isPlainObject(env) ||
    env.disposableProject !== true ||
    env.sideEffects !== "none-observed"
  ) {
    // §1: real-host fixtures use disposable projects and must assert no
    // side effects on the user's interactive session. Anything weaker is
    // not a conformance record.
    bad("environment must assert disposableProject=true and sideEffects='none-observed'");
  }
  if (!nonEmptyString(json.recordedAt) || Number.isNaN(Date.parse(json.recordedAt))) {
    bad("recordedAt must be a parseable timestamp string");
  }

  // Cross-field honesty rules.
  if (errors.length === 0) {
    const rec = json as unknown as ConformanceRecord;
    if (rec.result === "PASS" && rec.verification !== "verified-real-host") {
      bad("PASS requires verification=verified-real-host");
    }
    if (
      rec.result === "PASS" &&
      rec.dimensions !== undefined &&
      Object.values(rec.dimensions).some((d) => d !== "PASS")
    ) {
      bad("PASS requires every declared dimension at PASS");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, record: json as unknown as ConformanceRecord };
}

/* ------------------------------------------------------------------ */
/* Same-bytes verification (§3)                                        */
/* ------------------------------------------------------------------ */

export type ArtifactHashChecker = (path: string) => Uint8Array | string | null;

/**
 */
export function recomputeArtifactHashes(
  record: ConformanceRecord,
  readArtifact: ArtifactHashChecker,
): { ok: boolean; mismatches: string[]; missing: string[] } {
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const [path, expected] of Object.entries(record.artifactHashes)) {
    const bytes = readArtifact(path);
    if (bytes === null) {
      missing.push(path);
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) mismatches.push(path);
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}

/* ------------------------------------------------------------------ */
/* Layer-2 gate (§4)                                                   */
/* ------------------------------------------------------------------ */

export type ConformanceClaim = {
  capabilityId: string;
  /** Catalog compatibility.os value the claim covers. */
  os: "win32" | "darwin";
};

/**
 * A record bundled with the artifact resolver for ITS OWN evidence root.
 * Conformance artifacts are stored per run (`evidence/conformance/<runId>/`),
 * so a shared path->bytes resolver cannot express same-bytes verification;
 * each source carries the reader bound to its run directory.
 */
export type ConformanceRecordSource = {
  record: unknown;
  readArtifact: ArtifactHashChecker;
};

export type ConformanceViolation = {
  claim: ConformanceClaim;
  reason:
    | "no-evidence"
    | "stale-evidence"
    | "non-pass-result"
    | "wrong-verification"
    | "wrong-platform"
    | "artifact-mismatch"
    | "artifact-missing";
  detail: string;
};

/**
 * Evaluate claims against records. A claim passes iff at least one record
 * covers the capability on the claimed OS with result PASS at
 * verified-real-host AND every cited artifact hash recomputes via
 * `readArtifact` (same-bytes against the candidate). Records that fail
 * structural validation are ignored as evidence — they cannot support a
 * claim, and their invalidity is itself not silently upgraded.
 */
export function evaluateConformanceClaims(
  claims: readonly ConformanceClaim[],
  records: readonly unknown[],
  readArtifact: (path: string) => Uint8Array | null,
): { ok: boolean; violations: ConformanceViolation[] } {
  return evaluateConformanceClaimSources(
    claims,
    records.map((record) => ({ record, readArtifact })),
  );
}

/**
 * Same evaluation as `evaluateConformanceClaims`, but each record source
 * supplies its own `readArtifact` — used by the release gate where every
 * record's artifacts live under that record's run directory.
 */
export function evaluateConformanceClaimSources(
  claims: readonly ConformanceClaim[],
  sources: readonly ConformanceRecordSource[],
): { ok: boolean; violations: ConformanceViolation[] } {
  const violations: ConformanceViolation[] = [];
  const parsed = sources.map((s) => ({
    result: parseConformanceRecord(s.record),
    readArtifact: s.readArtifact,
  }));

  for (const claim of claims) {
    const covering = parsed.filter(
      ({ result }) =>
        result.ok &&
        result.record.capabilityIds.includes(claim.capabilityId) &&
        result.record.platform.os === claim.os &&
        (result.record.catalogBinding.platform === undefined ||
          result.record.catalogBinding.platform === claim.os),
    );

    if (covering.length === 0) {
      violations.push({
        claim,
        reason: "no-evidence",
        detail: `no conformance record covers ${claim.capabilityId} on ${claim.os}`,
      });
      continue;
    }

    let passed = false;
    const seenReasons = new Set<string>();
    for (const { result, readArtifact } of covering) {
      if (!result.ok) continue; // filtered above; narrows the type
      const rec = result.record;
      if (rec.result !== "PASS") {
        seenReasons.add(`non-pass-result:${rec.result}`);
        continue;
      }
      if (rec.verification !== "verified-real-host") {
        seenReasons.add("wrong-verification");
        continue;
      }
      const hashes = recomputeArtifactHashes(rec, readArtifact);
      if (!hashes.ok) {
        if (hashes.mismatches.length > 0) seenReasons.add("artifact-mismatch");
        if (hashes.missing.length > 0) seenReasons.add("artifact-missing");
        continue;
      }
      passed = true;
      break;
    }
    if (!passed) {
      const reason = [...seenReasons][0];
      violations.push({
        claim,
        reason: (reason?.split(":")[0] as ConformanceViolation["reason"]) ?? "non-pass-result",
        detail: `no qualifying record for ${claim.capabilityId} on ${claim.os} (${[...seenReasons].join(", ")})`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Convenience: derive claims from catalog rows. A row claims platform `os`
 * when its coverage.verification is `verified-real-host` and its
 * compatibility.os lists that platform — i.e. the catalog already asserts
 * real-host evidence there, so the gate demands the record behind it.
 */
export function claimsFromCatalog(
  records: readonly CapabilityRecord[],
): ConformanceClaim[] {
  const claims: ConformanceClaim[] = [];
  for (const rec of records) {
    if (rec.coverage.verification !== "verified-real-host") continue;
    for (const os of rec.compatibility.os ?? []) {
      if (os === "win32" || os === "darwin") {
        claims.push({ capabilityId: rec.id, os });
      }
    }
  }
  return claims;
}
