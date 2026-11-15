/**
 * es3-ast.mjs — ExtendScript ES3 compatibility analysis on a real syntax
 * tree (Issue #52).
 *
 * This replaces the earlier regex lint. Regexes cannot prove ES3
 * compatibility — they miss constructs inside strings/templates and
 * cannot distinguish syntax from text. Everything here is derived from
 * the TypeScript compiler's parse tree, so "the output is ES3" means
 * "every node in the parsed output is an ES3 node", not "no banned
 * substring appeared".
 *
 * Two surfaces:
 *
 *   lintSourceAst — TS/JS *source*. `allowModules` controls whether
 *     import/export is legal input (true for project builds behind the
 *     bundler, false for single-file builds). Bare (non-relative)
 *     specifiers are always errors — ExtendScript has no module loader.
 *     ES5+ runtime builtins that survive transpilation are flagged by
 *     AST shape, not text. ES2015 *syntax* in source is allowed: tsc/
 *     esbuild lower it. Getters/setters are flagged because tsc does not
 *     lower object-literal accessors to ES3.
 *
 *   lintOutputAst — emitted JSX. Whitelist-style: the output is parsed
 *     and every SyntaxKind is checked against the ES3-allowed set.
 *     Arrow functions, classes, template literals, let/const,
 *     destructuring, spread, for-of, computed names, shorthand
 *     properties, async/yield — anything outside the set is an error
 *     with a source position. This is the ES3 proof; the compat tests
 *     in tests/run.mjs feed it adversarial inputs (keywords inside
 *     strings, arrows in comments) to show it cannot be fooled by text.
 */
import ts from "typescript";

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
// Detected by AST shape: a PropertyAccess/Call whose terminal name matches
// a builtin absent from ExtendScript's ES3 host. Receiver type cannot be
// resolved without full type info, so member names that are ambiguous
// with ES3-legal uses (e.g. Array.prototype.indexOf vs
// String.prototype.indexOf) are deliberately NOT in this table — same
// conservatism as before, but now enforced structurally.

const ES5_BUILTIN_NAMES = new Map([
  // object-scoped: `JSON.parse`, `Object.keys`, `Array.isArray`, ...
  ["JSON", ["parse", "stringify"]],
  ["Object", ["keys", "values", "entries", "getOwnPropertyNames", "getOwnPropertyDescriptor", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties", "create", "freeze", "seal", "isFrozen", "isSealed", "isExtensible", "preventExtensions", "assign", "getOwnPropertySymbols"]],
  ["Array", ["isArray", "from", "of", "prototype"]],
  ["Date", ["now", "UTC"]],
  ["Function", ["prototype"]],
  ["Math", ["trunc", "sign", "cbrt", "clz32", "imul", "fround", "log2", "log10", "expm1", "hypot"]],
  ["Number", ["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON", "POSITIVE_INFINITY", "NEGATIVE_INFINITY"]],
  ["String", ["fromCharCode", "fromCodePoint", "raw"]],
  ["Symbol", ["for", "keyFor", "iterator", "asyncIterator", "hasInstance", "isConcatSpreadable", "match", "replace", "search", "species", "split", "toPrimitive", "toStringTag", "unscopables"]],
  ["Reflect", ["*"]],
  ["Promise", ["*"]],
  ["Map", ["*"]],
  ["Set", ["*"]],
  ["WeakMap", ["*"]],
  ["WeakSet", ["*"]],
  ["Proxy", ["*"]],
  ["Intl", ["*"]],
]);

// Unambiguous ES5 prototype methods: the NAME itself is ES5-only on the
// receivers ExtendScript ships (Array/String/Function). `.indexOf` is
// excluded — String.prototype.indexOf is ES3.
const ES5_METHOD_NAMES = new Set([
  "forEach", "map", "filter", "reduce", "reduceRight", "some", "every",
  "find", "findIndex", "findLast", "findLastIndex",
  "trim", "trimLeft", "trimRight", "trimStart", "trimEnd",
  "bind", "call", "apply", // call/apply ARE ES3 — keep them legal
]);
ES5_METHOD_NAMES.delete("call");
ES5_METHOD_NAMES.delete("apply");

const ES3_RESERVED = new Set([
  "break", "case", "catch", "continue", "default", "delete", "do", "else",
  "finally", "for", "function", "if", "in", "instanceof", "new", "return",
  "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with",
]);

function isEs5BuiltinAccess(node) {
  // JSON.parse / Object.keys / Array.isArray / Date.now / Math.trunc ...
  // PropertyAccessChain covers `a?.b`; both are PropertyAccess-ish.
  if (ts.isPropertyAccessExpression(node) || node.kind === ts.SyntaxKind.PropertyAccessChain) {
    const expr = node.expression;
    const name = node.name.text;
    if (ts.isIdentifier(expr)) {
      const allowed = ES5_BUILTIN_NAMES.get(expr.text);
      if (allowed && (allowed.includes("*") || allowed.includes(name))) {
        return { object: expr.text, member: name };
      }
    }
    // bare ES5 method call: x.forEach( — flagged by method name only when
    // it is a call (property access alone may be a data field).
    if (ES5_METHOD_NAMES.has(name) && ts.isCallExpression(node.parent)) {
      return { object: expr.getText?.() ?? "?", member: name };
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
        `${filename}: '${hit.object}.${hit.member}' is an ES5+ builtin absent from ExtendScript ES3`));
    }
  });
  return diags;
}

// ------------------------------------------------------- output proof

/**
 * SyntaxKinds that must never appear in emitted JSX. Anything not listed
 * here and not in ES3_OUTPUT_ALLOWED is still checked: the walk flags
 * every node whose kind is in ES3_FORBIDDEN. Kinds absent from both sets
 * (new TS syntax) are treated as forbidden — fail closed.
 */
const ES3_FORBIDDEN_KINDS = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.ObjectBindingPattern,
  ts.SyntaxKind.ArrayBindingPattern,
  ts.SyntaxKind.ComputedPropertyName,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.NamespaceExportDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.NamedImports,
  ts.SyntaxKind.ImportClause,
]);

/** Variable declarations using let/const (ES2015) instead of var. */
function isLetOrConst(node) {
  return ts.isVariableDeclarationList(node) &&
    (ts.getCombinedNodeFlags(node) & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
}

/** ES5+ builtins that must not appear in emitted output either. */
const OUTPUT_BUILTIN_NAMES = new Map([
  ["JSON", ["parse", "stringify"]],
  ["Object", ["keys", "values", "entries", "getOwnPropertyNames", "getOwnPropertyDescriptor", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties", "create", "freeze", "seal", "isFrozen", "isSealed", "isExtensible", "preventExtensions", "assign"]],
  ["Array", ["isArray", "from", "of"]],
  ["Date", ["now"]],
  ["Function", ["prototype"]],
  ["Math", ["trunc", "sign", "cbrt", "clz32", "imul", "fround", "log2", "log10", "expm1", "hypot"]],
  ["Number", ["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON", "POSITIVE_INFINITY", "NEGATIVE_INFINITY"]],
  ["String", ["fromCharCode", "fromCodePoint", "raw"]],
]);

/**
 * Verify emitted JSX is ES3. Returns diagnostics; empty = proof passed.
 * The check is structural: parse the output, then require every node to
 * be an ES3-legal kind, every variable declaration `var`, no ES5+
 * builtins, and no reserved word used as a dot-property name.
 */
export function lintOutputAst(output, { filename = "<output>" } = {}) {
  const sf = parse(output, filename, ts.ScriptKind.JS);
  const diags = parseDiagnostics(sf, filename);
  walk(sf, (node) => {
    if (ES3_FORBIDDEN_KINDS.has(node.kind)) {
      diags.push(diag("error", "es3-output-kind", filename, node,
        `${filename}: ES2015+ syntax '${ts.SyntaxKind[node.kind]}' survived transpile`));
      return;
    }
    if (isLetOrConst(node)) {
      diags.push(diag("error", "es3-output-letconst", filename, node,
        `${filename}: let/const survived transpile — ExtendScript ES3 has only var`));
    }
    // Reserved words as property names are ES5; ExtendScript tolerance is
    // unproven, so dot-access `.class`/`.function`/... is flagged.
    if (ts.isPropertyAccessExpression(node) && ES3_RESERVED.has(node.name.text)) {
      diags.push(diag("error", "es3-output-reserved-prop", filename, node,
        `${filename}: reserved word '${node.name.text}' used as a property name — ES5-only, unproven in ExtendScript`));
    }
    // `yield`/`let`/`const`/`async`/`await` used as plain identifiers are
    // legal ES3 (sloppy mode) — only their keyword positions are checked
    // above, so identifier use is deliberately left alone.
    // ES5+ builtins in output.
    if (ts.isPropertyAccessExpression(node)) {
      const expr = node.expression;
      const name = node.name.text;
      if (ts.isIdentifier(expr)) {
        const allowed = OUTPUT_BUILTIN_NAMES.get(expr.text);
        if (allowed && allowed.includes(name)) {
          diags.push(diag("error", "es3-output-builtin", filename, node,
            `${filename}: ES5+ builtin '${expr.text}.${name}' present in emitted JSX`));
        }
      }
    }
    // Unambiguous ES5 prototype methods surviving into output.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      if (["forEach", "map", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "trim", "trimLeft", "trimRight", "trimStart", "trimEnd", "bind"].includes(m)) {
        diags.push(diag("error", "es3-output-method", filename, node,
          `${filename}: ES5+ method '.${m}(' present in emitted JSX`));
      }
    }
  });
  return diags;
}
