/**
 * Tests for scaffold.mjs — automated-test / fake-level evidence only.
 * No After Effects is involved; generated trees are never loaded here.
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

test("generates the expected tree with substituted values", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    for (const rel of [
      "CSXS/manifest.xml",
      "index.html",
      "js/main.js",
      "js/csinterface-wrapper.js",
    ]) {
      assert.equal((await stat(join(out, rel))).isFile(), true, rel);
    }

    const manifest = await readFile(join(out, "CSXS/manifest.xml"), "utf8");
    assert.match(manifest, /<ExtensionManifest/);
    assert.match(manifest, /Extension Id="com\.example\.probe-panel"/);
    assert.match(manifest, /Version="0\.1\.0"/);
    assert.match(manifest, /RequiredRuntimeList="CSXS-12\.0"/);
    assert.match(manifest, /<Host Name="AEFT" Version="\[25\.0,99\.0\]"/);
    assert.match(manifest, /<MainPath>\.\/index\.html<\/MainPath>/);
    assert.ok(!manifest.includes("{{"), "no unexpanded placeholders in manifest");

    const html = await readFile(join(out, "index.html"), "utf8");
    assert.match(html, /<title>Probe Panel<\/title>/);
    assert.match(html, /com\.example\.probe-panel v0\.1\.0/);
    assert.match(html, /<script src="CSInterface\.js"><\/script>/);
    assert.match(html, /js\/csinterface-wrapper\.js/);
    assert.match(html, /js\/main\.js/);
    assert.ok(!html.includes("{{"), "no unexpanded placeholders in html");

    const main = await readFile(join(out, "js/main.js"), "utf8");
    assert.match(main, /com\.example\.probe-panel/);
    assert.match(main, /app\.version\(\)/);
    assert.match(main, /intentional error probe/);
    assert.ok(!main.includes("{{"), "no unexpanded placeholders in main.js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("csinterface-wrapper.js is copied byte-identical", async () => {
  const dir = await tmp();
  try {
    const out = await scaffold({ ...BASE, out: join(dir, "panel") });
    const generated = await readFile(join(out, "js/csinterface-wrapper.js"), "utf8");
    const template = await readFile(
      new URL("../templates/js/csinterface-wrapper.js", import.meta.url), "utf8"
    );
    assert.equal(generated, template);
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
      ["--id", "com.example.panel", "--version", "1.0", "--out", out],
      ["--id", "com.example.panel", "--host", "25.0-99.0", "--out", out],
      ["--id", "com.example.panel", "--host", "[abc,def]", "--out", out],
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
      "--host", "[24.0,]",
      "--csxs", "11.1",
      "--out", out,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scaffolded CEP extension "com\.example\.cli-panel" v1\.2\.3/);
    const manifest = await readFile(join(out, "CSXS/manifest.xml"), "utf8");
    assert.match(manifest, /Version="\[24\.0,\]"/);
    assert.match(manifest, /RequiredRuntimeList="CSXS-11\.1"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
