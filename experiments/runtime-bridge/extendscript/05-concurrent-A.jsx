/*
 * 05-concurrent-A.jsx — long-ish safe read (walk project tree).
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 05 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Designed to pair with 06-concurrent-B.jsx. Probe A walks the
 * project tree; Probe B returns app.version. When the two are
 * fired back-to-back from the CEP panel (or from the daemon in
 * sequence), Probe B's timestamp should be strictly later than
 * Probe A's, and Probe B should observe the same numItems that
 * Probe A reported.
 *
 * This probe walks the project tree without mutating anything,
 * so it is safe to run multiple times.
 */
#include "lib/util.jsx"

try {
  if (!app.project) {
    return jsonErr("05-concurrent-A: no app.project (open a project first)");
  }
  var startMs = new Date().getTime();
  var counts = {
    comps: 0,
    footages: 0,
    folders: 0,
    total: app.project.numItems,
    layers: 0
  };
  // Walk items.
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (!it) continue;
    if (it instanceof CompItem) {
      counts.comps++;
      counts.layers += it.numLayers;
    } else if (it instanceof FootageItem) {
      counts.footages++;
    } else {
      // FolderItem has typeName "Folder".
      counts.folders++;
    }
  }
  var endMs = new Date().getTime();
  return jsonOk({
    counts: counts,
    durationMs: endMs - startMs,
    startedAtMs: startMs,
    endedAtMs: endMs
  });
} catch (e) {
  return jsonErr("05-concurrent-A failed: " + String(e));
}
