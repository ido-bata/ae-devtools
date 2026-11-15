#!/usr/bin/env node
/**
 * cli.mjs — jsx-toolchain CLI (Issue #52).
 *
 *   jsx-toolchain lint <file.ts>           ES3-compat lint (source)
 *   jsx-toolchain build <file.ts> [-o dir] transpile to ES3 JSX + sourcemap
 *   jsx-toolchain check <file.ts>          typecheck vs ae-globals.d.ts
 *   jsx-toolchain map <file.jsx.map> <line> <col>
 *                                        generated position -> TS source
 *
 * Exit codes: 0 ok, 1 diagnostics with errors, 2 usage/io error.
 * Output is JSON on stdout for machine consumption.
 */
import { readFileSync } from "node:fs";
import { buildFile } from "./build.mjs";
import { checkFile } from "./check.mjs";
import { lintSource, hasErrors } from "./es3-lint.mjs";
import { lookup } from "./sourcemap.mjs";

const [cmd, ...args] = process.argv.slice(2);

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

function needFile() {
  const f = args.find((a) => !a.startsWith("-"));
  if (!f) { console.error("missing file argument"); process.exit(2); }
  return f;
}

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
    const oi = args.indexOf("-o");
    const outDir = oi >= 0 ? args[oi + 1] : null;
    const r = buildFile(f, { outDir });
    const { output, map, ...rest } = r; // don't echo full artifact on stdout
    out({ ...rest, jsxBytes: output?.length ?? 0 }, r.status === "ok" ? 0 : 1);
    break;
  }
  case "check": {
    const f = needFile();
    const r = checkFile(f);
    out(r, r.ok ? 0 : 1);
    break;
  }
  case "map": {
    const [mapPath, line, col] = args;
    if (!mapPath || line === undefined) { console.error("usage: map <file.jsx.map> <line> [col]"); process.exit(2); }
    const map = JSON.parse(readFileSync(mapPath, "utf8"));
    const pos = lookup(map, Number(line), Number(col ?? 0));
    out({ schema: "ae-devtools.jsx-toolchain.map/v1", generated: { line: Number(line), column: Number(col ?? 0) }, original: pos }, pos ? 0 : 1);
    break;
  }
  default:
    console.error("usage: jsx-toolchain <lint|build|check|map> ...");
    process.exit(2);
}
