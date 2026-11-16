/**
 * es3-lint.mjs — ExtendScript ES3 compatibility lint (Issue #52).
 *
 * Two SEPARATE checks, kept distinct by diagnostic code:
 *
 *   lintSource — TS/JS source (es3-ast.mjs, TypeScript parse tree):
 *     module syntax rules, bare specifiers, object accessors, and
 *     ES5+ builtins via the shared es3-api.mjs table.
 *
 *   lintOutput — emitted JSX, verified in two independent passes:
 *       1. es3-syntax.mjs — an actual ES3 *grammar* parse (acorn
 *          ecmaVersion 3) plus a reserved-word check. This is the
 *          syntax proof: the artifact either parses as ES3 or it does
 *          not. It is NOT a SyntaxKind whitelist — the parser accepts
 *          and rejects real grammar.
 *       2. es3-api.mjs — ExtendScript *runtime API* compatibility:
 *          member accesses and method calls absent from the ES3 host
 *          (`JSON.*`, `Object.keys`, `x.forEach(`, ...). Syntax-legality
 *          and host-API availability are different questions and are
 *          reported under different codes (`es3-syntax` /
 *          `es3-reserved-word` vs `es3-api-*`).
 */
import { lintSourceAst, DIAG_SCHEMA } from "./es3-ast.mjs";
import { parseEs3, checkReservedWords } from "./es3-syntax.mjs";
import { classifyMemberAccess, isEs5MethodCall } from "./es3-api.mjs";

export { lintSourceAst, DIAG_SCHEMA };
export { parseEs3, checkReservedWords } from "./es3-syntax.mjs";
export { classifyMemberAccess, isEs5MethodCall, ES3_RESERVED_WORDS } from "./es3-api.mjs";

function diag(severity, code, file, node, message) {
  const loc = node.loc?.start ?? { line: 1, column: 0 };
  return {
    schema: DIAG_SCHEMA,
    severity,
    code,
    file,
    line: loc.line,
    column: loc.column + 1,
    message,
  };
}

/** Walk an ESTree (acorn) AST. */
function walkEstree(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") walkEstree(child, visit, node);
      }
    } else if (value && typeof value.type === "string") {
      walkEstree(value, visit, node);
    }
  }
}

/**
 * Runtime-API pass over the emitted JSX: flags member accesses and
 * method calls absent from the ExtendScript ES3 host. Runs on the
 * acorn ESTree AST — positions are real parse positions.
 */
export function checkOutputApi(program, { filename = "<output>" } = {}) {
  const diags = [];
  walkEstree(program, (node) => {
    if (node.type === "MemberExpression" && !node.computed &&
        node.object.type === "Identifier" && node.property.type === "Identifier") {
      const reason = classifyMemberAccess(node.object.name, node.property.name);
      if (reason) {
        diags.push(diag("error", "es3-api-builtin", filename, node,
          `${filename}: ${reason}`));
      }
    }
    if (node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" && !node.callee.computed &&
        node.callee.property.type === "Identifier" &&
        isEs5MethodCall(node.callee.property.name)) {
      diags.push(diag("error", "es3-api-method", filename, node.callee.property,
        `${filename}: '.${node.callee.property.name}(' is an ES5+ prototype method absent from ExtendScript ES3`));
    }
  });
  return diags;
}

/** Lint TS/JS source. Returns diagnostics in the v1 shape. */
export function lintSource(source, { filename = "<input>", allowModules = true } = {}) {
  return lintSourceAst(source, { filename, allowModules }).map(({ schema, ...d }) => d);
}

/**
 * Verify emitted JSX. Two passes, reported separately:
 *   1. ES3 grammar proof (acorn ecmaVersion 3 + reserved words)
 *   2. ExtendScript runtime API compatibility (es3-api.mjs table)
 * Empty result = the artifact parses as ES3 AND uses no builtin known
 * absent from the ES3 host. See each module's header for scope limits.
 */
export function lintOutput(output, { filename = "<output>" } = {}) {
  const { program, diagnostics } = parseEs3(output, { filename });
  if (!program) return diagnostics.map(({ schema, ...d }) => d);
  const diags = [
    ...checkReservedWords(program, { filename }),
    ...checkOutputApi(program, { filename }),
  ];
  return diags.map(({ schema, ...d }) => d);
}

export function hasErrors(diags) {
  return diags.some((d) => d.severity === "error");
}
