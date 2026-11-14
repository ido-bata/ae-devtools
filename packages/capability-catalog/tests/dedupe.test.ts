/**
 * CAP014 — dedupe across sources.
 *
 * capability-catalog §1: tool parity is a SEPARATE denominator; semantic
 * duplicates are linked, never counted twice as Adobe APIs. Acceptance #2 of
 * issue #11: a symbol reachable from tool + SDK + scripting counts once.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importScripting } from "../src/import-scripting.ts";
import {
  buildScriptingIndex,
  importSemanticOperations,
  importToolOperations,
} from "../src/import-tools.ts";
import { importSdkRows } from "../src/import-sdk.ts";
import { buildCapabilityUniverse } from "../src/dedupe.ts";
import { makeRecord } from "./fixture.ts";

const repoRoot = join(import.meta.dir, "../../..");
function load<T>(relative: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relative), "utf8")) as T;
}

type ScriptingInput = Parameters<typeof importScripting>[0];
type ToolsInput = Parameters<typeof importToolOperations>[0];
type SemanticInput = Parameters<typeof importSemanticOperations>[0];

const scripting = importScripting({
  symbols: load<ScriptingInput["symbols"]>("inventories/scripting/generated/symbols.json"),
  summary: load<ScriptingInput["summary"]>("inventories/scripting/generated/summary.json"),
  sourcesLock: load<ScriptingInput["sourcesLock"]>("inventories/scripting/sources.lock.json"),
});
const operations = load<ToolsInput["operations"]>(
  "inventories/tools/generated/operations.json",
);
const semantics = load<SemanticInput["semantics"]>(
  "inventories/tools/generated/semantics.json",
);
const snapshot = load<ToolsInput["snapshot"]>(
  "inventories/tools/snapshot/tools.json",
);
const tools = importToolOperations({
  operations,
  snapshot,
  scriptingIndex: buildScriptingIndex(scripting.records),
});
const semanticRecords = importSemanticOperations({ semantics, operations, snapshot });

describe("one underlying symbol across three sources counts once", () => {
  test("tool + scripting + SDK rows sharing a symbol yield a single universe entry", () => {
    const scriptingRow = makeRecord({
      id: "ae.scripting.widget.value",
      kind: "scripting-symbol",
      source: {
        publisher: "community",
        uri: "https://example.invalid/widget",
        version: "unresolved",
        observedAt: "2026-11-12",
        authority: "community-maintained",
        symbol: "widget.value",
      },
      coverage: {
        inventory: "source-reviewed",
        evidenceRefs: [{ kind: "source-doc", ref: "https://example.invalid/widget" }],
      },
    });
    const toolRow = makeRecord({
      id: "ae.tool.fixture-tool.widget-info",
      kind: "tool-operation",
      coverage: {
        inventory: "source-reviewed",
        implementation: "implemented",
        evidenceRefs: [{ kind: "source-impl", ref: "fixture.ts#L1" }],
      },
      links: [{ to: "ae.scripting.widget.value", basis: "underlying-symbol" }],
    });
    const sdkRow = makeRecord({
      id: "ae.sdk.fx-widget.widget-value",
      kind: "sdk-symbol",
      persistence: "build-time-supplied",
      source: {
        publisher: "adobe",
        uri: "header://FX.h",
        version: "26.5",
        observedAt: "2026-11-12",
        authority: "primary",
        symbol: "widget.value",
      },
      coverage: {
        inventory: "source-reviewed",
        evidenceRefs: [{ kind: "source-doc", ref: "header://FX.h:1" }],
      },
    });

    const universe = buildCapabilityUniverse({
      scripting: [scriptingRow],
      tools: [toolRow],
      semantics: [],
      sdkRows: [sdkRow],
    });

    expect(universe.adobeApiSymbols).toEqual(["widget.value"]);
    expect(universe.counts.toolLinked).toBe(1);
    expect(universe.counts.toolLinkedAlreadyCounted).toBe(1);
    expect(universe.toolParity).toEqual({ wrapperRows: 1, distinctSemanticOps: 0 });
  });
});

describe("real inventories (#8 + #9)", () => {
  const universe = buildCapabilityUniverse({
    scripting: scripting.records,
    tools: tools.records,
    semantics: semanticRecords.records,
    sdkRows: [],
  });

  test("464 wrapper rows collapse into 304 distinct semantic operations", () => {
    expect(universe.toolParity).toEqual({
      wrapperRows: 464,
      distinctSemanticOps: 304,
    });
  });

  test("tool rows linked to scripting symbols do not grow the Adobe API universe", () => {
    // Every underlying-symbol link resolves into the scripting set, so the
    // universe stays exactly the 656 scripting symbols — no double count.
    expect(universe.counts.toolLinked).toBeGreaterThanOrEqual(7);
    expect(universe.counts.toolLinkedAlreadyCounted).toBeGreaterThanOrEqual(
      universe.counts.toolLinked,
    );
    expect(universe.counts.toolLinkedNew).toBe(0);
    expect(universe.adobeApiSymbols.length).toBe(656);
    expect(new Set(universe.adobeApiSymbols).size).toBe(
      universe.adobeApiSymbols.length,
    );
    expect(
      universe.adobeApiSymbols.filter((s) => s === "app.version").length,
    ).toBe(1);
  });

  test("the naive cross-source sum (656 + 464) is never reported as the universe", () => {
    expect(universe.adobeApiSymbols.length).toBeLessThan(656 + 464);
    expect(universe.counts.unlinkedToolRows).toBeGreaterThan(0);
    // Unlinked wrappers live only in the tool parity denominator.
    expect(
      universe.counts.unlinkedToolRows,
    ).toBe(464 - universe.counts.toolLinked);
  });
});

describe("SDK rows supplied at build time join the universe without publishing rows", () => {
  test("supplied sdk rows add symbols to the universe and stay build-time-supplied", () => {
    const sdkRows = importSdkRows({
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
      observedAt: "2026-11-12",
    });
    const universe = buildCapabilityUniverse({
      scripting: scripting.records,
      tools: tools.records,
      semantics: semanticRecords.records,
      sdkRows,
    });
    expect(universe.adobeApiSymbols.length).toBe(657);
    expect(universe.adobeApiSymbols).toContain("FixtureAcquire");
    expect(sdkRows.every((r) => r.persistence === "build-time-supplied")).toBe(true);
  });
});
