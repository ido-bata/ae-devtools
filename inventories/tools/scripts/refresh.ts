/**
 * refresh.ts — CAP004 re-runnable update procedure.
 *
 * Default mode (report):
 *   - lists every pinned tool with its pinned SHA and clone HEAD,
 *   - fetches each clone and reports upstream commits newer than the pin,
 *   - re-runs extract + verify so the committed output is proven fresh.
 *
 * `--update <toolId>` (accept mode, run AFTER review):
 *   - rewrites the pinned commit in scripts/registry.ts to the clone's HEAD,
 *   - rewrites OBSERVED_AT to today,
 *   - prints the remaining steps (re-extract, verify, commit).
 *
 * Discovery delta (new repos from the search) is a human step: compare
 * `gh search repos "after effects mcp" ...` against snapshot/tools.json and
 * snapshot's notExamined list, then follow README "更新手順".
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVED_AT, PKG_ROOT, TOOL_DEFS, resolveSourceRoot } from "./registry.ts";
import { gitHead } from "./text.ts";

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function defaultBranch(dir: string): string | null {
  const symref = git(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
  if (!symref) return null;
  const m = symref.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
  return m?.[1] ?? null;
}

function updatePin(toolId: string, head: string): void {
  const registryPath = join(PKG_ROOT, "scripts", "registry.ts");
  const src = readFileSync(registryPath, "utf8");
  const idIdx = src.indexOf(`id: "${toolId}"`);
  if (idIdx < 0) throw new Error(`tool id not found in registry.ts: ${toolId}`);
  const commitMatch = /commit: "[0-9a-f]{7,40}"/.exec(src.slice(idIdx));
  if (!commitMatch || commitMatch.index === undefined) {
    throw new Error(`no commit field after id "${toolId}" in registry.ts`);
  }
  const absIdx = idIdx + commitMatch.index;
  const old = commitMatch[0];
  const next = src.slice(0, absIdx) + `commit: "${head}"` + src.slice(absIdx + old.length);
  const today = new Date().toISOString().slice(0, 10);
  const withDate = next.replace(
    /export const OBSERVED_AT = "[0-9-]{10}"/,
    `export const OBSERVED_AT = "${today}"`,
  );
  writeFileSync(registryPath, withDate);
  process.stdout.write(
    `registry.ts: ${toolId} re-pinned ${old.replace("commit: ", "")} -> ${head}, OBSERVED_AT -> ${today}\n`,
  );
}

async function runExtractAndVerify(): Promise<void> {
  for (const script of ["extract.ts", "verify.ts"]) {
    const proc = Bun.spawn(["bun", "run", join(PKG_ROOT, "scripts", script)], {
      cwd: PKG_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${script} failed (exit ${code})`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const updateIdx = argv.indexOf("--update");
  const updateTarget = updateIdx >= 0 ? argv[updateIdx + 1] : undefined;

  if (updateTarget) {
    const def = TOOL_DEFS.find((t) => t.id === updateTarget);
    if (!def) throw new Error(`unknown tool: ${updateTarget}`);
    const root = resolveSourceRoot(def).root;
    const head = gitHead(root);
    if (!head) throw new Error(`not a git checkout: ${root}`);
    updatePin(def.id, head);
    process.stdout.write("now run: bun run extract && bun run verify, review the delta, then commit\n");
    return;
  }

  // Report mode.
  let upstreamDeltas = 0;
  for (const def of TOOL_DEFS) {
    const root = resolveSourceRoot(def).root;
    const head = gitHead(root);
    const pinState = head === null ? "MISSING" : head === def.commit ? "pinned" : `DRIFT (${head})`;
    process.stdout.write(`${def.id}: ${pinState} (${def.commit.slice(0, 10)})\n`);
    if (!existsSync(root)) continue;
    git(root, ["fetch", "-q", "origin"]);
    const branch = defaultBranch(root);
    if (branch) {
      const behind = git(root, ["rev-list", "--count", `HEAD..origin/${branch}`]);
      if (behind && behind !== "0") {
        upstreamDeltas += 1;
        const log = git(root, ["log", "--oneline", `HEAD..origin/${branch}`]) ?? "";
        process.stdout.write(`  upstream: ${behind} commit(s) newer than pin:\n${log}\n`);
      } else {
        process.stdout.write("  upstream: no commits newer than pin\n");
      }
    } else {
      process.stdout.write("  upstream: could not determine default branch (offline?)\n");
    }
  }
  process.stdout.write(
    upstreamDeltas > 0
      ? `${upstreamDeltas} tool(s) have upstream commits. Review, then ` +
          "`bun run refresh -- --update <tool>` per tool.\n"
      : "all pins current with their upstream default branches (as of this fetch).\n",
  );

  process.stdout.write(`observedAt: ${OBSERVED_AT}\n`);
  await runExtractAndVerify();
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
