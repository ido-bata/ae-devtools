/*
 * cep-panel contract tests — shared CEP contract checks with
 * experiments/cep-extension (Issue #36/#43). Validates the STATIC
 * bundle under experiments/runtime-bridge/cep-panel/:
 *
 *   - CSXS/manifest.xml against the vendored official XSD
 *     (schema/ExtensionManifest_v_7_0.xsd — same file PR #40 vendors;
 *     deduplicate when both land)
 *   - official CEP 5+/12 manifest structure (no pre-CEP5 attributes)
 *   - bundled CSInterface.js present and wired in index.html
 *   - evalScript single-argument callback contract + EvalScript-error
 *     sentinel handling in the wrapper
 *   - probes live INSIDE the extension dir (CEP file-access boundary)
 *     and carry no unresolved #include directives
 *   - app.version read as attribute, never invoked
 *
 * Evidence level: automated test / source-reviewed. No real host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..");
const XSD = join(PANEL, "schema", "ExtensionManifest_v_7_0.xsd");
const MANIFEST = join(PANEL, "CSXS", "manifest.xml");

const read = (p) => readFile(p, "utf8");
const xmllintAvailable = () =>
  spawnSync("xmllint", ["--version"], { encoding: "utf8" }).status === 0;

test("manifest is well-formed and uses the official CEP 5+/12 structure", async () => {
  const m = await read(MANIFEST);
  assert.match(m, /<ExtensionManifest\b/);
  assert.match(m, /<ExtensionList>/);
  assert.match(m, /<ExecutionEnvironment>/);
  assert.match(m, /<HostList>[\s\S]*Name="AEFT"/);
  assert.match(m, /<RequiredRuntimeList>[\s\S]*Name="CSXS"/);
  assert.match(m, /<DispatchInfoList>/);
  assert.match(m, /<UI>[\s\S]*<Type>Panel<\/Type>/);
  assert.match(m, /<MainPath>\.\/index\.html<\/MainPath>/);
  // Pre-CEP5 shape must not come back.
  assert.doesNotMatch(m, /<Extension\b[^>]*HostList=/);
  assert.doesNotMatch(m, /<Extension\b[^>]*RequiredRuntimeList=/);
});

test("manifest validates against the vendored official XSD", async (t) => {
  if (!xmllintAvailable()) {
    t.skip("xmllint not available; XSD validation skipped");
    return;
  }
  const m = await read(MANIFEST);
  // Published XSD enumerates Version="7.0" only while the official CEP 12
  // sample ships "12.0" (stale schema). Validate structure on a pinned
  // copy and assert the emitted value separately — same approach as
  // experiments/cep-extension/tests/scaffold.test.mjs.
  assert.match(m, /Version="12\.0"/);
  const pinned = m.replace(
    /<ExtensionManifest([^>]*?) Version="12\.0"/,
    '<ExtensionManifest$1 Version="7.0"'
  );
  assert.notEqual(pinned, m, "Version pin substitution applied");
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "cep-panel-xsd-"));
  try {
    const p = join(dir, "manifest-pinned.xml");
    await writeFile(p, pinned);
    const r = spawnSync("xmllint", ["--noout", "--schema", XSD, p], { encoding: "utf8" });
    assert.equal(r.status, 0, `XSD validation failed:\n${r.stderr}${r.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CSInterface.js is bundled and referenced by index.html", async () => {
  assert.ok(existsSync(join(PANEL, "CSInterface.js")), "CSInterface.js must ship in the bundle");
  const cs = await read(join(PANEL, "CSInterface.js"));
  assert.match(cs, /CSInterface\.prototype\.evalScript/);
  const html = await read(join(PANEL, "index.html"));
  assert.match(html, /<script src="CSInterface\.js"><\/script>/);
});

test("wrapper honors the single-argument evalScript contract", async () => {
  const w = await read(join(PANEL, "js", "csinterface-wrapper.js"));
  // evalScript callback takes ONE result argument; ExtendScript failure
  // arrives as the "EvalScript error." sentinel string.
  assert.match(w, /EvalScript error\./);
  // No Node-style (err, value) callback on evalScript calls.
  assert.doesNotMatch(w, /evalScript\([^)]*function\s*\(\s*err\s*,/);
});

test("probes are bundled inside the extension and free of #include", async () => {
  const dir = join(PANEL, "extendscript");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsx")).sort();
  assert.equal(files.length, 8, "expected the 8 probe files");
  for (const f of files) {
    const src = await read(join(dir, f));
    assert.doesNotMatch(src, /^#include /m, `${f} must not rely on #include (evalScript strings do not preprocess it)`);
    assert.doesNotMatch(src, /app\.version\s*\(/, `${f} must read app.version as a property`);
  }
  const main = await read(join(PANEL, "js", "main.js"));
  for (const m of main.matchAll(/"(\.\/extendscript\/[^"]+)"/g)) {
    assert.ok(existsSync(join(PANEL, m[1])), `probe path ${m[1]} must resolve inside the bundle`);
  }
});
