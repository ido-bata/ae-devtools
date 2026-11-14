/**
 * lifecycle.mjs — CEP extension install/uninstall/status/log/cleanup
 * (Issue #36). Machine-level operations only: real AE load/reload stays
 * BLOCKED on an owned session (see LOAD-PROOF.md).
 *
 * Safety contract:
 *  - installs ONLY into the CEP extensions dir for the given platform
 *    (or an explicit targetDir for tests/fixtures)
 *  - writes an ownership marker `.ae-devtools-owned.json` into the
 *    installed dir; uninstall/cleanup refuse dirs without it — we never
 *    touch extensions we did not install
 *  - idempotent: reinstalling identical content is a no-op; drifted
 *    owned content is replaced (recorded); foreign content is refused
 *  - rollback: copy to `<dest>.tmp-<pid>` first, rename on success,
    remove tmp on any failure — a failed install never leaves a
 *    half-copied dir at the final path
 *  - no AE process is launched, signaled, or configured by this module
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const OWNED_MARKER = ".ae-devtools-owned.json";
export const MANIFEST_PATH = join("CSXS", "manifest.xml");

/** CEP extensions dir per platform. win32 uses %APPDATA%; darwin the
 *  documented ~/Library path. Other platforms are unsupported (CEP is
 *  Windows/macOS only). */
export function cepExtensionsDir({ platform = process.platform, home = process.env.HOME, appData = process.env.APPDATA } = {}) {
  if (platform === "darwin") {
    if (!home) throw new Error("HOME is required for darwin CEP dir");
    return join(home, "Library", "Application Support", "Adobe", "CEP", "extensions");
  }
  if (platform === "win32") {
    if (!appData) throw new Error("APPDATA is required for win32 CEP dir");
    return join(appData, "Adobe", "CEP", "extensions");
  }
  throw new Error(`unsupported platform for CEP extensions dir: ${platform}`);
}

/** CEPHtmlEngine log dir (panel/JSX-side evidence lives here). */
export function cepLogDir({ platform = process.platform, home = process.env.HOME } = {}) {
  if (platform === "darwin") {
    if (!home) throw new Error("HOME is required for darwin CEP log dir");
    return join(home, "Library", "Logs", "CSXS");
  }
  if (platform === "win32") return null; // %APPDATA%/Adobe/CEP/logs — not modeled here
  return null;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function hashTree(dir) {
  const out = {};
  async function walk(d, prefix) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === OWNED_MARKER) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full, rel);
      else if (e.isFile()) {
        out[rel] = createHash("sha256").update(await readFile(full)).digest("hex");
      }
    }
  }
  await walk(dir, "");
  return out;
}

function treesEqual(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Extract the Extension Id from CSXS/manifest.xml (first
 *  <Extension Id="...">). Throws if absent — a dir without a manifest
 *  is not installable. */
export async function readManifestId(sourceDir) {
  const m = await readFile(join(sourceDir, MANIFEST_PATH), "utf8");
  const hit = m.match(/<Extension\s+[^>]*\bId\s*=\s*"([^"]+)"/);
  if (!hit) throw new Error(`manifest has no Extension Id: ${join(sourceDir, MANIFEST_PATH)}`);
  return hit[1];
}

async function readMarker(dest) {
  try {
    return JSON.parse(await readFile(join(dest, OWNED_MARKER), "utf8"));
  } catch { return null; }
}

/**
 * Install an extension directory into the CEP extensions dir.
 * @returns {{status:"installed"|"already-installed"|"reinstalled-drift",
 *            dest:string, files:number}}
 * @throws on foreign (unowned) existing dir, manifest/Id mismatch,
 *         unsupported platform, or copy failure (tmp cleaned up).
 */
export async function install({ sourceDir, extensionId = null, targetDir = null, platform = process.platform } = {}) {
  const src = resolve(sourceDir);
  const manifestId = await readManifestId(src);
  if (extensionId && manifestId !== extensionId) {
    throw new Error(`manifest Extension Id '${manifestId}' != requested '${extensionId}'`);
  }
  const target = resolve(targetDir ?? cepExtensionsDir({ platform }));
  const dest = join(target, manifestId);
  await mkdir(target, { recursive: true });

  const marker = await readMarker(dest);
  if (await exists(dest) && !marker) {
    throw new Error(`refusing to touch unowned extension dir: ${dest}`);
  }

  const srcHash = await hashTree(src);
  if (marker && treesEqual(srcHash, await hashTree(dest))) {
    return { status: "already-installed", dest, files: Object.keys(srcHash).length };
  }

  const tmp = join(dirname(dest), `.tmp-${manifestId}-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  try {
    await cp(src, tmp, { recursive: true });
    await writeFile(join(tmp, OWNED_MARKER), JSON.stringify({
      schema: "ae-devtools.cep-owned/v1",
      extensionId: manifestId,
      installedAt: new Date().toISOString(),
      fileCount: Object.keys(srcHash).length,
    }, null, 2) + "\n");
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return { status: marker ? "reinstalled-drift" : "installed", dest, files: Object.keys(srcHash).length };
}

/** Remove an installed extension. Refuses unowned dirs. Idempotent:
 *  missing dir → {status:"absent"}. */
export async function uninstall({ extensionId, targetDir = null, platform = process.platform } = {}) {
  const target = resolve(targetDir ?? cepExtensionsDir({ platform }));
  const dest = join(target, extensionId);
  if (!(await exists(dest))) return { status: "absent", dest };
  const marker = await readMarker(dest);
  if (!marker || marker.extensionId !== extensionId) {
    throw new Error(`refusing to remove unowned extension dir: ${dest}`);
  }
  await rm(dest, { recursive: true, force: true });
  return { status: "removed", dest };
}

/** Inspect install state without modifying anything. */
export async function status({ extensionId, targetDir = null, platform = process.platform, sourceDir = null } = {}) {
  const target = resolve(targetDir ?? cepExtensionsDir({ platform }));
  const dest = join(target, extensionId);
  if (!(await exists(dest))) return { status: "absent", dest };
  const marker = await readMarker(dest);
  const owned = marker?.extensionId === extensionId;
  let drift = null;
  if (owned && sourceDir) {
    const a = await hashTree(resolve(sourceDir));
    const b = await hashTree(dest);
    drift = treesEqual(a, b) ? "none" : "content-differs";
  }
  return { status: owned ? "installed-owned" : "installed-foreign", dest, owned, drift };
}

/** Remove every ae-devtools-owned extension under target. Foreign dirs
 *  are left untouched and reported. */
export async function cleanup({ targetDir = null, platform = process.platform } = {}) {
  const target = resolve(targetDir ?? cepExtensionsDir({ platform }));
  if (!(await exists(target))) return { removed: [], foreign: [] };
  const removed = [], foreign = [];
  for (const e of await readdir(target, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".tmp-")) continue;
    const dir = join(target, e.name);
    const marker = await readMarker(dir);
    if (marker?.extensionId === e.name) {
      await rm(dir, { recursive: true, force: true });
      removed.push(e.name);
    } else {
      foreign.push(e.name);
    }
  }
  return { removed, foreign };
}

/** List CEPHtmlEngine log files (names + sizes). Reading panel logs is
 *  evidence collection, not AE interaction. */
export async function collectLogs({ logDir = null, home = process.env.HOME } = {}) {
  const dir = logDir ?? cepLogDir({ home });
  if (!dir || !(await exists(dir))) return { dir, logs: [] };
  const logs = [];
  for (const e of await readdir(dir)) {
    if (!/CEPHtmlEngine.*\.log$/i.test(e)) continue;
    const st = await stat(join(dir, e));
    logs.push({ name: e, bytes: st.size, mtime: st.mtime.toISOString() });
  }
  return { dir, logs: logs.sort((a, b) => a.name.localeCompare(b.name)) };
}
