#!/usr/bin/env node
/**
 * coverage-matrix.mjs — project inventories/sdk/generated/aggregate.json
 * into a suite-family coverage matrix (Issues #19 CAP045/CAP048).
 *
 * This is a pure data transform: it re-labels the extractor's structural
 * classes with the verification states this repo can honestly claim, and
 * emits JSON + Markdown. It never touches an AE SDK header, an AE
 * process, or claims real-host support.
 *
 *   node inventories/sdk/scripts/coverage-matrix.mjs [aggregate.json] [out-prefix]
 *
 * Default input: inventories/sdk/generated/aggregate.json
 * Default outputs: <prefix>.coverage-matrix.json / .md next to it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/**
 * Map extractor symbol classes → honest verification state.
 * "inventory" means: structurally attributed by the extractor only;
 * nothing about load/execution is proven. Rows needing a child Issue
 * (CAP047) stay open until one exists — this matrix does not close them.
 */
export const CLASS_STATE = {
  "build-test-lifecycle": {
    state: "build-probe-only",
    note: "Sample projects compile (Sweetie/Checkout, macOS arm64). Load/execution UNVERIFIED.",
  },
  "external-command": {
    state: "inventory-only",
    note: "Selector strings attributed from headers. No adapter, no real-host dispatch evidence.",
  },
  "host-callback": {
    state: "inventory-only",
    note: "Callback slots/types enumerated. Lifetime/thread-safety rules documented, unexercised.",
  },
  "in-host-plugin-command": {
    state: "inventory-only",
    note: "In-plugin command surface enumerated. Not reachable from devtools yet.",
  },
  "unsupported-or-unknown": {
    state: "unsupported-or-unknown",
    note: "Extractor could not attribute; see unknownByReason. Requires per-family review (CAP047).",
  },
};

export function buildMatrix(aggregate) {
  const totals = aggregate.totals ?? {};
  const classes = {};
  for (const [cls, meta] of Object.entries(CLASS_STATE)) {
    classes[cls] = {
      symbols: totals.byClass?.[cls] ?? 0,
      state: meta.state,
      note: meta.note,
      implemented: false,
      verifiedOnRealHost: false,
    };
  }
  // Any class present in the aggregate but missing from CLASS_STATE is a
  // new extractor class — surface it as unknown rather than dropping it.
  for (const cls of Object.keys(totals.byClass ?? {})) {
    if (!classes[cls]) {
      classes[cls] = { symbols: totals.byClass[cls], state: "unknown", note: "unmapped extractor class", implemented: false, verifiedOnRealHost: false };
    }
  }
  const headers = (aggregate.perHeader ?? []).map((h) => ({
    path: h.path,
    symbols: h.symbols,
    byClass: h.byClass ?? {},
  }));
  return {
    schema: "ae-devtools/sdk-coverage-matrix/1",
    release: aggregate.release ?? null,
    evidenceLevel: aggregate.evidenceLevel ?? null,
    totals: {
      symbols: totals.symbols ?? 0,
      unknown: totals.unknown ?? 0,
      unknownByReason: totals.unknownByReason ?? {},
      headerFilesParsed: totals.headerFilesParsed ?? 0,
    },
    classes,
    headers,
    denominatorCaveats: aggregate.denominatorCaveats ?? [],
    claims: {
      implemented: "code exists and compiles",
      verifiedOnRealHost: "observed running against an installed After Effects",
      statement: "No row in this matrix is verifiedOnRealHost. Build-probe-only means the SDK sample compiles; it does not mean AE loads the plugin.",
    },
  };
}

export function renderMarkdown(matrix) {
  const lines = [
    "# SDK coverage matrix (generated)",
    "",
    `Release: ${matrix.release?.identifier ?? "unknown"} (${matrix.release?.distribution ?? "?"})`,
    `Symbols: ${matrix.totals.symbols} across ${matrix.totals.headerFilesParsed} headers; unknown/unsupported: ${matrix.totals.unknown}`,
    "",
    "| Class | Symbols | State |",
    "| --- | ---: | --- |",
  ];
  for (const [cls, row] of Object.entries(matrix.classes)) {
    lines.push(`| ${cls} | ${row.symbols} | ${row.state} — ${row.note} |`);
  }
  lines.push("", "## Per-header symbol counts", "", "| Header | Symbols |", "| --- | ---: |");
  for (const h of matrix.headers) lines.push(`| ${h.path} | ${h.symbols} |`);
  lines.push("", "## Caveats", "");
  for (const c of matrix.denominatorCaveats) lines.push(`- ${c}`);
  lines.push("", matrix.claims.statement, "");
  return lines.join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const input = process.argv[2] ?? join(REPO, "inventories/sdk/generated/aggregate.json");
  const outPrefix = process.argv[3] ?? input.replace(/\.json$/, "");
  const agg = JSON.parse(readFileSync(input, "utf8"));
  const matrix = buildMatrix(agg);
  writeFileSync(`${outPrefix}.coverage-matrix.json`, JSON.stringify(matrix, null, 2) + "\n");
  writeFileSync(`${outPrefix}.coverage-matrix.md`, renderMarkdown(matrix));
  console.log(`wrote ${outPrefix}.coverage-matrix.{json,md}`);
}
