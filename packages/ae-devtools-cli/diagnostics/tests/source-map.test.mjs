/**
 * Tests for diagnostics → source-position mapping (Issue #37, CAP064).
 *
 * Automated-test / fake-level evidence only: the fixtures under
 * ./fixtures were produced by `../jsx-toolchain`'s own build
 * commands (single-file `build` of fixtures/runtime-error.ts and
 * project `build-project` of fixtures/project/main.ts) and committed —
 * the tests must not invoke tsc/esbuild. No After Effects is involved.
 *
 * Regenerate fixtures (from packages/ae-devtools-cli/jsx-toolchain, after npm install):
 *   node -e 'import("./src/build.mjs").then(async m => {
 *     m.buildFile("fixtures/runtime-error.ts", { outDir: "../diagnostics/tests/fixtures/single" });
 *     await m.buildProject("fixtures/project/main.ts", { outDir: "../diagnostics/tests/fixtures/project", name: "probe" });
 *   })'
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  locateMapFiles,
  loadSourceMap,
  resolveGeneratedPosition,
  resolveDiagnosticsSource,
  excerptFromContent,
  SOURCE_MAP_RESULT_SCHEMA,
} from "../source-map.mjs";
import { makeDiagnosticsRecord } from "../schema.mjs";
import { fromAeError } from "../collectors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const SINGLE_DIR = join(FIX, "single");
const PROJECT_DIR = join(FIX, "project");
const SINGLE_JSX = join(SINGLE_DIR, "runtime-error.jsx");
const SINGLE_MAP = join(SINGLE_DIR, "runtime-error.jsx.map");
const PROJECT_JSX = join(PROJECT_DIR, "probe.jsx");
const CLI = join(HERE, "..", "source-map.mjs");

function recordWith(source) {
  return makeDiagnosticsRecord({
    kind: "script-exception",
    severity: "error",
    message: "test failure",
    collector: "test",
    source,
  });
}

// --- single-file (build) round-trip ------------------------------------

test("single-file: jsx line maps back to the TS source line with excerpt", () => {
  // runtime-error.jsx line 3 is `var missing = __toolchainUndeclaredIdentifier;`
  // which is runtime-error.ts line 3.
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 3 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.schema, SOURCE_MAP_RESULT_SCHEMA);
  assert.equal(r.status, "mapped");
  assert.equal(r.maps.bundle, null);
  assert.equal(r.original.file, "runtime-error.ts");
  assert.equal(r.original.line, 3);
  assert.match(r.original.excerpt, /__toolchainUndeclaredIdentifier/);
  assert.equal(r.original.contentAvailable, true);
  // line-only query: first mapped segment on jsx line 3 is genCol 4
  assert.equal(r.hops[0].generated.column, 4);
  assert.equal(r.generated.column, null); // record carried no column
});

test("single-file: explicit 1-based record column is honored", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 3, column: 10 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "mapped");
  assert.equal(r.original.file, "runtime-error.ts");
  assert.equal(r.generated.column, 10);
  assert.equal(r.hops[0].generated.column, 9); // 1-based → 0-based
});

test("single-file: works through fromAeError record shape", () => {
  const rec = fromAeError(
    { aeError: { name: "ReferenceError", message: "x is undefined", line: 3, file: SINGLE_JSX } },
    { ctx: {} },
  );
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "mapped");
  assert.equal(r.original.line, 3);
});

test("single-file: bare filename resolves via mapDir", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: "runtime-error.jsx", line: 3 });
  const r = resolveDiagnosticsSource(rec, { mapDir: SINGLE_DIR });
  assert.equal(r.status, "mapped");
  assert.equal(r.original.file, "runtime-error.ts");
});

// --- project (build-project) two-hop ------------------------------------

test("project: jsx line resolves through jsx.map + bundle.js.map to TS", () => {
  // probe.jsx line 18 is `$.global.__toolchainProject = report;` → main.ts line 6
  const rec = recordWith({ assetKind: "jsx-script", path: PROJECT_JSX, line: 18 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "mapped");
  assert.ok(r.maps.bundle, "expected bundle map to be discovered");
  assert.equal(r.original.file, "main.ts");
  assert.equal(r.original.line, 6);
  assert.match(r.original.excerpt, /__toolchainProject/);
  assert.equal(r.hops.length, 2);
  assert.equal(r.hops[0].map, "jsx");
  assert.equal(r.hops[1].map, "bundle");
  assert.equal(r.hops[0].original.source, "probe.bundle.js");
  assert.equal(r.original.via.jsx.line, 18);
});

test("project: positions can land in a bundled lib file", () => {
  const jsxMap = loadSourceMap(join(PROJECT_DIR, "probe.jsx.map"));
  const bundleMap = loadSourceMap(join(PROJECT_DIR, "probe.bundle.js.map"));
  // find a generated line whose two-hop result lands in lib/greet.ts
  const lines = readFileSync(PROJECT_JSX, "utf8").split("\n");
  let found = null;
  for (let l = 1; l <= lines.length && !found; l++) {
    const r = resolveGeneratedPosition({ jsxMap, bundleMap, line: l, columnSpecified: false });
    if (r.status === "mapped" && /greet\.ts$/.test(r.original.file)) found = r;
  }
  assert.ok(found, "expected some jsx line to map into lib/greet.ts");
  assert.equal(found.original.line >= 1, true);
});

// --- honest failure statuses ---------------------------------------------

test("unmapped: generated line beyond the map stays unmapped", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 9999 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "unmapped");
  assert.equal(r.original, null);
  assert.match(r.reason, /not covered/);
});

test("unmapped: explicit column with no segments stays unmapped", () => {
  const jsxMap = loadSourceMap(SINGLE_MAP);
  const r = resolveGeneratedPosition({ jsxMap, line: 9999, column: 0 });
  assert.equal(r.status, "unmapped");
});

test("explicit map options are authoritative when discovery fails", () => {
  // The record's source.path is a host-side path absent on this machine
  // — discovery finds nothing, but the caller-supplied map must win.
  const rec = recordWith({ assetKind: "jsx-script", path: "/nonexistent/host-side.jsx", line: 3 });
  const r = resolveDiagnosticsSource(rec, { jsxMapPath: SINGLE_MAP });
  assert.equal(r.status, "mapped");
  assert.equal(r.original.file, "runtime-error.ts");
  assert.equal(r.original.line, 3);
});

test("explicit pre-parsed maps resolve a record with no path at all", () => {
  const rec = recordWith({ assetKind: "jsx-script", line: 18 }); // no source.path
  const jsxMap = loadSourceMap(join(PROJECT_DIR, "probe.jsx.map"));
  const bundleMap = loadSourceMap(join(PROJECT_DIR, "probe.bundle.js.map"));
  const r = resolveDiagnosticsSource(rec, { jsxMap, bundleMap });
  assert.equal(r.status, "mapped");
  assert.equal(r.original.file, "main.ts");
  assert.equal(r.original.line, 6);
});

test("explicit jsxMapPath still pair-discovers the project bundle map", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: "/nonexistent/x.jsx", line: 18 });
  const r = resolveDiagnosticsSource(rec, { jsxMapPath: join(PROJECT_DIR, "probe.jsx.map") });
  assert.equal(r.status, "mapped");
  assert.ok(r.maps.bundle?.endsWith("probe.bundle.js.map"));
  assert.equal(r.original.file, "main.ts");
});

test("invalid-map: undecodable mappings VLQ is reported, not thrown", () => {
  // "!!!!" is not valid base64 VLQ — parseMappings throws a plain Error
  // lazily inside lookup(); the resolver must surface invalid-map.
  const jsxMap = { version: 3, sources: ["a.ts"], names: [], mappings: "!!!!" };
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 3 });
  const r = resolveDiagnosticsSource(rec, { jsxMap });
  assert.equal(r.status, "invalid-map");
  assert.match(r.reason, /invalid base64/);
});

test("unsupported-with-reason: plugin-binary has no symbol source to map", () => {
  const rec = recordWith({ assetKind: "plugin-binary", path: "/nonexistent/plugin.aex", line: 12 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "unsupported-with-reason");
  assert.equal(r.original, null);
  assert.match(r.reason, /no symbol source/);
});

test("no-map: record path has no sibling .jsx.map", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: "/nonexistent/nowhere.jsx", line: 3 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "no-map");
  assert.equal(r.original, null);
});

test("no-map: record without path and without options", () => {
  const rec = recordWith({ assetKind: "jsx-script", line: 3 });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "no-map");
});

test("no-position: record without a usable line", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX });
  const r = resolveDiagnosticsSource(rec);
  assert.equal(r.status, "no-position");
  // schema refuses line:0 at validation; feed the resolver a raw object
  const r2 = resolveDiagnosticsSource({ source: { assetKind: "jsx-script", path: SINGLE_JSX, line: 0 } });
  assert.equal(r2.status, "no-position");
});

test("invalid-map: malformed .jsx.map JSON is reported, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-smap-"));
  try {
    writeFileSync(join(dir, "bad.jsx.map"), "{ not json");
    const rec = recordWith({ assetKind: "jsx-script", path: join(dir, "bad.jsx"), line: 1 });
    const r = resolveDiagnosticsSource(rec);
    assert.equal(r.status, "invalid-map");
    assert.match(r.reason, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguous: multiple jsx maps in a directory require disambiguation", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-smap-"));
  try {
    copyFileSync(SINGLE_MAP, join(dir, "a.jsx.map"));
    copyFileSync(SINGLE_MAP, join(dir, "b.jsx.map"));
    const rec = recordWith({ assetKind: "jsx-script", path: "whatever.jsx", line: 3 });
    const r = resolveDiagnosticsSource(rec, { mapDir: dir });
    assert.equal(r.status, "ambiguous");
    assert.equal(r.candidates.length, 2);
    // preferName disambiguates
    copyFileSync(SINGLE_MAP, join(dir, "runtime-error.jsx.map"));
    const r2 = resolveDiagnosticsSource(rec, { mapDir: dir, preferName: "runtime-error" });
    assert.equal(r2.status, "mapped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two-hop: unmapped middle hop stays unmapped", () => {
  const jsxMap = { version: 3, sources: ["b.js"], names: [], mappings: "AAAA" };
  const bundleMap = { version: 3, sources: ["a.ts"], names: [], mappings: "" };
  const r = resolveGeneratedPosition({ jsxMap, bundleMap, line: 1, column: 0 });
  assert.equal(r.status, "unmapped");
  assert.equal(r.hops.length, 2);
});

test("excerpt: absent sourcesContent yields null excerpt, not a guess", () => {
  const jsxMap = { version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" };
  const r = resolveGeneratedPosition({ jsxMap, line: 1, column: 0 });
  assert.equal(r.status, "mapped");
  assert.equal(r.original.excerpt, null);
  assert.equal(r.original.contentAvailable, false);
});

test("excerptFromContent handles bounds", () => {
  assert.equal(excerptFromContent("a\nb\n", 2), "b");
  assert.equal(excerptFromContent("a\n", 5), null);
  assert.equal(excerptFromContent(null, 1), null);
});

// --- locateMapFiles -------------------------------------------------------

test("locateMapFiles: .jsx artifact finds sibling map", () => {
  const r = locateMapFiles(SINGLE_JSX);
  assert.equal(r.status, "ok");
  assert.equal(r.jsxMapPath, SINGLE_MAP);
  assert.equal(r.bundleMapPath, null); // single-file build: no bundle map
});

test("locateMapFiles: .jsx.map path used directly; project pair detected", () => {
  const r = locateMapFiles(join(PROJECT_DIR, "probe.jsx.map"));
  assert.equal(r.status, "ok");
  assert.ok(r.bundleMapPath?.endsWith("probe.bundle.js.map"));
});

test("locateMapFiles: bundle.js.map derives the jsx map", () => {
  const r = locateMapFiles(join(PROJECT_DIR, "probe.bundle.js.map"));
  assert.equal(r.status, "ok");
  assert.ok(r.jsxMapPath.endsWith("probe.jsx.map"));
});

test("locateMapFiles: preferName '.bundle.js' stem still matches the jsx map", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-smap-"));
  try {
    copyFileSync(join(PROJECT_DIR, "probe.jsx.map"), join(dir, "probe.jsx.map"));
    copyFileSync(SINGLE_MAP, join(dir, "other.jsx.map"));
    // A bundle-artifact basename must reduce to the same "probe" stem —
    // otherwise directory discovery falls through to ambiguous.
    const r = locateMapFiles(dir, { preferName: "probe.bundle.js" });
    assert.equal(r.status, "ok");
    assert.ok(r.jsxMapPath.endsWith("probe.jsx.map"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locateMapFiles: output prefix works", () => {
  const r = locateMapFiles(join(SINGLE_DIR, "runtime-error"));
  assert.equal(r.status, "ok");
  assert.equal(r.jsxMapPath, SINGLE_MAP);
});

// --- CLI ------------------------------------------------------------------

test("cli: --jsx/--line prints mapped JSON and exits 0", () => {
  const out = execFileSync(
    process.execPath,
    [CLI, "--jsx", SINGLE_JSX, "--line", "3"],
    { encoding: "utf8" },
  );
  const r = JSON.parse(out);
  assert.equal(r.status, "mapped");
  assert.equal(r.original.file, "runtime-error.ts");
});

test("cli: explicit --jsx-map/--bundle-map resolve a record whose path is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-smap-"));
  try {
    const recPath = join(dir, "rec.json");
    writeFileSync(recPath, JSON.stringify(recordWith({
      assetKind: "jsx-script", path: "/nonexistent/host-side.jsx", line: 3,
    })));
    const single = JSON.parse(execFileSync(process.execPath,
      [CLI, recPath, "--jsx-map", SINGLE_MAP], { encoding: "utf8" }));
    assert.equal(single.status, "mapped");
    assert.equal(single.original.file, "runtime-error.ts");

    // two-hop: project jsx map + explicit bundle map
    writeFileSync(recPath, JSON.stringify(recordWith({
      assetKind: "jsx-script", path: "/nonexistent/host-side.jsx", line: 18,
    })));
    const project = JSON.parse(execFileSync(process.execPath,
      [CLI, recPath,
        "--jsx-map", join(PROJECT_DIR, "probe.jsx.map"),
        "--bundle-map", join(PROJECT_DIR, "probe.bundle.js.map")],
      { encoding: "utf8" }));
    assert.equal(project.status, "mapped");
    assert.equal(project.original.file, "main.ts");
    assert.equal(project.original.line, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: record file input works; unmapped exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-smap-"));
  try {
    const recPath = join(dir, "rec.json");
    writeFileSync(recPath, JSON.stringify(recordWith({
      assetKind: "jsx-script", path: SINGLE_JSX, line: 3,
    })));
    const ok = JSON.parse(execFileSync(process.execPath, [CLI, recPath], { encoding: "utf8" }));
    assert.equal(ok.status, "mapped");

    writeFileSync(recPath, JSON.stringify(recordWith({
      assetKind: "jsx-script", path: SINGLE_JSX, line: 9999,
    })));
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, recPath], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
