#!/usr/bin/env node
/**
 * package-vsix.mjs — build an installable VSIX for the VSCode extension
 * (Issue #166).
 *
 * `vsce package` inside vscode-extension/ produces a VSIX that contains
 * ONLY that directory, but controller.mjs imports ../mcp-server,
 * ../vscode-debugger etc. The packaged extension cannot activate
 * (ERR_MODULE_NOT_FOUND). This script assembles the runtime the
 * extension actually needs:
 *
 *   stage/
 *     package.json            — vscode-extension manifest with
 *                               main = "./vscode-extension/extension.mjs"
 *     <npm-pack files set>    — the same set `npm pack` ships
 *     node_modules/           — production dependencies (jsonc-parser,
 *                               @ido-bata/ae-a8n, …)
 *     .vscodeignore           — drops tests/evidence from the VSIX
 *
 * The relative imports in vscode-extension/*.mjs then resolve to the
 * sibling directories at the extension root.
 *
 * Usage:
 *   node scripts/package-vsix.mjs [--out <file.vsix>] [--stage-dir <dir>]
 *                                 [--stage-only] [--vsce <bin>]
 *
 * --stage-only stops after assembling the stage tree (used by tests);
 * the default also runs `vsce package` (resolved via npx @vscode/vsce).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, "..");
export const VSCODE_EXTENSION_DIR = "vscode-extension";

const VSCODEIGNORE = `**/tests/**
**/*.test.mjs
**/evidence/**
node_modules/.package-lock.json
node_modules/.bin/**
`;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (flag) => process.argv.includes(flag);

/**
 * Assemble the VSIX stage tree under `stageDir` and return its path.
 * Pure filesystem work — no vsce invocation, no network.
 *
 * @param {object} options
 * @param {string} options.pkgRoot   — ae-devtools-cli package root
 * @param {string} options.stageDir  — empty dir to populate
 * @returns {string} path to the stage root (contains package.json)
 */
export function stageExtension({ pkgRoot = PKG_ROOT, stageDir } = {}) {
  if (!stageDir) throw new Error("stageDir is required");
  mkdirSync(stageDir, { recursive: true });
  const extRoot = join(stageDir, "extension");
  mkdirSync(extRoot, { recursive: true });

  // 1. npm pack → extract. Gives exactly the tarball's `files` set plus
  //    LICENSE/README — the same bytes a consumer installs.
  const packDir = join(stageDir, "pack");
  mkdirSync(packDir, { recursive: true });
  const packOut = execFileSync("npm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: pkgRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [tarball] = JSON.parse(packOut);
  const tgz = join(packDir, tarball.filename);
  execFileSync("tar", ["-xzf", tgz, "-C", extRoot, "--strip-components=1"]);
  rmSync(packDir, { recursive: true, force: true });

  // 1b. Drop test suites and recorded evidence — they are shipped in the
  //     npm tarball for consumers but are dead weight (and confusing
  //     surface) inside an extension bundle. .vscodeignore below is the
  //     second layer for anything missed.
  const dropDirs = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (name === "tests" || name === "evidence") {
        rmSync(p, { recursive: true, force: true });
      } else {
        dropDirs(p);
      }
    }
  };
  dropDirs(extRoot);

  // 2. Production node_modules. The package has no devDependencies, so
  //    the installed tree IS the production set.
  cpSync(join(pkgRoot, "node_modules"), join(extRoot, "node_modules"), {
    recursive: true,
    // npm's internal bookkeeping is not needed inside a VSIX.
    filter: (src) => !src.endsWith(".package-lock.json") && !src.includes("/.bin/"),
  });

  // 3. Extension manifest at the stage root. `main` points into the
  //    vscode-extension/ subdirectory so its ../<sibling> imports land
  //    on the staged runtime dirs. "type":"module" matches the ESM
  //    codebase (.mjs files are ESM regardless; this covers future .js).
  const manifest = JSON.parse(
    readFileSync(join(pkgRoot, VSCODE_EXTENSION_DIR, "package.json"), "utf8"),
  );
  manifest.main = `./${VSCODE_EXTENSION_DIR}/extension.mjs`;
  manifest.type = "module";
  // vsce only ships node_modules entries for packages declared as
  // `dependencies` of the extension manifest. Mirror the runtime deps
  // of @ido-bata/ae-devtools-cli so the staged node_modules actually
  // lands in the VSIX.
  const pkgManifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  if (pkgManifest.dependencies) manifest.dependencies = pkgManifest.dependencies;
  writeFileSync(join(extRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  // 4. Keep tests/evidence out of the VSIX; node_modules stays.
  writeFileSync(join(extRoot, ".vscodeignore"), VSCODEIGNORE);

  return extRoot;
}

function vscePackage(extRoot, outPath) {
  // Pinned vsce: packaging must be reproducible; a floating vsce could
  // change manifest generation between releases.
  const vsce = process.env.AE_DEVTOOLS_VSCE ?? "npx";
  const args =
    vsce === "npx"
      ? ["--yes", "@vscode/vsce@4.1.1", "package"]
      : ["package"];
  if (outPath) args.push("--out", outPath);
  const r = spawnSync(vsce, args, { cwd: extRoot, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`vsce package failed (exit ${r.status})`);
  }
}

function main() {
  const out = arg("--out");
  const stageDir = arg("--stage-dir") ?? mkdtempSync(join(tmpdir(), "ae-devtools-vsix-"));
  const keepStage = hasFlag("--keep-stage") || Boolean(arg("--stage-dir"));

  const extRoot = stageExtension({ pkgRoot: PKG_ROOT, stageDir });
  console.log(`staged extension at ${extRoot}`);

  // Sanity: the imports that broke the naive VSIX must resolve now.
  for (const rel of [
    "vscode-extension/extension.mjs",
    "vscode-extension/controller.mjs",
    "mcp-server/tools.mjs",
    "mcp-server/session.mjs",
    "vscode-debugger/src/gen.mjs",
    "node_modules/jsonc-parser/package.json",
    "node_modules/@ido-bata/ae-a8n/package.json",
  ]) {
    if (!existsSync(join(extRoot, rel))) {
      throw new Error(`staged tree is missing required path: ${rel}`);
    }
  }

  if (hasFlag("--stage-only")) {
    console.log("stage-only: skipping vsce package");
    if (!keepStage) console.log(`(stage dir retained at ${stageDir})`);
    return;
  }

  vscePackage(extRoot, out ? resolve(out) : undefined);
  if (!keepStage) rmSync(stageDir, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
