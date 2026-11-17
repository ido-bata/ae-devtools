import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CONFORMANCE_SCHEMA,
  CONFORMANCE_RECORD_VERSION,
  parseConformanceRecord,
  recomputeArtifactHashes,
  evaluateConformanceClaims,
  claimsFromCatalog,
  type ConformanceRecord,
} from "../src/conformance.ts";
import type { CapabilityRecord } from "../src/schema.ts";

const ARTIFACT_BYTES = new TextEncoder().encode("artifact-bytes");
const ARTIFACT_SHA = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
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

const readOk = (path: string) => (path === "out/result.json" ? ARTIFACT_BYTES : null);

describe("parseConformanceRecord", () => {
  test("accepts a well-formed PASS record", () => {
    const r = parseConformanceRecord(record());
    expect(r.ok).toBe(true);
  });

  test("rejects wrong schema and unknown recordVersion", () => {
    expect(parseConformanceRecord(record({ schema: "other/v9" })).ok).toBe(false);
    expect(parseConformanceRecord(record({ recordVersion: 99 })).ok).toBe(false);
  });

  test("rejects PASS below verified-real-host", () => {
    const r = parseConformanceRecord(record({ verification: "automated-fake" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/verified-real-host/);
  });

  test("rejects non-disposable / side-effecting environments", () => {
    expect(
      parseConformanceRecord(
        record({ environment: { disposableProject: false, sideEffects: "none-observed" } }),
      ).ok,
    ).toBe(false);
    expect(
      parseConformanceRecord(
        record({ environment: { disposableProject: true, sideEffects: "project-modified" } }),
      ).ok,
    ).toBe(false);
  });

  test("rejects malformed artifact hashes", () => {
    expect(
      parseConformanceRecord(record({ artifactHashes: { "a.json": "deadbeef" } })).ok,
    ).toBe(false);
    expect(parseConformanceRecord(record({ artifactHashes: {} })).ok).toBe(false);
  });
});

describe("recomputeArtifactHashes", () => {
  test("same bytes pass; different bytes and missing artifacts fail distinctly", () => {
    const parsed = parseConformanceRecord(record());
    if (!parsed.ok) throw new Error("fixture invalid");
    expect(recomputeArtifactHashes(parsed.record, readOk).ok).toBe(true);

    const wrong = recomputeArtifactHashes(parsed.record, () => new TextEncoder().encode("x"));
    expect(wrong.ok).toBe(false);
    expect(wrong.mismatches).toEqual(["out/result.json"]);

    const missing = recomputeArtifactHashes(parsed.record, () => null);
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(["out/result.json"]);
  });
});

describe("evaluateConformanceClaims", () => {
  const claim = { capabilityId: "ae.operation.app.version-info", os: "darwin" as const };

  test("PASS record with recomputing artifacts satisfies the claim", () => {
    const r = evaluateConformanceClaims([claim], [record()], readOk);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("no records -> no-evidence violation", () => {
    const r = evaluateConformanceClaims([claim], [], readOk);
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.reason).toBe("no-evidence");
  });

  test("FAIL/BLOCKED/UNKNOWN results never satisfy a claim", () => {
    for (const result of ["FAIL", "BLOCKED", "UNKNOWN", "NOT_RUN"] as const) {
      const r = evaluateConformanceClaims([claim], [record({ result })], readOk);
      expect(r.ok).toBe(false);
      expect(r.violations[0]?.reason).toBe("non-pass-result");
    }
  });

  test("artifact mismatch and missing are distinct violations", () => {
    const mism = evaluateConformanceClaims(
      [claim],
      [record()],
      () => new TextEncoder().encode("different"),
    );
    expect(mism.violations[0]?.reason).toBe("artifact-mismatch");

    const miss = evaluateConformanceClaims([claim], [record()], () => null);
    expect(miss.violations[0]?.reason).toBe("artifact-missing");
  });

  test("wrong OS and wrong binding platform do not cover the claim", () => {
    const wrongOs = evaluateConformanceClaims(
      [{ capabilityId: "ae.operation.app.version-info", os: "win32" }],
      [record()],
      readOk,
    );
    expect(wrongOs.violations[0]?.reason).toBe("no-evidence");

    const wrongBinding = evaluateConformanceClaims(
      [claim],
      [record({ catalogBinding: { kind: "real-host", ref: "r", platform: "win32" } })],
      readOk,
    );
    expect(wrongBinding.violations[0]?.reason).toBe("no-evidence");
  });

  test("structurally invalid records cannot support a claim", () => {
    const r = evaluateConformanceClaims([claim], [record({ recordVersion: 42 })], readOk);
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.reason).toBe("no-evidence");
  });
});

describe("claimsFromCatalog", () => {
  test("only verified-real-host rows with OS bounds produce claims", () => {
    const base = {
      kind: "semantic-operation",
      persistence: "repository",
      source: { name: "scripting", authority: "adobe" },
      category: "c",
      access: "read",
      execution: { class: "extendscript", lifecycle: "x", canRemoteInvoke: true },
      risk: { effect: "none", trust: "read-only", undoable: null, retrySafety: "unknown" },
      coverage: { inventory: "discovered", reachability: "reachable", implementation: "implemented", evidenceRefs: [] },
    } as unknown as CapabilityRecord;

    const verified = {
      ...base,
      id: "ae.operation.a.b",
      compatibility: { os: ["darwin", "win32"] },
      coverage: { ...base.coverage, verification: "verified-real-host" },
    } as CapabilityRecord;
    const fake = {
      ...base,
      id: "ae.operation.c.d",
      compatibility: { os: ["darwin"] },
      coverage: { ...base.coverage, verification: "automated-fake" },
    } as CapabilityRecord;
    const noOs = {
      ...base,
      id: "ae.operation.e.f",
      compatibility: {},
      coverage: { ...base.coverage, verification: "verified-real-host" },
    } as CapabilityRecord;

    expect(claimsFromCatalog([verified, fake, noOs])).toEqual([
      { capabilityId: "ae.operation.a.b", os: "darwin" },
      { capabilityId: "ae.operation.a.b", os: "win32" },
    ]);
  });
});
