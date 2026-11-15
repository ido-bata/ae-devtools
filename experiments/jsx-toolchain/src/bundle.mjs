/**
 * bundle.mjs — multi-file TypeScript → single ES2015 IIFE (Issue #52).
 *
 * ExtendScript has no module system, so project builds go through
 * esbuild's bundler: every `import`/`export` in the project is resolved
 * and flattened into one script. esbuild emits ES2015 at most — it
 * cannot target ES5 — so the bundle is then lowered to ES5 by tsc in
 * build.mjs and verified by lintOutput (ES3 grammar parse + runtime
 * API check).
 *
 * Sourcemaps are chained, not composed: esbuild's map points
 * bundle→original TS (with sourcesContent), tsc's map points
 * jsx→bundle. `resolvePosition` performs the two-hop lookup so a host
 * error line lands on the original TS source.
 *
 * Bare (non-relative) imports are rejected: ExtendScript has no module
 * loader and no node_modules — esbuild fails to resolve them, which is
 * the desired fail-closed behavior.
 */
import { build as esbuild } from "esbuild";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import ts from "typescript";
import { lintSourceAst } from "./es3-ast.mjs";
import { lookup } from "./sourcemap.mjs";

export const BUNDLE_SCHEMA = "ae-devtools.jsx-toolchain.bundle/v1";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** Collect every script source under a directory (skips node_modules). */
export function collectSources(dir) {
  const out = [];
  const walkDir = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walkDir(p);
      else if (SOURCE_EXTS.has(p.slice(p.lastIndexOf(".")))) out.push(p);
    }
  };
  walkDir(resolve(dir));
  return out.sort();
}

function scriptKindFor(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.jsx?$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Bundle one entry file. Returns { code, map, inputs, diagnostics,
 * status }; never throws for expected failures.
 */
export async function bundleProject(entryPath) {
  const absEntry = resolve(entryPath);
  const result = {
    schema: BUNDLE_SCHEMA,
    entry: absEntry,
    code: null,
    map: null,
    inputs: [],
    diagnostics: [],
    status: "ok",
  };

  let out;
  try {
    out = await esbuild({
      entryPoints: [absEntry],
      bundle: true,
      format: "iife",
      target: "es2015",
      platform: "neutral",
      sourcemap: true,
      sourcesContent: true,
      write: false,
      // Names the virtual outputs bundle.js / bundle.js.map so both are
      // returned as outputFiles (without it esbuild emits a single
      // <stdout> file and drops the external map).
      outfile: "bundle.js",
      absWorkingDir: dirname(absEntry),
      logLevel: "silent",
      metafile: true,
    });
  } catch (error) {
    result.status = "bundle-failed";
    result.diagnostics.push({
      severity: "error", code: "esbuild-error", line: null, file: absEntry,
      message: String(error?.message ?? error).split("\n").slice(0, 12).join("\n"),
    });
    return result;
  }

  const file = out.outputFiles.find((f) => f.path.endsWith(".js"));
  const mapFile = out.outputFiles.find((f) => f.path.endsWith(".js.map"));
  if (!file || !mapFile) {
    result.status = "bundle-failed";
    result.diagnostics.push({ severity: "error", code: "esbuild-no-output", message: "esbuild produced no js/map output" });
    return result;
  }
  result.code = file.text;
  result.map = JSON.parse(mapFile.text);
  result.inputs = Object.keys(out.metafile.inputs)
    .map((p) => resolve(dirname(absEntry), p))
    .sort();

  // Lint every bundled source: bare specifiers, accessors, ES5+ builtins.
  for (const input of result.inputs) {
    let text;
    try {
      text = readFileSync(input, "utf8");
    } catch {
      continue;
    }
    result.diagnostics.push(...lintSourceAst(text, { filename: input, scriptKind: scriptKindFor(input) }));
  }
  if (result.diagnostics.some((d) => d.severity === "error")) {
    result.status = "lint-failed";
    return result;
  }
  return result;
}

/**
 * Two-hop sourcemap resolution: a position in the final JSX maps through
 * tsc's map into the esbuild bundle, then through esbuild's map into the
 * original TS/JS source. Returns the TS position or null.
 */
export function resolvePosition({ jsxMap, bundleMap, line, column = 0 }) {
  const mid = lookup(jsxMap, line, column);
  if (mid === null) return null;
  // mid.line/mid.column are positions inside the bundle text.
  const orig = lookup(bundleMap, mid.line, mid.column ?? 0);
  if (orig === null) return null;
  return {
    ...orig,
    via: { jsx: { line, column }, bundle: { line: mid.line, column: mid.column ?? 0 } },
  };
}
