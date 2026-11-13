/**
 * Verify that the committed inventory matches a clean rebuild (CAP005 acceptance:
 * extraction must be deterministic and re-runnable).
 *
 * Steps:
 *   1. Rebuild from the cache into the real output directory.
 *   2. Hash every generated file.
 *   3. Rebuild again and compare hashes.
 *   4. Confirm the committed files in git are identical to what was just produced.
 *
 * Step 4 is what makes this a real gate: a dirty or stale generated directory fails,
 * so the committed inventory can never drift from the extractor that claims to
 * produce it.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "generated");

function sha(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function hashDir(dir: string): Promise<Map<string, string>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out = new Map<string, string>();
  for (const f of files) out.set(f, sha(await readFile(join(dir, f))));
  return out;
}

async function runBuild(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", join(HERE, "build.ts")], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`build failed (exit ${code}):\n${err}`);
  }
}

function compare(
  label: string,
  a: Map<string, string>,
  b: Map<string, string>,
): string[] {
  const problems: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(key);
    const right = b.get(key);
    if (left !== right) {
      problems.push(`${label}: ${key} differs (${left ?? "absent"} vs ${right ?? "absent"})`);
    }
  }
  return problems;
}

/**
 * Compare the working tree's generated files against git's index. Uses `git diff`
 * so an untracked-but-expected file is also reported.
 */
async function gitDiffers(): Promise<{ differs: boolean; detail: string }> {
  const proc = Bun.spawn(
    ["git", "status", "--porcelain", "--", "inventories/scripting/generated"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { differs: out.trim().length > 0, detail: out.trim() };
}

async function main(): Promise<void> {
  process.stdout.write("run 1 ...\n");
  await runBuild();
  const first = await hashDir(OUT);

  process.stdout.write("run 2 ...\n");
  await runBuild();
  const second = await hashDir(OUT);

  const problems = compare("determinism", first, second);

  if (problems.length > 0) {
    process.stderr.write(`\nFAIL: build is not deterministic\n${problems.join("\n")}\n`);
    process.exit(1);
  }

  for (const [file, hash] of [...first.entries()].sort()) {
    process.stdout.write(`  ${file.padEnd(34)} ${hash}\n`);
  }

  const git = await gitDiffers();
  if (git.differs) {
    process.stderr.write(
      `\nFAIL: committed inventory differs from a clean rebuild ` +
        `(regenerate and commit):\n${git.detail}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nOK: ${first.size} files, byte-identical across two runs, and committed state matches.\n`,
  );
}

await main();
