/**
 * es3-lint.mjs — ExtendScript ES3 compatibility lint (Issue #52).
 *
 * Thin compatibility wrapper over es3-ast.mjs: all analysis is done on
 * the TypeScript parse tree, never by regex. See es3-ast.mjs for the
 * rules and their rationale.
 *
 *   lintSource — TS/JS source: bare module specifiers, object accessors,
 *     ES5+ builtins. Module syntax itself is legal (the bundler stage
 *     consumes it); ES2015 syntax is legal (tsc/esbuild lower it).
 *   lintOutput — emitted JSX: structural ES3 proof (see es3-ast.mjs).
 */
import { lintSourceAst, lintOutputAst } from "./es3-ast.mjs";

export { lintSourceAst, lintOutputAst };

/** Lint TS/JS source. Returns diagnostics in the v1 shape. */
export function lintSource(source, { filename = "<input>", allowModules = true } = {}) {
  return lintSourceAst(source, { filename, allowModules }).map(({ schema, ...d }) => d);
}

/** Verify transpiled output is structurally ES3. */
export function lintOutput(output, { filename = "<output>" } = {}) {
  return lintOutputAst(output, { filename }).map(({ schema, ...d }) => d);
}

export function hasErrors(diags) {
  return diags.some((d) => d.severity === "error");
}
