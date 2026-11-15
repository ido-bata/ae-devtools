/**
 * es3-lint.mjs — ExtendScript ES3 compatibility lint (Issue #52).
 *
 * ExtendScript is ES3: no `let`/`const` at runtime (tsc --target ES5 already
 * lowers them, so source-level let/const is allowed), no ES5+ builtins, no
 * modules, no `JSON` unless the host ships one (ae-a8n's codec is private —
 * scripts cannot assume it).
 *
 * Two surfaces are checked:
 *   1. SOURCE — constructs tsc cannot fix for us: import/export module
 *      syntax (single-file slice), and ES5+ runtime builtins that survive
 *      transpilation but do not exist in the ES3 host.
 *   2. OUTPUT — post-transpile scan proving the emitted JSX really is ES3
 *      (catches a wrong compiler target or a future transform regression).
 *
 * This is a lint, not a proof: it cannot know which builtins a given AE
 * version happens to ship. Rules are conservative and documented; unknown
 * constructs are NOT flagged (no false confidence).
 */

/** ES5+ runtime builtins absent from ES3. Matched as `X.y` or bare calls. */
const ES5_BUILTINS = [
  { re: /\bJSON\s*\./, name: "JSON", note: "ExtendScript has no JSON; use the host codec" },
  { re: /\bArray\.isArray\s*\(/, name: "Array.isArray" },
  { re: /\bObject\.(keys|values|entries|getOwnPropertyNames|getPrototypeOf|defineProperty|create|freeze|seal|isFrozen|isSealed)\s*\(/, name: "Object.*" },
  // indexOf/lastIndexOf omitted: String.prototype.indexOf is ES3 while
  // Array.prototype.indexOf is ES5 — a regex cannot tell them apart, and
  // ambiguous constructs are not flagged (see module doc).
  { re: /\.(forEach|map|filter|reduce|reduceRight|some|every|find|findIndex)\s*\(/, name: "Array.prototype ES5 method" },
  { re: /\bDate\.now\s*\(/, name: "Date.now" },
  { re: /\bFunction\.prototype\.bind|\.bind\s*\(/, name: "Function.prototype.bind" },
  { re: /\.(trim|trimLeft|trimRight|trimStart|trimEnd)\s*\(/, name: "String.prototype.trim*" },
];

const BUILTIN_RULES = ES5_BUILTINS;

const SOURCE_RULES = [
  {
    re: /^\s*import\s/m,
    code: "es3-module-import",
    severity: "error",
    note: "import statements are invalid in a single-file JSX; bundle first or use $.evalFile includes",
  },
  {
    re: /^\s*export\s+(default\s+)?/m,
    code: "es3-module-export",
    severity: "error",
    note: "export statements are invalid in a single-file JSX",
  },
];

const OUTPUT_RULES = [
  { re: /(^|[^=<>!])=>/, code: "es3-output-arrow", note: "arrow function survived transpile" },
  { re: /`/, code: "es3-output-template", note: "template literal survived transpile" },
  { re: /\b(class|let|const|yield|async|await)\b/, code: "es3-output-keyword", note: "ES2015+ keyword in output" },
];

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Lint TS/JS source. Returns [{severity, code, line, message}]. */
export function lintSource(source, { filename = "<input>" } = {}) {
  const diags = [];
  for (const rule of SOURCE_RULES) {
    const m = rule.re.exec(source);
    if (m) {
      diags.push({
        severity: rule.severity, code: rule.code, line: lineOf(source, m.index),
        message: `${filename}:${rule.code}: ${rule.note}`,
      });
    }
  }
  for (const rule of BUILTIN_RULES) {
    const m = rule.re.exec(source);
    if (m) {
      diags.push({
        severity: "error", code: `es3-builtin-${rule.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        line: lineOf(source, m.index),
        message: `${filename}: ES5+ builtin '${rule.name}' is not available in ExtendScript ES3${rule.note ? ` — ${rule.note}` : ""}`,
      });
    }
  }
  return diags;
}

/** Blank out strings/comments so keyword rules don't hit literal text.
 *  Crude but sufficient for generated ES3 output (no nested templates —
 *  ES3 output cannot contain them anyway). */
function stripStringsAndComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** Verify transpiled output contains no ES2015+ remnants. */
export function lintOutput(output, { filename = "<output>" } = {}) {
  const diags = [];
  const lines = stripStringsAndComments(output).split("\n");
  lines.forEach((text, i) => {
    for (const rule of OUTPUT_RULES) {
      if (rule.re.test(text)) {
        diags.push({
          severity: "error", code: rule.code, line: i + 1,
          message: `${filename}:${i + 1}: ${rule.note} ('${text.trim().slice(0, 60)}')`,
        });
      }
    }
  });
  return diags;
}

export function hasErrors(diags) {
  return diags.some((d) => d.severity === "error");
}
