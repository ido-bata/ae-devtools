/**
 * package-vsix.test.mjs — VSIX stage-tree completeness (Issue #166).
 *
 * Regression coverage for the defect where `vsce package` inside
 * vscode-extension/ shipped only that directory, so controller.mjs's
 * ../mcp-server imports failed with ERR_MODULE_NOT_FOUND on activation.
 *
 * Automated-test / fake level: this validates the staged tree that
 * scripts/package-vsix.mjs produces — every relative import reachable
 * from the extension entry must resolve inside the stage root, and the
 * production node_modules the extension needs must be present.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", "..");

const { stageExtension } = await import(pathToFileURL(join(cliRoot, "scripts", "package-vsix.mjs")).href);

function makeStage(t) {
  const dir = mkdtempSync(join(tmpdir(), "ae-devtools-vsix-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return stageExtension({ pkgRoot: cliRoot, stageDir: dir });
}

// Collect every relative specifier (static import/export-from and
// dynamic import()) referenced by a file, recursively within stageRoot.
function collectRelativeSpecifiers(file, stageRoot, seen = new Set()) {
  const abs = resolve(dirname(file), file.startsWith("/") ? file : file);
  if (seen.has(abs) || !existsSync(abs) || !abs.endsWith(".mjs")) return seen;
  seen.add(abs);
  const src = readFileSync(abs, "utf8");
  const re = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const target = resolve(dirname(abs), m[1]);
    if (existsSync(target)) collectRelativeSpecifiers(target, stageRoot, seen);
    else seen.add(`MISSING:${target}`);
  }
  return seen;
}

test("staged tree resolves every relative import reachable from extension entry", (t) => {
  const extRoot = makeStage(t);
  const entry = join(extRoot, "vscode-extension", "extension.mjs");
  assert.ok(existsSync(entry), "extension entry must exist in stage");
  const seen = collectRelativeSpecifiers(entry, extRoot);
  const missing = [...seen].filter((s) => s.startsWith("MISSING:"));
  assert.deepEqual(missing, [], `unresolved relative imports:\n${missing.join("\n")}`);
});

test("staged tree contains controller's sibling-package dependencies", (t) => {
  const extRoot = makeStage(t);
  for (const rel of [
    "mcp-server/tools.mjs",
    "mcp-server/session.mjs",
    "vscode-debugger/src/gen.mjs",
    "vscode-debugger/src/schema.mjs",
    "vscode-debugger/src/preflight.mjs",
  ]) {
    assert.ok(existsSync(join(extRoot, rel)), `missing ${rel}`);
  }
});

test("staged tree includes production node_modules the extension imports", (t) => {
  const extRoot = makeStage(t);
  for (const rel of [
    "node_modules/jsonc-parser/package.json",
    "node_modules/@ido-bata/ae-a8n/package.json",
  ]) {
    assert.ok(existsSync(join(extRoot, rel)), `missing ${rel}`);
  }
});

test("staged manifest points main at the packaged extension entry", (t) => {
  const extRoot = makeStage(t);
  const manifest = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "ae-devtools-vscode-extension");
  assert.equal(manifest.main, "./vscode-extension/extension.mjs");
  assert.ok(existsSync(join(extRoot, manifest.main)), "manifest.main must resolve");
  assert.equal(manifest.type, "module");
});

test("staged tree excludes tests but keeps runtime sources", (t) => {
  const extRoot = makeStage(t);
  const vscodeExt = join(extRoot, "vscode-extension");
  assert.ok(!existsSync(join(vscodeExt, "tests")), "tests must not ship");
  // controller.mjs is runtime code, not a test.
  assert.ok(statSync(join(vscodeExt, "controller.mjs")).isFile());
});

test("controller module loads from the staged tree without vscode API", async (t) => {
  const extRoot = makeStage(t);
  const controllerPath = join(extRoot, "vscode-extension", "controller.mjs");
  const mod = await import(pathToFileURL(controllerPath).href);
  assert.equal(typeof mod.createController, "function");
  assert.equal(typeof mod.EXTENSION_SCHEMA, "string");
});

test("stage contains no leftover pack artifacts", (t) => {
  const stageDir = mkdtempSync(join(tmpdir(), "ae-devtools-vsix-test-"));
  t.after(() => rmSync(stageDir, { recursive: true, force: true }));
  const extRoot = stageExtension({ pkgRoot: cliRoot, stageDir });
  const names = readdirSync(stageDir);
  assert.deepEqual(names, ["extension"], `unexpected stage entries: ${names}`);
  assert.ok(!existsSync(join(extRoot, "pack")));
});
