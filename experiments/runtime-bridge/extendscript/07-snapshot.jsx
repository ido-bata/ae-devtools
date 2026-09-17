/*
 * 07-snapshot.jsx — structured snapshot of
 *   { version, project, activeItem, selection, selectedProperties }
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 07 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * This is the read path the daemon's inspect_* verbs will fan out
 * from. The shape is intentionally minimal: we do not project
 * every AE Scripting attribute; we project only what an external
 * tool can act on without further introspection.
 */
#include "lib/util.jsx"

try {
  var snap = {
    version: String(app.version),
    project: null,
    activeItem: null,
    selection: [],
    selectedProperties: []
  };

  if (app.project) {
    snap.project = {
      numItems: app.project.numItems,
      // app.project.file is null for unsaved projects; this is
      // documented AE behavior, not a bug.
      file: app.project.file ? String(app.project.file) : null
    };
    var ai = app.project.activeItem;
    if (ai instanceof CompItem) {
      snap.activeItem = {
        type: "CompItem",
        name: ai.name,
        id: ai.id,
        numLayers: ai.numLayers,
        width: ai.width,
        height: ai.height,
        frameRate: ai.frameRate,
        duration: ai.duration
      };
      // Selection lives on the comp.
      var sel = ai.selectedLayers || [];
      for (var i = 0; i < sel.length; i++) {
        snap.selection.push({
          index: sel[i].index,
          name: sel[i].name,
          id: sel[i].id
        });
      }
      // selectedProperties is documented but its JSON shape is
      // non-trivial; v1 returns an empty array and documents the gap.
    }
  }

  return jsonOk(snap);
} catch (e) {
  return jsonErr("07-snapshot failed: " + String(e));
}
