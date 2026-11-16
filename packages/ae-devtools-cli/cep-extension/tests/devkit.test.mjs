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

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [DEVKIT, ...args], {
    encoding: "utf8",
    timeout: 30000,
    ...opts,
  });
  if (r.error) {
    // Spawn failure or timeout — fail loudly instead of asserting on
    // undefined status/stdout.
    throw new Error(`devkit ${args[0]} failed to run: ${r.error.message}`);
  }
  return r;
}

async function scaffoldTo(dir) {
  const r = cli([
    "scaffold",
    "--id", "com.example.devkit-panel",
    // Non-default values: if devkit.mjs stopped forwarding --version/
    // --host/--csxs, scaffold.mjs's defaults would silently produce the
    // same-looking tree and this helper could not tell the difference.
    "--title", "Devkit Panel",
    "--version", "1.2.3",
    "--host", "[24.0,30.0)",
    "--csxs", "11.1",
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
    // Non-default scaffold args must actually land in the manifest —
    // otherwise a broken --version/--host/--csxs forward is invisible.
    const manifest = await readFile(join(out, "CSXS", "manifest.xml"), "utf8");
    assert.match(manifest, /ExtensionBundleVersion="1\.2\.3"/);
    assert.match(manifest, /<Host Name="AEFT" Version="\[24\.0,30\.0\)"\/>/);
    assert.match(manifest, /<RequiredRuntime Name="CSXS" Version="11\.1"\/>/);
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

test("validate exercises the no-xmllint subset fallback branch", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    await writeFile(join(out, "CSXS", "manifest.xml"),
      '<?xml version="1.0"?><ExtensionManifest><ExtensionList>');
    const prev = process.env.AE_DEVTOOLS_CEP_NO_XMLLINT;
    process.env.AE_DEVTOOLS_CEP_NO_XMLLINT = "1";
    try {
      const report = await validateExtension(out);
      const xml = report.checks.find((c) => c.name === "manifest-xml");
      assert.equal(xml.status, "fail");
      // The subset path must be identifiable in the detail text.
      assert.match(xml.detail, /subset|xmllint/i);
    } finally {
      if (prev === undefined) delete process.env.AE_DEVTOOLS_CEP_NO_XMLLINT;
      else process.env.AE_DEVTOOLS_CEP_NO_XMLLINT = prev;
    }
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
    // One trigger per ES3_SUBSET_RULES entry — deleting any rule from
    // validate.mjs must fail this test.
    await writeFile(join(out, "jsx", "bad.jsx"),
      "var items = [1,2,3];\n" +                                   // line 1
      "items.forEach(function (x) { $.writeln(x); });\n" +        // es3-es5-method
      "var s = JSON.stringify({ a: 1 });\n" +                     // es3-json
      "let y = () => 1;\n" +                                     // es3-let-const + es3-arrow
      "class Foo {}\n" +                                         // es3-class
      "var k = Object.keys(items);\n" +                          // es3-object-static
      "var isArr = Array.isArray(items);\n");                     // es3-array-static
    const report = await validateExtension(out);
    assert.equal(report.ok, false);
    const jsx = report.checks.find((c) => c.name === "host-jsx-es3");
    assert.equal(jsx.status, "fail");
    // The offending file must be pinned — hits are aggregated across
    // all *.jsx, so an unpinned assertion could be satisfied by a
    // regression in the shipped template instead of bad.jsx.
    assert.match(jsx.detail, /bad\.jsx/);
    for (const code of [
      "es3-es5-method", "es3-json", "es3-let-const", "es3-arrow",
      "es3-class", "es3-object-static", "es3-array-static",
    ]) {
      assert.match(jsx.detail, new RegExp(code), `missing rule hit ${code}`);
    }
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
    assert.equal(dm.status, "info");
    assert.match(dm.detail, /present/);
    // The marker is informational only — it must never fail the report.
    assert.equal(report.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---- review-fix coverage ---- */

test("host.jsx escapes Windows paths and quotes into parseable JSON", async () => {
  // The template is plain ES3 — run it under Node with a stub `app`
  // and assert the emitted string parses and round-trips.
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    const src = await readFile(join(out, "jsx", "host.jsx"), "utf8");
    const winPath = "C:\\Users\\me\\proj\\a \"quoted\" dir\\file.aep";
    const app = {
      version: "25.0",
      project: { file: { fsName: winPath } },
    };
    // host.jsx is a single IIFE expression statement; evalScript
    // returns its completion value. Emulate that with eval().
    const text = new Function("app", `return eval(${JSON.stringify(src)});`)(app);
    const parsed = JSON.parse(text);
    assert.equal(parsed.appVersion, "25.0");
    assert.equal(parsed.project, winPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("panel refs may be extension-root-relative (/js/main.js)", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    await writeFile(join(out, "index.html"),
      '<html><head><script src="/js/main.js"></script></head><body></body></html>');
    const report = await validateExtension(out);
    const refs = report.checks.find((c) => c.name === "panel-references");
    assert.equal(refs.status, "pass", refs.detail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest structure check ignores commented-out elements", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffoldTo(out);
    const manifest = await readFile(join(out, "CSXS", "manifest.xml"), "utf8");
    // Comment out a required element — the structure check must still fail.
    const broken = manifest.replace(/<DispatchInfoList>[\s\S]*?<\/DispatchInfoList>/,
      "<!-- <DispatchInfoList><DispatchInfo><Resources/></DispatchInfo></DispatchInfoList> -->");
    await writeFile(join(out, "CSXS", "manifest.xml"), broken);
    const report = await validateExtension(out);
    const s = report.checks.find((c) => c.name === "manifest-structure");
    assert.equal(s.status, "fail");
    assert.match(s.detail, /DispatchInfoList/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ES3 lint: strings/comments cannot hide or fake violations", () => {
  // `//` and `=>` inside string literals must not trip the lint;
  // an unbalanced quote inside a comment must not mask real code.
  const tricky = [
    'var url = "https://example.com/a=>b";',
    "var s = 'it\\'s fine';",
    "// don't let this apostrophe break masking: var x = () => 1;",
    "var arrow = () => 1;",
  ].join("\n");
  const hits = lintJsxEs3Subset(tricky);
  assert.equal(hits.filter((h) => h.code === "es3-arrow").length, 1);
  assert.equal(hits[0].line, 4);
  // Array.prototype methods are ES3 — must NOT be flagged.
  assert.deepEqual(lintJsxEs3Subset("var a=[1]; a.slice(0); a.push(1);"), []);
  // Array.isArray IS ES5+ — must be flagged.
  const stat = lintJsxEs3Subset("var b = Array.isArray(a);");
  assert.equal(stat[0].code, "es3-array-static");
});

test("devkit CLI propagates scaffold exit codes", async () => {
  const dir = await tmp();
  try {
    const bad = cli(["scaffold", "--id", "", "--out", join(dir, "x")]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--id/);
    // validate on a bad dir exits non-zero via exitCode (not process.exit)
    const v = cli(["validate", join(dir, "nope")]);
    assert.equal(v.status, 2);
    assert.match(v.stderr, /not a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
