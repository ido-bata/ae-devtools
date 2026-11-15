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
