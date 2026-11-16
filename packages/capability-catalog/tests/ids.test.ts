/**
 * CAP013 — stable capability ID grammar.
 *
 * The grammar is frozen by Issue #11: `ae.<namespace>.<segment>.<segment>+`.
 * These tests pin construction, parsing, slug rules, and the round-trip from
 * the #9 inventory's provisional IDs to canonical IDs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCapabilityId,
  scriptingId,
  sdkSymbolId,
  semanticOperationId,
  toolOperationId,
} from "../src/ids.ts";

describe("capability ID grammar", () => {
  test("parses every namespace with at least two segments after the namespace", () => {
    expect(parseCapabilityId("ae.scripting.app.version")).toEqual({
      namespace: "scripting",
      segments: ["app", "version"],
    });
    expect(parseCapabilityId("ae.sdk.suites-sp.SPAcquireSuite")).toEqual({
      namespace: "sdk",
      segments: ["suites-sp", "SPAcquireSuite"],
    });
    expect(parseCapabilityId("ae.operation.app.version-info")).toEqual({
      namespace: "operation",
      segments: ["app", "version-info"],
    });
    expect(parseCapabilityId("ae.tool.ido-bata-ae-a8n.app-info")).toEqual({
      namespace: "tool",
      segments: ["ido-bata-ae-a8n", "app-info"],
    });
  });

  test("rejects malformed ids instead of normalizing them silently", () => {
    const bad = [
      "",
      "ae.scripting.app",
      "foo.scripting.app.version",
      "ae.unknown.app.version",
      "ae.scripting..version",
      "ae.scripting.app.version extra",
      "ae.tool.single",
      "ae.operation.app version",
      "ae.tool.ido-bata ae-a8n.app-info",
    ];
    for (const id of bad) {
      expect(parseCapabilityId(id)).toBeNull();
    }
  });

  test("constructors slug tool identities and preserve source symbol spelling", () => {
    expect(toolOperationId("ido-bata/ae-a8n", "app.info")).toBe(
      "ae.tool.ido-bata-ae-a8n.app-info",
    );
    expect(toolOperationId("BenZed/after-effects", "run-script")).toBe(
      "ae.tool.benzed-after-effects.run-script",
    );
    expect(toolOperationId("JUNKDOGE-JOE/after-effects-mcp", "app.version")).toBe(
      "ae.tool.junkdoge-joe-after-effects-mcp.app-version",
    );
    expect(semanticOperationId("app.version-info")).toBe("ae.operation.app.version-info");
    expect(sdkSymbolId("Suites/SP.h", "SPAcquireSuite")).toBe(
      "ae.sdk.suites-sp.SPAcquireSuite",
    );
    expect(scriptingId("AVLayer", "enabled")).toBe("ae.scripting.AVLayer.enabled");
  });

  test("constructors reject segments the grammar cannot represent", () => {
    expect(() => scriptingId("app", "bad segment")).toThrow();
    expect(() => semanticOperationId("App.Version")).toThrow();
    expect(() => semanticOperationId("nodot")).toThrow();
    expect(() => toolOperationId("///", "op")).toThrow();
    expect(() => sdkSymbolId("SP.h", "bad name")).toThrow();
  });

  test("tool ids are slugged, so punctuation variants cannot fork an identity", () => {
    expect(toolOperationId("tool id", "op")).toBe("ae.tool.tool-id.op");
    expect(toolOperationId("Tool//ID", "op.name")).toBe("ae.tool.tool-id.op-name");
  });

  test("every provisional scripting id in the #9 inventory maps to one canonical id", () => {
    const symbols = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../inventories/scripting/generated/symbols.json"),
        "utf8",
      ),
    ) as { symbols: Array<{ id: string; owner: string; member: string }> };

    expect(symbols.symbols.length).toBe(656);
    const seen = new Set<string>();
    for (const s of symbols.symbols) {
      expect(s.id.startsWith("provisional.ae.scripting.")).toBe(true);
      const canonical = s.id.slice("provisional.".length);
      expect(parseCapabilityId(canonical)).toEqual({
        namespace: "scripting",
        segments: [s.owner, s.member],
      });
      expect(scriptingId(s.owner, s.member)).toBe(canonical);
      expect(seen.has(canonical)).toBe(false);
      seen.add(canonical);
    }
    expect(seen.size).toBe(656);
  });

  test("tool operation ids built from the #8 inventory are unique", () => {
    const ops = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../inventories/tools/generated/operations.json"),
        "utf8",
      ),
    ) as { operations: Array<{ toolId: string; name: string }> };

    expect(ops.operations.length).toBe(464);
    const seen = new Set<string>();
    for (const op of ops.operations) {
      const id = toolOperationId(op.toolId, op.name);
      expect(parseCapabilityId(id)?.namespace).toBe("tool");
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(464);
  });
});
