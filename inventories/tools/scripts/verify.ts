/**
 * verify.ts — proves the committed inventory is trustworthy:
 *
 *   1. Citation integrity (review D3): every operation row's
 *      definitionFile+definitionLine and implementationFile+implementationLine
 *      must resolve inside the SAME file they name — file exists, line within
 *      range, and `source-verified` rows are checked for both pairs.
 *   2. Byte identity: a fresh extraction must reproduce the committed
 *      generated/ + snapshot/ files byte for byte (stale or hand-edited
 *      output fails).
 *   3. Evidence completeness: every row carries accessBasis, route,
 *      semanticId and a valid status.
 *
 * Exit 0 only when all checks pass.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT, resolveSourceRoot, TOOL_DEFS } from "./registry.ts";
import { checkCitation } from "./text.ts";
import type { OperationRow } from "./types.ts";

function sha(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function hashDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of listJson(dir)) out.set(f, sha(readFileSync(join(dir, f))));
  return out;
}

function checkCitations(operations: OperationRow[]): string[] {
  const problems: string[] = [];
  const roots = new Map<string, string>();
  for (const def of TOOL_DEFS) roots.set(def.id, resolveSourceRoot(def).root);

  for (const row of operations) {
    const root = roots.get(row.toolId);
    if (!root) {
      problems.push(`${row.toolId} ${row.name}: tool has no resolved source root`);
      continue;
    }
    const def = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!def.ok) {
      problems.push(
        `${row.toolId} ${row.name}: definition ${row.definitionFile}:${row.definitionLine} — ${def.reason}`,
      );
    }
    const impl = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!impl.ok) {
      problems.push(
        `${row.toolId} ${row.name}: implementation ${row.implementationFile}:${row.implementationLine} — ${impl.reason}`,
      );
    }
    if (!row.accessBasis || row.accessBasis.trim().length < 10) {
      problems.push(`${row.toolId} ${row.name}: missing accessBasis evidence`);
    }
    if (row.status !== "source-verified" && row.status !== "claimed/unverifiable") {
      problems.push(`${row.toolId} ${row.name}: invalid status ${row.status}`);
    }
    if (!row.route || !row.semanticId) {
      problems.push(`${row.toolId} ${row.name}: missing route or semanticId`);
    }
    if (!Array.isArray(row.args)) {
      problems.push(`${row.toolId} ${row.name}: args must be an array`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // --- 1. citation integrity against the committed operations.json ---------
  const opsPath = join(PKG_ROOT, "generated", "operations.json");
  if (!existsSync(opsPath)) {
    failures.push("generated/operations.json missing — run `bun run extract` first");
  } else {
    const parsed = JSON.parse(readFileSync(opsPath, "utf8")) as { operations: OperationRow[] };
    const problems = checkCitations(parsed.operations);
    failures.push(...problems);
    process.stdout.write(
      `citations: ${parsed.operations.length} rows checked, ${problems.length} problems\n`,
    );
  }

  // --- 2. byte identity: fresh render vs committed files -------------------
  try {
    const { renderOutputs } = await import("./extract.ts");
    const fresh = await renderOutputs();

    const tmp = join(PKG_ROOT, ".tmp-verify");
    rmSync(tmp, { recursive: true, force: true });
    for (const [rel, content] of fresh) {
      const abs = join(tmp, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }

    const freshHashes = new Map<string, string>();
    for (const sub of ["generated", "snapshot"]) {
      for (const [f, h] of hashDir(join(tmp, sub))) freshHashes.set(`${sub}/${f}`, h);
    }
    const committedHashes = new Map<string, string>();
    for (const sub of ["generated", "snapshot"]) {
      for (const [f, h] of hashDir(join(PKG_ROOT, sub))) committedHashes.set(`${sub}/${f}`, h);
    }
    rmSync(tmp, { recursive: true, force: true });

    for (const [key, hash] of freshHashes) {
      const have = committedHashes.get(key);
      if (have === undefined) failures.push(`fresh run produced ${key}, which is not committed`);
      else if (have !== hash) failures.push(`byte mismatch: ${key} (committed ${have} != fresh ${hash})`);
    }
    for (const key of committedHashes.keys()) {
      if (!freshHashes.has(key)) failures.push(`committed file not produced by a fresh run: ${key}`);
    }
    process.stdout.write(
      `byte-identity: ${freshHashes.size} files compared, ` +
        `${[...freshHashes].filter(([k, h]) => committedHashes.get(k) !== h).length} mismatches\n`,
    );
  } catch (err) {
    failures.push(`fresh extraction run failed: ${String(err)}`);
  }

  if (failures.length > 0) {
    process.stderr.write(`verify FAILED (${failures.length} problems):\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write("verify OK: citations resolve, fresh run byte-identical to committed output\n");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
