/**
 * watch.mjs — rebuild-on-change loop for project builds (Issue #101).
 *
 * Runs `buildProject` once, then watches the entry plus every input the
 * last build reported (esbuild metafile inputs, already collected by
 * bundleProject) via node:fs — no new dependencies. Each quiet period
 * after a change triggers one rebuild; the watched set is refreshed from
 * the new build's inputs so added/removed imports are picked up.
 *
 * Watching is per-file on the parent directory (editors that save via
 * atomic rename still trigger). Build failures are reported through
 * onStatus exactly like successes — the loop never stops on its own.
 * Callers receive one status object per completed build attempt and
 * must serialize onStatus consumption themselves if needed.
 */
import { watch as fsWatch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { buildProject } from "./build.mjs";

export const WATCH_SCHEMA = "ae-devtools.jsx-toolchain.watch/v1";
export const WATCH_DEBOUNCE_MS = 100;

const ARTIFACT_KEYS = ["jsxPath", "mapPath", "bundleMapPath", "bundlePath"];

function pickArtifacts(r) {
  const artifacts = {};
  for (const k of ARTIFACT_KEYS) if (r[k]) artifacts[k] = r[k];
  return Object.keys(artifacts).length ? artifacts : null;
}

/**
 * Start watching. Returns { close, done }: close() stops watchers and
 * resolves done; an in-flight build is allowed to finish writing but no
 * further status is emitted after close.
 */
export function watchProject(entryPath, { outDir = null, name = null, onStatus = () => {}, debounceMs = WATCH_DEBOUNCE_MS } = {}) {
  const absEntry = resolve(entryPath);
  let inputs = [absEntry];
  const watchers = new Map(); // file -> fs.FSWatcher on its parent dir
  let timer = null;
  let building = false;
  let queued = false;
  let closed = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  function schedule() {
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void runBuild();
    }, debounceMs);
  }

  function syncWatchers() {
    const want = new Set([absEntry, ...inputs]);
    for (const [file, w] of watchers) {
      if (want.has(file)) continue;
      try { w.close(); } catch { /* already closed */ }
      watchers.delete(file);
    }
    for (const file of want) {
      if (watchers.has(file)) continue;
      const dir = dirname(file);
      const base = basename(file);
      try {
        const w = fsWatch(dir, (_event, changed) => {
          if (closed) return;
          // changed === null means "something in the dir changed, name
          // unknown" on some platforms — rebuild conservatively.
          if (changed === null || changed === base) schedule();
        });
        w.on("error", () => { /* dir removed etc.; next build re-syncs */ });
        watchers.set(file, w);
      } catch {
        // Parent dir unreadable or file's dir missing — the build status
        // reports the failure; watching continues for the rest.
      }
    }
  }

  async function runBuild() {
    if (closed) return;
    if (building) {
      queued = true;
      return;
    }
    building = true;
    let status;
    try {
      const r = await buildProject(absEntry, { outDir, name });
      // A failed build (e.g. esbuild bundle-failed) reports inputs: [] —
      // keep watching the last known set so fixing the broken file still
      // triggers a rebuild.
      if (Array.isArray(r.inputs) && r.inputs.length) inputs = r.inputs;
      status = {
        schema: WATCH_SCHEMA,
        status: r.status,
        artifacts: pickArtifacts(r),
        inputs: r.inputs ?? [],
        diagnostics: r.diagnostics ?? [],
        ts: new Date().toISOString(),
      };
    } catch (error) {
      status = {
        schema: WATCH_SCHEMA,
        status: "watch-error",
        artifacts: null,
        inputs: [absEntry],
        diagnostics: [{
          severity: "error",
          code: "watch-error",
          message: String(error?.message ?? error),
        }],
        ts: new Date().toISOString(),
      };
    } finally {
      building = false;
    }
    if (!closed) {
      syncWatchers();
      onStatus(status);
    }
    if (queued && !closed) {
      queued = false;
      schedule();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const w of watchers.values()) {
      try { w.close(); } catch { /* already closed */ }
    }
    watchers.clear();
    resolveDone();
  }

  void runBuild();
  return { close, done };
}
