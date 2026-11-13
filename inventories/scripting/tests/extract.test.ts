/**
 * Unit tests for the inventory extractors.
 *
 * These run without network access and without After Effects. They assert parser
 * behaviour on synthetic markdown plus the anchor convention verified against the
 * live site, so a regression in slug generation fails here rather than silently
 * producing dead provenance links.
 */

import { describe, expect, test } from "bun:test";

import { extractHeadings, slugify } from "../scripts/markdown.ts";
import { extractFromDoc } from "../scripts/extract-symbols.ts";
import { extractEnums } from "../scripts/extract-enums.ts";
import { decodeEntities, normaliseText } from "../scripts/adobe-page.ts";

const urlFor = (p: string) => `https://example.test/${p}/`;

function doc(sitePath: string, text: string) {
  return { path: `x/docs/${sitePath}.md`, sitePath, text };
}

describe("slugify", () => {
  // Expectations verified against the published site's rendered <hN id="...">.
  test("removes punctuation instead of hyphenating it", () => {
    expect(slugify("app.beginUndoGroup()")).toBe("appbeginundogroup");
    expect(slugify("Property.propertyValueType")).toBe("propertypropertyvaluetype");
    expect(slugify("app.exitAfterLaunchAndEval")).toBe("appexitafterlaunchandeval");
  });

  test("hyphenates spaces", () => {
    expect(slugify("Font object")).toBe("font-object");
    expect(slugify("Team Projects")).toBe("team-projects");
  });

  test("drops inline code ticks", () => {
    expect(slugify("`app.activeViewer`")).toBe("appactiveviewer");
  });
});

describe("extractHeadings", () => {
  test("ignores headings inside fenced code", () => {
    const text = [
      "# Title",
      "",
      "```javascript",
      "### not.a.heading()",
      "```",
      "",
      "## Attributes",
    ].join("\n");
    const headings = extractHeadings(text);
    expect(headings.map((h) => h.text)).toEqual(["Title", "Attributes"]);
  });
});

describe("extractFromDoc", () => {
  const text = [
    "# Widget object",
    "",
    "!!! info",
    "    Widget is a subclass of [Base object](base.md). All methods and attributes of Base are available.",
    "",
    "## Attributes",
    "",
    "### Widget.size",
    "",
    "`widget.size`",
    "",
    "#### Type",
    "",
    "Integer; read-only.",
    "",
    "### Widget.opacity",
    "",
    "`widget.opacity`",
    "",
    "#### Type",
    "",
    "Floating-point value; read/write.",
    "",
    "## Methods",
    "",
    "### Widget.resize()",
    "",
    "`widget.resize(width, height)`",
    "",
    "#### Parameters",
    "",
    "| Parameter | Type | Description |",
    "| --- | --- | --- |",
    "| `width` | Integer | Width. |",
    "",
  ].join("\n");

  const result = extractFromDoc(doc("widget", text), {
    sourceKey: "test",
    publisher: "test",
    urlFor,
  });

  test("extracts members with kinds and owners", () => {
    expect(result.symbols.map((s) => `${s.owner}.${s.member}:${s.kind}`)).toEqual([
      "Widget.size:attribute",
      "Widget.opacity:attribute",
      "Widget.resize:method",
    ]);
  });

  test("reads access from the Type subsection", () => {
    const byName = new Map(result.symbols.map((s) => [s.member, s]));
    expect(byName.get("size")?.access).toBe("read");
    expect(byName.get("opacity")?.access).toBe("read-write");
    expect(byName.get("resize")?.access).toBeNull();
  });

  test("captures method signature components", () => {
    const resize = result.symbols.find((s) => s.member === "resize");
    expect(resize?.signature).toEqual(["width", "height"]);
  });

  test("records base class and provenance", () => {
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]?.baseClass).toBe("Base");
    expect(result.symbols[0]?.url).toBe("https://example.test/widget/");
    expect(result.symbols[0]?.authority).toBe("community-maintained");
  });

  test("marks Adobe-undocumented entries distinctly", () => {
    const undoc = [
      "# Thing object",
      "## Attributes",
      "### Thing.hidden",
      "`thing.hidden`",
      "!!! warning",
      '    This method/property is officially undocumented and was found via research.',
      "#### Type",
      "String; read-only.",
    ].join("\n");
    const r = extractFromDoc(doc("thing", undoc), {
      sourceKey: "test",
      publisher: "test",
      urlFor,
    });
    expect(r.symbols[0]?.status).toBe("undocumented-community-research");
    expect(r.symbols[0]?.markedUndocumented).toBe(true);
  });

  test("reads the version note when present", () => {
    const versioned = [
      "# Thing object",
      "## Attributes",
      "### Thing.added",
      "`thing.added`",
      "!!! note",
      "    This functionality was added in After Effects 26.5",
      "#### Type",
      "String; read-only.",
    ].join("\n");
    const r = extractFromDoc(doc("thing", versioned), {
      sourceKey: "test",
      publisher: "test",
      urlFor,
    });
    expect(r.symbols[0]?.versionAdded).toBe("26.5");
    expect(r.symbols[0]?.versionRangeStated).toBe(true);
  });

  test("does not invent a version when none is stated", () => {
    const r = extractFromDoc(
      doc("plain", ["# Plain object", "## Attributes", "### Plain.x", "`plain.x`", "#### Type", "String; read-only."].join("\n")),
      { sourceKey: "test", publisher: "test", urlFor },
    );
    expect(r.symbols[0]?.versionAdded).toBeNull();
    expect(r.symbols[0]?.versionRangeStated).toBe(false);
  });

  test("rejects member headings that belong to another class", () => {
    const mixed = [
      "# Alpha object",
      "## Attributes",
      "### Alpha.one",
      "`alpha.one`",
      "### Beta.two",
      "`beta.two`",
    ].join("\n");
    const r = extractFromDoc(doc("alpha", mixed), {
      sourceKey: "test",
      publisher: "test",
      urlFor,
    });
    expect(r.symbols.map((s) => s.member)).toEqual(["one"]);
  });

  test("resolves the owner from member prefixes when the title differs", () => {
    const mismatched = [
      "# Font object",
      "## Attributes",
      "### FontObject.designAxesData",
      "`font.designAxesData`",
    ].join("\n");
    const r = extractFromDoc(doc("fontobject", mismatched), {
      sourceKey: "test",
      publisher: "test",
      urlFor,
    });
    expect(r.classes[0]?.name).toBe("FontObject");
    expect(r.classes[0]?.ownerResolution).toBe("member-prefix");
    expect(r.classes[0]?.pageTitle).toBe("Font object");
  });

  test("treats a globals page as global functions", () => {
    const globals = [
      "# Global functions",
      "## Methods",
      "### writeLn()",
      "`writeLn(text)`",
      "#### Description",
      "Writes a line.",
    ].join("\n");
    const r = extractFromDoc(doc("globals", globals), {
      sourceKey: "test",
      publisher: "test",
      urlFor,
    });
    expect(r.symbols[0]?.kind).toBe("global-function");
    expect(r.symbols[0]?.owner).toBe("global");
    expect(r.symbols[0]?.status).toBe("documented");
  });
});

describe("extractEnums", () => {
  test("reads a typed bullet list", () => {
    const text = [
      "# Thing object",
      "## Attributes",
      "### Thing.mode",
      "A `ModeType` enumerated value; read/write. One of:",
      "",
      "- `ModeType.FAST`: Fast mode.",
      "- `ModeType.SLOW`: Slow mode.",
    ].join("\n");
    const r = extractEnums(doc("thing", text), { sourceKey: "test", urlFor });
    expect(r.enums).toHaveLength(1);
    expect(r.enums[0]?.name).toBe("ModeType");
    expect(r.enums[0]?.values.map((v) => v.value)).toEqual(["FAST", "SLOW"]);
  });

  test("reads a dedicated enum section with numeric values", () => {
    const text = [
      "# Thing object",
      "## StageType",
      "",
      "| Value | Description |",
      "| --- | --- |",
      "| `StageType.SOURCE` | `0`. The source. |",
      "| `StageType.ALL` | `-1`. Everything. |",
    ].join("\n");
    const r = extractEnums(doc("thing", text), { sourceKey: "test", urlFor });
    expect(r.enums[0]?.name).toBe("StageType");
    expect(r.enums[0]?.definition).toBe("dedicated-section");
    expect(r.enums[0]?.values.map((v) => v.numericValue)).toEqual([0, -1]);
  });

  test("does not invent values for a type never defined", () => {
    const text = [
      "# Thing object",
      "### Thing.mode",
      "A `GhostType` enumerated value; read/write.",
    ].join("\n");
    const r = extractEnums(doc("thing", text), { sourceKey: "test", urlFor });
    expect(r.enums).toHaveLength(0);
  });
});

describe("adobe page text normalisation", () => {
  test("decodes entities", () => {
    expect(decodeEntities("Scripting &amp; Expressions")).toBe(
      "Scripting & Expressions",
    );
    expect(decodeEntities("&#8212;")).toBe("\u2014");
  });

  test("strips tags and collapses whitespace", () => {
    const html = "<div><p>Uses the   Adobe <b>ExtendScript</b> language.</p></div>";
    expect(normaliseText(html)).toBe("Uses the Adobe ExtendScript language.");
  });

  test("drops script and style blocks", () => {
    const html = "<style>.a{color:red}</style><p>Kept</p><script>var x=1</script>";
    expect(normaliseText(html)).toBe("Kept");
  });
});

describe("extractEnums inline-qualified shape", () => {
  test("reads a qualified constant table under a member entry", () => {
    const text = [
      "# Thing object",
      "## Attributes",
      "### Thing.StageType",
      "A namespace object exposing sentinel values.",
      "",
      "| Value | Description |",
      "| --- | --- |",
      "| `StageType.SOURCE` | `0`. The source. |",
      "| `StageType.ALL_EFFECTS` | `-1`. Everything. |",
      "| `StageType.ONLY_MASKS` | `-2`. Masks only. |",
      "",
      "#### Type",
      "Object; read-only.",
    ].join("\n");
    const r = extractEnums(doc("thing", text), { sourceKey: "test", urlFor });
    const stage = r.enums.find((e) => e.name === "StageType");
    expect(stage?.definition).toBe("inline-qualified-values");
    expect(stage?.values.map((v) => [v.value, v.numericValue])).toEqual([
      ["SOURCE", 0],
      ["ALL_EFFECTS", -1],
      ["ONLY_MASKS", -2],
    ]);
  });

  test("does not treat a known class reference as an enum", () => {
    const text = [
      "# Thing object",
      "## Attributes",
      "### Thing.mode",
      "Compare with `OtherClass.SOMETHING` and `OtherClass.ELSE`.",
    ].join("\n");
    const r = extractEnums(doc("thing", text), {
      sourceKey: "test",
      urlFor,
      knownClassNames: ["OtherClass"],
    });
    expect(r.enums).toHaveLength(0);
  });

  test("requires more than one constant before asserting an enum", () => {
    const text = [
      "# Thing object",
      "## Attributes",
      "### Thing.one",
      "See `LonelyType.ONLY`.",
    ].join("\n");
    const r = extractEnums(doc("thing", text), { sourceKey: "test", urlFor });
    expect(r.enums).toHaveLength(0);
  });
});

describe("heading tolerance", () => {
  test("accepts a member heading with a trailing colon", () => {
    const text = [
      "# Thing object",
      "## Attributes",
      "### Thing.lightSource:",
      "`thing.lightSource`",
      "#### Type",
      "Object; read/write.",
    ].join("\n");
    const r = extractFromDoc(doc("thing", text), {
      sourceKey: "test",
      publisher: "test",
      urlFor,
    });
    expect(r.symbols.map((s) => s.member)).toEqual(["lightSource"]);
    expect(r.symbols[0]?.access).toBe("read-write");
  });
});
