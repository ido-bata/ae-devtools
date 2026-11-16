/**
 * Tests for devkit.mjs + validate.mjs — automated-test / fake-level
 * evidence only. No After Effects is involved; generated trees are
 * inspected statically. Real-host load evidence stays UNVERIFIED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateExtension, lintJsxEs3Subset, xmlWellFormedSubset } from "../validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVKIT = join(HERE, "..", "devkit.mjs");

async function tmp() {
  return mkdtemp(join(tmpdir(), "cep-devkit-"));
}

function cli(args) {
  return spawnSync(process.execPath, [DEVKIT, ...args], { encoding: "utf8" });
}

async function scaffoldTo(dir) {
  const r = cli([
    "scaffold",
    "--id", "com.example.devkit-panel",
    "--title", "Devkit Panel",
    "--version", "0.1.0",
    "--host", "[25.0,99.0]",
    "--csxs", "12.0",
    "--out", dir,
  ]);
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

test("devkit scaffold produces the full tree incl. jsx/host.jsx and validate passes", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    const r = cli(["validate", out]);
    assert.equal(r.status, 0, `validate failed:\n${r.stdout}\n${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.loadProof, "NOT RUN");
    assert.match(report.loadProofNote, /never loads|static/i);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    assert.equal(byName["required-files"].status, "pass");
    assert.equal(byName["manifest-xml"].status, "pass");
    assert.equal(byName["manifest-structure"].status, "pass");
    assert.equal(byName["panel-references"].status, "pass");
    assert.equal(byName["csinterface"].status, "pass");
    assert.equal(byName["host-jsx-es3"].status, "pass");
    assert.equal(byName["load-proof"].status, "info");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate catches a malformed manifest (xmllint or subset path)", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    // Unclosed root element — malformed under both xmllint and the
    // subset tag-balance check.
    await writeFile(join(out, "CSXS", "manifest.xml"),
      '<?xml version="1.0"?><ExtensionManifest><ExtensionList>');
    const report = await validateExtension(out);
    assert.equal(report.ok, false);
    const xml = report.checks.find((c) => c.name === "manifest-xml");
    assert.equal(xml.status, "fail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate catches a manifest missing required CEP structure", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    // Well-formed XML but pre-CEP5 shape: no ExecutionEnvironment /
    // DispatchInfoList elements.
    await writeFile(join(out, "CSXS", "manifest.xml"),
      '<?xml version="1.0"?><ExtensionManifest ExtensionBundleId="x" Version="12.0">' +
      '<ExtensionList><Extension Id="x" Version="0.1.0"/></ExtensionList>' +
      '<Extension Id="x" HostList="AEFT"/></ExtensionManifest>');
    const report = await validateExtension(out);
    assert.equal(report.ok, false);
    const s = report.checks.find((c) => c.name === "manifest-structure");
    assert.equal(s.status, "fail");
    assert.match(s.detail, /missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate catches missing required files and dangling panel refs", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    await rm(join(out, "index.html"));
    let report = await validateExtension(out);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === "required-files").status, "fail");

    // restore index.html with a dangling script ref
    await writeFile(join(out, "index.html"),
      '<html><head><script src="js/does-not-exist.js"></script>' +
      '<script src="../escape.js"></script></head><body></body></html>');
    report = await validateExtension(out);
    assert.equal(report.ok, false);
    const refs = report.checks.find((c) => c.name === "panel-references");
    assert.equal(refs.status, "fail");
    assert.match(refs.detail, /does-not-exist\.js/);
    assert.match(refs.detail, /escape\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate catches missing bundled CSInterface.js", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    await rm(join(out, "CSInterface.js"));
    const report = await validateExtension(out);
    assert.equal(report.ok, false);
    const cs = report.checks.find((c) => c.name === "csinterface");
    assert.equal(cs.status, "fail");
    assert.match(cs.detail, /bundled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate fails on ES5+ constructs in host JSX (ES3 subset lint)", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    await writeFile(join(out, "jsx", "bad.jsx"),
      "var items = [1,2,3];\n" +
      "items.forEach(function (x) { $.writeln(x); });\n" +
      "var s = JSON.stringify({ a: 1 });\n" +
      "let y = () => 1;\n");
    const report = await validateExtension(out);
    assert.equal(report.ok, false);
    const jsx = report.checks.find((c) => c.name === "host-jsx-es3");
    assert.equal(jsx.status, "fail");
    assert.match(jsx.detail, /es3-es5-method/);
    assert.match(jsx.detail, /es3-json/);
    assert.match(jsx.detail, /es3-let-const/);
    assert.match(jsx.detail, /es3-arrow/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ES3 subset lint ignores comments and clean ES3 passes", () => {
  const clean = [
    "// let x = 1;  (commented-out ES6 must not trip the lint)",
    "/* JSON.stringify is mentioned here in prose */",
    "function f(a, b) {",
    "  var out = '{\"v\":\"' + String(app.version) + '\"}';",
    "  for (var i = 0; i < a.length; i++) { out += a[i]; }",
    "  try { return out; } catch (e) { return 'err'; }",
    "}",
  ].join("\n");
  assert.deepEqual(lintJsxEs3Subset(clean), []);
});

test("xmlWellFormedSubset catches imbalance and passes simple docs", () => {
  assert.equal(xmlWellFormedSubset("<a><b/></a>").ok, true);
  assert.equal(xmlWellFormedSubset("<a><b></a>").ok, false);
  assert.equal(xmlWellFormedSubset("<a>").ok, false);
  assert.equal(xmlWellFormedSubset("<!-- <a> --><a>x</a>").ok, true);
});

test("validate on a dir without a manifest fails cleanly", async () => {
  const dir = await tmp();
  try {
    await mkdir(join(dir, "empty"), { recursive: true });
    const report = await validateExtension(join(dir, "empty"));
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === "required-files").status, "fail");
    await assert.rejects(() => validateExtension(join(dir, "missing")), /not a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("debuggable marker is reported informationally", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    let report = await validateExtension(out);
    let dm = report.checks.find((c) => c.name === "debuggable-marker");
    assert.equal(dm.status, "info");
    assert.match(dm.detail, /absent/);
    await writeFile(join(out, ".debuggable"), "");
    report = await validateExtension(out);
    dm = report.checks.find((c) => c.name === "debuggable-marker");
    assert.match(dm.detail, /present/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
