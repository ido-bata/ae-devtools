/*
 * 08-identity.jsx — temp comp + layer; returns index / id / name.
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 08 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Scope: this probe stops at "create + read". It does NOT exercise
 * rename / reorder / save. Those experiments require a real AE
 * and a project file on disk; they are NOT part of v1 verification
 * (see EXPERIMENT-LOG.md Probe 08 Limitations).
 *
 * Steps:
 *   1. Snapshot: app.project.numItems before mutation.
 *   2. Mutate: app.project.items.addComp("probe-08-temp", 100, 100, 1.0, 5.0).
 *   3. Add a Solid layer (av.layers.addSolid(...)).
 *   4. Capture the new comp's index, id, name and the new layer's
 *      index, id, name.
 *   5. Cleanup: remove the temp comp.
 */
#include "lib/util.jsx"

try {
  if (!app.project) {
    return jsonErr("08-identity: no app.project (open a project first)");
  }
  var before = app.project.numItems;
  var comp = app.project.items.addComp("probe-08-temp", 100, 100, 1.0, 5.0);
  var layer = comp.layers.addSolid([1, 0, 0], "probe-08-layer", 100, 100, 1.0);

  var result = {
    numItemsBefore: before,
    compIndex: comp.index,
    compId: comp.id,
    compName: comp.name,
    layerIndex: layer.index,
    layerId: layer.id,
    layerName: layer.name
  };

  // Cleanup. Removing the comp removes its layers too.
  comp.remove();

  result.numItemsAfterCleanup = app.project.numItems;
  return jsonOk(result);
} catch (e) {
  return jsonErr("08-identity failed: " + String(e));
}
