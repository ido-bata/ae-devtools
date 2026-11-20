/**
 * ae-a8n-resolve.mjs — single ae-a8n module resolution (Issue #253).
 *
 * Before this module the "root vs npm, dist/index.js entry, version
 * read" mechanics were copy-adapted in three places:
 * a8n-transport/session.mjs (loadAeA8n), a8n-transport/compat.mjs
 * (probeAeA8n) and recovery-orchestrator/cli.mjs (loadA8n). They agreed
 * today but carried subtly different contracts (cliPath derivation,
 * version source, failure mode). This is the ONE resolver; each
 * consumer keeps its own gate on top:
 *
 *   - session.mjs        — contract exports + handshake battery, then launch
 *   - compat.mjs         — probeAeA8n wraps this and NEVER throws
 *   - recovery cli.mjs   — per-command export surface check (assertA8nSurface)
 *
 * Dependency-free on purpose: automated tests import this module while
 * session.mjs must never be loaded by tests.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** git HEAD of a local checkout, or null when unavailable. */
export async function gitHead(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function packageVersion(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the ae-a8n API module + CLI entry.
 *
 * @param {object} [options]
 *   aeA8nRoot — local ae-a8n checkout root with a built dist/; overrides
 *               the pinned npm dependency (recorded in `source` so the
 *               run is never mistaken for a released-package verification)
 * @returns {Promise<{mod:object, AfterEffects:*, cliPath:string,
 *   source:string, version:string|null, head:string|null, entry:string|null}>}
 *   Throws when the module cannot be resolved/imported — callers that
 *   need a non-throwing probe (compat.mjs) wrap this in try/catch.
 *   `version` is the package.json version (local root or npm install);
 *   `head` is the git HEAD for local roots and the package version for
 *   npm (the strongest identity each source attests).
 */
export async function resolveAeA8n({ aeA8nRoot } = {}) {
  if (typeof aeA8nRoot === "string" && aeA8nRoot.length > 0) {
    const indexPath = join(aeA8nRoot, "dist", "index.js");
    const mod = await import(pathToFileURL(indexPath).href);
    return {
      mod,
      AfterEffects: mod.AfterEffects,
      cliPath: join(aeA8nRoot, "dist", "cli.js"),
      source: `local:${aeA8nRoot}`,
      version: packageVersion(aeA8nRoot),
      head: await gitHead(aeA8nRoot),
      entry: indexPath,
    };
  }
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@ido-bata/ae-a8n");
  const mod = await import("@ido-bata/ae-a8n");
  // dist/index.js and dist/cli.js are siblings; package.json sits at the
  // package root (two levels up from the resolved entry).
  const version = packageVersion(dirname(dirname(entry)));
  return {
    mod,
    AfterEffects: mod.AfterEffects,
    cliPath: join(dirname(entry), "cli.js"),
    source: "npm:@ido-bata/ae-a8n",
    version,
    head: version,
    entry,
  };
}
