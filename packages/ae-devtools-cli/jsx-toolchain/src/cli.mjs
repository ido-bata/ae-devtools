#!/usr/bin/env node
/**
 * cli.mjs — jsx-toolchain CLI (Issue #52).
 *
 *   jsx-toolchain lint <file.ts>             ES3-compat lint (AST-based source lint)
 *   jsx-toolchain build <file.ts> [-o dir]   single-file -> ES3 JSX + map
 *   jsx-toolchain build-project <entry> [-o dir] [--name n]
 *                                          multi-file -> bundled ES3 JSX
 *                                          + jsx.map + bundle.js.map
 *   jsx-toolchain check <file|dir|entry>     typecheck vs ae-api.d.ts
 *   jsx-toolchain watch <entry> [-o dir] [--name n]
 *                                          rebuild on change; one JSON
 *                                          status line per build on stdout
 *   jsx-toolchain map <file.jsx.map> <line> [col]
 *                                          generated -> bundle position
 *   jsx-toolchain resolve <dir|prefix> <line> [col]
 *                                          jsx position -> original TS
 *                                          (two-hop through both maps)
 *
 * Exit codes: 0 ok, 1 diagnostics with errors, 2 usage/io error.
 * Output is JSON on stdout for machine consumption.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildFile, buildProject } from "./build.mjs";
import { checkFile, checkProject } from "./check.mjs";
import { lintSource, hasErrors } from "./es3-lint.mjs";
import { lookup } from "./sourcemap.mjs";
import { resolvePosition } from "./bundle.mjs";
import { arg } from "../../devtools-cli/argv.mjs";

const [cmd, ...args] = process.argv.slice(2);

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

// Options that consume the following argument as their value. The file
// operand must skip both the flag AND its value, or `-o dist main.ts`
// would resolve the entry to "dist".
const VALUE_OPTIONS = new Set(["-o", "--name"]);

function positionalArgs() {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_OPTIONS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

function needFile() {
  const f = positionalArgs()[0];
  if (!f) { console.error("missing file argument"); process.exit(2); }
  return f;
}

function outDirArg() {
  const oi = args.indexOf("-o");
  return oi >= 0 ? args[oi + 1] : null;
}

/** Find the jsx + bundle maps for a build output dir or file prefix. */
function findMaps(target) {
  const abs = resolve(target);
  const candidates = [];
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs)) {
      if (f.endsWith(".jsx.map")) candidates.push(join(abs, f));
    }
  } else {
    candidates.push(`${abs}.map`, abs);
  }
  for (const jsxMapPath of candidates) {
    if (!existsSync(jsxMapPath)) continue;
    const bundleMapPath = jsxMapPath.replace(/\.jsx\.map$/, ".bundle.js.map");
    if (!existsSync(bundleMapPath)) continue;
    return {
      jsxMapPath,
      bundleMapPath,
      jsxMap: JSON.parse(readFileSync(jsxMapPath, "utf8")),
      bundleMap: JSON.parse(readFileSync(bundleMapPath, "utf8")),
    };
  }
  return null;
}

let dispatchError = null;
try {
switch (cmd) {
  case "lint": {
    const f = needFile();
    const src = readFileSync(f, "utf8");
    const diagnostics = lintSource(src, { filename: f });
    out({ schema: "ae-devtools.jsx-toolchain.lint/v1", file: f, diagnostics, ok: !hasErrors(diagnostics) }, hasErrors(diagnostics) ? 1 : 0);
    break;
  }
  case "build": {
    const f = needFile();
    const r = buildFile(f, { outDir: outDirArg() });
    const { output, map, ...rest } = r; // don't echo full artifact on stdout
    out({ ...rest, jsxBytes: output?.length ?? 0 }, r.status === "ok" ? 0 : 1);
    break;
  }
  case "build-project": {
    const f = needFile();
    const name = arg("--name", args) ?? null;
    const r = await buildProject(f, { outDir: outDirArg(), name });
    const { output, map, bundleMap, ...rest } = r;
    out({
      ...rest,
      jsxBytes: output?.length ?? 0,
      inputs: r.inputs,
    }, r.status === "ok" ? 0 : 1);
    break;
  }
  case "watch": {
    const f = needFile();
    const name = arg("--name", args) ?? null;
    const { watchProject } = await import("./watch.mjs");
    const handle = watchProject(f, {
      outDir: outDirArg(),
      name,
      onStatus: (s) => process.stdout.write(JSON.stringify(s) + "\n"),
    });
    const stop = () => handle.close();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // done resolves only after watchers close AND any in-flight build
    // settles; exit via exitCode so buffered stdout is flushed and the
    // event loop drains naturally instead of being cut mid-write.
    await handle.done;
    process.exitCode = 0;
    break;
  }
  case "check": {
    const f = needFile();
    const abs = resolve(f);
    const r = statSync(abs).isDirectory() ? checkProject(abs) : checkFile(abs);
    out(r, r.ok ? 0 : 1);
    break;
  }
  case "map": {
    const [mapPath, line, col] = positionalArgs();
    if (!mapPath || line === undefined) { console.error("usage: map <file.jsx.map> <line> [col]"); process.exit(2); }
    const map = JSON.parse(readFileSync(mapPath, "utf8"));
    const pos = lookup(map, Number(line), Number(col ?? 0));
    out({ schema: "ae-devtools.jsx-toolchain.map/v1", generated: { line: Number(line), column: Number(col ?? 0) }, original: pos }, pos ? 0 : 1);
    break;
  }
  case "resolve": {
    const [target, line, col] = positionalArgs();
    if (!target || line === undefined) { console.error("usage: resolve <outdir|file-prefix> <line> [col]"); process.exit(2); }
    const maps = findMaps(target);
    if (!maps) {
      out({ schema: "ae-devtools.jsx-toolchain.resolve/v1", error: "no .jsx.map + .bundle.js.map pair found", target }, 2);
      break;
    }
    const pos = resolvePosition({
      jsxMap: maps.jsxMap, bundleMap: maps.bundleMap,
      line: Number(line), column: Number(col ?? 0),
    });
    out({
      schema: "ae-devtools.jsx-toolchain.resolve/v1",
      jsxMap: maps.jsxMapPath,
      bundleMap: maps.bundleMapPath,
      generated: { line: Number(line), column: Number(col ?? 0) },
      original: pos,
    }, pos ? 0 : 1);
    break;
  }
  default:
    console.error("usage: jsx-toolchain <lint|build|build-project|check|watch|map|resolve> ...");
    process.exit(2);
}
} catch (e) {
  // Filesystem/JSON failures (missing input, malformed sourcemap) are
  // usage-level errors: report a structured payload and exit 2 instead
  // of dumping a stack trace (Issue #234).
  dispatchError = e;
}
if (dispatchError !== null) {
  out({
    schema: "ae-devtools.jsx-toolchain.error/v1",
    command: cmd ?? null,
    error: String(dispatchError?.message ?? dispatchError),
  }, 2);
}
