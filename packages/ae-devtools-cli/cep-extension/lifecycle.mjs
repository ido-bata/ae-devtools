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

/** CEPHtmlEngine log dir (panel/JSX-side evidence lives here).
 *  darwin: ~/Library/Logs/CSXS (verified on real host — EVIDENCE.md).
 *  win32: the user's temp dir. Adobe's CEP Debugging Handbook
 *  (CEP_11.x/CEP_12.x, "Logs Folders") documents the Windows CEP logs
 *  folder as `%temp%` — files like CEP12-<Host>.log and
 *  CEPHtmlEngine12-<Host>-<ver>-<ext>.log sit directly in
 *  %TEMP% (typically C:\Users\<user>\AppData\Local\Temp), NOT under
 *  %APPDATA%\Adobe\CEP. Modeled path only: never exercised on a real
 *  Windows host (UNVERIFIED).
 *  Other platforms: null (unsupported). */
export function cepLogDir({ platform = process.platform, home = process.env.HOME, temp = process.env.TEMP ?? process.env.TMP } = {}) {
  if (platform === "darwin") {
    if (!home) throw new Error("HOME is required for darwin CEP log dir");
    return join(home, "Library", "Logs", "CSXS");
  }
  if (platform === "win32") {
    if (!temp) throw new Error("TEMP/TMP is required for win32 CEP log dir");
    return temp;
  }
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
export async function collectLogs({ logDir = null, home = process.env.HOME, platform = process.platform, temp = process.env.TEMP ?? process.env.TMP } = {}) {
  const dir = logDir ?? cepLogDir({ platform, home, temp });
  if (!dir || !(await exists(dir))) return { dir, logs: [] };
  const logs = [];
  for (const e of await readdir(dir)) {
    if (!/CEPHtmlEngine.*\.log$/i.test(e)) continue;
    const st = await stat(join(dir, e));
    logs.push({ name: e, bytes: st.size, mtime: st.mtime.toISOString() });
  }
  return { dir, logs: logs.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Read-only PlayerDebugMode status (CAP058 mechanization).
 *
 * CEP debug-loading of unsigned extensions requires
 * `defaults write com.adobe.CSXS.<n> PlayerDebugMode 1` on macOS —
 * this reports the CURRENT values only; it never writes. The load
 * proof (LOAD-PROOF.md) decides whether setting them is authorized.
 * Non-darwin / unreadable hosts report `unknown`, never a guess.
 */
export async function playerDebugModeStatus({ platform = process.platform, run = null } = {}) {
  if (platform !== "darwin") {
    return { platform, supported: false, keys: [], note: "PlayerDebugMode check is macOS-only here; Windows registry path is UNVERIFIED" };
  }
  const exec = run ?? (async (args) => {
    const { execFile } = await import("node:child_process");
    return new Promise((res, rej) =>
      execFile("defaults", args, { encoding: "utf8" }, (e, so) => (e ? rej(e) : res(so))));
  });
  const keys = [];
  for (const n of [11, 12]) {
    const domain = `com.adobe.CSXS.${n}`;
    try {
      const out = await exec(["read", domain, "PlayerDebugMode"]);
      keys.push({ domain, PlayerDebugMode: out.trim(), status: "set" });
    } catch {
      keys.push({ domain, PlayerDebugMode: null, status: "unset-or-unreadable" });
    }
  }
  return { platform, supported: true, keys };
}
