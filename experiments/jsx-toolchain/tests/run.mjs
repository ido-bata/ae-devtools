/**
 * run.mjs — jsx-toolchain tests (Issue #52).
 * Fake/unit level only; real-host evidence lives in EVIDENCE.md.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { lintSource, lintOutput, hasErrors } from "../src/es3-lint.mjs";
import { buildFile, transpileToEs3 } from "../src/build.mjs";
import { checkFile } from "../src/check.mjs";
import { lookup, parseMappings } from "../src/sourcemap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures");
const CLI = join(HERE, "..", "src", "cli.mjs");
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
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

t("lint flags import/export", () => {
  const d = lintSource('import x from "y";\nexport default x;', { filename: "x.ts" });
  assert.ok(d.some((x) => x.code === "es3-module-import"));
  assert.ok(d.some((x) => x.code === "es3-module-export"));
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

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
