/**
 * build.mjs — TypeScript/modern JS -> ExtendScript ES3 JSX (Issue #52).
 *
 * Two modes:
 *
 *   buildFile     — single file, no module syntax (import/export of
 *                   relative paths are lint errors at this level only
 *                   when they cannot be bundled; use buildProject for
 *                   real projects).
 *   buildProject  — multi-file: esbuild bundles the module graph to a
 *                   single ES2015 IIFE (bundle.mjs), tsc lowers it to
 *                   ES5, the AST lint proves the result is ES3.
 *
 * TS 5.9 removed `target=ES3`; ES5 emit is verified ES3-clean
 * structurally by lintOutputAst — every node in the parsed output must
 * be an ES3 kind. That is the compatibility proof; regexes are not
 * involved.
 *
 * Emits `<name>.jsx` + `<name>.jsx.map` (jsx -> bundle) +
 * `<name>.bundle.js.map` (bundle -> original TS, sourcesContent
 * inlined). `resolvePosition` in bundle.mjs performs the two-hop lookup
 * so a host error lands on the original TS source.
 */
import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { lintSource, lintOutput, hasErrors } from "./es3-lint.mjs";
import { bundleProject } from "./bundle.mjs";

export const JSX_TOOLCHAIN = "ae-devtools.jsx-toolchain/v1";

export function transpileToEs3(source, { filename = "input.ts" } = {}) {
  return ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      // transpileModule forces isolatedModules, which forbids module:None
      // at ES5 targets. ES2015 module emit is identical for the module-free
      // inputs this pipeline accepts (single-file lint rejects imports;
      // project input is already a module-free IIFE bundle).
      module: ts.ModuleKind.ES2015,
      sourceMap: true,
      inlineSources: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
}

function transpileDiagnostics(t, result) {
  for (const d of t.diagnostics ?? []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    let line = null;
    let column = null;
    if (d.file && d.start !== undefined) {
      const lc = d.file.getLineAndCharacterOfPosition(d.start);
      line = lc.line + 1;
      column = lc.character + 1;
    }
    result.diagnostics.push({
      severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      code: `tsc-${d.code}`,
      line,
      column,
      file: d.file ? d.file.fileName : null,
      message: msg,
    });
  }
}

function writeArtifacts({ outDir, name, output, jsxMap, bundleMap, bundleCode }) {
  mkdirSync(outDir, { recursive: true });
  const jsxPath = join(outDir, `${name}.jsx`);
  writeFileSync(jsxPath, output);
  writeFileSync(`${jsxPath}.map`, JSON.stringify(jsxMap));
  const paths = { jsxPath, mapPath: `${jsxPath}.map` };
  if (bundleMap) {
    paths.bundleMapPath = join(outDir, `${name}.bundle.js.map`);
    writeFileSync(paths.bundleMapPath, JSON.stringify(bundleMap));
  }
  if (bundleCode !== undefined && bundleCode !== null) {
    paths.bundlePath = join(outDir, `${name}.bundle.js`);
    writeFileSync(paths.bundlePath, bundleCode);
  }
  return paths;
}

/**
 * Build one source file (single-file mode; no imports). Returns a
 * result object; never throws for expected failures.
 */
export function buildFile(inputPath, { outDir = null } = {}) {
  const absIn = resolve(inputPath);
  const source = readFileSync(absIn, "utf8");
  const name = basename(absIn).replace(/\.(tsx?|jsx?)$/, "");

  const result = {
    schema: JSX_TOOLCHAIN,
    input: absIn,
    output: null,
    map: null,
    diagnostics: [],
    status: "ok",
  };

  result.diagnostics.push(...lintSource(source, { filename: absIn, allowModules: false }));
  if (hasErrors(result.diagnostics)) {
    result.status = "lint-failed";
    return result;
  }

  const t = transpileToEs3(source, { filename: absIn });
  transpileDiagnostics(t, result);
  if (hasErrors(result.diagnostics)) {
    result.status = "transpile-failed";
    return result;
  }

  result.output = t.outputText;
  result.map = JSON.parse(t.sourceMapText);
  result.map.file = `${name}.jsx`;

  result.diagnostics.push(...lintOutput(result.output, { filename: `${name}.jsx` }));
  if (hasErrors(result.diagnostics)) {
    result.status = "output-lint-failed";
    return result;
  }

  if (outDir) {
    Object.assign(result, writeArtifacts({ outDir, name, output: result.output, jsxMap: result.map }));
  }
  return result;
}

/**
 * Build a multi-file project from an entry point. Async because esbuild
 * is. Returns the same result shape as buildFile plus `bundle` metadata
 * (inputs, bundle map path) for two-hop diagnostics.
 */
export async function buildProject(entryPath, { outDir = null, name = null } = {}) {
  const absIn = resolve(entryPath);
  const base = name ?? basename(absIn).replace(/\.(tsx?|jsx?)$/, "");

  const result = {
    schema: JSX_TOOLCHAIN,
    mode: "project",
    input: absIn,
    output: null,
    map: null,
    bundleMap: null,
    inputs: [],
    diagnostics: [],
    status: "ok",
  };

  const bundle = await bundleProject(absIn);
  result.inputs = bundle.inputs;
  result.diagnostics.push(...bundle.diagnostics);
  if (bundle.status !== "ok") {
    result.status = bundle.status;
    return result;
  }

  // The bundle text ends with `//# sourceMappingURL=bundle.js.map`,
  // which refers to esbuild's map, not ours. Strip it before lowering —
  // tsc appends the correct jsx->bundle map reference itself.
  const bundleCode = bundle.code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "\n");

  // Lower the ES2015 bundle to ES5. The bundle's "source" is itself, so
  // this map is jsx -> bundle (hop 1 of 2).
  const t = transpileToEs3(bundleCode, { filename: `${base}.bundle.js` });
  transpileDiagnostics(t, result);
  if (hasErrors(result.diagnostics)) {
    result.status = "transpile-failed";
    return result;
  }

  result.output = t.outputText;
  result.map = JSON.parse(t.sourceMapText);
  result.map.file = `${base}.jsx`;
  result.bundleMap = bundle.map;

  // Structural ES3 proof on the final artifact.
  result.diagnostics.push(...lintOutput(result.output, { filename: `${base}.jsx` }));
  if (hasErrors(result.diagnostics)) {
    result.status = "output-lint-failed";
    return result;
  }

  if (outDir) {
    Object.assign(result, writeArtifacts({
      outDir, name: base, output: result.output, jsxMap: result.map,
      bundleMap: result.bundleMap, bundleCode,
    }));
  }
  return result;
}
