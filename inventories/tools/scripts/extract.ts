/**
 * CAP001/CAP002/CAP003/CAP004 extractor entry point.
 *
 * Deterministic: identical inputs (same pinned commits, same source files)
 * must produce byte-identical output. `renderOutputs()` is the single source
 * of truth for what gets written; main() commits it to generated/ + snapshot/
 * and verify.ts re-renders it for the byte-identity check.
 *
 * Caps: CAP001 discovery record + tool registry (snapshot/tools.json),
 * CAP002 operation rows (generated/operations.json),
 * CAP003 semantic normalization + gap matrix (generated/semantics.json),
 * CAP004 refresh procedure (generated/discovery.json).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVED_AT, TOOL_DEFS, resolveSourceRoot } from "./registry.ts";
import type {
  AccessCounts,
  DiscoveryRecord,
  OperationRow,
  RefreshStep,
  SemanticBundle,
  ToolRecord,
} from "./types.ts";
import { gitDirty, gitHead, toJson } from "./text.ts";

export const GENERATED = join(import.meta.dir, "..", "generated");
export const SNAPSHOT = join(import.meta.dir, "..", "snapshot");

// ---------------------------------------------------------------------------
// CAP001 discovery record + CAP004 refresh procedure
// ---------------------------------------------------------------------------

export const DISCOVERY: DiscoveryRecord = {
  id: "CAP001",
  purpose:
    "Inventory of real After Effects control tools and the operations they actually implement in source (not README claims).",
  searchTerms: [
    "after effects mcp",
    "AfterEffects MCP",
    "after effects automation mcp",
    "after effects extendscript bridge mcp",
  ],
  searchedAt: OBSERVED_AT,
  scope:
    "GitHub repository search (gh search repos) for MCP servers controlling Adobe After Effects, plus repos already cited by ae-devtools/ae-a8n research (BenZed/after-effects, ido-bata/Ae_LayerNote, ido-bata/ae-a8n) and this repository's experiments/runtime-bridge.",
  selectionCriteria:
    "Examined when the repository contains readable source that reaches After Effects (ExtendScript/CEP/bridge) and is a plausible control tool. Top search results by activity were cloned; deep extraction was performed where the tool surface was machine-locatable. Every examined tool records commit + license + observation date.",
  outOfScope: [
    "README/marketing claims without source",
    "closed-source or unlicensed binaries without readable source",
    "tools not reached by the search terms (the population is open; no completeness claim)",
    "real-host execution (source review only — see ae-devtools #13-#19)",
  ],
  sources: [
    'gh search repos "after effects mcp" --limit 30 (2026-11-12)',
    "ae-devtools docs/architecture/research/ (existing research)",
    "ae-a8n ADR-0001 (BenZed/after-effects citation)",
    "specs/ae-capability-coverage/research.md §4 parity discovery protocol (read from branch 6)",
  ],
};

/** Candidates from the same search that were NOT examined in this pass. */
export const NOT_EXAMINED: { repo: string; reason: string }[] = [
  { repo: "tzdwindows/after-effects-mcp", reason: "not examined in this pass (search result, source not read)" },
  { repo: "Anant-404/AfterEffects-mcp", reason: "not examined in this pass (search result, source not read)" },
  { repo: "hodor/ae-mcp", reason: "not examined in this pass (search result, source not read)" },
  { repo: "dogauto/after-effects-mcp", reason: "not examined in this pass (search result, source not read)" },
  { repo: "Remirdy/AfterEffectsMCP", reason: "not examined in this pass (search result, source not read)" },
  { repo: "ndtrong27/after-effects-mcp", reason: "not examined in this pass (search result, source not read)" },
];

export const REFRESH_PROCEDURE: RefreshStep[] = [
  {
    step: 1,
    action: "Re-run the discovery search and diff the candidate set against snapshot/tools.json + NOT_EXAMINED.",
    command: 'gh search repos "after effects mcp" --limit 30 --json fullName,license,updatedAt,stargazersCount',
  },
  {
    step: 2,
    action: "Fetch each pinned clone and report upstream commits newer than the pinned SHA.",
    command: "bun run refresh",
  },
  { step: 3, action: "Re-extract from the pinned checkouts (deterministic).", command: "bun run extract" },
  {
    step: 4,
    action: "Verify committed output is byte-identical to a fresh run and every cited file+line resolves.",
    command: "bun run verify",
  },
  {
    step: 5,
    action:
      "Accept an upstream update only after review: re-pin the commit in scripts/registry.ts (or `bun run refresh -- --update <tool>`), re-run steps 3-4, commit the delta.",
  },
  {
    step: 6,
    action:
      "Add a newly discovered tool: clone into .reference/<dir>, add a ToolDef (commit/license/status) to scripts/registry.ts, add an adapter under scripts/adapters/, add its semantic ids to scripts/semantics.ts, re-run steps 3-4.",
  },
];

// ---------------------------------------------------------------------------
// Tool registry -> ToolRecord (with pin enforcement)
// ---------------------------------------------------------------------------

export function buildToolRecords(operations: OperationRow[] = []): ToolRecord[] {
  const byTool = new Map<string, OperationRow[]>();
  for (const row of operations) {
    const list = byTool.get(row.toolId) ?? [];
    list.push(row);
    byTool.set(row.toolId, list);
  }
  return TOOL_DEFS.map((def) => {
    const root = resolveSourceRoot(def);
    const rows = byTool.get(def.id) ?? [];
    // source-verified only when the adapter produced rows AND every row's
    // citations resolve (adapters throw otherwise, so rows.length > 0 with no
    // throw means both file+line pairs were machine-checked).
    const status: ToolRecord["status"] =
      rows.length > 0 && rows.every((r) => r.status === "source-verified")
        ? "source-verified"
        : "claimed/unverifiable";
    const record: ToolRecord = {
      id: def.id,
      repoUrl: def.repoUrl,
      kind: def.kind,
      commit: def.commit,
      license: def.license,
      licenseEvidence: def.licenseEvidence,
      observedAt: OBSERVED_AT,
      status,
      sourceRoot:
        root.kind === "self" ? "." : root.kind === "clone" ? `.reference/${def.cloneDir ?? def.id}` : "$AE_A8N_PATH or .reference/ae-a8n",
      extraction: def.extraction,
    };
    if (def.notes) record.notes = def.notes;
    if (rows.length === 0) {
      record.status = "claimed/unverifiable";
      record.notes = `${record.notes ? `${record.notes} ` : ""}このパスでは行を抽出していない (adapters/${def.extraction}.ts 未実装または対象外); source-verified ではない`;
    }
    if (root.kind === "clone") {
      const head = gitHead(root.root);
      if (head === null) {
        throw new Error(
          `${def.id}: source root missing: ${root.root} (clone it — see README "更新手順")`,
        );
      }
      if (head !== def.commit) {
        throw new Error(
          `${def.id}: HEAD ${head} != pinned ${def.commit} (review, then \`bun run refresh -- --update ${def.id}\`)`,
        );
      }
    } else if (root.kind === "local") {
      const head = gitHead(root.root);
      if (head !== null && head !== def.commit) {
        throw new Error(`${def.id}: local checkout ${head} != pinned ${def.commit}`);
      }
    } else {
      if (gitDirty(root.root, "experiments/runtime-bridge")) {
        throw new Error(`${def.id}: experiments/runtime-bridge is dirty; re-pin before extracting`);
      }
    }
    return record;
  });
}

export function countAccess(rows: OperationRow[]): AccessCounts {
  const counts: AccessCounts = {
    total: rows.length,
    read: 0,
    write: 0,
    execute: 0,
    "host-callback": 0,
    "build-test": 0,
    unknown: 0,
  };
  for (const row of rows) counts[row.access] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// CAP002 adapters
// ---------------------------------------------------------------------------

/** One adapter module per tool; each exports extract(): OperationRow[]. */
const ADAPTERS = [
  "./adapters/ae-a8n.ts",
  "./adapters/ae-devtools.ts",
  "./adapters/ishu86.ts",
  "./adapters/heroicswan.ts",
] as const;

export async function runAdapters(): Promise<OperationRow[]> {
  let rows: OperationRow[] = [];
  for (const mod of ADAPTERS) {
    const loaded = (await import(mod)) as { extract?: () => OperationRow[] | Promise<OperationRow[]> };
    if (typeof loaded.extract !== "function") throw new Error(`adapter ${mod} does not export extract()`);
    rows = rows.concat(await loaded.extract());
  }
  return rows;
}

export interface ExtractResult {
  tools: ToolRecord[];
  operations: OperationRow[];
  semantics: SemanticBundle;
}

export async function extractAll(): Promise<ExtractResult> {
  const operations = await runAdapters();
  const tools = buildToolRecords(operations);
  const { buildSemantics } = await import("./semantics.ts");
  const semantics = buildSemantics(operations, tools);
  return { tools, operations, semantics };
}

/** All output files as (relative path -> exact file content). */
export async function renderOutputs(): Promise<Map<string, string>> {
  const { tools, operations, semantics } = await extractAll();
  const out = new Map<string, string>();
  out.set(
    "snapshot/tools.json",
    toJson({ observedAt: OBSERVED_AT, tools, notExamined: NOT_EXAMINED }),
  );
  out.set(
    "generated/discovery.json",
    toJson({ discovery: DISCOVERY, refreshProcedure: REFRESH_PROCEDURE }),
  );
  out.set("generated/operations.json", toJson({ counts: countAccess(operations), operations }));
  out.set("generated/semantics.json", toJson(semantics));
  return out;
}

export async function main(): Promise<void> {
  const outputs = await renderOutputs();
  for (const [rel, content] of outputs) {
    const abs = join(import.meta.dir, "..", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const ops = JSON.parse(outputs.get("generated/operations.json") ?? '{"counts":{}}') as {
    counts: AccessCounts;
    operations: OperationRow[];
  };
  const toolsOut = JSON.parse(outputs.get("snapshot/tools.json") ?? '{"tools":[]}') as {
    tools: ToolRecord[];
  };
  const examined = toolsOut.tools.filter((t) => t.status === "source-verified").length;
  const c = ops.counts;
  process.stdout.write(
    `tools=${examined}/${toolsOut.tools.length} examined operations=${c.total} read=${c.read} write=${c.write} ` +
      `execute=${c.execute} host-callback=${c["host-callback"]} build-test=${c["build-test"]} unknown=${c.unknown}\n`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
