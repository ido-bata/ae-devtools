/**
 * watch.mjs — rebuild-on-change loop for project builds (Issue #101).
 *
 * Runs `buildProject` once, then watches the entry plus every input the
 * last build reported (esbuild metafile inputs, already collected by
 * bundleProject) via node:fs — no new dependencies. Each quiet period
 * after a change triggers one rebuild; the watched set is refreshed from
 * the new build's inputs so added/removed imports are picked up.
 *
 * Watching is per-file, grouped into ONE fs.watch per parent directory
 * (editors that save via atomic rename still trigger). The build's own
 * output artifacts are excluded from the watch set so a rebuild can
 * never retrigger itself. Build failures are reported through onStatus
 * exactly like successes — the loop never stops on its own. Callers
 * receive one status object per completed build attempt; a throwing
 * onStatus is swallowed so a broken consumer cannot kill the watcher.
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
 * resolves done once any in-flight build has settled (so callers never
 * terminate mid-write); no further status is emitted after close.
 */
export function watchProject(entryPath, { outDir = null, name = null, onStatus = () => {}, debounceMs = WATCH_DEBOUNCE_MS } = {}) {
  const absEntry = resolve(entryPath);
  let inputs = [absEntry];
  // dir -> { watcher, files: Set<basename> } — one fs.watch per directory.
  const dirWatchers = new Map();
  // Resolved paths the last successful build wrote; never watched.
  let artifactPaths = new Set();
  let timer = null;
  let building = false;
  let queued = false;
  let closed = false;
  let inflight = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  function schedule() {
    if (closed) return;
    // Trailing debounce: every change restarts the quiet period, so a
    // burst of writes (truncate-then-save, editor multi-events) triggers
    // ONE rebuild after the burst instead of rebuilding mid-write.
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      startBuild();
    }, debounceMs);
  }

  function syncWatchers() {
    // The build's own outputs are never inputs — watching them would
    // let each rebuild retrigger itself forever.
    const want = new Set();
    for (const f of [absEntry, ...inputs]) {
      if (!artifactPaths.has(f)) want.add(f);
    }
    const byDir = new Map(); // dir -> Set<basename>
    for (const f of want) {
      const dir = dirname(f);
      if (!byDir.has(dir)) byDir.set(dir, new Set());
      byDir.get(dir).add(basename(f));
    }
    // Drop watchers whose files are all gone; shrink the rest.
    for (const [dir, entry] of dirWatchers) {
      const wanted = byDir.get(dir);
      if (!wanted) {
        try { entry.watcher.close(); } catch { /* already closed */ }
        dirWatchers.delete(dir);
        continue;
      }
      // Mutate the SAME Set the fs.watch closure captured: drop files no
      // longer wanted, add newly imported ones.
      for (const b of [...entry.files]) {
        if (!wanted.has(b)) entry.files.delete(b);
      }
      for (const b of wanted) entry.files.add(b);
      byDir.delete(dir);
    }
    // Remaining byDir entries are directories not yet watched.
    for (const [dir, bases] of byDir) {
      const files = new Set(bases);
      try {
        const w = fsWatch(dir, (_event, changed) => {
          if (closed) return;
          // changed === null means "something in the dir changed, name
          // unknown" on some platforms — rebuild conservatively.
          if (changed === null || files.has(changed)) schedule();
        });
        w.on("error", () => {
          // Drop the dead watcher so the next syncWatchers() recreates it.
          const cur = dirWatchers.get(dir);
          if (cur && cur.watcher === w) dirWatchers.delete(dir);
          try { w.close(); } catch { /* already closed */ }
        });
        dirWatchers.set(dir, { watcher: w, files });
      } catch {
        // Parent dir unreadable or missing — the build status reports
        // the failure; watching continues for the rest.
      }
    }
  }

  async function doBuild() {
    let status;
    try {
      const r = await buildProject(absEntry, { outDir, name });
      // A failed build (e.g. esbuild bundle-failed) reports inputs: [] —
      // keep watching the last known set so fixing the broken file still
      // triggers a rebuild.
      if (Array.isArray(r.inputs) && r.inputs.length) inputs = r.inputs;
      const written = ARTIFACT_KEYS.map((k) => r[k]).filter(Boolean).map((p) => resolve(p));
      if (written.length) artifactPaths = new Set(written);
      status = {
        schema: WATCH_SCHEMA,
        status: r.status,
        artifacts: pickArtifacts(r),
        // Report the EFFECTIVE watch set: on a failed build r.inputs is
        // empty but the previous inputs are still being watched.
        inputs: inputs.slice(),
        diagnostics: r.diagnostics ?? [],
        ts: new Date().toISOString(),
      };
    } catch (error) {
      status = {
        schema: WATCH_SCHEMA,
        status: "watch-error",
        artifacts: null,
        inputs: inputs.slice(),
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
      try {
        onStatus(status);
      } catch {
        // A throwing consumer (e.g. a broken stdout pipe) must not kill
        // the watch loop.
      }
    }
    if (queued && !closed) {
      queued = false;
      schedule();
    }
  }

  function startBuild() {
    if (closed) return;
    if (building) {
      queued = true;
      return;
    }
    building = true;
    inflight = doBuild();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const { watcher } of dirWatchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    dirWatchers.clear();
    // `done` resolves only after the in-flight build settles, so the
    // caller cannot terminate the process mid-write (partial artifacts).
    const p = inflight;
    if (p) p.then(() => resolveDone(), () => resolveDone());
    else resolveDone();
  }

  startBuild();
  return { close, done };
}
