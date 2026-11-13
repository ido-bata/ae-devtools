/**
 * Unit tests for the SDK header extractor.
 *
 * These run without an After Effects SDK and without any licensed material: they
 * exercise the parser on synthetic headers written inline. Nothing here reads the
 * real SDK, and nothing here asserts a count derived from it — the shipped
 * inventory is verified separately by `--check` against a local SDK.
 *
 *   bun test inventories/sdk/scripts
 */

import { describe, expect, test } from "bun:test";
import {
  CLASSES,
  blankNonCode,
  buildAggregate,
  findEnumBlocks,
  findFunctionPointers,
  findStructBlocks,
  isDeprecatedHeader,
  lineIndexAt,
  matchBrace,
  noticeFamily,
  type SymbolRow,
} from "./extract-sdk-inventory.ts";

describe("blankNonCode", () => {
  test("preserves byte offsets and newlines", () => {
    const src = "int a; /* x\ny */ int b;";
    const out = blankNonCode(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toContain("int a;");
    expect(out).toContain("int b;");
    expect(out).not.toContain("x");
  });

  test("blanks string and char literals so braces inside them are inert", () => {
    const out = blankNonCode('const char* s = "{ not a brace }";');
    expect(out).not.toContain("{");
    expect(out).toContain("const char* s =");
  });
});

describe("lineIndexAt", () => {
  test("maps offsets to 1-based line numbers", () => {
    const src = "a\nbb\nccc";
    const at = lineIndexAt(src);
    expect(at(0)).toBe(1);
    expect(at(2)).toBe(2);
    expect(at(7)).toBe(3);
  });
});

describe("matchBrace", () => {
  test("finds the matching close brace across nesting", () => {
    const src = "typedef struct X { int a; struct { int b; } c; } X;";
    const open = src.indexOf("{");
    const close = matchBrace(src, open);
    expect(src[close]).toBe("}");
    expect(src.slice(close, close + 3)).toBe("} X");
  });
});

describe("findStructBlocks", () => {
  test("reads the tag name", () => {
    const src = "typedef struct AEGP_ThingSuite1\n{\n int x;\n} AEGP_ThingSuite1;";
    const blocks = findStructBlocks(blankNonCode(src), lineIndexAt(src));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("AEGP_ThingSuite1");
  });

  test("reads the declarator when the tag is absent", () => {
    const src = "typedef struct\n{\n int x;\n} PF_AnonLike;";
    const blocks = findStructBlocks(blankNonCode(src), lineIndexAt(src));
    expect(blocks[0].name).toBe("PF_AnonLike");
  });

  test("takes the first name when the declarator lists several", () => {
    // `} PF_EventCallbacks, *PF_EventCallbacksPtr;` must not lose its name.
    const src = "typedef struct\n{\n int x;\n} PF_EventCallbacks, *PF_EventCallbacksPtr;";
    const blocks = findStructBlocks(blankNonCode(src), lineIndexAt(src));
    expect(blocks[0].name).toBe("PF_EventCallbacks");
  });
});

describe("findFunctionPointers", () => {
  test("finds named slots including multi-line signatures", () => {
    const src = `
      typedef struct S {
        A_Err (*Alpha)(int a);
        A_Err (*Beta)(
          int a,
          int b);
        int notAFunction;
      } S;`;
    const code = blankNonCode(src);
    const names = findFunctionPointers(code, 0, code.length, lineIndexAt(code)).map((f) => f.name);
    expect(names).toEqual(["Alpha", "Beta"]);
  });

  test("reports the line of each slot", () => {
    const src = "typedef struct S {\n  A_Err (*Alpha)(void);\n  A_Err (*Beta)(void);\n} S;";
    const code = blankNonCode(src);
    const found = findFunctionPointers(code, 0, code.length, lineIndexAt(code));
    expect(found.map((f) => [f.name, f.line])).toEqual([
      ["Alpha", 2],
      ["Beta", 3],
    ]);
  });
});

describe("findEnumBlocks", () => {
  test("finds an unnamed enum block", () => {
    const src = "enum\n{\n A = 0,\n B\n};";
    expect(findEnumBlocks(blankNonCode(src), lineIndexAt(src))).toHaveLength(1);
  });
});

describe("noticeFamily", () => {
  test("recognises the confidential no-reproduction notice", () => {
    const raw = "/* ADOBE CONFIDENTIAL\n reproduction of this material\n is strictly forbidden */";
    expect(noticeFamily(raw)).toBe("adobe-confidential-no-reproduction");
  });

  test("recognises the permissive notice", () => {
    const raw = "/* NOTICE: Adobe permits you to use, modify, and distribute this file */";
    expect(noticeFamily(raw)).toBe("adobe-permissive");
  });

  test("recognises a copyright-only header", () => {
    expect(noticeFamily("// Copyright (c) 2011 Adobe Systems Inc")).toBe("other-copyright-only");
  });

  test("returns no-notice when there is none", () => {
    expect(noticeFamily("#define A 1\n")).toBe("no-notice");
  });
});

describe("isDeprecatedHeader", () => {
  test("flags the *Old.h variants only", () => {
    expect(isDeprecatedHeader("AE_GeneralPlugOld.h")).toBe(true);
    expect(isDeprecatedHeader("AE_GeneralPlug.h")).toBe(false);
    expect(isDeprecatedHeader("SP/SPBasic.h")).toBe(false);
  });
});

describe("buildAggregate", () => {
  const row = (over: Partial<SymbolRow>): SymbolRow => ({
    kind: "suite-slot",
    name: "Synthetic_Symbol",
    header: "X.h",
    line: 1,
    class: "external-command",
    evidence: "suite-registration-string",
    rule: "suite-slot+registration-string:SomeSuite",
    ...over,
  });

  test("assigns every class a bucket and sums to the denominator", () => {
    const rows = [
      row({}),
      row({ class: "host-callback", evidence: "host-invoked-callback" }),
      row({ class: "unsupported-or-unknown", unknownReason: "pure-data-type" }),
    ];
    const agg = buildAggregate(rows, [], "26.5", "Headers");
    expect(agg.totals.symbols).toBe(3);
    for (const c of CLASSES) expect(agg.totals.byClass[c]).toBeGreaterThanOrEqual(0);
    const sum = CLASSES.reduce((s, c) => s + agg.totals.byClass[c], 0);
    expect(sum).toBe(agg.totals.symbols);
    expect(agg.totals.unknown).toBe(1);
  });

  test("never publishes a rule string carrying a declaring struct name", () => {
    // The committed aggregate is public; rule detail is local-only.
    const agg = buildAggregate([row({})], [], "26.5", "Headers");
    const serialised = JSON.stringify(agg);
    expect(serialised).not.toContain("SomeSuite");
    expect(Object.keys(agg.totals.byRuleFamily)).toContain("suite-slot+registration-string");
  });

  test("is deterministic for the same input", () => {
    const rows = [row({}), row({ name: "B", line: 2 })];
    expect(JSON.stringify(buildAggregate(rows, [], "26.5", "Headers"))).toBe(
      JSON.stringify(buildAggregate(rows, [], "26.5", "Headers")),
    );
  });
});
