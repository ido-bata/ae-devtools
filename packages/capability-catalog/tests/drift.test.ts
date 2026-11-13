/**
 * CAP015 — drift gate.
 *
 * Acceptance #1 of issue #11: unregistered symbols and unjustified coverage
 * promotions are detected. The SDK source can never be reported as
 * "no drift" unless SDK-derived rows were actually supplied (§1.1).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importScripting } from "../src/import-scripting.ts";
import { importSdkRows } from "../src/import-sdk.ts";
import { buildCatalog, serializeCatalog } from "../src/generate.ts";
import { compareSdkRows, runDriftGate } from "../src/drift.ts";
import { buildCoverageReport } from "../src/coverage.ts";
import { loadRepoInputs } from "../scripts/inputs.ts";

const repoRoot = join(import.meta.dir, "../../..");
function load<T>(relative: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relative), "utf8")) as T;
}

type ScriptingInput = Parameters<typeof importScripting>[0];

const scriptingFile = load<ScriptingInput["symbols"]>(
  "inventories/scripting/generated/symbols.json",
);
const summaryFile = load<ScriptingInput["summary"]>(
  "inventories/scripting/generated/summary.json",
);
const lockFile = load<ScriptingInput["sourcesLock"]>(
  "inventories/scripting/sources.lock.json",
);

describe("drift gate on the real inventories", () => {
  const imports = loadRepoInputs();
  const manifest = buildCatalog(imports);
  const result = runDriftGate({ manifest, imports });

  test("is green when the manifest matches the source snapshots", () => {
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    const verdict = (source: string) =>
      result.verdicts.find((v) => v.source === source)?.verdict;
    expect(verdict("scripting")).toBe("clean");
    expect(verdict("tools")).toBe("clean");
  });

  test("reports SDK drift as unknown, never as 'no drift', without supplied rows", () => {
    const sdkVerdict = result.verdicts.find((v) => v.source === "sdk");
    expect(sdkVerdict?.verdict).toBe("unknown");
    expect(sdkVerdict?.reason).toContain("build-time");
    expect(JSON.stringify(result.verdicts)).not.toContain("no drift");
  });

  test("a claimed clean SDK verdict without supplied rows is a false green", () => {
    const falseClaim = runDriftGate({
      manifest,
      imports,
      claimedVerdicts: [{ source: "sdk", verdict: "clean", reason: "operator claim" }],
    });
    expect(falseClaim.ok).toBe(false);
    expect(falseClaim.violations.map((v) => v.code)).toContain(
      "unjustified-no-drift-claim",
    );
    // The other sources stay clean; only the false claim fails.
    expect(
      falseClaim.violations.every((v) => v.code === "unjustified-no-drift-claim"),
    ).toBe(true);
  });
});

describe("unregistered symbol and stale row detection", () => {
  test("a source symbol with no catalog row fails the gate", () => {
    const base = loadRepoInputs();
    const manifest = buildCatalog(base);

    const extraRow = {
      id: "provisional.ae.scripting.app.brandNewFeature",
      kind: "method",
      owner: "app",
      member: "brandNewFeature",
      sourceKey: "dfad",
      sourceTier: "community-reference",
      publisher: "docsforadobe (community)",
      authority: "community-maintained",
      url: "https://example.invalid/new",
      anchor: "new",
      versionAdded: null,
      access: null,
      status: "documented",
      notes: ["domain=application"],
    };
    const drifted = loadRepoInputs();
    drifted.scripting = importScripting({
      symbols: { symbols: [...scriptingFile.symbols, extraRow] },
      summary: summaryFile,
      sourcesLock: lockFile,
    });

    const result = runDriftGate({ manifest, imports: drifted });
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.code === "unregistered-symbol");
    expect(violation?.id).toBe("ae.scripting.app.brandNewFeature");
    expect(result.verdicts.find((v) => v.source === "scripting")?.verdict).toBe("drift");
  });

  test("a catalog row the source no longer has fails the gate as stale", () => {
    const base = loadRepoInputs();
    const manifest = buildCatalog(base);

    const shrunk = loadRepoInputs();
    shrunk.scripting = importScripting({
      symbols: { symbols: scriptingFile.symbols.filter((s) => s.id !== "provisional.ae.scripting.app.activate") },
      summary: summaryFile,
      sourcesLock: lockFile,
    });

    const result = runDriftGate({ manifest, imports: shrunk });
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.code === "stale-catalog-row");
    expect(violation?.id).toBe("ae.scripting.app.activate");
  });
});

describe("unjustified coverage promotion detection in the manifest", () => {
  const base = loadRepoInputs();

  test("a manifest row claiming real-host verification without evidence fails the gate", () => {
    const manifest = buildCatalog(base);
    const target = manifest.records.find((r) => r.id === "ae.scripting.app.version");
    if (!target) throw new Error("fixture row missing");
    target.coverage.verification = "verified-real-host";
    target.coverage.evidenceRefs = [{ kind: "source-doc", ref: "https://example.invalid" }];

    const result = runDriftGate({ manifest, imports: base });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("unjustified-promotion");
    const violation = result.violations.find((v) => v.id === "ae.scripting.app.version");
    expect(violation?.code).toBe("unjustified-promotion");
  });

  test("a Windows row with only darwin real-host evidence stays UNVERIFIED", () => {
    const manifest = buildCatalog(base);
    const target = manifest.records.find((r) => r.id === "ae.scripting.app.version");
    if (!target) throw new Error("fixture row missing");
    target.compatibility.os = ["win32"];
    target.coverage.verification = "verified-real-host";
    target.coverage.evidenceRefs = [
      { kind: "source-doc", ref: "https://example.invalid" },
      { kind: "real-host", ref: "evidence/macos-run", platform: "darwin" },
    ];

    const result = runDriftGate({ manifest, imports: base });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("windows-unverified");
    expect(result.violations.map((v) => v.code)).toContain("unjustified-promotion");
  });

  test("coverage percentages published while the release set is undetermined are rejected", () => {
    const manifest = buildCatalog(base);
    const undetermined = buildCoverageReport({
      ...base,
      supportedRelease: { state: "not-recorded" },
      generatedAt: "2026-11-13T00:00:00.000Z",
    });
    // Simulate a hand-written report that publishes numbers anyway.
    const tampered = {
      ...undetermined,
      groups: undetermined.groups.map((g) =>
        g.label === "scripting-symbols"
          ? { ...g, percentages: { implemented: 42, automatedFakeTested: 0, verifiedRealHost: 0 } }
          : g,
      ),
    };

    const result = runDriftGate({ manifest, imports: base, claimedReport: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain(
      "coverage-published-while-undetermined",
    );
  });

  test("a numeric percentage on an unsupplied denominator is rejected", () => {
    const manifest = buildCatalog(base);
    const determined = buildCoverageReport({
      ...base,
      supportedRelease: { state: "recorded", releases: ["26.5"] },
      generatedAt: "2026-11-13T00:00:00.000Z",
    });
    const tampered = {
      ...determined,
      groups: determined.groups.map((g) =>
        g.label === "sdk-symbols"
          ? { ...g, percentages: { implemented: 42, automatedFakeTested: 0, verifiedRealHost: 42 } }
          : g,
      ),
    };

    const result = runDriftGate({ manifest, imports: base, claimedReport: tampered });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("denominator-coerced");
  });
});

describe("SDK drift comparison with supplied rows", () => {
  const observedAt = "2026-11-13";
  const baseline = importSdkRows({
    detail: {
      release: "26.5",
      symbols: [
        {
          kind: "suite-slot",
          name: "FixtureAcquire",
          header: "FX.h",
          line: 10,
          class: "external-command",
          evidence: "suite-registration-string",
          rule: "suite+registration-string",
        },
      ],
    },
    observedAt,
  });

  test("identical supplied rows produce no drift", () => {
    const current = importSdkRows({
      detail: {
        release: "26.5",
        symbols: [
          {
            kind: "suite-slot",
            name: "FixtureAcquire",
            header: "FX.h",
            line: 12,
            class: "external-command",
            evidence: "suite-registration-string",
            rule: "suite+registration-string",
          },
        ],
      },
      observedAt,
    });
    expect(compareSdkRows(baseline, current)).toEqual({ added: [], removed: [] });
  });

  test("a newly supplied symbol is detected as drift", () => {
    const current = importSdkRows({
      detail: {
        release: "26.5",
        symbols: [
          ...baseline.map((r) => ({ kind: "suite-slot", name: r.source.symbol ?? "", header: "FX.h", line: 10, class: "external-command", evidence: "suite-registration-string", rule: "suite+registration-string" })),
          {
            kind: "suite-slot",
            name: "FixtureRelease",
            header: "FX.h",
            line: 20,
            class: "external-command",
            evidence: "suite-registration-string",
            rule: "suite+registration-string",
          },
        ],
      },
      observedAt,
    });
    expect(compareSdkRows(baseline, current)).toEqual({
      added: ["ae.sdk.fx.FixtureRelease"],
      removed: [],
    });
  });

  test("the gate uses supplied rows for the SDK verdict and stays unknown without a baseline", () => {
    const imports = loadRepoInputs();
    const manifest = buildCatalog(imports);
    const withRows = runDriftGate({ manifest, imports, sdkRows: baseline });
    const sdkVerdict = withRows.verdicts.find((v) => v.source === "sdk");
    expect(sdkVerdict?.verdict).toBe("unknown");
    expect(sdkVerdict?.reason).toContain("baseline");

    const withBaseline = runDriftGate({
      manifest,
      imports,
      sdkRows: baseline,
      sdkBaselineRows: baseline,
    });
    expect(withBaseline.verdicts.find((v) => v.source === "sdk")?.verdict).toBe("clean");
    expect(withBaseline.ok).toBe(true);
  });
});

describe("manifest generation (capability manifest)", () => {
  const imports = loadRepoInputs();
  const manifest = buildCatalog(imports);

  test("contains every repository-persisted row and no SDK symbol row", () => {
    expect(manifest.records.length).toBe(656 + 464 + 304);
    expect(manifest.records.every((r) => r.persistence === "repository")).toBe(true);
    expect(manifest.records.some((r) => r.kind === "sdk-symbol")).toBe(false);
    expect(manifest.records.some((r) => r.id.startsWith("ae.sdk."))).toBe(false);
    expect(manifest.sdk.persistence).toBe("aggregate-only");
    expect(manifest.sdk.totals.symbols).toBe(4677);
    expect(manifest.sdk.denominatorCaveats.length).toBe(5);
    expect(manifest.contractVersion).toEqual({ major: 1, minor: 0 });
  });

  test("records are sorted by id and serialization is byte-stable", () => {
    const ids = manifest.records.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
    const first = serializeCatalog(manifest);
    const second = serializeCatalog(buildCatalog(imports));
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
  });

  test("the committed manifest matches a fresh build from the current inventories", () => {
    const committed = readFileSync(join(repoRoot, "packages/capability-catalog/generated/catalog.json"), "utf8");
    expect(serializeCatalog(manifest)).toBe(committed);
  });
});
