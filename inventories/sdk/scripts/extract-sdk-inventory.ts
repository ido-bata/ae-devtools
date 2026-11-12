#!/usr/bin/env bun
/**
 * AE SDK public-header inventory extractor (CAP009 / CAP010 / CAP011).
 *
 * Deterministic, re-runnable extraction of symbol *structure* from an After
 * Effects SDK distribution that the operator already holds locally.
 *
 * REDISTRIBUTION CONSTRAINT — read before changing any output path.
 * The AE SDK 26.5 headers carry an "ADOBE CONFIDENTIAL / reproduction of this
 * material is strictly forbidden" notice, and the SDK package ships no license,
 * EULA or readme granting redistribution. Therefore:
 *
 *   - `--out-aggregate` (committed) must contain ONLY counts, hashes and
 *     provenance. It must never contain symbol identifiers or header text.
 *   - `--out-detail` (git-ignored, local only) contains the per-symbol rows.
 *     It is the artifact a reader needs their own licensed SDK to reproduce.
 *
 * The committed aggregate is what this repository publishes; the detail dump is
 * a local working artifact. Do not invert or merge these two.
 *
 * Usage:
 *   bun inventories/sdk/scripts/extract-sdk-inventory.ts \
 *     --headers /path/to/AeSDK/Examples/Headers \
 *     --zip     /path/to/AfterEffectsSDK_26.5_MacOS.zip
 *
 *   # verify a committed aggregate still matches a fresh run (no writes):
 *   bun inventories/sdk/scripts/extract-sdk-inventory.ts ... --check
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/* ------------------------------------------------------------------ */
/* Classification vocabulary                                           */
/* ------------------------------------------------------------------ */

/**
 * The five classes required by CAP011. Exactly one is assigned per symbol.
 *
 * external-command        The client invokes an operation on the host. Evidence:
 *                         the callable is a slot of a struct that carries a
 *                         `#define k<Name> "..."` registration string, i.e. a
 *                         suite the client acquires and calls into AE.
 * in-host-plugin-command  The host dispatches a command into the plug-in module.
 *                         Evidence: selector enums documented as commands sent
 *                         to the effect, and entry-point blocks/prototypes the
 *                         host calls.
 * host-callback           The host invokes it at its own discretion. Evidence:
 *                         it is a slot of a host-owned procedure table, or a
 *                         prototype the plug-in hands to the host for later use.
 * build-test-lifecycle    Version / PiPL / spec-version declarations. Not a
 *                         runtime operation.
 * unsupported-or-unknown  Direction not attributable from the header text, or a
 *                         plain data type with no call direction.
 */
const CLASSES = [
  "external-command",
  "in-host-plugin-command",
  "host-callback",
  "build-test-lifecycle",
  "unsupported-or-unknown",
] as const;
type SymbolClass = (typeof CLASSES)[number];

const KINDS = [
  "suite",
  "suite-slot",
  "selector",
  "entry-point",
  "entry-point-slot",
  "callback-type",
  "callback-slot",
  "version-or-pipl",
  "type",
] as const;
type SymbolKind = (typeof KINDS)[number];

const EVIDENCES = [
  "suite-registration-string",
  "host-to-plugin-selector",
  "host-dispatches-entry-point",
  "host-invoked-callback",
  "version-or-pipl-declaration",
  "none",
] as const;
type Evidence = (typeof EVIDENCES)[number];

const UNKNOWN_REASONS = [
  "pure-data-type",
  "reserved-selector",
  "deprecated-header-only",
  "unattributed-callable",
] as const;
type UnknownReason = (typeof UNKNOWN_REASONS)[number];

type SymbolRow = {
  kind: SymbolKind;
  name: string;
  header: string;
  line: number;
  class: SymbolClass;
  evidence: Evidence;
  /** Named rule that produced the class, so the local detail dump is auditable. */
  rule: string;
  unknownReason?: UnknownReason;
  deprecatedHeader?: boolean;
};

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

type Options = {
  headers?: string;
  zip?: string;
  release?: string;
  outAggregate?: string;
  outDetail?: string;
  check: boolean;
  quiet: boolean;
};

function printUsage(): void {
  console.log(`AE SDK header inventory extractor

  --headers <dir>        Directory holding the SDK public headers (required).
  --zip <file>           SDK distribution archive, hashed for provenance.
  --release <id>         SDK release identifier (default: 26.5).
  --out-aggregate <file> Committed aggregate JSON.
  --out-detail <file>    Local-only per-symbol JSON (git-ignored).
  --check                Regenerate in memory and compare with --out-aggregate.
  --quiet                Suppress the summary on stderr.`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--headers": opts.headers = value(); break;
      case "--zip": opts.zip = value(); break;
      case "--release": opts.release = value(); break;
      case "--out-aggregate": opts.outAggregate = value(); break;
      case "--out-detail": opts.outDetail = value(); break;
      case "--check": opts.check = true; break;
      case "--quiet": opts.quiet = true; break;
      case "-h":
      case "--help": printUsage(); process.exit(0); break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* Source scanning primitives                                          */
/* ------------------------------------------------------------------ */

/**
 * Replace comments and string/char literals with spaces, preserving byte offsets
 * and newlines so line numbers computed on the result stay valid.
 */
function blankNonCode(src: string): string {
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}

function lineIndexAt(src: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type StructBlock = {
  name: string | null;
  startLine: number;
  bodyStart: number;
  bodyEnd: number;
};

/**
 * Collect `typedef struct <Tag>? { ... } <Decl>;` blocks.
 *
 * The declarator may list several names (`} PF_EventCallbacks,
 * *PF_EventCallbacksPtr;`); the first identifier is the struct name.
 */
function findStructBlocks(code: string, lineAt: (o: number) => number): StructBlock[] {
  const out: StructBlock[] = [];
  const re = /typedef\s+struct\s+([A-Za-z_]\w*)?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = re.lastIndex - 1;
    const close = matchBrace(code, open);
    if (close < 0) continue;
    const tail = code.slice(close + 1, close + 300);
    const tailName = /^\s*([A-Za-z_]\w*)?\s*(?:,|;)/.exec(tail);
    const name = m[1] ?? tailName?.[1] ?? null;
    out.push({ name, startLine: lineAt(m.index), bodyStart: re.lastIndex, bodyEnd: close });
    re.lastIndex = close + 1;
  }
  return out;
}

type EnumBlock = { startLine: number; bodyStart: number; bodyEnd: number };

function findEnumBlocks(code: string, lineAt: (o: number) => number): EnumBlock[] {
  const out: EnumBlock[] = [];
  const re = /(?:typedef\s+)?enum(?:\s+[A-Za-z_]\w*)?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = re.lastIndex - 1;
    const close = matchBrace(code, open);
    if (close < 0) continue;
    out.push({ startLine: lineAt(m.index), bodyStart: re.lastIndex, bodyEnd: close });
    re.lastIndex = close + 1;
  }
  return out;
}

type Named = { name: string; line: number; offset: number };

/** `Ret (*Name)(args)` — a function-pointer declarator. */
function findFunctionPointers(
  src: string,
  from: number,
  to: number,
  lineAt: (o: number) => number,
): Named[] {
  const out: Named[] = [];
  const segment = src.slice(from, to);
  const re = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    out.push({ name: m[1], line: lineAt(from + m.index), offset: from + m.index });
  }
  return out;
}

/** `typedef Ret (Name)(args)` — a function type without a star. */
function findFunctionTypes(
  src: string,
  from: number,
  to: number,
  lineAt: (o: number) => number,
): Named[] {
  const out: Named[] = [];
  const segment = src.slice(from, to);
  const re = /typedef\s+[^;{}()]*?\(\s*([A-Za-z_]\w*)\s*\)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    out.push({ name: m[1], line: lineAt(from + m.index), offset: from + m.index });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Direction signals                                                   */
/* ------------------------------------------------------------------ */

/**
 * Struct-name signals. Deliberately narrow: a name is used only to pick between
 * two non-unknown classes, and never to move something out of
 * unsupported-or-unknown without corroboration elsewhere in the same file.
 */
/** The host fills these and the plug-in calls into them. */
const HOST_PROC_TABLE = /(?:Hooks?|Callbacks?|Procs?|InterruptFuncs|HostProcs)$/;
/** The plug-in fills these and the host calls them in a documented order. */
const ENTRY_BLOCK = /(?:FunctionBlock\d*|EntryPoints?|PanelFunctions\d*)$/;

const SELECTOR_PREFIXES = ["PF_Cmd_", "PF_Event_"];

const ENTRY_POINT_WORDS = [
  /entry\s*point/i,
  /must be implemented by the plugin/i,
  /export the name of this function/i,
  /AE will call/i,
  /the host calls/i,
  /invoked by (?:after effects|the host|AE)\b/i,
  /signature that must be implemented/i,
];

const CALLBACK_WORDS = [
  /will be called/i,
  /call(?:ed)? (?:back|hook)/i,
  /callback function pointer/i,
  /provide[sd]? (?:a|the) callback/i,
];

/**
 * Version / PiPL declarations: the SDK's own API-version constants. These carry no
 * call direction, so they are build-test-lifecycle rather than a command. The
 * per-AE-release `PF_AE###_PLUG_IN_VERSION` family is included, not just the
 * current one, because a plug-in negotiates against the host with them.
 */
const VERSION_MACROS =
  /^(?:AEFX_API_VERSION|AEFX_API_SUBVERS|PF_PLUG_IN_VERSION|PF_PLUG_IN_SUBVERS|PF_AE\d+_PLUG_IN_VERSION|PF_AE\d+_PLUG_IN_SUBVERS)$/;

/* ------------------------------------------------------------------ */
/* Per-file extraction                                                 */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([".git", "__MACOSX"]);

function collectHeaderFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(h|hpp)$/i.test(entry)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Notice family at the top of a header. The SDK mixes several notice variants
 * (Adobe confidential, PICA-era proprietary, permissive, none), and the
 * distinction matters for what may be published.
 */
function noticeFamily(raw: string): string {
  const head = raw.slice(0, 4000).replace(/\s+/g, " ");
  if (/ADOBE CONFIDENTIAL/.test(head) && /strictly forbidden/.test(head)) {
    return "adobe-confidential-no-reproduction";
  }
  if (/permits you to use, modify, and distribute/.test(head)) return "adobe-permissive";
  if (/strictly forbidden/.test(head) || /CONFIDENTIAL/.test(head)) return "other-restrictive";
  if (/Copyright|copyright/.test(head)) return "other-copyright-only";
  return "no-notice";
}

function isDeprecatedHeader(header: string): boolean {
  return /Old\.h$/i.test(header);
}

type FileResult = {
  rows: SymbolRow[];
  notice: string;
  bytes: number;
  sha256: string;
};

function extractFile(
  absPath: string,
  root: string,
  globalSuiteMacros: ReadonlySet<string>,
): FileResult {
  const buf = readFileSync(absPath);
  const text = buf.toString("utf8");
  const header = relative(root, absPath).split(sep).join("/");
  const code = blankNonCode(text);
  const lineAt = lineIndexAt(code);
  const rows: SymbolRow[] = [];
  const deprecated = isDeprecatedHeader(header);

  const structs = findStructBlocks(code, lineAt);
  const enums = findEnumBlocks(code, lineAt);

  /** Registration macros: `#define kAEGPCompSuite "AEGP Comp Suite"`. */
  const suiteMacros: { ident: string; text: string }[] = [];
  {
    const re = /#\s*define\s+(k\w+)\s+"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) suiteMacros.push({ ident: m[1], text: m[2] });
  }

  const push = (row: SymbolRow): void => {
    if (deprecated) row.deprecatedHeader = true;
    rows.push(row);
  };
  const unknown = (
    base: Omit<SymbolRow, "class" | "rule" | "unknownReason">,
    reason: UnknownReason,
  ): void =>
    push({ ...base, class: "unsupported-or-unknown", unknownReason: reason, rule: `unknown:${reason}` });

  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  /**
   * Corroborate a suite struct with its registration macro by *identifier*, not by
   * prose. `AEGP_ColorSettingsSuite6` matches `kAEGPColorSettingsSuite` even
   * though that macro's string says "PF Color Settings Suite", and
   * `PF_AdvAppSuite1` matches `kPFAdvAppSuite` even though the string interleaves
   * "AE". Comparing identifier prefixes avoids both false negatives and the false
   * positives a token-similarity match would create inside a large header.
   *
   * Registration is resolved across the whole corpus, not per file: the deprecated
   * `*Old.h` headers restate suites whose `k...` macro is declared in the current
   * header, so a per-file lookup would wrongly report them as unregistered.
   */
  const suiteMacroFor = (structName: string): string | null => {
    const base = norm(structName.replace(/Suite\d*$/, ""));
    if (!base) return null;
    const local = suiteMacros.find((mac) => {
      const ident = norm(mac.ident.replace(/^k/, "").replace(/Suite$/, ""));
      return ident === base || ident.startsWith(base) || base.startsWith(ident);
    });
    if (local) return local.ident;
    for (const ident of globalSuiteMacros) {
      const n = norm(ident.replace(/^k/, "").replace(/Suite$/, ""));
      if (n === base || n.startsWith(base) || base.startsWith(n)) return ident;
    }
    return null;
  };

  const isSuiteName = (n: string | null): boolean => !!n && /Suite\d*$/.test(n);

  /* --- 1. suites and their slots ---------------------------------- */
  const suiteBlocks = structs.filter((b) => isSuiteName(b.name));
  const suiteBodyText = suiteBlocks.map((b) => code.slice(b.bodyStart, b.bodyEnd)).join("\n");

  for (const block of suiteBlocks) {
    const slots = findFunctionPointers(code, block.bodyStart, block.bodyEnd, lineAt);
    if (slots.length === 0) continue;
    const macro = suiteMacroFor(block.name!);
    const registered = macro !== null;
    push({
      kind: "suite",
      name: block.name!,
      header,
      line: block.startLine,
      class: "external-command",
      evidence: registered ? "suite-registration-string" : "none",
      rule: registered ? "suite+registration-string" : "suite-unregistered",
    });
    for (const slot of slots) {
      push({
        kind: "suite-slot",
        name: slot.name,
        header,
        line: slot.line,
        class: "external-command",
        evidence: registered ? "suite-registration-string" : "none",
        rule: registered ? "suite-slot+registration-string" : "suite-slot-unregistered",
      });
    }
  }

  /* --- 2. selectors ------------------------------------------------ */
  for (const e of enums) {
    const body = code.slice(e.bodyStart - 1, e.bodyEnd + 1);
    const prelude = code.slice(Math.max(0, e.bodyStart - 2000), e.bodyStart);
    const documented = /command selectors|sent to the effect|these command/i.test(prelude);
    const re = /([A-Za-z_]\w*)\s*(?:=[^,}]*)?(?:,|\})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const name = m[1];
      if (!SELECTOR_PREFIXES.some((p) => name.startsWith(p))) continue;
      const line = lineAt(e.bodyStart - 1 + m.index);
      if (/RESERVED|UNUSED/i.test(name)) {
        unknown({ kind: "selector", name, header, line, evidence: "none" }, "reserved-selector");
        continue;
      }
      push({
        kind: "selector",
        name,
        header,
        line,
        class: "in-host-plugin-command",
        evidence: documented ? "host-to-plugin-selector" : "none",
        rule: documented ? "selector-enum+documented-commands" : "selector-enum-undocumented",
      });
    }
  }

  /* --- 3. function-pointer blocks that are neither suites ---------- */
  /** Types consumed as a field by a host-owned procedure table. */
  const nestedInHostTable = new Set<string>();
  for (const block of structs) {
    if (!block.name || !HOST_PROC_TABLE.test(block.name) || isSuiteName(block.name)) continue;
    const body = code.slice(block.bodyStart, block.bodyEnd);
    const re = /\b([A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*(?:\[[^\]]*\])?\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) nestedInHostTable.add(m[1]);
  }

  for (const block of structs) {
    if (!block.name || isSuiteName(block.name)) continue;
    const slots = findFunctionPointers(code, block.bodyStart, block.bodyEnd, lineAt);
    if (slots.length === 0) continue;

    const hostTable = HOST_PROC_TABLE.test(block.name);
    const entryBlock = ENTRY_BLOCK.test(block.name);
    const nested = nestedInHostTable.has(block.name);
    for (const slot of slots) {
      if (hostTable || nested) {
        push({
          kind: "callback-slot",
          name: slot.name,
          header,
          line: slot.line,
          class: "host-callback",
          evidence: "host-invoked-callback",
          rule: hostTable ? `host-proc-table:${block.name}` : `nested-in-host-proc-table:${block.name}`,
        });
      } else if (entryBlock) {
        push({
          kind: "entry-point-slot",
          name: slot.name,
          header,
          line: slot.line,
          class: "in-host-plugin-command",
          evidence: "host-dispatches-entry-point",
          rule: `entry-block:${block.name}`,
        });
      } else {
        unknown(
          { kind: "callback-slot", name: slot.name, header, line: slot.line, evidence: "none" },
          "unattributed-callable",
        );
      }
    }
  }

  /* --- 4. function typedefs --------------------------------------- */
  const inStructOffset = (offset: number): boolean =>
    structs.some((b) => offset > b.bodyStart && offset < b.bodyEnd);

  const fnPtrs = findFunctionPointers(code, 0, code.length, lineAt).filter(
    (f) => !inStructOffset(f.offset),
  );
  const fnTypes = findFunctionTypes(code, 0, code.length, lineAt).filter(
    (f) => !inStructOffset(f.offset),
  );

  /**
   * Typedef name -> the struct block that holds a field of that type. This is the
   * main structural signal for typedef'd callables: the block that consumes a
   * type tells us who invokes it. Fields may terminate with `,` or `;`.
   */
  const fieldOwner = new Map<string, string>();
  for (const block of structs) {
    if (!block.name) continue;
    const body = code.slice(block.bodyStart, block.bodyEnd);
    const re = /\b([A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*(?:\[[^\]]*\])?\s*[,;]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) if (!fieldOwner.has(m[1])) fieldOwner.set(m[1], block.name);
  }

  /** Types handed to the host as a suite call argument (registered, later invoked). */
  const passedToHostViaSuite = (name: string): boolean =>
    new RegExp(`\\b${name}\\b`).test(suiteBodyText);

  /**
   * Nearest preceding comment block with prose, used only as supporting evidence.
   * Consecutive `//` lines and separator banners are coalesced, because a
   * prototype's describing sentence is often the first line of a multi-line
   * banner rather than the line immediately above it.
   */
  const nearestComment = (offset: number): string => {
    const before = text.slice(0, offset);
    const cms = [...before.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)];
    const prose: string[] = [];
    for (let i = cms.length - 1; i >= 0; i--) {
      const raw = cms[i][0];
      // Stop once a blank line separates us from the declaration.
      const gap = before.slice(cms[i].index! + raw.length, i === cms.length - 1 ? offset : cms[i + 1].index!);
      const text_ = raw.replace(/^\/[/*]+|\*+\/$/g, "").trim();
      const separator = /^[/=*\-_\s]*$/.test(text_);
      if (i === cms.length - 1 && /\n\s*\n/.test(gap) && prose.length > 0) break;
      if (!separator) prose.unshift(text_);
      if (/\n\s*\n/.test(gap) && prose.length > 0) break;
    }
    return prose.join(" ");
  };

  for (const f of [...fnPtrs, ...fnTypes]) {
    const owner = fieldOwner.get(f.name);
    const comment = nearestComment(f.offset);

    // Structural first: who holds this type decides who calls it.
    if (owner) {
      if (isSuiteName(owner) || HOST_PROC_TABLE.test(owner)) {
        push({
          kind: "callback-type",
          name: f.name,
          header,
          line: f.line,
          class: "host-callback",
          evidence: "host-invoked-callback",
          rule: isSuiteName(owner) ? `slot-type-of-suite:${owner}` : `host-proc-table:${owner}`,
        });
        continue;
      }
      if (ENTRY_BLOCK.test(owner)) {
        push({
          kind: "entry-point",
          name: f.name,
          header,
          line: f.line,
          class: "in-host-plugin-command",
          evidence: "host-dispatches-entry-point",
          rule: `entry-block:${owner}`,
        });
        continue;
      }
    }

    // A hook type the plug-in passes into a suite registration call; the host
    // stores it and invokes it later.
    if (passedToHostViaSuite(f.name)) {
      push({
        kind: "callback-type",
        name: f.name,
        header,
        line: f.line,
        class: "host-callback",
        evidence: "host-invoked-callback",
        rule: "registered-with-host-via-suite",
      });
      continue;
    }

    if (ENTRY_POINT_WORDS.some((re) => re.test(comment))) {
      push({
        kind: "entry-point",
        name: f.name,
        header,
        line: f.line,
        class: "in-host-plugin-command",
        evidence: "host-dispatches-entry-point",
        rule: "prototype+entry-point-comment",
      });
      continue;
    }
    if (CALLBACK_WORDS.some((re) => re.test(comment))) {
      push({
        kind: "callback-type",
        name: f.name,
        header,
        line: f.line,
        class: "host-callback",
        evidence: "host-invoked-callback",
        rule: "prototype+callback-comment",
      });
      continue;
    }
    unknown(
      { kind: "callback-type", name: f.name, header, line: f.line, evidence: "none" },
      "unattributed-callable",
    );
  }

  /* --- 5. version / PiPL macros ----------------------------------- */
  {
    const re = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      if (!VERSION_MACROS.test(m[1])) continue;
      push({
        kind: "version-or-pipl",
        name: m[1],
        header,
        line: lineAt(m.index),
        class: "build-test-lifecycle",
        evidence: "version-or-pipl-declaration",
        rule: "version-macro",
      });
    }
  }

  /* --- 6. remaining named data types ------------------------------ */
  const emitted = new Set(rows.map((r) => r.name));
  for (const block of structs) {
    if (!block.name || isSuiteName(block.name) || emitted.has(block.name)) continue;
    unknown(
      { kind: "type", name: block.name, header, line: block.startLine, evidence: "none" },
      "pure-data-type",
    );
  }
  {
    const re = /typedef\s+(?!struct\b|enum\b|union\b)[^;{}]*?\b([A-Za-z_]\w*)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const name = m[1];
      if (/\(\s*\*/.test(m[0])) continue;
      if (fnTypes.some((f) => f.name === name) || emitted.has(name)) continue;
      unknown(
        { kind: "type", name, header, line: lineAt(m.index), evidence: "none" },
        "pure-data-type",
      );
    }
  }

  return {
    rows,
    notice: noticeFamily(text),
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

function emptyCounts(keys: readonly string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of [...keys].sort()) o[k] = 0;
  return o;
}

type FileMeta = { header: string; bytes: number; sha256: string; notice: string };

function buildAggregate(
  rows: SymbolRow[],
  files: FileMeta[],
  release: string,
  headersRootName: string,
) {
  const byClass = emptyCounts(CLASSES);
  const byKind = emptyCounts(KINDS);
  const byEvidence = emptyCounts(EVIDENCES);
  const unknownByReason = emptyCounts(UNKNOWN_REASONS);
  /**
   * Rule tallies are aggregated by rule *family* only. The detailed rule string
   * carries the declaring struct name (for example a specific suite or callback
   * table), which is symbol-level content and must not be published.
   */
  const byRuleFamily: Record<string, number> = {};

  for (const r of rows) {
    byClass[r.class]++;
    byKind[r.kind]++;
    byEvidence[r.evidence]++;
    const family = r.rule.split(":")[0];
    byRuleFamily[family] = (byRuleFamily[family] ?? 0) + 1;
    if (r.class === "unsupported-or-unknown" && r.unknownReason) unknownByReason[r.unknownReason]++;
  }

  const perHeader = files
    .map((f) => {
      const own = rows.filter((r) => r.header === f.header);
      const c = emptyCounts(CLASSES);
      for (const r of own) c[r.class]++;
      return {
        path: f.header,
        bytes: f.bytes,
        sha256: f.sha256,
        notice: f.notice,
        symbols: own.length,
        byClass: c,
        unknown: c["unsupported-or-unknown"],
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const sortedRules: Record<string, number> = {};
  for (const k of Object.keys(byRuleFamily).sort()) sortedRules[k] = byRuleFamily[k];

  return {
    schema: "ae-devtools.sdk-inventory.aggregate/v0-provisional",
    schemaStatus: "provisional",
    catalogContract:
      "Provisional shapes only. The final capability-ID grammar and catalog schema are owned by issue #11 and are not fixed here.",
    redistribution: {
      headersNotice:
        "Headers carry an 'ADOBE CONFIDENTIAL ... reproduction of this material is strictly forbidden' notice; the SDK package ships no license, EULA or readme grant.",
      licenseFileInPackage: false,
      committedContent:
        "Aggregate counts, per-header hashes and provenance only. No symbol identifiers, no header text, no struct layouts.",
      detailContent:
        "Per-symbol rows are generated locally into a git-ignored path and are never published. Reproducing the symbol list requires the operator's own licensed SDK.",
    },
    release: { identifier: release, distribution: "macOS", headersRoot: headersRootName },
    coverageSemantics: {
      denominatorDefinition:
        "Every callable, registrable or declarable symbol the headers expose: suites, suite slots, selectors, entry-point prototypes and blocks, callback types and slots, version/PiPL declarations, and named data types. Named data types stay in the denominator and are counted as unsupported-or-unknown/pure-data-type so the total is never silently shrunk.",
      classificationNote:
        "Classes come from declaration context, not identifier spelling. Suite membership plus a registration-string macro yields external-command; selector and entry-point wiring yields in-host-plugin-command; host procedure tables and prototypes registered with the host yield host-callback. Anything the headers do not attribute stays unknown.",
      classes: [...CLASSES],
      kinds: [...KINDS],
    },
    totals: {
      headerFilesParsed: perHeader.length,
      headerFilesPresent: perHeader.length,
      headersAtTopLevel: perHeader.filter((h) => !h.path.includes("/")).length,
      symbols: rows.length,
      byClass,
      unknown: byClass["unsupported-or-unknown"],
      unknownByReason,
      byKind,
      byEvidence,
      byRuleFamily: sortedRules,
      deprecatedHeaderSymbols: rows.filter((r) => r.deprecatedHeader).length,
    },
    perHeader,
    denominatorCaveats: [
      "The count is the number of symbol rows this extractor can attribute structurally. It is not a claim that the SDK's public surface is fully enumerated.",
      "unsupported-or-unknown is dominated by plain data types, which have no call direction to classify. It is not a count of missing callables.",
      "Headers marked deprecated (the *Old.h variants) do not reduce the denominator; their symbols are counted in their functional class and flagged separately.",
      "Classification is rule-based and provisional. Rule tallies are reported so a reviewer can see exactly which rule produced each class.",
      "No behavioural claim about any AE build is implied. Nothing here was executed against After Effects.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.headers) {
    printUsage();
    throw new Error("--headers is required");
  }
  const headersRoot = resolve(opts.headers);
  if (!statSync(headersRoot).isDirectory()) throw new Error(`not a directory: ${headersRoot}`);

  const release = opts.release ?? "26.5";
  const outAggregate = opts.outAggregate ?? "inventories/sdk/generated/aggregate.json";
  const outDetail = opts.outDetail ?? "inventories/sdk/.local/symbols.json";

  const files = collectHeaderFiles(headersRoot);

  // Suite registration macros are resolved corpus-wide: deprecated headers restate
  // suites whose `k...` macro is declared in the current header.
  const globalSuiteMacros = new Set<string>();
  for (const abs of files) {
    const t = readFileSync(abs, "utf8");
    const re = /#\s*define\s+(k\w+)\s+"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) globalSuiteMacros.add(m[1]);
  }

  const rows: SymbolRow[] = [];
  const fileMeta: FileMeta[] = [];

  for (const abs of files) {
    const r = extractFile(abs, headersRoot, globalSuiteMacros);
    fileMeta.push({
      header: relative(headersRoot, abs).split(sep).join("/"),
      bytes: r.bytes,
      sha256: r.sha256,
      notice: r.notice,
    });
    rows.push(...r.rows);
  }

  rows.sort((a, b) => {
    if (a.header !== b.header) return a.header < b.header ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  const aggregate = buildAggregate(rows, fileMeta, release, headersRoot.split(sep).pop()!);

  const provenance = {
    schema: "ae-devtools.sdk-inventory.provenance/v0-provisional",
    schemaStatus: "provisional",
    release,
    distribution: "macOS",
    acquisition: {
      method:
        "Adobe-distributed After Effects SDK archive, obtained by the operator and supplied locally. The repository never vendors the SDK.",
      archiveSha256: opts.zip ? sha256File(resolve(opts.zip)) : null,
    },
    license: {
      licenseFileInPackage: false,
      searchedFor: ["licen*", "eula", "readme", "notice", "terms", "copying", "*.txt"],
      finding:
        "The SDK archive contains no license, EULA, readme or notice text file. The only documents are two PDFs that redirect to the public documentation site.",
      headerNoticeFamilies: fileMeta.reduce<Record<string, number>>((acc, f) => {
        acc[f.notice] = (acc[f.notice] ?? 0) + 1;
        return acc;
      }, {}),
      conclusion:
        "No grant to redistribute header content was found. Committed output is therefore restricted to aggregate counts, hashes and provenance.",
    },
    corpus: {
      headerFiles: fileMeta.length,
      byExtension: fileMeta.reduce<Record<string, number>>((acc, f) => {
        const ext = f.header.slice(f.header.lastIndexOf("."));
        acc[ext] = (acc[ext] ?? 0) + 1;
        return acc;
      }, {}),
      totalBytes: fileMeta.reduce((s, f) => s + f.bytes, 0),
      combinedSha256: createHash("sha256")
        .update(fileMeta.map((f) => `${f.header}:${f.sha256}`).sort().join("\n"))
        .digest("hex"),
    },
    hashes: {
      algorithm: "sha256",
      headerCount: fileMeta.length,
      note: "Per-header hashes are recorded in aggregate.json perHeader[].sha256.",
    },
  };

  if (opts.check) {
    const existing = readFileSync(resolve(outAggregate), "utf8");
    if (existing !== stableStringify(aggregate)) {
      console.error("NOT IDEMPOTENT: committed aggregate differs from a fresh run.");
      process.exit(1);
    }
    if (!opts.quiet) console.error(`idempotent: ${outAggregate} matches a fresh run`);
    return;
  }

  mkdirSync(dirname(resolve(outAggregate)), { recursive: true });
  writeFileSync(resolve(outAggregate), stableStringify(aggregate));

  mkdirSync(dirname(resolve(outDetail)), { recursive: true });
  writeFileSync(
    resolve(outDetail),
    stableStringify({
      schema: "ae-devtools.sdk-inventory.detail/v0-provisional",
      warning:
        "LOCAL ONLY. Contains symbol identifiers derived from ADOBE CONFIDENTIAL headers. Do not commit or publish.",
      release,
      symbols: rows,
    }),
  );

  if (!opts.quiet) {
    const t = aggregate.totals;
    console.error(
      [
        `headers parsed      : ${t.headerFilesParsed}`,
        `symbols (denominator): ${t.symbols}`,
        ...CLASSES.map((c) => `  ${c.padEnd(22)}: ${t.byClass[c]}`),
        `unknown             : ${t.unknown}`,
        ...Object.entries(t.unknownByReason).map(([k, v]) => `  ${k.padEnd(22)}: ${v}`),
      ].join("\n"),
    );
  }

  // Provenance is written next to the aggregate so a reviewer can audit CAP009
  // without running the extractor.
  if (opts.outAggregate) {
    writeFileSync(resolve(outAggregate.replace(/aggregate\.json$/, "provenance.json")), stableStringify(provenance));
  }
}

if (import.meta.main) main();

export {
  CLASSES,
  KINDS,
  blankNonCode,
  lineIndexAt,
  matchBrace,
  findStructBlocks,
  findEnumBlocks,
  findFunctionPointers,
  findFunctionTypes,
  noticeFamily,
  isDeprecatedHeader,
  buildAggregate,
  type SymbolClass,
  type SymbolKind,
  type SymbolRow,
};
