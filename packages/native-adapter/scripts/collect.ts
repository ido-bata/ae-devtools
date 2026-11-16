/**
 * collect.ts — debug-log excerpt → native-probe-result/v1 CLI (Issue #81).
 *
 * Reads an AE debug-log excerpt (the lines `probe.cpp` emits via
 * `AEGP_WriteToDebugLog`), runs `collectProbeResults`, validates every
 * produced record with `validateProbeResult`, and prints the results
 * as JSON. `plugin.*` and `evidence.*` are SUPPLIED — they are not in
 * the log — so they come from a caller-provided JSON file:
 *
 *   {
 *     "plugin": { "name": "...", "entryPoint": "...",
 *                 "sdkRelease": { "identifier": "...", "distribution": "..." } },
 *     "evidence": { "aeVersion": "...", "os": "...", "arch": "...",
 *                   "debugLogRef": "...", "sessionRef": "..." }
 *   }
 *
 * Fake/mock level only: this parses text. It contacts no AE and its
 * output is evidence-shaped input for promotion review, never proof
 * of real-host execution by itself.
 *
 *   bun run scripts/collect.ts <logfile> [--supplied supplied.json] [--out results.json]
 *
 * Exit 0 when every collected record validates; exit 1 otherwise.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectProbeResults, type CollectSupplied } from "../src/collect.ts";
import { validateProbeResult } from "../src/probe-result.ts";

function usage(): never {
  console.error(
    "usage: bun run scripts/collect.ts <logfile> [--supplied supplied.json] [--out results.json]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let logPath: string | undefined;
let suppliedPath: string | undefined;
let outPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--supplied") suppliedPath = args[++i];
  else if (a === "--out") outPath = args[++i];
  else if (a.startsWith("--")) usage();
  else if (logPath === undefined) logPath = a;
  else usage();
}
if (logPath === undefined || suppliedPath === undefined) usage();

const supplied = JSON.parse(readFileSync(resolve(suppliedPath!), "utf8")) as CollectSupplied;
if (!supplied.plugin) {
  console.error("supplied JSON must contain plugin.{name,entryPoint,sdkRelease}");
  process.exit(2);
}

const logText = readFileSync(resolve(logPath!), "utf8");
const results = collectProbeResults(logText, supplied);

let invalid = 0;
for (const [i, r] of results.entries()) {
  const errors = validateProbeResult(r);
  if (errors.length > 0) {
    invalid += 1;
    console.error(`result[${i}] (ordinal ${r.execution.ordinal}, ${r.execution.kind}):`);
    for (const e of errors) console.error(`  - ${e}`);
  }
}

const json = `${JSON.stringify(results, null, 2)}\n`;
if (outPath !== undefined) writeFileSync(resolve(outPath), json);
else process.stdout.write(json);

console.error(
  `collect: ${results.length} execution(s), ${invalid} invalid ` +
    `(kinds: ${results.map((r) => r.execution.kind).join(",") || "none"})`,
);
process.exit(invalid > 0 ? 1 : 0);
