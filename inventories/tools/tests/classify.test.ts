/**
 * Tests for the access classifier (review D1) and citation integrity (D3).
 *
 * These are the regression tests for the two defect classes that invalidated
 * the previous inventory attempt:
 *   D1 — access must be derived from behaviour, never defaulted to write.
 *   D3 — file + line must resolve inside the same file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBody, classifyOverride } from "../scripts/classify.ts";
import { checkCitation } from "../scripts/text.ts";

describe("classifyBody", () => {
  test("an assignment through a host accessor chain is a write", () => {
    const body = [
      'var comp = findComp(String(requireParam(params, "name")));',
      'var layer = findLayer(comp, String(requireParam(params, "layer")));',
      "layer.enabled = enabled;",
      "return layerInfo(layer);",
    ].join("\n");
    const cls = classifyBody(body);
    expect(cls.access).toBe("write");
    expect(cls.basis).toContain("layer.enabled");
  });

  test("a local plain-object field assignment is NOT a host write (D1-b)", () => {
    const body = [
      "var info = { version: String(app.version) };",
      "try {",
      "  var build = app.buildNumber;",
      "  if (build !== undefined) { info.build = String(build); }",
      "} catch (e) {}",
      "return info;",
    ].join("\n");
    const cls = classifyBody(body);
    expect(cls.access).toBe("read");
    expect(cls.access).not.toBe("write");
  });

  test("changing a UI selection is execute, not write (D1-a)", () => {
    const body = [
      "for (var j = 1; j <= comp.numLayers; j++) {",
      "  comp.layer(j).selected = false;",
      "}",
      "wanted.selected = true;",
    ].join("\n");
    const cls = classifyBody(body);
    expect(cls.access).toBe("execute");
    expect(cls.basis).toContain(".selected");
  });

  test("mutating a layer property is a write", () => {
    const body = 'property.setValue(value);\nreturn describeProperty(property);';
    const cls = classifyBody(body);
    expect(cls.access).toBe("write");
    expect(cls.basis).toContain("setValue");
  });

  test("reading host state is a read", () => {
    const body = "return { version: String(app.version), count: project.numItems };";
    expect(classifyBody(body).access).toBe("read");
  });

  test("an unrecognisable body is unknown, never write", () => {
    expect(classifyBody("return 42;").access).toBe("unknown");
    expect(classifyBody("").access).toBe("unknown");
    expect(classifyBody("/* only a comment */").access).toBe("unknown");
  });

  test("comments are not behaviour", () => {
    const body = "// setValue([0,0,0]) would be a write\nreturn 1;";
    expect(classifyBody(body).access).toBe("unknown");
  });

  test("tool-specific extras are honoured", () => {
    const body = "var result = applyEffect(layer, identifier);\nreturn result;";
    expect(classifyBody(body).access).toBe("unknown");
    expect(classifyBody(body, { write: [/applyEffect\s*\(/] }).access).toBe("write");
  });
});

describe("classifyOverride", () => {
  test("rejects basis strings that are too short to be evidence", () => {
    expect(() => classifyOverride("write", "short")).toThrow();
  });

  test("keeps a descriptive basis", () => {
    const cls = classifyOverride(
      "write",
      "creates temporary comp then removes it — net project content unchanged",
    );
    expect(cls.access).toBe("write");
    expect(cls.basis).toContain("net project content unchanged");
  });
});

describe("checkCitation (D3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cite-"));
  writeFileSync(join(dir, "ok.ts"), "line1\nline2\nline3\n");

  test("a valid file+line pair resolves inside that file", () => {
    const res = checkCitation(dir, "ok.ts", 2);
    expect(res.ok).toBe(true);
    expect(res.actual).toBe("line2");
  });

  test("a line past the end of the file fails", () => {
    const res = checkCitation(dir, "ok.ts", 4);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("out of range");
  });

  test("a missing file fails", () => {
    const res = checkCitation(dir, "nope.ts", 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("missing");
  });

  test("line 0 fails", () => {
    expect(checkCitation(dir, "ok.ts", 0).ok).toBe(false);
  });

  test("temp dir cleanup", () => {
    expect(existsSync(join(dir, "ok.ts"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
