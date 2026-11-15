/**
 * run.mjs — vscode-debugger contract tests (Issue #53).
 * No AE required: this validates the launch.json contract only.
 * Real attach behavior is UNVERIFIED (see README/EVIDENCE note on #53).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateLaunchJson, hasErrors } from "../src/schema.mjs";
import { buildAttachConfig, writeLaunchJson, DEFAULT_NAME } from "../src/gen.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures");
const CLI = join(HERE, "..", "src", "cli.mjs");
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

function loadFixture(f) {
  return JSON.parse(readFileSync(join(FIX, f), "utf8"));
}

t("valid attach fixture passes with no errors", () => {
  const d = validateLaunchJson(loadFixture("launch.valid-attach.json"));
  assert.equal(hasErrors(d), false, JSON.stringify(d));
});

t("wrong debug type is an error", () => {
  const d = validateLaunchJson(loadFixture("launch.bad-type.json"));
  assert.ok(d.some((x) => x.code === "wrong-type" && x.severity === "error"));
});

t("V1 property names are rejected", () => {
  const d = validateLaunchJson(loadFixture("launch.v1-props.json"));
  const v1 = d.filter((x) => x.code === "v1-property");
  assert.ok(v1.length >= 3, JSON.stringify(d));
  assert.ok(hasErrors(d));
});

t("launch request warns about owned-session bypass but is legal", () => {
  const d = validateLaunchJson(loadFixture("launch.launch-request.json"));
  assert.equal(hasErrors(d), false, JSON.stringify(d));
  assert.ok(d.some((x) => x.code === "launch-bypasses-owned-session" && x.severity === "warning"));
});

t("malformed fields fail closed", () => {
  const d = validateLaunchJson(loadFixture("launch.bad-fields.json"));
  assert.ok(d.some((x) => x.code === "bad-host-app-specifier"));
  assert.ok(d.some((x) => x.code === "bad-hidden-types"));
  assert.ok(d.some((x) => x.code === "bad-debug-level"));
  assert.ok(hasErrors(d));
});

t("launch-only property on attach is an error", () => {
  const d = validateLaunchJson({
    version: "0.2.0",
    configurations: [{ type: "extendscript-debug", request: "attach", name: "x", script: "/tmp/a.jsx" }],
  });
  assert.ok(d.some((x) => x.code === "launch-only-on-attach"));
});

t("unknown property is an error", () => {
  const d = validateLaunchJson({
    version: "0.2.0",
    configurations: [{ type: "extendscript-debug", request: "attach", name: "x", bogusProp: 1 }],
  });
  assert.ok(d.some((x) => x.code === "unknown-property"));
});

t("attach without hostAppSpecifier warns (unpinned)", () => {
  const d = validateLaunchJson({
    version: "0.2.0",
    configurations: [{ type: "extendscript-debug", request: "attach", name: "x" }],
  });
  assert.equal(hasErrors(d), false);
  assert.ok(d.some((x) => x.code === "attach-unpinned" && x.severity === "warning"));
});

t("buildAttachConfig produces a self-validating attach config", () => {
  const c = buildAttachConfig({ hostAppSpecifier: "aftereffects-27.0" });
  assert.equal(c.type, "extendscript-debug");
  assert.equal(c.request, "attach");
  assert.equal(c.engineName, "main");
  assert.deepEqual(c.hiddenTypes, ["builtin"]);
});

t("buildAttachConfig rejects malformed specifier", () => {
  assert.throws(() => buildAttachConfig({ hostAppSpecifier: "AE 2027" }));
  assert.throws(() => buildAttachConfig({ hostAppSpecifier: "aftereffects" }));
});

t("writeLaunchJson creates .vscode/launch.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-debug-"));
  try {
    const c = buildAttachConfig({ hostAppSpecifier: "aftereffects-26.0" });
    const r = writeLaunchJson(dir, c);
    assert.equal(r.merged, false);
    const doc = JSON.parse(readFileSync(r.path, "utf8"));
    assert.equal(doc.version, "0.2.0");
    assert.equal(doc.configurations.length, 1);
    assert.equal(doc.configurations[0].request, "attach");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("writeLaunchJson merges without clobbering foreign configs", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-debug-"));
  try {
    const foreign = { version: "0.2.0", configurations: [{ type: "node", request: "launch", name: "mine" }] };
    mkdirSync(join(dir, ".vscode"), { recursive: true });
    writeFileSync(join(dir, ".vscode", "launch.json"), JSON.stringify(foreign));
    const c = buildAttachConfig({ hostAppSpecifier: "aftereffects-27.0" });
    const r = writeLaunchJson(dir, c);
    assert.equal(r.merged, true);
    const doc = JSON.parse(readFileSync(r.path, "utf8"));
    assert.equal(doc.configurations.length, 2);
    assert.ok(doc.configurations.some((x) => x.name === "mine"));
    assert.ok(doc.configurations.some((x) => x.name === DEFAULT_NAME));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("writeLaunchJson replaces our own config on re-run (idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-debug-"));
  try {
    const c1 = buildAttachConfig({ hostAppSpecifier: "aftereffects-27.0" });
    writeLaunchJson(dir, c1);
    const c2 = buildAttachConfig({ hostAppSpecifier: "aftereffects-26.0", name: DEFAULT_NAME });
    writeLaunchJson(dir, c2);
    const doc = JSON.parse(readFileSync(join(dir, ".vscode", "launch.json"), "utf8"));
    assert.equal(doc.configurations.length, 1);
    assert.equal(doc.configurations[0].hostAppSpecifier, "aftereffects-26.0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("writeLaunchJson refuses non-JSON existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-debug-"));
  try {
    mkdirSync(join(dir, ".vscode"), { recursive: true });
    writeFileSync(join(dir, ".vscode", "launch.json"), "// jsonc comments\n{ not json");
    const c = buildAttachConfig({ hostAppSpecifier: "aftereffects-27.0" });
    assert.throws(() => writeLaunchJson(dir, c));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("cli gen writes launch.json and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-debug-"));
  try {
    const out = execFileSync("node", [CLI, "gen", "--host-app-specifier", "aftereffects-27.0", "--project-dir", dir], { encoding: "utf8" });
    const r = JSON.parse(out);
    assert.equal(r.config.request, "attach");
    assert.ok(existsSync(join(dir, ".vscode", "launch.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t("cli gen fails closed on bad specifier", () => {
  assert.throws(() => execFileSync("node", [CLI, "gen", "--host-app-specifier", "bogus!"], { encoding: "utf8", stdio: "pipe" }));
});

t("cli validate exits 1 on bad fixture, 0 on good", () => {
  assert.throws(() => execFileSync("node", [CLI, "validate", join(FIX, "launch.bad-type.json")], { encoding: "utf8", stdio: "pipe" }));
  const out = execFileSync("node", [CLI, "validate", join(FIX, "launch.valid-attach.json")], { encoding: "utf8" });
  assert.equal(JSON.parse(out).ok, true);
});

t("cli validate tolerates JSONC comments in launch.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-debug-"));
  try {
    const p = join(dir, "launch.json");
    writeFileSync(p, '{\n  // a comment\n  "version": "0.2.0",\n  "configurations": [\n    { "type": "extendscript-debug", "request": "attach", "name": "x", "hostAppSpecifier": "aftereffects-27.0", },\n  ],\n}\n');
    const out = execFileSync("node", [CLI, "validate", p], { encoding: "utf8" });
    assert.equal(JSON.parse(out).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
