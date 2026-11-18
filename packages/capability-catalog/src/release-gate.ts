/**
 * Release-scope declaration and the composed release gate — Issue #147,
 * CAP056, per specs/ae-capability-coverage/design/conformance-evidence.md
 * §4 and plan.md §6.1.
 *
 * The layer-2 claim gate (`conformance.ts`) judges claims it is given.
 * This module derives THAT claim set from two reviewed inputs:
 *
 *   1. `release-scope.json` — the owner-declared release scope: which
 *      release this tree describes, whether the supported-release set is
 *      recorded (plan §6.1 step 3 — an owner decision, never implied),
 *      and which capability × OS cells the release explicitly claims at
 *      `verified-real-host`.
 *   2. the catalog manifest — rows whose `coverage.verification` is
 *      already `verified-real-host` are claims in their own right
 *      (`claimsFromCatalog`); the gate demands the evidence record
 *      behind each one.
 *
 * Fail-closed rules:
 *   - a declared claim naming a capability absent from the manifest is
 *     `unknown-capability`;
 *   - a declared claim for an OS the catalog row does not declare in
 *     `compatibility.os` is `platform-not-declared` — the release cannot
 *     claim a platform the catalog itself marks unbounded/unknown;
 *   - an empty claim set is NOT a pass: the verdict is `no-claims`,
 *     reported separately so it cannot be mistaken for verified
 *     conformance. Capabilities correctly declared unsupported /
 *     UNVERIFIED simply never enter the claim set and never block.
 *
 * Evidence records are supplied by the caller as `ConformanceRecordSource`
 * plus the runId they were loaded from; IO and path-safety live in
 * `scripts/conformance-gate.ts`.
 */

import {
  claimsFromCatalog,
  evaluateConformanceClaimSources,
  parseConformanceRecord,
  type ConformanceClaim,
  type ConformanceRecordSource,
  type ConformanceViolation,
} from "./conformance.ts";
import type { CatalogManifest } from "./generate.ts";
import type { SupportedRelease } from "./coverage.ts";

export const RELEASE_SCOPE_SCHEMA = "ae-devtools.release-scope/v1" as const;

export type DeclaredCapabilityClaim = {
  capabilityId: string;
  os: "win32" | "darwin";
};

/* ------------------------------------------------------------------ */
/* Candidate binding (same-bytes vs the release candidate)             */
/* ------------------------------------------------------------------ */

/**
 * Repo-relative path prefixes whose modification invalidates real-host
 * evidence: the exercised runtime and the operation inventories whose
 * semantics the claims are measured against. Gate/claim definitions
 * (release-scope.json, real-host-claims.json, catalog sources, the gate
 * itself) are NOT in scope — they are re-evaluated on every gate run
 * and do not change what was measured. Tests, docs, evidence trees,
 * packaging metadata and generated catalogs are excluded — they
 * neither implement nor redefine what was verified (harness bytes are
 * already pinned by artifactHashes). Generated inventory files ARE in
 * scope: they are the runtime op semantics, not build artifacts.
 */
export const CONFORMANCE_EVIDENCE_SCOPE: readonly string[] = [
  "packages/ae-devtools-cli/",
  "inventories/scripting/",
  "inventories/tools/",
];

const EVIDENCE_SCOPE_EXCLUDE =
  /(?:^|\/)(?:tests?|__tests__|docs?|evidence)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)[^/]*\.md$|(?:^|\/)package-lock\.json$|(?:^|\/)node_modules\//;

/** True when `path` is inside the evidence scope (change ⇒ stale). */
export function isEvidenceScopePath(path: string): boolean {
  if (EVIDENCE_SCOPE_EXCLUDE.test(path)) return false;
  return CONFORMANCE_EVIDENCE_SCOPE.some((prefix) => path.startsWith(prefix));
}

/**
 * Binds evidence to the release candidate being gated. `sourceSha` alone
 * is self-reported; the gate must prove the run happened on this release
 * line AND that no evidence-scope path changed between that SHA and the
 * candidate — otherwise "same-bytes artifacts" only prove the evidence
 * tree is internally consistent, not that it describes this candidate.
 */
export type CandidateBinding = {
  /** git SHA of the candidate under evaluation (e.g. HEAD). */
  head: string;
  /** true when `sha` is `head` or an ancestor of it. */
  isAncestor: (sha: string) => boolean;
  /** repo-relative paths that differ between `sha` and `head`. */
  changedPathsSince: (sha: string) => string[];
};

export type StaleEvidence = {
  runId: string;
  sourceSha: string;
  reason: "source-sha-not-ancestor" | "evidence-scope-changed";
  paths?: string[];
};

export type ReleaseScope = {
  schema: typeof RELEASE_SCOPE_SCHEMA;
  /** Release line this scope describes, e.g. "0.3.0". */
  release: string;
  supportedRelease: SupportedRelease;
  claimedCapabilities: DeclaredCapabilityClaim[];
};

export type ReleaseScopeParse =
  | { ok: true; scope: ReleaseScope }
  | { ok: false; errors: string[] };

const OS_VALUES = ["win32", "darwin"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function parseReleaseScope(json: unknown): ReleaseScopeParse {
  const errors: string[] = [];
  const bad = (msg: string) => errors.push(msg);
  if (!isPlainObject(json)) return { ok: false, errors: ["release scope is not an object"] };
  if (json.schema !== RELEASE_SCOPE_SCHEMA) {
    bad(`schema must be ${RELEASE_SCOPE_SCHEMA}`);
  }
  if (!nonEmptyString(json.release)) bad("release must be a non-empty string");

  const sr = json.supportedRelease;
  if (!isPlainObject(sr) || (sr.state !== "not-recorded" && sr.state !== "recorded")) {
    bad("supportedRelease must be { state: 'not-recorded' } or { state: 'recorded', releases: string[] }");
  } else if (sr.state === "recorded") {
    if (
      !Array.isArray(sr.releases) ||
      sr.releases.length === 0 ||
      !sr.releases.every(nonEmptyString)
    ) {
      bad("supportedRelease.state='recorded' requires a non-empty releases string array");
    }
    if (sr.scope !== undefined) {
      if (!isPlainObject(sr.scope)) {
        bad("supportedRelease.scope must be an object when present");
      } else {
        for (const key of ["os", "arch"] as const) {
          const v = sr.scope[key];
          if (v !== undefined && (!Array.isArray(v) || !v.every(nonEmptyString))) {
            bad(`supportedRelease.scope.${key} must be a string array when present`);
          }
        }
        for (const key of ["verification", "note"] as const) {
          const v = sr.scope[key];
          if (v !== undefined && typeof v !== "string") {
            bad(`supportedRelease.scope.${key} must be a string when present`);
          }
        }
      }
    }
  }

  if (!Array.isArray(json.claimedCapabilities)) {
    bad("claimedCapabilities must be an array");
  } else {
    json.claimedCapabilities.forEach((c, i) => {
      if (
        !isPlainObject(c) ||
        !nonEmptyString(c.capabilityId) ||
        !OS_VALUES.includes(c.os as (typeof OS_VALUES)[number])
      ) {
        bad(`claimedCapabilities[${i}] must be { capabilityId: string, os: 'win32'|'darwin' }`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scope: json as unknown as ReleaseScope };
}

/* ------------------------------------------------------------------ */
/* Claim-set resolution                                                */
/* ------------------------------------------------------------------ */

export type ScopeViolation = {
  claim: DeclaredCapabilityClaim;
  reason: "unknown-capability" | "platform-not-declared";
  detail: string;
};

export type ClaimResolution = {
  /** Deduped union of catalog-derived and declared claims. */
  claims: ConformanceClaim[];
  /** Declared claims that failed catalog cross-checks. */
  violations: ScopeViolation[];
  /** Count split so a reader can see where the claim set came from. */
  fromCatalog: number;
  declared: number;
};

/**
 * Union of `claimsFromCatalog(manifest.records)` and the scope's declared
 * claims, deduplicated on (capabilityId, os). Every declared claim is
 * cross-checked against the manifest: the capability must exist and its
 * `compatibility.os` must list the claimed platform — a release cannot
 * assert real-host verification on a platform the catalog row itself
 * leaves unbounded.
 */
export function resolveReleaseClaims(
  scope: ReleaseScope,
  manifest: CatalogManifest,
): ClaimResolution {
  const byId = new Map(manifest.records.map((r) => [r.id, r]));
  const violations: ScopeViolation[] = [];
  const seen = new Set<string>();
  const claims: ConformanceClaim[] = [];
  const push = (claim: ConformanceClaim) => {
    const key = `${claim.capabilityId}${claim.os}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(claim);
  };

  for (const claim of claimsFromCatalog(manifest.records)) push(claim);
  const fromCatalog = claims.length;

  for (const declared of scope.claimedCapabilities) {
    const row = byId.get(declared.capabilityId);
    if (!row) {
      violations.push({
        claim: declared,
        reason: "unknown-capability",
        detail: `claimedCapabilities names '${declared.capabilityId}' which is not a catalog record`,
      });
      continue;
    }
    const osBounds = row.compatibility.os ?? [];
    if (!osBounds.includes(declared.os)) {
      violations.push({
        claim: declared,
        reason: "platform-not-declared",
        detail: `'${declared.capabilityId}' does not declare os '${declared.os}' in compatibility.os`,
      });
      continue;
    }
    push(declared);
  }

  return { claims, violations, fromCatalog, declared: scope.claimedCapabilities.length };
}

/* ------------------------------------------------------------------ */
/* Composed gate                                                       */
/* ------------------------------------------------------------------ */

/** A loaded evidence record: its runId (directory name) plus the record
 *  JSON and the artifact reader bound to that run's directory. */
export type LoadedConformanceRecord = ConformanceRecordSource & { runId: string };

export type ReleaseGateReport = {
  schema: "ae-devtools.conformance-gate/v1";
  release: string;
  supportedRelease: SupportedRelease;
  /** `no-claims` is deliberately distinct from `pass`: zero evaluated
   *  claims is the absence of a claim, not verified conformance. */
  verdict: "pass" | "violations" | "no-claims";
  ok: boolean;
  claimsEvaluated: number;
  claimSources: { fromCatalog: number; declared: number };
  scopeViolations: ScopeViolation[];
  violations: ConformanceViolation[];
  /** Records that failed structural validation — surfaced, never used
   *  as evidence and never silently upgraded. */
  rejectedRecords: Array<{ runId: string; errors: string[] }>;
  /** Records excluded because their sourceSha does not bind to the
   *  candidate (not an ancestor, or evidence-scope paths changed since). */
  staleEvidence: StaleEvidence[];
  /** The candidate head the binding was evaluated against. */
  candidateHead: string;
  diagnostics: string[];
};

/**
 * Compose the release gate. `recordSources` are the candidate evidence
 * records, each tagged with the runId of the directory it was loaded
 * from. Structural parse runs inside the evaluator; this function
 * additionally reports rejected records for visibility.
 */
export function evaluateReleaseGate(input: {
  scope: ReleaseScope;
  manifest: CatalogManifest;
  recordSources: readonly LoadedConformanceRecord[];
  /** Required: binds records to the candidate under evaluation. Without
   *  it the gate could only prove evidence-tree self-consistency. */
  candidate: CandidateBinding;
}): ReleaseGateReport {
  const { scope, manifest, recordSources, candidate } = input;
  const resolution = resolveReleaseClaims(scope, manifest);

  // Candidate binding: a record is evidence for THIS candidate only when
  // its run happened on an ancestor of the candidate head and no
  // evidence-scope path changed in between. Stale records are excluded
  // before claim evaluation — claims they alone covered surface as
  // no-evidence/stale violations, never as passes.
  const staleEvidence: StaleEvidence[] = [];
  const freshSources = recordSources.filter((s) => {
    const parsed = parseConformanceRecord(s.record);
    if (!parsed.ok) return true; // invalid records are reported separately
    const sha = parsed.record.sourceSha;
    if (!candidate.isAncestor(sha)) {
      staleEvidence.push({ runId: s.runId, sourceSha: sha, reason: "source-sha-not-ancestor" });
      return false;
    }
    const scopePaths = candidate
      .changedPathsSince(sha)
      .filter(isEvidenceScopePath);
    if (scopePaths.length > 0) {
      staleEvidence.push({
        runId: s.runId,
        sourceSha: sha,
        reason: "evidence-scope-changed",
        paths: scopePaths,
      });
      return false;
    }
    return true;
  });

  const evaluation = evaluateConformanceClaimSources(resolution.claims, freshSources);

  // Surface structurally invalid records: they cannot support a claim,
  // and their presence in the evidence tree is itself worth reporting.
  const rejectedRecords = recordSources.flatMap((s) => {
    const parsed = parseConformanceRecord(s.record);
    return parsed.ok ? [] : [{ runId: s.runId, errors: parsed.errors }];
  });

  const diagnostics: string[] = [];
  if (scope.supportedRelease.state === "not-recorded") {
    diagnostics.push("supported-release-set-not-recorded");
  }
  if (resolution.claims.length === 0) {
    diagnostics.push("claim-set-empty");
  }

  const hasViolations =
    resolution.violations.length > 0 || evaluation.violations.length > 0;
  const verdict = hasViolations
    ? "violations"
    : resolution.claims.length === 0
      ? "no-claims"
      : "pass";

  return {
    schema: "ae-devtools.conformance-gate/v1",
    release: scope.release,
    supportedRelease: scope.supportedRelease,
    verdict,
    ok: !hasViolations,
    claimsEvaluated: resolution.claims.length,
    claimSources: { fromCatalog: resolution.fromCatalog, declared: resolution.declared },
    scopeViolations: resolution.violations,
    violations: evaluation.violations,
    rejectedRecords,
    staleEvidence,
    candidateHead: candidate.head,
    diagnostics,
  };
}
