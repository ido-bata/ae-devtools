/**
 * es3-ast.mjs — ExtendScript ES3 *source* analysis on the TypeScript
 * parse tree (Issue #52).
 *
 * Scope: TS/JS *source* lint only — module syntax rules, bare import
 * specifiers, object accessors, and ES5+ runtime builtins detected by
 * AST shape. The emitted-JSX checks live elsewhere:
 *
 *   es3-syntax.mjs — final ES3 *grammar* proof via an actual ES3 parser
 *     (acorn ecmaVersion 3) + reserved-word check.
 *   es3-api.mjs    — the shared ExtendScript runtime API table used by
 *     both this file (source) and the output walk (emitted JSX).
 *
 * Nothing here is a "complete ES3 proof" — source lint only rejects
 * constructs that cannot survive the pipeline; the output artifact is
 * what gets the grammar proof.
 */
import ts from "typescript";
import { classifyMemberAccess, isEs5MethodCall } from "./es3-api.mjs";

export const DIAG_SCHEMA = "ae-devtools.jsx-toolchain.diagnostic/v1";

function diag(severity, code, file, node, message) {
  const sf = node.getSourceFile();
  const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return {
    schema: DIAG_SCHEMA,
    severity,
    code,
    file,
    line: pos.line + 1,
    column: pos.character + 1,
    message,
  };
}

function parse(source, filename, scriptKind = ts.ScriptKind.TS) {
  return ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true, scriptKind);
}

/** Parse diagnostics (syntax errors) as lint diagnostics. */
function parseDiagnostics(sf, file) {
  const out = [];
  for (const d of sf.parseDiagnostics) {
    const pos = sf.getLineAndCharacterOfPosition(d.start);
    out.push({
      schema: DIAG_SCHEMA,
      severity: "error",
      code: `parse-${d.code}`,
      file,
      line: pos.line + 1,
      column: pos.character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    });
  }
  return out;
}

// ------------------------------------------------------- ES5+ builtins
//
// Detected by AST shape via the shared es3-api.mjs table: a
// PropertyAccess whose terminal name matches a builtin absent from
// ExtendScript's ES3 host. Receiver type cannot be resolved without
// full type info, so member names ambiguous with ES3-legal uses are
// deliberately not flagged (see es3-api.mjs header).

function isEs5BuiltinAccess(node) {
  // JSON.parse / Object.keys / Array.isArray / Date.now / Math.trunc ...
  // PropertyAccessChain covers `a?.b`; both are PropertyAccess-ish.
  if (ts.isPropertyAccessExpression(node) || node.kind === ts.SyntaxKind.PropertyAccessChain) {
    const expr = node.expression;
    const name = node.name.text;
    if (ts.isIdentifier(expr)) {
      const reason = classifyMemberAccess(expr.text, name);
      if (reason) {
        return { object: expr.text, member: name, reason };
      }
    }
    // bare ES5 method call: x.forEach( — flagged by method name only when
    // it is a call (property access alone may be a data field).
    if (isEs5MethodCall(name) && ts.isCallExpression(node.parent)) {
      return { object: expr.getText?.() ?? "?", member: name, reason: `'${name}' is an ES5+ prototype method absent from ExtendScript ES3` };
    }
  }
  return null;
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Lint TS/JS source. `allowModules=false` (single-file builds) makes
 * import/export an error; bare specifiers are always errors.
 */
export function lintSourceAst(source, { filename = "<input>", scriptKind = ts.ScriptKind.TS, allowModules = true } = {}) {
  const sf = parse(source, filename, scriptKind);
  const diags = parseDiagnostics(sf, filename);
  walk(sf, (node) => {
    // Single-file mode: module syntax has no bundler behind it.
    if (!allowModules && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isImportEqualsDeclaration(node))) {
      diags.push(diag("error", "es3-module-syntax", filename, node,
        `${filename}: module syntax requires the project build (bundler) — single-file JSX cannot contain import/export`));
    }
    // Bare (non-relative) import specifiers can never resolve in
    // ExtendScript — no module loader exists.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec) && !spec.text.startsWith(".")) {
        diags.push(diag("error", "es3-bare-import", filename, spec,
          `${filename}: bare module specifier '${spec.text}' cannot resolve — ExtendScript has no module loader`));
      }
    }
    // Object-literal getters/setters are ES5; tsc does not lower them.
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      diags.push(diag("error", "es3-accessor", filename, node,
        `${filename}: object accessor (get/set) is ES5 syntax with no ES3 lowering`));
    }
    const hit = isEs5BuiltinAccess(node);
    if (hit) {
      diags.push(diag("error", "es3-builtin", filename, node,
        `${filename}: ${hit.reason}`));
    }
  });
  return diags;
}
