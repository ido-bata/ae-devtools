import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  parseReleaseScope,
  resolveReleaseClaims,
  evaluateReleaseGate,
  RELEASE_SCOPE_SCHEMA,
  isEvidenceScopePath,
  type CandidateBinding,
  type ReleaseScope,
} from "../src/release-gate.ts";
import {
  CONFORMANCE_SCHEMA,
  CONFORMANCE_RECORD_VERSION,
} from "../src/conformance.ts";
import type { CapabilityRecord } from "../src/schema.ts";
import type { CatalogManifest } from "../src/generate.ts";

const ARTIFACT_BYTES = new TextEncoder().encode("artifact-bytes");
const ARTIFACT_SHA = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");
const readOk = () => ARTIFACT_BYTES;

function catalogRecord(over: Record<string, unknown> = {}): CapabilityRecord {
  return {
    id: "ae.operation.app.version-info",
    kind: "semantic-operation",
    persistence: "repository",
    source: { publisher: "adobe", uri: "u", version: "1", observedAt: "2026-01-01", authority: "primary" },
    category: "app",
    access: "read",
    execution: { class: "extendscript", lifecycle: "x", canRemoteInvoke: true },
    compatibility: { os: ["darwin"] },
    risk: { effect: "none", trust: "read-only", undoable: null, retrySafety: "unknown" },
    coverage: {
      inventory: "source-reviewed",
      reachability: "reachable",
      implementation: "implemented",
      verification: "automated-fake",
      evidenceRefs: [],
    },
    ...over,
  } as CapabilityRecord;
}

function manifest(records: CapabilityRecord[]): CatalogManifest {
  return { records } as unknown as CatalogManifest;
}

function scope(over: Record<string, unknown> = {}): ReleaseScope {
  const parsed = parseReleaseScope({
    schema: RELEASE_SCOPE_SCHEMA,
    release: "0.3.0",
    supportedRelease: { state: "not-recorded" },
    claimedCapabilities: [],
    ...over,
  });
  if (!parsed.ok) throw new Error(`bad scope fixture: ${parsed.errors}`);
  return parsed.scope;
}

function conformanceRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: CONFORMANCE_SCHEMA,
    recordVersion: CONFORMANCE_RECORD_VERSION,
    capabilityIds: ["ae.operation.app.version-info"],
    platform: { os: "darwin", osVersion: "15.0", arch: "arm64" },
    aeVersion: { version: "27.0", build: "78" },
    sdkBuild: null,
    sdkBuildStatus: "not-applicable",
    verification: "verified-real-host",
    result: "PASS",
    catalogBinding: { kind: "real-host", ref: "run-1", platform: "darwin" },
    sourceSha: "af1389203ef9ce9dca560274ee0514031bb332c2",
    runId: "run-1",
    artifactHashes: { "out/result.json": ARTIFACT_SHA },
    environment: { disposableProject: true, sideEffects: "none-observed" },
    recordedAt: "2026-11-17T00:00:00Z",
    ...over,
  };
}

const source = (record: unknown, readArtifact = readOk) => ({
  runId: "run-1",
  record,
  readArtifact: () => readArtifact(),
});

// Default candidate binding: every record SHA is an ancestor of head and
// nothing in the evidence scope changed — i.e. evidence is fresh.
const freshCandidate = (over: Partial<CandidateBinding> = {}): CandidateBinding => ({
  head: "c0ffee00000000000000000000000000000000",
  isAncestor: () => true,
  changedPathsSince: () => [],
  ...over,
});

describe("parseReleaseScope", () => {
  test("accepts a minimal honest scope", () => {
    const r = parseReleaseScope({
      schema: RELEASE_SCOPE_SCHEMA,
      release: "0.3.0",
      supportedRelease: { state: "not-recorded" },
      claimedCapabilities: [],
    });
    expect(r.ok).toBe(true);
  });

  test("supportedRelease.scope is validated when present", () => {
    const base = {
      schema: RELEASE_SCOPE_SCHEMA,
      release: "0.4.0",
      claimedCapabilities: [],
    };
    expect(parseReleaseScope({
      ...base,
      supportedRelease: { state: "recorded", releases: ["26.5"], scope: { os: ["darwin"], arch: ["arm64"], verification: "verified-real-host", note: "bounded" } },
    }).ok).toBe(true);
    expect(parseReleaseScope({
      ...base,
      supportedRelease: { state: "recorded", releases: ["26.5"], scope: "darwin" },
    }).ok).toBe(false);
    expect(parseReleaseScope({
      ...base,
      supportedRelease: { state: "recorded", releases: ["26.5"], scope: { os: "darwin" } },
    }).ok).toBe(false);
    expect(parseReleaseScope({
      ...base,
      supportedRelease: { state: "recorded", releases: ["26.5"], scope: { verification: 42 } },
    }).ok).toBe(false);
  });

  test("rejects bad schema, missing release, malformed claims", () => {
    expect(parseReleaseScope({}).ok).toBe(false);
    expect(
      parseReleaseScope({
        schema: RELEASE_SCOPE_SCHEMA,
        release: "0.3.0",
        supportedRelease: { state: "not-recorded" },
        claimedCapabilities: [{ capabilityId: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      parseReleaseScope({
        schema: RELEASE_SCOPE_SCHEMA,
        release: "0.3.0",
        supportedRelease: { state: "recorded", releases: [] },
        claimedCapabilities: [],
      }).ok,
    ).toBe(false);
  });
});

describe("resolveReleaseClaims", () => {
  test("empty scope + no verified catalog rows -> empty claim set", () => {
    const r = resolveReleaseClaims(scope(), manifest([catalogRecord()]));
    expect(r.claims).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  test("catalog verified-real-host rows become claims per declared os", () => {
    const row = catalogRecord({
      compatibility: { os: ["darwin", "win32"] },
      coverage: {
        inventory: "source-reviewed",
        reachability: "reachable",
        implementation: "implemented",
        verification: "verified-real-host",
        evidenceRefs: [],
      },
    });
    const r = resolveReleaseClaims(scope(), manifest([row]));
    expect(r.claims).toEqual([
      { capabilityId: "ae.operation.app.version-info", os: "darwin" },
      { capabilityId: "ae.operation.app.version-info", os: "win32" },
    ]);
    expect(r.fromCatalog).toBe(2);
  });

  test("declared claim for unknown capability is a scope violation", () => {
    const r = resolveReleaseClaims(
      scope({ claimedCapabilities: [{ capabilityId: "ae.operation.nope.x", os: "darwin" }] }),
      manifest([catalogRecord()]),
    );
    expect(r.violations[0]?.reason).toBe("unknown-capability");
    expect(r.claims).toEqual([]);
  });

  test("declared claim for undeclared platform is a scope violation", () => {
    const r = resolveReleaseClaims(
      scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "win32" }] }),
      manifest([catalogRecord()]), // compatibility.os = ["darwin"] only
    );
    expect(r.violations[0]?.reason).toBe("platform-not-declared");
    expect(r.claims).toEqual([]);
  });

  test("valid declared claim joins the set; duplicates collapse", () => {
    const r = resolveReleaseClaims(
      scope({
        claimedCapabilities: [
          { capabilityId: "ae.operation.app.version-info", os: "darwin" },
          { capabilityId: "ae.operation.app.version-info", os: "darwin" },
        ],
      }),
      manifest([catalogRecord()]),
    );
    expect(r.claims).toEqual([{ capabilityId: "ae.operation.app.version-info", os: "darwin" }]);
    expect(r.declared).toBe(2);
  });
});

describe("evaluateReleaseGate", () => {
  test("empty claim set -> verdict no-claims, ok but explicitly not a pass", () => {
    const report = evaluateReleaseGate({
      scope: scope(),
      manifest: manifest([catalogRecord()]),
      recordSources: [],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("no-claims");
    expect(report.ok).toBe(true);
    expect(report.claimsEvaluated).toBe(0);
    expect(report.diagnostics).toContain("claim-set-empty");
    expect(report.diagnostics).toContain("supported-release-set-not-recorded");
  });

  test("recorded supportedRelease drops that diagnostic", () => {
    const report = evaluateReleaseGate({
      scope: scope({ supportedRelease: { state: "recorded", releases: ["ae-2027", "ae-2026"] } }),
      manifest: manifest([catalogRecord()]),
      recordSources: [],
      candidate: freshCandidate(),
    });
    expect(report.diagnostics).not.toContain("supported-release-set-not-recorded");
  });

  test("declared claim without evidence -> violations verdict, not ok", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("violations");
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.reason).toBe("no-evidence");
  });

  test("declared claim satisfied by PASS record with recomputing artifacts", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord())],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("pass");
    expect(report.ok).toBe(true);
    expect(report.claimsEvaluated).toBe(1);
  });

  test("artifact mismatch fails the claim", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord(), () => new TextEncoder().encode("tampered"))],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("violations");
    expect(report.violations[0]?.reason).toBe("artifact-mismatch");
  });

  test("structurally invalid records are rejected, not used as evidence", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord({ recordVersion: 42 }))],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("violations");
    expect(report.rejectedRecords).toHaveLength(1);
    expect(report.rejectedRecords[0]?.runId).toBe("run-1");
  });

  test("scope violations fail the gate even with zero claims evaluated", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.nope.x", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("violations");
    expect(report.ok).toBe(false);
    expect(report.scopeViolations[0]?.reason).toBe("unknown-capability");
    expect(report.claimsEvaluated).toBe(0);
  });

  test("stale evidence: sourceSha not an ancestor of candidate is excluded", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord())],
      candidate: freshCandidate({ isAncestor: () => false }),
    });
    expect(report.verdict).toBe("violations");
    expect(report.staleEvidence[0]?.reason).toBe("source-sha-not-ancestor");
    expect(report.violations[0]?.reason).toBe("no-evidence");
  });

  test("stale evidence: evidence-scope change since sourceSha is excluded (negative control)", () => {
    // Candidate kept the old evidence tree but touched exercised code —
    // the PASS must NOT carry over.
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord())],
      candidate: freshCandidate({
        changedPathsSince: () => ["packages/ae-devtools-cli/dev-loop/outcomes.mjs"],
      }),
    });
    expect(report.verdict).toBe("violations");
    expect(report.staleEvidence[0]?.reason).toBe("evidence-scope-changed");
    expect(report.staleEvidence[0]?.paths).toContain("packages/ae-devtools-cli/dev-loop/outcomes.mjs");
  });

  test("non-scope changes since sourceSha keep evidence fresh", () => {
    const report = evaluateReleaseGate({
      scope: scope({ claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }] }),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord())],
      candidate: freshCandidate({
        changedPathsSince: () => [
          "packages/ae-devtools-cli/dev-loop/tests/run.mjs",
          "docs/release.md",
          "packages/capability-catalog/generated/catalog.json",
        ],
      }),
    });
    expect(report.verdict).toBe("pass");
    expect(report.staleEvidence).toHaveLength(0);
  });

  // ---- supportedRelease scope binding (Issue #229) ----

  const recordedScope = (scopeOver: Record<string, unknown> = {}) =>
    scope({
      supportedRelease: {
        state: "recorded",
        releases: ["26.5"],
        scope: { os: ["darwin"], arch: ["arm64"], verification: "verified-real-host" },
        ...scopeOver,
      },
      claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }],
    });
  const inScopeRecord = (over: Record<string, unknown> = {}) =>
    conformanceRecord({
      aeVersion: { version: "26.5.3x9", build: "9" },
      platform: { os: "darwin", osVersion: "27.2.1", arch: "arm64" },
      ...over,
    });

  test("recorded scope: in-scope PASS record still passes", () => {
    const report = evaluateReleaseGate({
      scope: recordedScope(),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(inScopeRecord())],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("pass");
    expect(report.outOfScopeEvidence).toHaveLength(0);
  });

  test("recorded scope: AE 27.0 record cannot satisfy a 26.5 claim", () => {
    const report = evaluateReleaseGate({
      scope: recordedScope(),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(conformanceRecord())], // fixture: aeVersion 27.0
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("violations");
    expect(report.violations[0]?.reason).toBe("no-evidence");
    expect(report.outOfScopeEvidence[0]?.reason).toBe("ae-version-out-of-scope");
    expect(report.diagnostics).toContain("supported-scope-excluded-evidence");
  });

  test("recorded scope: wrong arch/os records are excluded", () => {
    for (const [over, reason] of [
      [{ platform: { os: "darwin", osVersion: "27.2.1", arch: "x64" } }, "platform-out-of-scope"],
      [{ platform: { os: "win32", osVersion: "11", arch: "arm64" } }, "platform-out-of-scope"],
      [{ verification: "automated-fake", result: "NOT_RUN" }, "verification-out-of-scope"],
    ] as const) {
      const report = evaluateReleaseGate({
        scope: recordedScope(),
        manifest: manifest([catalogRecord()]),
        recordSources: [source(inScopeRecord(over))],
        candidate: freshCandidate(),
      });
      expect(report.verdict).toBe("violations");
      expect(report.outOfScopeEvidence[0]?.reason).toBe(reason);
    }
  });

  test("recorded scope without scope fields constrains only the release line", () => {
    const report = evaluateReleaseGate({
      scope: scope({
        supportedRelease: { state: "recorded", releases: ["26.5"] },
        claimedCapabilities: [{ capabilityId: "ae.operation.app.version-info", os: "darwin" }],
      }),
      manifest: manifest([catalogRecord()]),
      // arch/os outside any declared bound still count — only the AE
      // release line is constrained when scope.os/arch are absent.
      recordSources: [source(inScopeRecord({
        platform: { os: "darwin", osVersion: "27.2.1", arch: "x64" },
      }))],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("pass");
  });

  test("unparseable aeVersion is out of scope, never assumed in", () => {
    const report = evaluateReleaseGate({
      scope: recordedScope(),
      manifest: manifest([catalogRecord()]),
      recordSources: [source(inScopeRecord({ aeVersion: { version: "unknown", build: "?" } }))],
      candidate: freshCandidate(),
    });
    expect(report.verdict).toBe("violations");
    expect(report.outOfScopeEvidence[0]?.reason).toBe("ae-version-out-of-scope");
  });

  test("isEvidenceScopePath: scope prefixes in, tests/docs/evidence out", () => {
    expect(isEvidenceScopePath("packages/ae-devtools-cli/dev-loop/outcomes.mjs")).toBe(true);
    expect(isEvidenceScopePath("packages/ae-devtools-cli/package.json")).toBe(true);
    expect(isEvidenceScopePath("inventories/scripting/ops.json")).toBe(true);
    expect(isEvidenceScopePath("inventories/tools/generated/operations.json")).toBe(true);
    expect(isEvidenceScopePath("packages/ae-devtools-cli/dev-loop/tests/run.mjs")).toBe(false);
    expect(isEvidenceScopePath("packages/ae-devtools-cli/docs/adoption.md")).toBe(false);
    expect(isEvidenceScopePath("packages/ae-devtools-cli/mcp-server/evidence/run.json")).toBe(false);
    expect(isEvidenceScopePath("packages/capability-catalog/evidence/conformance/x/record.json")).toBe(false);
    expect(isEvidenceScopePath("packages/capability-catalog/generated/catalog.json")).toBe(false);
    // Gate/claim definitions are re-evaluated every run — not measured bytes.
    expect(isEvidenceScopePath("packages/capability-catalog/release-scope.json")).toBe(false);
    expect(isEvidenceScopePath("packages/capability-catalog/src/release-gate.ts")).toBe(false);
    expect(isEvidenceScopePath("README.md")).toBe(false);
    // Issue #230 anchoring: package-lock.json pins exercised dependency
    // code — it is IN scope now. docs/evidence dirs are excluded only
    // inside the CLI package tree; under inventories/ every file is
    // potential op semantics and stays in scope.
    expect(isEvidenceScopePath("packages/ae-devtools-cli/package-lock.json")).toBe(true);
    expect(isEvidenceScopePath("inventories/scripting/docs/spec.json")).toBe(true);
    expect(isEvidenceScopePath("inventories/tools/evidence/ops.json")).toBe(true);
    expect(isEvidenceScopePath("inventories/tools/tests/fixture.json")).toBe(false);
  });
});
