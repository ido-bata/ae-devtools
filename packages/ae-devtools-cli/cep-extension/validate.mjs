/**
 * validate.mjs — static validation for a CEP extension project
 * directory (Issue #36 devkit). Zero dependencies, Node >= 22, no AE.
 *
 * What it checks (all fake-level / static — nothing is loaded):
 *
 *   required-files     CSXS/manifest.xml + index.html present
 *   manifest-xml       manifest well-formedness: `xmllint --noout` when
 *                      available, otherwise a documented XML subset
 *                      check (tag balance; NOT a namespace/schema
 *                      validation)
 *   manifest-structure required CEP 5+/12 elements present
 *                      (ExtensionManifest/ExtensionList/
 *                      ExecutionEnvironment/HostList AEFT/
 *                      RequiredRuntimeList CSXS/DispatchInfoList/
 *                      MainPath) — heuristic, not XSD validation
 *   panel-references   every local <script src>/<link href> in
 *                      index.html resolves to a file inside the dir
 *   csinterface        whether index.html references a bundled
 *                      CSInterface.js and that file exists (official
 *                      cookbook requires bundling; host does NOT
 *                      provide it)
 *   host-jsx-es3       every *.jsx under the dir passes a documented
 *                      ES3 *subset* lint (see ES3_SUBSET_RULES).
 *                      This is a heuristic scan, NOT a grammar proof —
 *                      for a real ES3 parse use the sibling
 *                      jsx-toolchain package's `lintOutput` when its
 *                      deps (acorn) are installed.
 *   debuggable-marker  informational: presence/absence of a
 *                      `.debuggable` file at the extension root
 *   load-proof         ALWAYS reported as "NOT RUN" — validation is
 *                      static; it is never evidence of a real load.
 *
 * Result shape:
 *   { dir, ok, checks: [{name,status,detail}], loadProof }
 * status: "pass" | "fail" | "warn" | "info" | "skip"
 * ok === true iff no check has status "fail".
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve, relative, sep } from "node:path";

const MANIFEST_REL = join("CSXS", "manifest.xml");
const INDEX_REL = "index.html";

function check(name, status, detail) {
  return { name, status, detail };
}

async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/** Recursively collect *.jsx files under dir (relative paths). */
async function findJsx(dir, prefix = "") {
  const out = [];
  let entries;
  try { entries = await readdir(join(dir, prefix), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await findJsx(dir, rel));
    else if (e.isFile() && /\.jsx$/i.test(e.name)) out.push(rel);
  }
  return out.sort();
}

function xmllintAvailable() {
  // Test hook: AE_DEVTOOLS_CEP_NO_XMLLINT=1 forces the subset fallback
  // so the no-xmllint branch of validateExtension stays covered on
  // machines that do have xmllint installed.
  if (process.env.AE_DEVTOOLS_CEP_NO_XMLLINT === "1") return false;
  return spawnSync("xmllint", ["--version"], { encoding: "utf8" }).status === 0;
}

/**
 * XML well-formedness SUBSET check — used only when xmllint is absent.
 * Strips comments/CDATA/PIs/doctype, then verifies start/end tag
 * balance. Does NOT validate attributes, namespaces, or entities;
 * a "pass" here is weaker than xmllint and is reported as such.
 */
export function xmlWellFormedSubset(xml) {
  const stripped = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const stack = [];
  const re = /<\/?([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const [whole, name] = m;
    const isClose = whole.startsWith("</");
    const selfClose = !isClose && /\/\s*>$/.test(whole);
    if (isClose) {
      const top = stack.pop();
      if (top !== name) {
        return { ok: false, error: `mismatched close tag </${name}> (expected </${top ?? "?"}>)` };
      }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    return { ok: false, error: `unclosed tag(s): ${stack.join(", ")}` };
  }
  return { ok: true };
}

const MANIFEST_REQUIRED = [
  ["<ExtensionManifest", "root element"],
  ["<ExtensionList>", "ExtensionList"],
  ["<ExecutionEnvironment>", "ExecutionEnvironment"],
  ["<HostList>", "HostList"],
  ['Name="AEFT"', "AEFT host entry"],
  ["<RequiredRuntimeList>", "RequiredRuntimeList"],
  ['Name="CSXS"', "CSXS runtime entry"],
  ["<DispatchInfoList>", "DispatchInfoList"],
  ["<MainPath>", "MainPath"],
];

/**
 * Blank out comments AND string literals for the ES3 lint, preserving
 * line structure so reported line numbers stay accurate. Strings are
 * masked FIRST so a `//`, `/*` or `=>` inside a literal cannot be
 * mistaken for code (and a comment cannot swallow a string). Block
 * comments are replaced by same-length whitespace — dropping the
 * newlines inside them would shift every later line number.
 */
function maskNonCode(src) {
  const mask = (s) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g, mask)
    .replace(/\/\*[\s\S]*?\*\//g, mask)
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * ES3 SUBSET lint for ExtendScript host (.jsx) files.
 *
 * This is a HEURISTIC scan over comment-stripped source, not a grammar
 * proof. Rules target constructs that are unambiguously absent from
 * ExtendScript's ES3 engine. Deliberately excluded: `.indexOf(` /
 * `.lastIndexOf(` (exist on String in ES3; Array.indexOf is ES5 but
 * cannot be distinguished without parsing), `eval(`, `arguments`,
 * reserved-word-as-identifier checks.
 *
 * For a real ES3 grammar proof use the sibling jsx-toolchain
 * package's `lintOutput` (acorn ecmaVersion 3) when its dependencies
 * are
 * installed — cep-extension stays zero-dependency, so this subset is
 * the documented fallback.
 */
export const ES3_SUBSET_RULES = [
  { code: "es3-let-const", re: /\b(?:let|const)\s+[A-Za-z_$]/,
    msg: "let/const are ES6; ExtendScript requires var" },
  { code: "es3-arrow", re: /=>/,
    msg: "arrow functions are ES6; use function()" },
  { code: "es3-class", re: /\bclass\s+[A-Za-z_$]/,
    msg: "class is ES6; ExtendScript has no classes" },
  { code: "es3-json", re: /\bJSON\s*\./,
    msg: "JSON.* is not part of the ES3 host surface" },
  { code: "es3-object-static", re: /\bObject\.(?:keys|create|definePropert|definePropertie|getOwnProperty|freeze|seal|preventExtensions|isFrozen|isSealed|isExtensible|getPrototypeOf)\w*\b/,
    msg: "Object.* static helpers are ES5+; absent from ExtendScript ES3" },
  // Array.isArray/from/of are ES5+ statics; Array.prototype.slice/call
  // are valid ES3 and must not be flagged.
  { code: "es3-array-static", re: /\bArray\.(?:isArray|from|of)\b/,
    msg: "Array.* statics are ES5+; absent from ExtendScript ES3" },
  { code: "es3-es5-method", re: /\.(?:forEach|map|filter|reduce|reduceRight|some|every|find|findIndex|findLast|findLastIndex|includes|fill|copyWithin|flat|flatMap|at|with|toSorted|toReversed|toSpliced|trim|trimStart|trimEnd|padStart|padEnd|repeat|codePointAt|normalize|startsWith|endsWith|matchAll|replaceAll|keys|values|entries)\s*\(/,
    msg: "ES5+ prototype method call; absent from ExtendScript ES3" },
];

/** Returns [{line, code, msg}] for ES5+ constructs in JSX source. */
export function lintJsxEs3Subset(source) {
  const code = maskNonCode(source);
  const hits = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const rule of ES3_SUBSET_RULES) {
      if (rule.re.test(lines[i])) {
        hits.push({ line: i + 1, code: rule.code, msg: rule.msg });
      }
    }
  }
  return hits;
}

/** Extract local resource refs (script src / link href) from HTML. */
function localRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<script[^>]+\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]+\bhref\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  return refs.filter((r) => !/^[a-z][a-z0-9+.-]*:/i.test(r) && !r.startsWith("//") && !r.startsWith("data:"));
}

/**
 * Validate a CEP extension project directory.
 * Never throws for content problems — returns ok:false with failed
 * checks. Throws only for an unreadable/missing root dir.
 */
export async function validateExtension(dirArg) {
  const dir = resolve(dirArg);
  if (!(await isDir(dir))) {
    throw new Error(`not a directory: ${dir}`);
  }
  const checks = [];

  // 1. required files
  const manifestPath = join(dir, MANIFEST_REL);
  const indexPath = join(dir, INDEX_REL);
  const haveManifest = await isFile(manifestPath);
  const haveIndex = await isFile(indexPath);
  checks.push(check("required-files",
    haveManifest && haveIndex ? "pass" : "fail",
    `manifest=${haveManifest ? "present" : "MISSING"} index.html=${haveIndex ? "present" : "MISSING"}`));

  // 2. manifest well-formedness
  if (haveManifest) {
    const xml = await readFile(manifestPath, "utf8");
    if (xmllintAvailable()) {
      const r = spawnSync("xmllint", ["--noout", manifestPath], { encoding: "utf8" });
      checks.push(check("manifest-xml",
        r.status === 0 ? "pass" : "fail",
        r.status === 0 ? "xmllint: well-formed" : `xmllint: ${r.stderr.trim() || "malformed"}`));
    } else {
      const res = xmlWellFormedSubset(xml);
      checks.push(check("manifest-xml",
        res.ok ? "pass" : "fail",
        res.ok
          ? "XML subset check (tag balance only — xmllint unavailable; not namespace/schema validation)"
          : `XML subset check: ${res.error}`));
    }

    // 3. manifest structure (heuristic element presence). Match on
    // comment/CDATA-stripped text so a commented-out element or a
    // string value cannot satisfy the check by accident.
    const xmlCode = xml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    const missing = MANIFEST_REQUIRED.filter(([needle]) => !xmlCode.includes(needle));
    checks.push(check("manifest-structure",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0
        ? "required CEP 5+/12 elements present (heuristic, not XSD validation)"
        : `missing: ${missing.map(([, label]) => label).join(", ")}`));
  } else {
    checks.push(check("manifest-xml", "skip", "no manifest to check"));
    checks.push(check("manifest-structure", "skip", "no manifest to check"));
  }

  // 4. panel references + CSInterface bundling
  if (haveIndex) {
    const html = await readFile(indexPath, "utf8");
    const refs = localRefs(html);
    const missingRefs = [];
    for (const ref of refs) {
      const clean = ref.split("?")[0].split("#")[0];
      // A leading "/" is CEP extension-root-relative (the extension
      // folder is the local server root), NOT a filesystem-absolute
      // path — resolve it inside the extension dir. Windows drive
      // paths and UNC paths remain absolute and are rejected.
      const rootRelative = clean.startsWith("/");
      if (isAbsolutePath(clean) && !rootRelative) {
        missingRefs.push(`${ref} (absolute path — must stay inside the extension dir)`);
        continue;
      }
      const target = rootRelative
        ? resolve(dir, `.${clean}`)
        : resolve(dir, clean);
      const rel = relative(dir, target);
      if (rel === ".." || rel.startsWith(`..${sep}`)) {
        missingRefs.push(`${ref} (escapes extension dir)`);
        continue;
      }
      if (!(await isFile(target))) missingRefs.push(ref);
    }
    checks.push(check("panel-references",
      missingRefs.length === 0 ? "pass" : "fail",
      missingRefs.length === 0
        ? `${refs.length} local resource ref(s) resolve inside the extension dir`
        : `unresolved/outside refs: ${missingRefs.join(", ")}`));

    // CSInterface.js may be bundled at the root OR referenced from a
    // sub-directory (e.g. lib/CSInterface.js) — resolve each referenced
    // path instead of assuming the extension root.
    const csRefs = refs.filter((r) => /CSInterface\.js(?:[?#]|$)/.test(r));
    const csExists = await isFile(join(dir, "CSInterface.js"));
    if (csRefs.length > 0) {
      const unresolved = [];
      for (const ref of csRefs) {
        const clean = ref.split("?")[0].split("#")[0];
        const rootRelative = clean.startsWith("/");
        const target = rootRelative
          ? resolve(dir, `.${clean}`)
          : resolve(dir, clean);
        const rel = relative(dir, target);
        if ((rel === ".." || rel.startsWith(`..${sep}`)) || !(await isFile(target))) {
          unresolved.push(ref);
        }
      }
      checks.push(check("csinterface",
        unresolved.length === 0 ? "pass" : "fail",
        unresolved.length === 0
          ? `${csRefs.length} CSInterface.js reference(s) resolve to bundled file(s)`
          : `CSInterface.js referenced but missing/outside: ${unresolved.join(", ")} (must be bundled — host does not provide it)`));
    } else {
      checks.push(check("csinterface", "info",
        csExists ? "CSInterface.js bundled but not referenced by index.html"
                 : "no CSInterface.js reference in index.html (panel may not use evalScript)"));
    }
  } else {
    checks.push(check("panel-references", "skip", "no index.html"));
    checks.push(check("csinterface", "skip", "no index.html"));
  }

  // 5. host JSX ES3 subset lint
  const jsxFiles = await findJsx(dir);
  if (jsxFiles.length === 0) {
    checks.push(check("host-jsx-es3", "info", "no *.jsx files found"));
  } else {
    const bad = [];
    for (const rel of jsxFiles) {
      const src = await readFile(join(dir, rel), "utf8");
      for (const hit of lintJsxEs3Subset(src)) {
        bad.push(`${rel}:${hit.line} ${hit.code} — ${hit.msg}`);
      }
    }
    checks.push(check("host-jsx-es3",
      bad.length === 0 ? "pass" : "fail",
      bad.length === 0
        ? `${jsxFiles.length} .jsx file(s) clean under the documented ES3 subset (heuristic — see module docs)`
        : bad.join("; ")));
  }

  // 6. .debuggable marker (informational only)
  const debuggable = await isFile(join(dir, ".debuggable"));
  checks.push(check("debuggable-marker", "info",
    debuggable
      ? ".debuggable present at extension root"
      : ".debuggable absent — unsigned debug loading on macOS uses PlayerDebugMode (see README); presence/absence is informational only"));

  // 7. honest load-proof status — ALWAYS NOT RUN
  checks.push(check("load-proof", "info",
    "NOT RUN — static validation only; real CEP load requires LOAD-PROOF.md and an owned AE session"));

  const ok = checks.every((c) => c.status !== "fail");
  return {
    dir,
    ok,
    checks,
    loadProof: "NOT RUN",
    loadProofNote:
      "validate is static/fake-level evidence. It never loads the extension into After Effects. " +
      "See LOAD-PROOF.md for the gated real-host procedure.",
  };
}

function isAbsolutePath(p) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
