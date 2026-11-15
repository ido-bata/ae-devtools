/**
 * build.mjs — TypeScript/modern JS -> ExtendScript ES3 JSX (Issue #52).
 *
 * Single-file slice: transpileModule with ScriptTarget.ES5 +
 * ModuleKind.None (TS 5.9 removed the ES3 target; ES5 emit is verified ES3-clean by lintOutput). Multi-file bundling is a follow-up; `import`/`export`
 * are rejected by the linter before this stage anyway.
 *
 * Emits `<name>.jsx` + `<name>.jsx.map` (Source Map v3, sourcesContent
 * inlined so the map alone can recover source text).
 */
import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { lintSource, lintOutput, hasErrors } from "./es3-lint.mjs";

export const JSX_TOOLCHAIN = "ae-devtools.jsx-toolchain/v1";

export function transpileToEs3(source, { filename = "input.ts" } = {}) {
  return ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.ES2015, // import/export already rejected by lintSource
      sourceMap: true,
      inlineSources: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
}

/**
 * Build one source file. Returns a result object; never throws for
 * expected failures (lint/type/emit problems are diagnostics).
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

  result.diagnostics.push(...lintSource(source, { filename: absIn }));
  if (hasErrors(result.diagnostics)) {
    result.status = "lint-failed";
    return result;
  }

  const t = transpileToEs3(source, { filename: absIn });
  for (const d of t.diagnostics ?? []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    result.diagnostics.push({
      severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      code: `tsc-${d.code}`,
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
      message: msg,
    });
  }
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
    mkdirSync(outDir, { recursive: true });
    const jsxPath = join(outDir, `${name}.jsx`);
    writeFileSync(jsxPath, result.output);
    writeFileSync(`${jsxPath}.map`, JSON.stringify(result.map));
    result.jsxPath = jsxPath;
    result.mapPath = `${jsxPath}.map`;
  }
  return result;
}
