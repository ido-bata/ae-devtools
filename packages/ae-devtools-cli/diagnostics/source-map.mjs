/**
 * source-map.mjs — diagnostics record → original TypeScript position
 * (Issue #37, CAP064 groundwork).
 *
 * When ExtendScript inside AE reports an error at a generated JSX
 * `{line, column}`, this module maps that position back through the
 * Source Map v3 artifacts emitted by `packages/ae-devtools-cli/jsx-toolchain`:
 *
 *   single-file `build`        : <name>.jsx.map            (jsx → TS, one hop)
 *   project `build-project`    : <name>.jsx.map            (jsx → bundle)
 *                              + <name>.bundle.js.map     (bundle → TS, two hops)
 *
 * The VLQ/mapping consumer is imported from jsx-toolchain
 * (`../jsx-toolchain/src/sourcemap.mjs`, `lookup`) — it is deliberately
 * NOT copied. The two-hop composition mirrors `resolvePosition` in
 * `../jsx-toolchain/src/bundle.mjs`; that module cannot be imported here
 * because it pulls in esbuild/typescript, which the diagnostics test
 * suite does not need at runtime beyond the dependency-free `lookup`.
 *
 * Honesty rules — a position is never guessed:
 *   - no map file found              → status "no-map"
 *   - map found, position unmapped   → status "unmapped"
 *   - record carries no usable line  → status "no-position"
 *   - map JSON malformed             → status "invalid-map"
 *   - multiple candidate maps        → status "ambiguous"
 * The `excerpt` field comes only from the map's own `sourcesContent`;
 * it stays null when the map does not carry source text.
 *
 * Column convention: the diagnostics schema's `source.column` is a
 * positive integer, i.e. 1-based; generated-map columns are 0-based
 * (sourcemap/ExtendScript convention). This module converts at the
 * boundary: record/CLI columns are 1-based, `resolveGeneratedPosition`
 * takes the 0-based form `lookup` expects.
 *
 * Node >= 22, zero dependencies of its own.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { isMainEntry } from "../devtools-cli/is-main-entry.mjs";
import { lookup, parseMappings } from "../jsx-toolchain/src/sourcemap.mjs";

export const SOURCE_MAP_RESULT_SCHEMA = "ae-devtools.diagnostics.source-map/v1";

export class SourceMapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceMapError";
  }
}

const JSX_MAP_SUFFIX = ".jsx.map";
const BUNDLE_MAP_SUFFIX = ".bundle.js.map";

/**
 * Strip known artifact/map suffixes to get the artifact stem used for
 * map-directory disambiguation. Handles the compound forms a caller can
 * hand us: `probe.bundle.js`, `probe.bundle.js.map`, `probe.jsx.map`,
 * `probe.jsx`, `probe.js`, `probe.map` — all reduce to `probe`.
 */
function artifactStem(name) {
  let s = String(name);
  s = s.replace(/\.bundle\.js(\.map)?$/, "");
  s = s.replace(/\.jsx\.map$/, "");
  s = s.replace(/\.(jsx?|tsx?|map)$/, "");
  return s;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Load and sanity-check a Source Map v3 JSON file. */
export function loadSourceMap(mapPath) {
  let raw;
  try {
    raw = readFileSync(mapPath, "utf8");
  } catch (e) {
    throw new SourceMapError(`cannot read map ${mapPath}: ${e.message}`);
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    throw new SourceMapError(`map ${mapPath} is not valid JSON: ${e.message}`);
  }
  if (!isPlainObject(map) || map.version !== 3 || typeof map.mappings !== "string" || !Array.isArray(map.sources)) {
    throw new SourceMapError(`map ${mapPath} is not a Source Map v3 document`);
  }
  return map;
}

/** Extract the 1-based line's text from `sourcesContent`, or null. */
export function excerptFromContent(content, line) {
  if (typeof content !== "string" || !Number.isInteger(line) || line < 1) return null;
  const rows = content.split("\n");
  if (line > rows.length) return null;
  const text = rows[line - 1].trim();
  return text.length > 0 ? text : null;
}

/** Strip `sourcesContent` (potentially large) from a lookup result. */
function hopView(pos) {
  if (pos === null) return null;
  return {
    source: pos.source ?? null,
    line: pos.line ?? null,
    column: pos.column ?? null,
    name: pos.name ?? null,
  };
}

/**
 * Locate the map pair for a build artifact.
 *
 * `target` may be:
 *   - a `.jsx` artifact path        → sibling `<name>.jsx.map`
 *   - a `.jsx.map` path             → used directly
 *   - a `.bundle.js[.map]` path     → derives the sibling jsx map
 *   - a directory                   → discovers `*.jsx.map` inside;
 *     `preferName` (artifact basename, extension optional) disambiguates
 *   - an output prefix (no ext)     → tries `<prefix>.jsx.map`, `<prefix>.map`
 *
 * Returns one of:
 *   { status: "ok", jsxMapPath, bundleMapPath|null }
 *   { status: "none" }
 *   { status: "ambiguous", candidates: [...] }
 */
export function locateMapFiles(target, { preferName = null } = {}) {
  if (typeof target !== "string" || target.length === 0) return { status: "none" };
  const abs = resolve(target);

  // Given a jsx map path, attach the project-mode bundle map when the
  // sibling exists (build-project emits <name>.jsx.map +
  // <name>.bundle.js.map; single-file build emits only the former).
  const pair = (jsxMapPath) => {
    if (!existsSync(jsxMapPath)) return null;
    let bundleMapPath = null;
    if (jsxMapPath.endsWith(JSX_MAP_SUFFIX)) {
      const cand = jsxMapPath.slice(0, -JSX_MAP_SUFFIX.length) + BUNDLE_MAP_SUFFIX;
      if (existsSync(cand)) bundleMapPath = cand;
    }
    return { status: "ok", jsxMapPath, bundleMapPath };
  };

  if (abs.endsWith(JSX_MAP_SUFFIX)) return pair(abs) ?? { status: "none" };
  if (abs.endsWith(".jsx")) return pair(`${abs}.map`) ?? { status: "none" };
  if (abs.endsWith(BUNDLE_MAP_SUFFIX)) {
    const jsxMap = abs.slice(0, -BUNDLE_MAP_SUFFIX.length) + JSX_MAP_SUFFIX;
    return pair(jsxMap) ?? { status: "none" };
  }
  if (abs.endsWith(".bundle.js")) {
    const bundleMap = `${abs}.map`;
    if (!existsSync(bundleMap)) return { status: "none" };
    return pair(bundleMap.slice(0, -".map".length - ".bundle.js".length) + JSX_MAP_SUFFIX) ?? { status: "none" };
  }
  if (abs.endsWith(".map")) return pair(abs) ?? { status: "none" };

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    const candidates = readdirSync(abs)
      .filter((f) => f.endsWith(JSX_MAP_SUFFIX))
      .sort()
      .map((f) => join(abs, f));
    if (candidates.length === 0) return { status: "none" };
    if (preferName) {
      const stem = artifactStem(preferName);
      const match = candidates.filter((p) => basename(p, JSX_MAP_SUFFIX) === stem);
      if (match.length === 1) return pair(match[0]) ?? { status: "none" };
      if (match.length > 1) return { status: "ambiguous", candidates: match };
    }
    if (candidates.length === 1) return pair(candidates[0]) ?? { status: "none" };
    return { status: "ambiguous", candidates };
  }

  // Not an existing path: try it as an output prefix.
  for (const cand of [`${abs}.jsx.map`, `${abs}.map`]) {
    const r = pair(cand);
    if (r) return r;
  }
  return { status: "none" };
}

// Reuse the same parse cache lookup() populates on the map object —
// a line-only query would otherwise parse the mappings twice.
function segmentsFor(map, line) {
  const lines = map.__parsed ?? (map.__parsed = parseMappings(map));
  return lines[line - 1] ?? [];
}

/** First mapped segment's generated column on a line, or null. */
function firstMappedColumn(map, line) {
  for (const s of segmentsFor(map, line)) {
    if (s.src !== undefined) return s.genCol;
  }
  return null;
}

/**
 * Map one generated JSX position to its original source position.
 *
 * `line` is 1-based; `column` is 0-based (the `lookup` convention).
 * ExtendScript host errors normally carry a line and NO column; pass
 * `columnSpecified: false` for that case and the resolver uses the
 * line-granularity policy: the first mapped segment on the generated
 * line. That is a real mapping, not a guess — the effective column is
 * recorded in `hops`, and an honestly unmapped line stays "unmapped".
 * An explicit column that misses every segment stays "unmapped" too;
 * there is no silent fallback for caller-supplied columns.
 *
 * With `bundleMap` this performs the two-hop jsx→bundle→TS lookup;
 * without it, a single jsx→TS hop.
 *
 * Returns { status: "mapped"|"unmapped", original, hops } where `hops`
 * records each map traversal (content stripped). Output convention:
 * `original.line` is 1-based; `original.column` is 0-based (raw Source
 * Map convention — the same parity as jsx-toolchain's resolvePosition).
 * `original.excerpt`/`contentAvailable` come only from the map's own
 * `sourcesContent`.
 */
export function resolveGeneratedPosition({ jsxMap, bundleMap = null, line, column = 0, columnSpecified = true }) {
  let genCol = column;
  if (!columnSpecified) {
    const first = firstMappedColumn(jsxMap, line);
    if (first === null) {
      return {
        status: "unmapped",
        original: null,
        hops: [{ map: "jsx", generated: { line, column: null }, original: null }],
      };
    }
    genCol = first;
  }
  const hops = [];
  const mid = lookup(jsxMap, line, genCol);
  hops.push({ map: "jsx", generated: { line, column: genCol }, original: hopView(mid) });
  if (mid === null) {
    return { status: "unmapped", original: null, hops };
  }
  if (bundleMap === null) {
    return {
      status: "mapped",
      original: {
        file: mid.source ?? null,
        line: mid.line,
        column: mid.column,
        name: mid.name ?? null,
        excerpt: excerptFromContent(mid.content, mid.line),
        contentAvailable: mid.content !== null,
      },
      hops,
    };
  }
  const orig = lookup(bundleMap, mid.line, mid.column ?? 0);
  hops.push({
    map: "bundle",
    generated: { line: mid.line, column: mid.column ?? 0 },
    original: hopView(orig),
  });
  if (orig === null) {
    return { status: "unmapped", original: null, hops };
  }
  return {
    status: "mapped",
    original: {
      file: orig.source ?? null,
      line: orig.line,
      column: orig.column,
      name: orig.name ?? null,
      excerpt: excerptFromContent(orig.content, orig.line),
      contentAvailable: orig.content !== null,
      via: {
        jsx: { line, column: genCol },
        bundle: { line: mid.line, column: mid.column ?? 0 },
      },
    },
    hops,
  };
}

function emptyResult(record) {
  return {
    schema: SOURCE_MAP_RESULT_SCHEMA,
    record: isPlainObject(record)
      ? { kind: record.kind ?? null, collector: record.collector ?? null }
      : null,
    generated: null,
    maps: { jsx: null, bundle: null },
    original: null,
    status: "no-position",
    reason: null,
  };
}

/**
 * Resolve a diagnostics record's `source` block to the original TS
 * position. Options:
 *   jsxPath / mapDir / jsxMapPath / bundleMapPath — explicit artifact or
 *     map locations; `jsxMap` / `bundleMap` — pre-parsed map objects.
 *     Explicit map options are authoritative: when a jsx map is supplied
 *     explicitly, artifact discovery is skipped entirely (the record's
 *     source.path is often a host-side path absent on this machine).
 *   preferName — artifact basename used to disambiguate map directories.
 *
 * Never throws for expected data problems; returns a result object with
 * an honest `status`.
 */
export function resolveDiagnosticsSource(record, opts = {}) {
  const base = emptyResult(record);

  if (!isPlainObject(record) || !isPlainObject(record.source)) {
    base.reason = "record has no source block";
    return base;
  }
  const source = record.source;
  // CAP064 scope: only jsx-script positions have a source-map path today
  // (panel-asset consumers are still pending). plugin-binary positions
  // come from native code with no symbol source — there is nothing a
  // Source Map v3 lookup could resolve, so report unsupported-with-reason
  // instead of pretending map discovery ran.
  if (source.assetKind === "plugin-binary") {
    base.status = "unsupported-with-reason";
    base.reason =
      "plugin-binary positions have no symbol source; native plugin offsets cannot be mapped to source";
    return base;
  }
  if (!Number.isInteger(source.line) || source.line < 1) {
    base.reason = "record source has no usable line";
    return base;
  }
  const hasColumn = Number.isInteger(source.column) && source.column >= 1;
  const genCol0 = hasColumn ? source.column - 1 : 0;
  base.generated = {
    file: typeof source.path === "string" ? source.path : null,
    line: source.line,
    // echoed back in the record's 1-based convention; null when the
    // record carried no column (we do not invent one)
    column: hasColumn ? source.column : null,
  };

  // --- locate the maps -------------------------------------------------
  // Explicit map options are AUTHORITATIVE: when the caller supplies
  // jsxMap/jsxMapPath (and optionally bundleMap/bundleMapPath), discovery
  // is skipped entirely — the record's source.path is often a host-side
  // path that does not exist on this machine, and a failed discovery
  // must not veto maps the caller explicitly provided.
  const explicitJsxMap = isPlainObject(opts.jsxMap);
  const explicitJsxPath = typeof opts.jsxMapPath === "string" && opts.jsxMapPath.length > 0;
  const attempted = [];

  let jsxMapPath = explicitJsxPath ? resolve(opts.jsxMapPath) : null;
  let bundleMapPath =
    typeof opts.bundleMapPath === "string" && opts.bundleMapPath.length > 0
      ? resolve(opts.bundleMapPath)
      : null;

  if (!explicitJsxMap && !explicitJsxPath) {
    const candidates = [];
    if (typeof opts.jsxPath === "string") candidates.push(opts.jsxPath);
    if (typeof source.path === "string" && source.path.length > 0) {
      if (typeof opts.mapDir === "string") {
        candidates.push(join(opts.mapDir, basename(source.path)));
        candidates.push(join(opts.mapDir, source.path));
      }
      candidates.push(source.path);
    }
    // mapDir itself is a discovery target: an AE-reported file name may
    // not match the artifact path layout, so fall back to scanning it.
    if (typeof opts.mapDir === "string") {
      candidates.push(opts.mapDir);
    }
    if (candidates.length === 0) {
      base.status = "no-map";
      base.reason = "no artifact path on the record and no jsxPath/mapDir/jsxMap option";
      return base;
    }

    const preferName =
      opts.preferName ??
      (typeof source.path === "string" ? artifactStem(basename(source.path)) : null);

    let located = null;
    for (const cand of candidates) {
      const r = locateMapFiles(cand, { preferName });
      attempted.push({ target: cand, result: r.status });
      if (r.status === "ok") { located = r; break; }
      if (r.status === "ambiguous" && located === null) located = { ambiguous: r };
    }
    if (located === null) {
      base.status = "no-map";
      base.reason = `no .jsx.map found for: ${candidates.join(", ")}`;
      base.attempts = attempted;
      return base;
    }
    if (located.ambiguous) {
      base.status = "ambiguous";
      base.reason = "multiple .jsx.map candidates; pass jsxPath or preferName to disambiguate";
      base.candidates = located.ambiguous.candidates;
      return base;
    }

    jsxMapPath = located.jsxMapPath;
    if (bundleMapPath === null) bundleMapPath = located.bundleMapPath;
  } else if (bundleMapPath === null && jsxMapPath !== null) {
    // Explicit jsx map path without an explicit bundle map: still
    // pair-discover the project bundle-map sibling (build-project emits
    // <name>.bundle.js.map next to <name>.jsx.map).
    const r = locateMapFiles(jsxMapPath);
    attempted.push({ target: jsxMapPath, result: r.status });
    if (r.status === "ok") bundleMapPath = r.bundleMapPath;
  }

  base.maps.jsx = jsxMapPath;
  base.maps.bundle = bundleMapPath;
  if (attempted.length > 0) base.attempts = attempted;

  let jsxMap;
  let bundleMap = null;
  try {
    jsxMap = explicitJsxMap ? opts.jsxMap : loadSourceMap(jsxMapPath);
    if (isPlainObject(opts.bundleMap)) {
      bundleMap = opts.bundleMap;
    } else if (bundleMapPath !== null) {
      bundleMap = loadSourceMap(bundleMapPath);
    }
    // resolveGeneratedPosition parses mappings lazily — a syntactically
    // valid but undecodable VLQ payload throws a plain Error, which must
    // surface as invalid-map, not an uncaught exception.
    const res = resolveGeneratedPosition({
      jsxMap,
      bundleMap,
      line: source.line,
      column: genCol0,
      columnSpecified: hasColumn,
    });
    base.status = res.status;
    base.original = res.original;
    base.hops = res.hops;
    if (res.status === "unmapped") {
      base.reason = "map found but the generated position is not covered by any mapping";
    }
  } catch (e) {
    base.status = "invalid-map";
    base.reason = e.message;
  }
  return base;
}

// ---------------------------------------------------------------------
// CLI:
//   node source-map.mjs <record.json> [--jsx p] [--map-dir d]
//                        [--jsx-map p|--map p] [--bundle-map p]
//   node source-map.mjs --jsx file.jsx --line N [--col N]
//                        [--jsx-map p|--map p] [--bundle-map p] [--map-dir d]
// --col is 1-based like the diagnostics record column.
// Exit: 0 mapped, 1 not mapped, 2 usage/io error. JSON on stdout.
// ---------------------------------------------------------------------
const VALUE_FLAGS = new Set([
  "--jsx", "--line", "--col", "--jsx-map", "--map", "--bundle-map", "--map-dir",
]);

function cliMain(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      flags[a] = args[i + 1];
      i++;
    } else if (a.startsWith("-")) {
      console.error(`unknown flag ${a}`);
      return 2;
    } else {
      positional.push(a);
    }
  }

  const shared = {
    jsxPath: flags["--jsx"],
    mapDir: flags["--map-dir"],
    jsxMapPath: flags["--jsx-map"] ?? flags["--map"],
    bundleMapPath: flags["--bundle-map"],
  };

  let result;
  if (flags["--jsx"] !== undefined || flags["--line"] !== undefined) {
    if (flags["--jsx"] === undefined || flags["--line"] === undefined) {
      console.error("usage: --jsx <file> --line <N> [--col <N>] [--jsx-map p] [--bundle-map p] [--map-dir d]");
      return 2;
    }
    const line = Number(flags["--line"]);
    if (!Number.isInteger(line) || line < 1) {
      console.error("--line must be a positive integer");
      return 2;
    }
    const col = flags["--col"] === undefined ? undefined : Number(flags["--col"]);
    if (flags["--col"] !== undefined && (!Number.isInteger(col) || col < 1)) {
      console.error("--col must be a positive integer");
      return 2;
    }
    result = resolveDiagnosticsSource(
      {
        kind: "script-exception",
        source: {
          assetKind: "jsx-script",
          path: flags["--jsx"],
          line,
          ...(col !== undefined ? { column: col } : {}),
        },
      },
      shared,
    );
  } else if (positional.length === 1) {
    let record;
    try {
      record = JSON.parse(readFileSync(positional[0], "utf8"));
    } catch (e) {
      console.error(`cannot read record ${positional[0]}: ${e.message}`);
      return 2;
    }
    result = resolveDiagnosticsSource(record, shared);
  } else {
    console.error("usage: source-map.mjs <record.json> | --jsx <file> --line <N> [--col <N>]");
    return 2;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.status === "mapped" ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = cliMain(process.argv);
}
