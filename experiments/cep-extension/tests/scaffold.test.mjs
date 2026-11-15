/**
 * Tests for scaffold.mjs — automated-test / fake-level evidence only.
 * No After Effects is involved; generated trees are never loaded here.
 *
 * Manifest regression coverage targets the defects found in PR #40
 * review against the official Adobe CEP 12 material:
 *   - manifest must use the CEP 5.0+/12 shape (ExtensionList +
 *     ExecutionEnvironment + DispatchInfoList), not the pre-CEP5
 *     attribute form;
 *   - generated manifest is validated against the vendored official
 *     XSD (schema/ExtensionManifest_v_7_0.xsd) via xmllint when
 *     available;
 *   - main.js must not call app.version() (it is an attribute);
 *   - evalScript callback contract is a single result string with the
 *     "EvalScript error." sentinel, not an (err, value) pair;
 *   - CSInterface.js is bundled, not host-provided.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scaffold, ScaffoldError } from "../scaffold.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const SCAFFOLD = join(HERE, "scaffold.mjs");
const XSD = join(HERE, "schema", "ExtensionManifest_v_7_0.xsd");

async function tmp() {
  return mkdtemp(join(tmpdir(), "cep-scaffold-"));
}

const BASE = {
  id: "com.example.probe-panel",
  title: "Probe Panel",
  version: "0.1.0",
  host: "[25.0,99.0]",
  csxs: "12.0",
};

function xmllintAvailable() {
  return spawnSync("xmllint", ["--version"], { encoding: "utf8" }).status === 0;
}

test("generates the expected tree with substituted values", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    for (const rel of [
      "CSXS/manifest.xml",
      "index.html",
      "CSInterface.js",
      "js/main.js",
      "js/csinterface-wrapper.js",
    ]) {
      assert.equal((await stat(join(out, rel))).isFile(), true, rel);
    }

    const manifest = await readFile(join(out, "CSXS/manifest.xml"), "utf8");
    assert.match(manifest, /<ExtensionManifest/);
    assert.match(manifest, /ExtensionBundleId="com\.example\.probe-panel"/);
    assert.match(manifest, /ExtensionBundleVersion="0\.1\.0"/);
    assert.match(manifest, /Version="12\.0"/);
    // Official CEP 5.0+/12 structure.
    assert.match(manifest, /<ExtensionList>[\s\S]*<Extension Id="com\.example\.probe-panel" Version="0\.1\.0"\/>/);
    assert.match(manifest, /<ExecutionEnvironment>/);
    assert.match(manifest, /<HostList>[\s\S]*<Host Name="AEFT" Version="\[25\.0,99\.0\]"\/>/);
    assert.match(manifest, /<Locale Code="All"\/>/);
    assert.match(manifest, /<RequiredRuntimeList>[\s\S]*<RequiredRuntime Name="CSXS" Version="12\.0"\/>/);
    assert.match(manifest, /<DispatchInfoList>[\s\S]*<Extension Id="com\.example\.probe-panel">[\s\S]*<DispatchInfo>/);
    assert.match(manifest, /<MainPath>\.\/index\.html<\/MainPath>/);
    assert.match(manifest, /<AutoVisible>true<\/AutoVisible>/);
    assert.match(manifest, /<Type>Panel<\/Type>/);
    assert.match(manifest, /<Menu>Probe Panel<\/Menu>/);
    // Pre-CEP5 attribute form must NOT appear.
    assert.ok(!/RequiredRuntimeList="CSXS/.test(manifest), "no RequiredRuntimeList attribute form");
    assert.ok(!/DispatchInfoList"[^>]*Host=/.test(manifest), "no Host attribute on DispatchInfo");
    assert.ok(!manifest.includes("{{"), "no unexpanded placeholders in manifest");

    const html = await readFile(join(out, "index.html"), "utf8");
    assert.match(html, /<title>Probe Panel<\/title>/);
    assert.match(html, /com\.example\.probe-panel v0\.1\.0/);
    assert.match(html, /<script src="CSInterface\.js"><\/script>/);
    assert.match(html, /js\/csinterface-wrapper\.js/);
    assert.match(html, /js\/main\.js/);
    assert.ok(!html.includes("{{"), "no unexpanded placeholders in html");

    // CSInterface.js is the official bundled file, not a stub.
    const csInterface = await readFile(join(out, "CSInterface.js"), "utf8");
    assert.match(csInterface, /CSInterface - v12\.0\.0/);
    assert.match(csInterface, /CSInterface\.prototype\.evalScript = function\(script, callback\)/);

    const main = await readFile(join(out, "js/main.js"), "utf8");
    assert.match(main, /com\.example\.probe-panel/);
    assert.match(main, /intentional error probe|intentional-error/);
    assert.ok(!main.includes("{{"), "no unexpanded placeholders in main.js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest validates against the vendored official XSD", async (t) => {
  if (!xmllintAvailable()) {
    t.skip("xmllint not available; XSD validation skipped (structure assertions still apply)");
    return;
  }
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    const manifestPath = join(out, "CSXS/manifest.xml");
    const manifest = await readFile(manifestPath, "utf8");

    // Adobe's published XSD (ExtensionManifest_v_7_0.xsd) enumerates the
    // manifest Version attribute as "7.0" only, while the official CEP 12
    // sample ships Version="12.0". The published schema is stale relative
    // to the sample; validate structure on a copy pinned to the schema's
    // enumerated value, and assert the emitted value separately.
    assert.match(manifest, /Version="12\.0"/);
    const pinned = manifest.replace(
      /<ExtensionManifest([^>]*?) Version="12\.0"/,
      '<ExtensionManifest$1 Version="7.0"'
    );
    assert.notEqual(pinned, manifest, "Version pin substitution applied");
    const pinnedPath = join(dir, "manifest-pinned.xml");
    await writeFile(pinnedPath, pinned);

    const r = spawnSync(
      "xmllint", ["--noout", "--schema", XSD, pinnedPath],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, `XSD validation failed:\n${r.stderr}${r.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression: app.version is read as an attribute, never called", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    const main = await readFile(join(out, "js/main.js"), "utf8");
    const html = await readFile(join(out, "index.html"), "utf8");
    // Strip comments before scanning — the header documents the bug.
    const stripComments = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const mainCode = stripComments(main);
    const htmlCode = stripComments(html);
    // app.version is an ExtendScript attribute (provisional.ae.scripting
    // .app.version, kind=attribute). Calling it throws on a real host.
    assert.ok(!/app\.version\s*\(/.test(mainCode), "main.js must not call app.version()");
    assert.ok(!/app\.version\s*\(/.test(htmlCode), "index.html must not advertise app.version()");
    assert.match(main, /runScript\("app\.version", "app\.version"\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression: evalScript callback uses the single-result contract", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    const main = await readFile(join(out, "js/main.js"), "utf8");
    const wrapper = await readFile(join(out, "js/csinterface-wrapper.js"), "utf8");
    // Official contract: callback(result) — one string arg; failure is the
    // "EvalScript error." sentinel, NOT an (err, value) Node-style pair.
    assert.match(main, /csWrap\.evalScript\(source, function \(result\)/);
    assert.match(main, /EvalScript error\./);
    assert.ok(!/evalScript\(source, function \(err,/.test(main),
      "main.js must not treat the first callback arg as an error object");
    assert.match(wrapper, /indexOf\("EvalScript error\."\)/);
    // The wrapper must pass the callback through unmodified — CSInterface
    // invokes it with exactly one argument.
    assert.match(wrapper, /return this\.cs\.evalScript\(source, callback\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("csinterface-wrapper.js and CSInterface.js are copied byte-identical", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    for (const rel of ["js/csinterface-wrapper.js", "CSInterface.js"]) {
      const generated = await readFile(join(out, rel), "utf8");
      const template = await readFile(join(HERE, "templates", rel), "utf8");
      assert.equal(generated, template, rel);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("escapes XML-unsafe characters in title", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({
      ...BASE,
      title: 'A&B <Panel> "x"',
      out: join(dir, "panel"),
    });
    const html = await readFile(join(out, "index.html"), "utf8");
    assert.match(html, /A&amp;B &lt;Panel&gt; &quot;x&quot;/);
    const manifest = await readFile(join(out, "CSXS/manifest.xml"), "utf8");
    assert.ok(!manifest.includes("<Panel>"), "title must not inject markup");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a non-empty output directory without --force", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "keep.txt"), "do not delete");
    await assert.rejects(
      () => scaffold({ ...BASE, out }),
      (err) => err instanceof ScaffoldError && err.exitCode === 3
    );
    // The foreign file is untouched.
    assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "do not delete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--force regenerates over a previous scaffold", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await scaffold({ ...BASE, out });
    await writeFile(join(out, "extra.txt"), "leftover");
    await scaffold({ ...BASE, out, force: true });
    const entries = await readdir(out);
    assert.ok(entries.includes("CSXS"));
    // --force overwrites the scaffold's own outputs only; unrelated files
    // are the caller's responsibility (documented in README).
    assert.ok(entries.includes("extra.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function cli(args) {
  return spawnSync(process.execPath, [SCAFFOLD, ...args], { encoding: "utf8" });
}

test("CLI rejects invalid ids, versions, host ranges and paths", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "p");
    const cases = [
      ["--id", "nodots", "--out", out],
      ["--id", "com.example.a/b", "--out", out],
      ["--id", "com.example.panel", "--version", "1.0.x", "--out", out],
      ["--id", "com.example.panel", "--version", "abc", "--out", out],
      ["--id", "com.example.panel", "--host", "25.0-99.0", "--out", out],
      ["--id", "com.example.panel", "--host", "[abc,def]", "--out", out],
      // Open-ended bracketed range is not a valid XSD RangedVersion.
      ["--id", "com.example.panel", "--host", "[24.0,]", "--out", out],
      ["--id", "com.example.panel", "--csxs", "twelve", "--out", out],
      ["--id", "com.example.panel"], // missing --out
    ];
    for (const args of cases) {
      const r = cli(args);
      assert.equal(r.status, 2, `expected exit 2 for ${args.join(" ")}`);
      assert.match(r.stderr, /error:|usage:/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI exits 3 on non-empty output without --force", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "keep.txt"), "x");
    const r = cli([
      "--id", "com.example.panel", "--out", out,
    ]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /not empty/);
    const r2 = cli([
      "--id", "com.example.panel", "--out", out, "--force",
    ]);
    assert.equal(r2.status, 0, r2.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI happy path prints the output path", async () => {
  const dir = await tmp();
  try {
    const out = join(dir, "panel");
    const r = cli([
      "--id", "com.example.cli-panel",
      "--title", "CLI Panel",
      "--version", "1.2.3",
      "--host", "[24.0,99.0)",
      "--csxs", "11.1",
      "--out", out,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scaffolded CEP extension "com\.example\.cli-panel" v1\.2\.3/);
    const manifest = await readFile(join(out, "CSXS/manifest.xml"), "utf8");
    assert.match(manifest, /<Host Name="AEFT" Version="\[24\.0,99\.0\)"\/>/);
    assert.match(manifest, /<RequiredRuntime Name="CSXS" Version="11\.1"\/>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
