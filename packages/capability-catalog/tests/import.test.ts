/**
 * CAP014 — importing the three inventories into one record schema.
 *
 * Inputs are read-only: #9 scripting symbols + summary, #8 tool operations +
 * semantics + snapshot, #10 SDK aggregate + provenance (and, when a consumer
 * holds the licensed SDK, locally supplied per-symbol rows).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promotionViolations } from "../src/evidence.ts";
import { importScripting } from "../src/import-scripting.ts";
import { importSdkAggregate, importSdkRows } from "../src/import-sdk.ts";
import {
  buildScriptingIndex,
  importSemanticOperations,
  importToolOperations,
} from "../src/import-tools.ts";
import { parseCapabilityId } from "../src/ids.ts";

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

const tools = importToolOperations({ operations, snapshot });
const semanticRecords = importSemanticOperations({ semantics, operations, snapshot });

describe("scripting import (#9)", () => {
  test("imports all 656 symbols as canonical repository rows", () => {
    expect(scripting.records.length).toBe(656);
    expect(scripting.denominator).toEqual({ state: "supplied", count: 656 });
    const ids = new Set<string>();
    for (const r of scripting.records) {
      expect(r.id.startsWith("ae.scripting.")).toBe(true);
      expect(parseCapabilityId(r.id)?.namespace).toBe("scripting");
      expect(r.kind).toBe("scripting-symbol");
      expect(r.persistence).toBe("repository");
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
    expect(ids.size).toBe(656);
  });

  test("keeps the input evidence axes separate instead of collapsing them", () => {
    expect(scripting.evidenceLevel.inventory).toBe("source-reviewed");
    expect(scripting.evidenceLevel.verification).toBe("not-run");
    expect(scripting.evidenceLevel.realHost).toBe("not-run");
    expect(scripting.evidenceLevel.statement).toContain(
      "No After Effects process was started",
    );
    for (const r of scripting.records) {
      expect(r.coverage.inventory).toBe("source-reviewed");
      expect(r.coverage.verification).toBe("not-run");
      expect(r.coverage.reachability).toBe("unknown");
      expect(r.coverage.implementation).toBe("unknown");
    }
  });

  test("maps community authority, source revision and observed date per row", () => {
    const version = scripting.records.find((r) => r.id === "ae.scripting.app.version");
    expect(version).toBeDefined();
    expect(version?.source.authority).toBe("community-maintained");
    expect(version?.source.publisher).toBe("community");
    expect(version?.source.symbol).toBe("app.version");
    expect(version?.source.revision).toBe(
      "7137a990db4bd8dc9f5869b8ca431c7dfed52bdc",
    );
    expect(version?.source.observedAt).toBe("2026-11-12");
    expect(version?.coverage.evidenceRefs[0]?.kind).toBe("source-doc");
  });

  test("maps access values without inventing one", () => {
    const byAccess = new Map<string, number>();
    for (const r of scripting.records) {
      byAccess.set(r.access, (byAccess.get(r.access) ?? 0) + 1);
    }
    expect(byAccess.get("read")).toBe(178);
    expect(byAccess.get("read-write")).toBe(220);
    expect(byAccess.get("unknown")).toBe(258);
    // #9 records no access-unclassifiable failures; the three-kind unknown
    // taxonomy stays reserved for rows the inventory itself could not classify.
    for (const r of scripting.records) {
      expect(r.coverage.unknownKind).toBeUndefined();
    }
  });

  test("every imported row earns its documented state — no promotion violations", () => {
    const violations = scripting.records.flatMap(promotionViolations);
    expect(violations).toEqual([]);
  });
});

describe("tool import (#8)", () => {
  test("imports 464 wrapper rows with source-verified implementation evidence", () => {
    expect(tools.records.length).toBe(464);
    expect(tools.denominator).toEqual({ state: "supplied", count: 464 });
    const ids = new Set<string>();
    for (const r of tools.records) {
      expect(r.kind).toBe("tool-operation");
      expect(r.persistence).toBe("repository");
      expect(r.coverage.inventory).toBe("source-reviewed");
      expect(r.coverage.implementation).toBe("implemented");
      expect(r.coverage.verification).toBe("not-run");
      expect(r.execution.canRemoteInvoke).toBeNull();
      expect(r.coverage.evidenceRefs.some((e) => e.kind === "source-impl")).toBe(true);
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
    expect(ids.size).toBe(464);
    expect(tools.evidenceLevel).toEqual({
      inventory: "source-reviewed",
      verification: "not-run",
      realHost: "not-run",
      statement: expect.stringContaining("No After Effects process") as string,
    });
  });

  test("every wrapper links to its normalized semantic operation", () => {
    const semanticIds = new Set(semanticRecords.records.map((r) => r.id));
    expect(semanticIds.size).toBe(304);
    for (const r of tools.records) {
      const link = r.links?.find((l) => l.basis === "semantic-grouping");
      expect(link).toBeDefined();
      expect(semanticIds.has(link?.to ?? "")).toBe(true);
    }
    expect(semanticRecords.records.every((r) => r.kind === "semantic-operation")).toBe(
      true,
    );
    for (const r of semanticRecords.records) {
      const wrappers = r.links?.filter((l) => l.basis === "semantic-grouping") ?? [];
      expect(wrappers.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("marks the 27 access-unclassifiable rows instead of coercing them", () => {
    const unclassifiable = tools.records.filter(
      (r) => r.coverage.unknownKind === "unclassifiable",
    );
    expect(unclassifiable.length).toBe(27);
    const byAccess = new Map<string, number>();
    for (const r of tools.records) byAccess.set(r.access, (byAccess.get(r.access) ?? 0) + 1);
    expect(byAccess.get("read")).toBe(152);
    expect(byAccess.get("write")).toBe(253);
    expect(byAccess.get("execute")).toBe(31);
    expect(byAccess.get("build-test")).toBe(1);
    expect(byAccess.get("unknown")).toBe(27);
    // Arbitrary-script entry points are privileged dev code, not named ops (FR-07).
    const runScript = tools.records.find(
      (r) => r.id === "ae.tool.dakkshin-after-effects-mcp.run-script",
    );
    expect(runScript?.access).toBe("unknown");
    expect(runScript?.risk.trust).toBe("privileged-dev-code");
  });

  test("no tool row claims fake or real-host verification", () => {
    for (const r of [...tools.records, ...semanticRecords.records]) {
      expect(r.coverage.verification).toBe("not-run");
    }
    const violations = [
      ...tools.records.flatMap(promotionViolations),
      ...semanticRecords.records.flatMap(promotionViolations),
    ];
    expect(violations).toEqual([]);
  });

  test("rejects duplicate capability ids instead of silently overwriting", () => {
    const row = operations.operations[0];
    if (!row) throw new Error("fixture operations file is empty");
    expect(() =>
      importToolOperations({ operations: { operations: [row, row] }, snapshot }),
    ).toThrow(/duplicate capability id/);
  });
});

describe("SDK import (#10)", () => {
  type SdkInput = Parameters<typeof importSdkAggregate>[0];
  const aggregate = load<SdkInput["aggregate"]>(
    "inventories/sdk/generated/aggregate.json",
  );
  const provenance = load<SdkInput["provenance"]>(
    "inventories/sdk/generated/provenance.json",
  );
  const sdk = importSdkAggregate({ aggregate, provenance });

  test("aggregate-only input yields zero rows and an unsupplied denominator", () => {
    expect(sdk.records).toEqual([]);
    expect(sdk.supplied).toBe(false);
    expect(sdk.denominator.state).toBe("not-supplied");
    if (sdk.denominator.state === "not-supplied") {
      expect(sdk.denominator.reason).toContain("build-time");
    }
    expect(sdk.evidenceLevel.inventory).toBe("source-reviewed");
    expect(sdk.evidenceLevel.realHost).toBe("not-run");
    expect(sdk.evidenceLevel.statement).toContain("Windows headers were not obtained");
  });

  test("preserves the reported aggregate, its caveats and redistribution limits as provenance", () => {
    expect(sdk.aggregate?.totals.symbols).toBe(4677);
    expect(sdk.aggregate?.denominatorCaveats.length).toBe(5);
    expect(sdk.aggregate?.redistribution.committedContent).toContain("Aggregate counts");
    expect(sdk.aggregate?.totals.unknown).toBe(552);
    expect(sdk.provenance.acquisition.archiveSha256).toBe(
      "7b837d594696ca0ece1ddba5e15b0fd3bf1ee908a1c7be04d4627180aa7ece7e",
    );
  });

  test("locally supplied rows become build-time-supplied records, never repository rows", () => {
    const rows = importSdkRows({
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
          {
            kind: "type",
            name: "FixtureData",
            header: "FX.h",
            line: 20,
            class: "unsupported-or-unknown",
            evidence: "none",
            rule: "unknown",
            unknownReason: "pure-data-type",
          },
        ],
      },
      observedAt: "2026-11-12",
    });
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.kind).toBe("sdk-symbol");
      expect(r.persistence).toBe("build-time-supplied");
      expect(r.coverage.verification).toBe("not-run");
      expect(r.coverage.inventory).toBe("source-reviewed");
    }
    expect(rows[0]?.id).toBe("ae.sdk.fx.FixtureAcquire");
    expect(rows[0]?.access).toBe("execute");
    expect(rows[1]?.coverage.unknownKind).toBe("unclassifiable");
    expect(rows[1]?.access).toBe("unknown");
    expect(rows.flatMap(promotionViolations)).toEqual([]);
  });

  test("host-callback rows are never advertised as remotely invocable (FR-09)", () => {
    const rows = importSdkRows({
      detail: {
        release: "26.5",
        symbols: [
          {
            kind: "callback-slot",
            name: "FixtureRenderCallback",
            header: "FX.h",
            line: 30,
            class: "host-callback",
            evidence: "host-invoked-callback",
            rule: "host-proc-table",
          },
        ],
      },
      observedAt: "2026-11-12",
    });
    expect(rows[0]?.execution.canRemoteInvoke).toBe(false);
    expect(rows[0]?.access).toBe("host-callback");
  });
});

describe("scripting index for cross-source links", () => {
  test("maps source symbol spelling to canonical capability ids", () => {
    const index = buildScriptingIndex(scripting.records);
    expect(index.get("app.version")).toBe("ae.scripting.app.version");
    expect(index.get("AVLayer.adjustmentLayer")).toBe(
      "ae.scripting.AVLayer.adjustmentLayer",
    );
    expect(index.size).toBe(656);
  });
});
