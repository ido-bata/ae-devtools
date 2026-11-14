#!/usr/bin/env node
/**
 * scaffold.mjs — CEP extension project scaffold generator (Issue #36, CAP057).
 *
 * Generates a minimal, loadable-shape CEP extension tree:
 *
 *   <out>/CSXS/manifest.xml
 *   <out>/index.html
 *   <out>/js/main.js
 *   <out>/js/csinterface-wrapper.js   (copied verbatim from templates/)
 *
 * Node >= 22, zero dependencies, no network, no AE. The generated tree is
 * a *development target fixture*: generating it is automated-test-level
 * evidence only. Loading it into After Effects is a separate gated
 * procedure (see LOAD-PROOF.md) and stays UNVERIFIED until an owned AE
 * session produces the recorded evidence.
 *
 * Usage:
 *   node scaffold.mjs --id com.example.my-panel --title "My Panel" \
 *       --version 0.1.0 --host "[25.0,99.0]" --csxs 12.0 --out ./my-panel
 *
 * Options:
 *   --id <reverse-dns.id>   required; must contain at least one dot
 *   --title <text>          panel <title>/heading; default: derived from id
 *   --version <semver>      extension version; default 0.1.0
 *   --host <range>          AE Host Version range, e.g. "[25.0,99.0]" or
 *                           "[25.0,)"; default "[25.0,99.0]"
 *   --csxs <version>        RequiredRuntime CSXS version; default 12.0
 *   --out <dir>             output directory (required)
 *   --force                 overwrite a non-empty output directory
 *
 * Exit codes: 0 ok, 2 usage/validation error, 3 output refused.
 */
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "templates");

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const CSXS_RE = /^\d+\.\d+(\.\d+)?$/;
const HOST_RE = /^\[[0-9]+(\.[0-9]+)?(,[0-9]*(\.[0-9]+)?)?\]$/;

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scaffold.mjs --id <reverse-dns.id> --out <dir> " +
      "[--title <text>] [--version <semver>] [--host <range>] [--csxs <ver>] [--force]"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") { args.force = true; continue; }
    if (!a.startsWith("--")) usage(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (!["id", "title", "version", "host", "csxs", "out"].includes(key)) {
      usage(`unknown option: ${a}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) usage(`missing value for ${a}`);
    args[key] = value;
  }
  return args;
}

function validate(args) {
  if (!args.id || !ID_RE.test(args.id)) {
    usage("--id must be a reverse-DNS-style id with at least one dot " +
      "(letters, digits, '-', '_', '.'; no path separators)");
  }
  if (!args.out) usage("--out is required");
  args.version = args.version ?? "0.1.0";
  if (!VERSION_RE.test(args.version)) usage(`--version must be semver-ish, got: ${args.version}`);
  args.host = args.host ?? "[25.0,99.0]";
  if (!HOST_RE.test(args.host)) {
    usage(`--host must look like "[25.0,99.0]" or "[25.0,]", got: ${args.host}`);
  }
  args.csxs = args.csxs ?? "12.0";
  if (!CSXS_RE.test(args.csxs)) usage(`--csxs must be a dotted version, got: ${args.csxs}`);
  args.title = args.title ?? args.id.split(".").pop().replace(/[-_]+/g, " ");
  if (args.title.length === 0 || args.title.length > 80) {
    usage("--title must be 1..80 characters");
  }
  if (/[&<>"']/.test(args.id)) usage("--id contains XML-unsafe characters");
  return args;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(s) {
  return escapeXml(s);
}

function escapeJs(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function renderTemplate(name, vars) {
  const raw = await readFile(join(TEMPLATES, name), "utf8");
  const escapers = {
    xml: escapeXml,
    html: escapeHtml,
    js: escapeJs,
  };
  return raw.replace(/\{\{([A-Z_]+)(?::(xml|html|js))?\}\}/g, (_, key, mode) => {
    if (!(key in vars)) throw new Error(`template ${name}: unknown placeholder {{${key}}}`);
    const esc = escapers[mode ?? "xml"] ?? escapeXml;
    return esc(vars[key]);
  });
}

async function dirIsEmptyOrMissing(dir) {
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

export class ScaffoldError extends Error {
  constructor(message, exitCode = 3) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function scaffold(args) {
  const out = resolve(args.out);
  const ok = await dirIsEmptyOrMissing(out);
  if (!ok && !args.force) {
    throw new ScaffoldError(
      `output directory is not empty: ${out}\n` +
      "pass --force to overwrite, or choose another --out",
      3
    );
  }

  const vars = {
    EXT_ID: args.id,
    EXT_TITLE: args.title,
    EXT_VERSION: args.version,
    HOST_RANGE: args.host,
    CSXS_VERSION: args.csxs,
  };

  const files = [
    ["CSXS/manifest.xml", await renderTemplate("manifest.xml.tmpl", vars)],
    ["index.html", await renderTemplate("index.html.tmpl", vars)],
    ["js/main.js", await renderTemplate("js/main.js.tmpl", vars)],
    ["js/csinterface-wrapper.js", await readFile(join(TEMPLATES, "js/csinterface-wrapper.js"), "utf8")],
  ];

  for (const [rel, content] of files) {
    if (content.includes("{{")) {
      throw new Error(`unexpanded placeholder left in ${rel}`);
    }
    const dest = join(out, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = validate(parseArgs(process.argv.slice(2)));
    const out = await scaffold(args);
    console.log(`scaffolded CEP extension "${args.id}" v${args.version} -> ${out}`);
    console.log("next: see LOAD-PROOF.md for the gated real-AE load procedure (UNVERIFIED until run).");
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode ?? 1);
  }
}
