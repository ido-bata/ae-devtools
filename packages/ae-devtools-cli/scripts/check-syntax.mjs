/**
 * check-syntax.mjs — static syntax gate for the published .mjs surface
 * (Issue #185).
 *
 * The package ships plain ESM JavaScript with no typecheck step
 * (unlike capability-catalog / native-adapter's `tsc --noEmit`). The
 * minimal honest static gate available without adding a toolchain
 * dependency is `node --check` over every shipped .mjs file: it catches
 * syntax-level breakage (the class of error that otherwise only
 * surfaces when a consumer imports the module) at CI time.
 *
 * Deliberately NOT included (recorded decision, Issue #185):
 *   - `tsc --checkJs`: on this codebase it reports hundreds of
 *     JSDoc/type findings; adopting it needs a scoped tsconfig and a
 *     triage pass, tracked as follow-up rather than silently weakened.
 *   - eslint: no existing config; introducing one is a style decision,
 *     not a correctness gate.
 *
 * Scope = the same directories package.json `files` ships (module
 * dirs). tests/ trees are still walked: Issue #196 stopped shipping
 * them in the tarball (nested tests/.npmignore), but a broken test
 * file is still a broken source file worth gating.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Scope derives from package.json "files" — the same list that decides
// what ships — so a new module dir or harness can never ship ungated
// (Issue #232: the hand-maintained SHIPPED_DIRS list had already drifted,
// missing scripts/*.mjs and the conformance/ harnesses). `scripts/` is
// added explicitly: test-harness/testkit/consumer-smoke are dev tooling
// that never ships but is still source worth gating.
const { files: shipped } = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const SCOPES = [...shipped, "scripts"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith(".mjs")) yield p;
  }
}

const files = SCOPES.flatMap((d) => {
  const abs = join(PKG, d);
  try {
    if (statSync(abs).isDirectory()) return [...walk(abs)];
    // A `files` entry can be a single file (e.g. jsx-toolchain/real-run.mjs).
    return abs.endsWith(".mjs") ? [abs] : [];
  } catch {
    return [];
  }
}).sort();

if (files.length === 0) {
  console.error("check-syntax: no .mjs files found — scope list is stale");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const rel = file.slice(PKG.length + 1);
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`SYNTAX ${rel}`);
    console.error((r.stderr || "").trim());
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${files.length} files failed syntax check`);
  process.exit(1);
}
console.log(`${files.length} shipped .mjs files pass node --check`);
