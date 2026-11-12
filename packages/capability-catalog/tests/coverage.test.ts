/**
 * CAP015 — coverage report: per-source denominators, the seven FR-05 states,
 * the three unknown kinds as separate fields, and percentages that stay
 * `unknown` until (a) the supported-release set is recorded (plan §6.1) and
 * (b) the denominator is actually supplied (capability-catalog §1.1).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importScripting } from "../src/import-scripting.ts";
import { importSemanticOperations, importToolOperations } from "../src/import-tools.ts";
import { importSdkAggregate } from "../src/import-sdk.ts";
import {
  buildCoverageReport,
  groupPercentages,
  summarizeGroup,
} from "../src/coverage.ts";
import { makeRecord } from "./fixture.ts";

const repoRoot = join(import.meta.dir, "../../..");
function load<T>(relative: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relative), "utf8")) as T;
}

type ScriptingInput = Parameters<typeof importScripting>[0];
type ToolsInput = Parameters<typeof importToolOperations>[0];
type SemanticInput = Parameters<typeof importSemanticOperations>[0];
type SdkInput = Parameters<typeof importSdkAggregate>[0];

const scripting = importScripting({
  symbols: load<ScriptingInput["symbols"]>("inventories/scripting/generated/symbols.json"),
  summary: load<ScriptingInput["summary"]>("inventories/scripting/generated/summary.json"),
  sourcesLock: load<ScriptingInput["sourcesLock"]>("inventories/scripting/sources.lock.json"),
});
const operations = load<ToolsInput["operations"]>("inventories/tools/generated/operations.json");
const semanticsFile = load<SemanticInput["semantics"]>("inventories/tools/generated/semantics.json");
const snapshot = load<ToolsInput["snapshot"]>("inventories/tools/snapshot/tools.json");
const tools = importToolOperations({ operations, snapshot });
const semantics = importSemanticOperations({ semantics: semanticsFile, operations, snapshot });
const sdk = importSdkAggregate({
  aggregate: load<SdkInput["aggregate"]>("inventories/sdk/generated/aggregate.json"),
  provenance: load<SdkInput["provenance"]>("inventories/sdk/generated/provenance.json"),
});

const AT = "2026-11-13T00:00:00.000Z";
const report = buildCoverageReport({
  scripting,
  tools,
  semantics,
  sdk,
  supportedRelease: { state: "not-recorded" },
  generatedAt: AT,
});

function group(label: string) {
  const found = report.groups.find((g) => g.label === label);
  if (!found) throw new Error(`missing group ${label}`);
  return found;
}

describe("coverage report counts (CAP015)", () => {
  test("counts the seven FR-05 states per group, summing to the denominator", () => {
    const scriptingGroup = group("scripting-symbols");
    expect(scriptingGroup.counts.rows).toBe(656);
    const fr05Sum = Object.values(scriptingGroup.counts.fr05).reduce((a, b) => a + b, 0);
    expect(fr05Sum).toBe(656);
    expect(scriptingGroup.counts.fr05.documented).toBe(656);

    const toolGroup = group("tool-operations");
    expect(toolGroup.counts.rows).toBe(464);
    expect(toolGroup.counts.fr05.implemented).toBe(464);

    const semanticGroup = group("semantic-operations");
    expect(semanticGroup.counts.rows).toBe(304);
    expect(semanticGroup.counts.fr05.documented).toBe(304);

    expect(group("sdk-symbols").counts.rows).toBe(0);
  });

  test("keeps documented and verified axes apart — source-reviewed is not verification", () => {
    const g = group("scripting-symbols");
    expect(g.counts.inventory["source-reviewed"]).toBe(656);
    expect(g.counts.verification["not-run"]).toBe(656);
    expect(g.counts.verification["verified-real-host"]).toBe(0);
    expect(g.counts.verification["automated-fake"]).toBe(0);
    expect(g.counts.fr05["verified-on-real-host"]).toBe(0);
  });

  test("keeps the three unknown kinds in separate fields", () => {
    expect(group("tool-operations").counts.unknownByKind).toEqual({
      undiscovered: 0,
      unclassifiable: 27,
      denominatorUnsupplied: 0,
    });
    expect(group("sdk-symbols").counts.unknownByKind).toEqual({
      undiscovered: 0,
      unclassifiable: 0,
      denominatorUnsupplied: 1,
    });
    expect(group("scripting-symbols").counts.unknownByKind).toEqual({
      undiscovered: 0,
      unclassifiable: 0,
      denominatorUnsupplied: 0,
    });
  });

  test("preserves each input's evidence level on its group", () => {
    expect(group("scripting-symbols").evidenceLevel.statement).toContain(
      "No After Effects process was started",
    );
    expect(group("sdk-symbols").evidenceLevel.statement).toContain(
      "Windows headers were not obtained",
    );
    expect(group("tool-operations").evidenceLevel.verification).toBe("not-run");
  });
});

describe("supported-release gate (plan §6.1)", () => {
  test("without a recorded supported-release set, coverage is undetermined and publishes no percentages", () => {
    expect(report.generatedAt).toBe(AT);
    expect(report.coverage.state).toBe("undetermined");
    if (report.coverage.state === "undetermined") {
      expect(report.coverage.reason).toBe("supported-release-set-not-recorded");
    }
    for (const g of report.groups) {
      expect(g.percentages).toBeUndefined();
    }
  });

  test("with the set recorded, percentages are emitted — but never verified on an unsupplied denominator", () => {
    const determined = buildCoverageReport({
      scripting,
      tools,
      semantics,
      sdk,
      supportedRelease: { state: "recorded", releases: ["26.5"] },
      generatedAt: AT,
    });
    expect(determined.coverage.state).toBe("determined");

    const scriptingGroup = determined.groups.find((g) => g.label === "scripting-symbols");
    expect(scriptingGroup?.percentages?.implemented).toBe(0);
    expect(scriptingGroup?.percentages?.verifiedRealHost).toBe(0);

    const toolGroup = determined.groups.find((g) => g.label === "tool-operations");
    expect(toolGroup?.percentages?.implemented).toBe(100);
    expect(toolGroup?.percentages?.verifiedRealHost).toBe(0);

    const sdkGroup = determined.groups.find((g) => g.label === "sdk-symbols");
    expect(sdkGroup?.denominator.state).toBe("not-supplied");
    expect(sdkGroup?.percentages).toEqual({
      implemented: "unknown",
      automatedFakeTested: "unknown",
      verifiedRealHost: "unknown",
    });
  });

  test("an unsupplied denominator yields unknown percentages, never 0% or 100%", () => {
    const sdkGroup = group("sdk-symbols");
    expect(sdkGroup.denominator.state).toBe("not-supplied");
    const pct = groupPercentages(sdkGroup);
    expect(pct).toEqual({
      implemented: "unknown",
      automatedFakeTested: "unknown",
      verifiedRealHost: "unknown",
    });
    expect(pct.verifiedRealHost).not.toBe(0);
    expect(pct.verifiedRealHost).not.toBe(100);
  });
});

describe("false-green guards", () => {
  const fakeEvidenceLevel = {
    inventory: "source-reviewed",
    verification: "automated-test",
    realHost: "not-run",
    statement: "fixture: automated tests only",
  };

  test("fake-only rows can never produce verified 100%", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      makeRecord({
        id: `ae.tool.fake-tool.fake-op-${i}`,
        kind: "tool-operation",
        coverage: {
          inventory: "source-reviewed",
          implementation: "implemented",
          verification: "automated-fake",
          evidenceRefs: [
            { kind: "source-impl", ref: "fake.ts#L1" },
            { kind: "automated-test", ref: "fake.test.ts" },
          ],
        },
      }),
    );
    const g = summarizeGroup({
      source: "tools",
      kind: "tool-operation",
      label: "tool-operations",
      denominator: { state: "supplied", count: rows.length },
      records: rows,
      evidenceLevel: fakeEvidenceLevel,
    });
    expect(g.counts.fr05["automated-fake-tested"]).toBe(4);
    expect(g.counts.fr05["verified-on-real-host"]).toBe(0);

    const pct = groupPercentages(g);
    expect(pct.verifiedRealHost).toBe(0);
    expect(pct.verifiedRealHost).not.toBe(100);
    expect(pct.implemented).toBe(100);
    expect(pct.automatedFakeTested).toBe(100);
  });

  test("no group in any built report claims real-host verification", () => {
    for (const g of report.groups) {
      expect(g.counts.verification["verified-real-host"]).toBe(0);
      expect(g.counts.fr05["verified-on-real-host"]).toBe(0);
    }
  });
});
