/**
 * run.mjs — jsx-toolchain tests (Issue #52).
 * Fake/unit level only; real-host evidence lives in EVIDENCE.md.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { lintSource, lintOutput, hasErrors } from "../src/es3-lint.mjs";
import { buildFile, buildProject, transpileToEs3 } from "../src/build.mjs";
import { checkFile, checkProject } from "../src/check.mjs";
import { lookup, parseMappings } from "../src/sourcemap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures");
const CLI = join(HERE, "..", "src", "cli.mjs");
let passed = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(() => { passed++; console.log(`ok ${name}`); }).catch((e) => {
        console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1;
      }));
    } else {
      passed++; console.log(`ok ${name}`);
    }
  } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

t("lint flags ES5 builtins in source", () => {
  const src = readFileSync(join(FIX, "es5.ts"), "utf8");
  const d = lintSource(src, { filename: "es5.ts" });
  assert.ok(hasErrors(d));
  assert.ok(d.some((x) => x.code.includes("forEach") || x.message.includes("ES5")));
  assert.ok(d.some((x) => x.message.includes("JSON")));
  assert.ok(d.some((x) => x.message.includes("Object")));
});

t("lint allows ES3-clean source", () => {
  const src = readFileSync(join(FIX, "ok.ts"), "utf8");
  assert.equal(hasErrors(lintSource(src, { filename: "ok.ts" })), false);
});

t("lint does not flag String.indexOf (ES3)", () => {
  const d = lintSource('var i = "abc".indexOf("b");', { filename: "x.ts" });
  assert.equal(hasErrors(d), false);
});

t("lint rejects module syntax in single-file mode", () => {
  const d = lintSource('import x from "./y";\nexport default x;', { filename: "x.ts", allowModules: false });
  assert.ok(d.some((x) => x.code === "es3-module-syntax"));
});

t("lint allows relative module syntax in project mode", () => {
  const d = lintSource('import { x } from "./lib/x";\nexport function f() { return x; }\n', { filename: "m.ts", allowModules: true });
  assert.equal(d.length, 0, JSON.stringify(d));
});

t("lint rejects bare module specifiers even in project mode", () => {
  const d = lintSource('import fs from "fs";\n', { filename: "m.ts", allowModules: true });
  assert.ok(d.some((x) => x.code === "es3-bare-import"), JSON.stringify(d));
});

t("AST lint ignores ES3-adjacent words inside strings/comments", () => {
  const src = '// class arrow => function*\nvar s = "JSON.parse(Object.keys)";\nvar ok = 1;\n';
  const d = lintSource(src, { filename: "safe.ts", allowModules: false });
  assert.equal(d.length, 0, JSON.stringify(d));
});

t("AST lint flags real ES5 syntax (getter)", () => {
  const d = lintSource('var o = { get x() { return 1; } };\n', { filename: "g.ts", allowModules: false });
  assert.ok(d.length > 0, "expected a diagnostic");
});

t("build transpiles ok.ts to ES3 and emits map", () => {
  const r = buildFile(join(FIX, "ok.ts"));
  assert.equal(r.status, "ok");
  assert.match(r.output, /var msg/);
  assert.doesNotMatch(r.output, /=>|`|\blet\b|\bconst\b/);
  assert.ok(r.map.mappings.length > 0);
  assert.ok(r.map.sourcesContent?.length >= 1);
});

t("build refuses es5.ts at lint stage", () => {
  const r = buildFile(join(FIX, "es5.ts"));
  assert.equal(r.status, "lint-failed");
  assert.equal(r.output, null);
});

t("build still emits runtime-error.ts (type errors are check's job)", () => {
  const r = buildFile(join(FIX, "runtime-error.ts"));
  assert.equal(r.status, "ok");
  assert.match(r.output, /__toolchainUndeclaredIdentifier/);
});

t("output lint catches non-ES3 target regression", () => {
  const bad = "var f = () => 1; var s = `x`;";
  const d = lintOutput(bad);
  assert.ok(hasErrors(d));
});

t("output lint ignores keywords inside strings", () => {
  const d = lintOutput('var s = "let const class";');
  assert.equal(hasErrors(d), false);
});

// --- ES3 grammar proof (acorn ecmaVersion 3) -------------------------
// These are cases the previous SyntaxKind whitelist could not see:
// it only enumerated forbidden kinds and passed anything it did not
// recognize. A real ES3 parser accepts/rejects actual grammar.

t("ES3 parser rejects object-literal trailing comma (whitelist missed it)", () => {
  const d = lintOutput("var o = {a:1,};");
  assert.ok(d.some((x) => x.code === "es3-syntax"), JSON.stringify(d));
});

t("ES3 parser rejects getter syntax", () => {
  const d = lintOutput("var o = { get x() { return 1; } };");
  assert.ok(d.some((x) => x.code === "es3-syntax"), JSON.stringify(d));
});

t("ES3 reserved words as identifiers are rejected (acorn gap, closed)", () => {
  for (const src of ["var class = 1;", "var o = {}; o.class = 1;", "function f() { var delete = 2; }"]) {
    const d = lintOutput(src);
    // hard keywords fail the grammar parse (es3-syntax); future reserved
    // words acorn accepts fail the reserved-word check (es3-reserved-word)
    assert.ok(d.some((x) => x.code === "es3-reserved-word" || x.code === "es3-syntax"), `${src} -> ${JSON.stringify(d)}`);
  }
});

t("reserved words as object-literal keys are tolerated (JScript/ES5 reality)", () => {
  const d = lintOutput("var o = {default: 1, function: 2};");
  assert.equal(hasErrors(d), false, JSON.stringify(d));
});

t("ES3-clean constructs still pass the grammar proof", () => {
  const src = [
    "var a = [1,2,];",          // array trailing comma IS ES3
    "with (o) { x = 1; }",      // with is ES3
    "try { f(); } catch (e) { g(e); }",
    "var re = /a+/g;",
    "label: for (var i = 0; i < 3; i++) { if (i) continue label; }",
  ].join("\n");
  const d = lintOutput(src);
  assert.equal(hasErrors(d), false, JSON.stringify(d));
});

// --- runtime API compatibility (separate from syntax) ----------------

t("ES3 host builtins are NOT flagged (Date.UTC / String.fromCharCode false-positive fix)", () => {
  const src = [
    "var t = Date.UTC(2020, 0, 1);",
    "var p = Date.parse('x');",
    "var c = String.fromCharCode(65);",
    "var i = 'abc'.indexOf('b');",
    "var s = 'x'.substring(0, 1);",
    "var h = o.hasOwnProperty('k');",
    "var pr = Array.prototype.slice.call(a);",
  ].join("\n");
  assert.equal(hasErrors(lintOutput(src)), false, JSON.stringify(lintOutput(src)));
  assert.equal(hasErrors(lintSource(src, { filename: "x.js", allowModules: false })), false);
});

t("ES5+ builtins ARE flagged in output with es3-api codes", () => {
  const cases = [
    ["var j = JSON.parse('{}');", "es3-api-builtin"],
    ["var k = Object.keys(o);", "es3-api-builtin"],
    ["var n = Date.now();", "es3-api-builtin"],
    ["var m = Math.trunc(x);", "es3-api-builtin"],
    ["var c = String.fromCodePoint(65);", "es3-api-builtin"],
    ["var s = Object.setPrototypeOf(a, b);", "es3-api-builtin"], // tsc __extends helper dep
    ["var o = Object.create(null);", "es3-api-builtin"],
    ["xs.forEach(function (v) {});", "es3-api-method"],
    ["var f = g.bind(null);", "es3-api-method"],
  ];
  for (const [src, code] of cases) {
    const d = lintOutput(src);
    assert.ok(d.some((x) => x.code === code), `${src} -> ${JSON.stringify(d)}`);
  }
});

t("syntax-legality and API-absence are reported under different codes", () => {
  const d = lintOutput("var j = JSON.parse('{}'); var f = () => 1;");
  // the arrow fails the grammar proof first (parse fails -> API pass
  // cannot run); JSON alone surfaces under es3-api-builtin (see above)
  assert.ok(d.some((x) => x.code === "es3-syntax"), JSON.stringify(d));
});

t("ambiguous .indexOf is deliberately not flagged (String ES3 vs Array ES5)", () => {
  const d = lintOutput("var i = a.indexOf(x);");
  assert.equal(hasErrors(d), false, JSON.stringify(d));
});

t("sourcemap lookup maps generated line to TS source", () => {
  const r = buildFile(join(FIX, "runtime-error.ts"));
  assert.equal(r.status, "ok");
  // find generated line containing the undeclared identifier
  const genLines = r.output.split("\n");
  const idx = genLines.findIndex((l) => l.includes("__toolchainUndeclaredIdentifier"));
  assert.ok(idx >= 0);
  const pos = lookup(r.map, idx + 1, 10);
  assert.ok(pos, "expected a mapped position");
  assert.match(pos.source, /runtime-error\.ts$/);
  // the identifier is declared on source line 3
  assert.equal(pos.line, 3);
});

t("sourcemap lookup returns null for unmapped position", () => {
  const map = { version: 3, sources: ["a.ts"], names: [], mappings: "" };
  assert.equal(parseMappings(map).length, 1);
  assert.equal(lookup(map, 1, 0), null);
});

t("check reports type error in type-error.ts", () => {
  const r = checkFile(join(FIX, "type-error.ts"));
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.severity === "error"));
});

t("check passes ok.ts", () => {
  const r = checkFile(join(FIX, "ok.ts"));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

t("cli build writes jsx+map to outdir", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const out = execFileSync("node", [CLI, "build", join(FIX, "ok.ts"), "-o", dir], { encoding: "utf8" });
    const r = JSON.parse(out);
    assert.equal(r.status, "ok");
    const jsx = readFileSync(join(dir, "ok.jsx"), "utf8");
    const map = JSON.parse(readFileSync(join(dir, "ok.jsx.map"), "utf8"));
    assert.match(jsx, /app\.version/);
    assert.ok(map.mappings.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("cli lint exits 1 on es5.ts", () => {
  assert.throws(() => execFileSync("node", [CLI, "lint", join(FIX, "es5.ts")], { encoding: "utf8", stdio: "pipe" }));
});

t("cli map resolves a position end-to-end", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    execFileSync("node", [CLI, "build", join(FIX, "runtime-error.ts"), "-o", dir], { encoding: "utf8" });
    const jsx = readFileSync(join(dir, "runtime-error.jsx"), "utf8");
    const genLine = jsx.split("\n").findIndex((l) => l.includes("__toolchainUndeclaredIdentifier")) + 1;
    const out = execFileSync("node", [CLI, "map", join(dir, "runtime-error.jsx.map"), String(genLine), "10"], { encoding: "utf8" });
    const r = JSON.parse(out);
    assert.equal(r.original.line, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("buildProject bundles multi-file project to ES3 JSX", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const r = await buildProject(join(FIX, "project/main.ts"), { outDir: dir, name: "probe" });
    assert.equal(r.status, "ok", JSON.stringify(r.diagnostics));
    assert.equal(r.inputs.length, 3);
    const jsx = readFileSync(join(dir, "probe.jsx"), "utf8");
    assert.match(jsx, /hello /);
    assert.doesNotMatch(jsx, /\bimport\b|\bexport\b/);
    assert.equal(lintOutput(jsx).length, 0, JSON.stringify(lintOutput(jsx)));
    for (const f of ["probe.jsx.map", "probe.bundle.js", "probe.bundle.js.map"]) {
      assert.ok(existsSync(join(dir, f)), `missing ${f}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("buildProject fails closed on unresolvable/bare import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const f = join(dir, "bad.ts");
    writeFileSync(f, 'import fs from "fs";\n$.global.x = 1;\n');
    const r = await buildProject(f, { outDir: dir });
    // esbuild may fail resolution or the AST lint may catch the bare
    // specifier — either way the build must fail closed.
    assert.notEqual(r.status, "ok");
    assert.ok(r.diagnostics.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("resolvePosition maps JSX line back to original TS file", async () => {
  const { resolvePosition } = await import("../src/bundle.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const r = await buildProject(join(FIX, "project/main.ts"), { outDir: dir, name: "probe" });
    assert.equal(r.status, "ok");
    const jsxMap = JSON.parse(readFileSync(join(dir, "probe.jsx.map"), "utf8"));
    const bundleMap = JSON.parse(readFileSync(join(dir, "probe.bundle.js.map"), "utf8"));
    const jsx = readFileSync(join(dir, "probe.jsx"), "utf8");
    const genLine = jsx.split("\n").findIndex((l) => l.includes("__toolchainProject")) + 1;
    assert.ok(genLine > 0);
    const pos = resolvePosition({ jsxMap, bundleMap, line: genLine, column: 10 });
    assert.ok(pos, "expected two-hop mapped position");
    assert.match(pos.source, /main\.ts$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("checkProject typechecks directory with cross-file imports", () => {
  const r = checkProject(join(FIX, "project"));
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.mode, "project");
  assert.ok(r.files >= 3);
});

t("checkProject catches cross-file type error", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    writeFileSync(join(dir, "a.ts"), 'export function f(): number { return "s"; }\n');
    writeFileSync(join(dir, "main.ts"), 'import { f } from "./a";\nvar n: number = f();\n');
    const r = checkProject(dir);
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.file.includes("a.ts")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("buildProject lowers bundler/transpiler helpers to ES3 (enum, class, re-export)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const r = await buildProject(join(FIX, "project-helpers/main.ts"), { outDir: dir, name: "helpers" });
    assert.equal(r.status, "ok", JSON.stringify(r.diagnostics));
    const jsx = readFileSync(join(dir, "helpers.jsx"), "utf8");
    // transpiler helpers are present AND the artifact is still ES3
    assert.match(jsx, /Kind\[/);
    assert.equal(lintOutput(jsx).length, 0, JSON.stringify(lintOutput(jsx)));
    assert.doesNotMatch(jsx, /Object\.defineProperty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("buildProject fails closed when bundler helpers need ES5 builtins", async () => {
  // Same sources WITHOUT the fixture tsconfig (define semantics on):
  // esbuild emits __publicField -> Object.defineProperty, which the
  // output API check must reject — helpers are not blindly trusted.
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const { mkdirSync, cpSync } = await import("node:fs");
    mkdirSync(join(dir, "lib"), { recursive: true });
    cpSync(join(FIX, "project-helpers/lib/report.ts"), join(dir, "lib/report.ts"));
    cpSync(join(FIX, "project-helpers/lib/index.ts"), join(dir, "lib/index.ts"));
    cpSync(join(FIX, "project-helpers/main.ts"), join(dir, "main.ts"));
    const r = await buildProject(join(dir, "main.ts"), { outDir: dir, name: "helpers" });
    assert.equal(r.status, "output-lint-failed", JSON.stringify(r.status));
    assert.ok(r.diagnostics.some((d) => d.code === "es3-api-builtin" && d.message.includes("Object.defineProperty")),
      JSON.stringify(r.diagnostics));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("resolvePosition returns null when the middle hop is unmapped", async () => {
  const { resolvePosition } = await import("../src/bundle.mjs");
  const jsxMap = { version: 3, sources: ["b.js"], names: [], mappings: "AAAA" };
  const bundleMap = { version: 3, sources: ["a.ts"], names: [], mappings: "" };
  assert.equal(resolvePosition({ jsxMap, bundleMap, line: 1, column: 0 }), null);
});

t("ae-api.d.ts catches bogus AE member names", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsx-toolchain-"));
  try {
    const f = join(dir, "bad.ts");
    writeFileSync(f, 'var v = app.totallyBogusMemberXYZ;\n');
    const r = checkFile(f);
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.severity === "error"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await Promise.all(pending);
console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
