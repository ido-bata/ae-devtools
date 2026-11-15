/**
 * es3-syntax.mjs — final ES3 *grammar* validation of emitted JSX
 * (Issue #52).
 *
 * SEPARATE CONCERN from the runtime API check (es3-api.mjs). This module
 * answers only: "does this text parse as ECMAScript 3 grammar?" It does
 * NOT know or care whether `JSON.parse` exists in ExtendScript — that
 * is es3-api.mjs's job.
 *
 * Implementation: acorn `ecmaVersion: 3`. Unlike the previous
 * TypeScript-SyntaxKind whitelist (which could only enumerate node
 * kinds it knew about and silently passed anything unrecognized),
 * acorn implements an actual recursive-descent ES3 grammar: it accepts
 * what ES3 accepts and rejects what ES3 rejects — trailing commas in
 * object literals, getters/setters, arrows, template literals, let/const,
 * destructuring, for-of, spread, classes, computed names, etc.
 *
 * Known acorn-vs-ES3 gaps (documented, compensated where cheap):
 *
 *   - acorn accepts ES3 reserved words used as identifiers/property
 *     names (`var class = 1`, `o.class`) even at ecmaVersion 3. ES3
 *     grammar forbids this. `checkReservedWords` below closes that gap
 *     by walking the ESTree AST: any Identifier whose name is an ES3
 *     reserved word is an error, EXCEPT non-computed object-literal
 *     keys (`{ default: 1 }`), which JScript/ExtendScript accepts in
 *     practice and which transpilers legitimately emit.
 *   - acorn's ES3 mode is the closest machine-checkable approximation
 *     of ES3; it does not model ExtendScript-specific deviations
 *     (non-standard extensions, host objects, `with` quirks). Those are
 *     runtime-API concerns, not syntax.
 */
import { parse } from "acorn";
import { DIAG_SCHEMA } from "./es3-ast.mjs";
import { ES3_RESERVED_WORDS } from "./es3-api.mjs";

function diag(severity, code, file, line, column, message) {
  return { schema: DIAG_SCHEMA, severity, code, file, line, column, message };
}

/**
 * Parse `source` as ES3. Returns { program, diagnostics } — program is
 * the ESTree AST on success (null on syntax error), diagnostics always
 * contains any `es3-syntax` errors.
 */
export function parseEs3(source, { filename = "<output>" } = {}) {
  try {
    const program = parse(source, {
      ecmaVersion: 3,
      locations: true,
    });
    return { program, diagnostics: [] };
  } catch (error) {
    const loc = error.loc ?? { line: 1, column: 0 };
    return {
      program: null,
      diagnostics: [diag(
        "error", "es3-syntax", filename,
        loc.line, loc.column + 1,
        `${filename}: not valid ES3 syntax — ${error.message}`,
      )],
    };
  }
}

/**
 * Flag ES3 reserved words used as identifiers. acorn accepts them even
 * at ecmaVersion 3, so this is an explicit grammar check on top.
 *
 * Tolerated: non-computed keys of object-literal Property nodes
 * (`{ default: 1 }`) — ExtendScript/JScript accepts reserved property
 * names there and transpilers emit them. Everything else — variable
 * bindings, function names/params, references, labels, member-access
 * properties (`o.class`) — is an ES3 syntax error.
 */
export function checkReservedWords(program, { filename = "<output>" } = {}) {
  const diags = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (
      node.type === "Identifier" &&
      ES3_RESERVED_WORDS.has(node.name) &&
      !(parent && parent.type === "Property" && parent.key === node && !parent.computed)
    ) {
      const loc = node.loc?.start ?? { line: 1, column: 0 };
      diags.push(diag(
        "error", "es3-reserved-word", filename,
        loc.line, loc.column + 1,
        `${filename}: reserved word '${node.name}' used as an identifier — illegal in ES3 grammar`,
      ));
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") visit(child, node);
        }
      } else if (value && typeof value.type === "string") {
        visit(value, node);
      }
    }
  };
  visit(program, null);
  return diags;
}
