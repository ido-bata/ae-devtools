/*
 * 02-active-item.jsx — JSON projection of app.project.activeItem.
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 02 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * The probe projects a small, stable set of fields. The exact set
 * is what we expect to be the "inspect_active_item" verb's payload
 * in the daemon's read surface (see ADR-0001 §2 Boundary placement).
 *
 * If activeItem is null, returns { ok: true, payload: { activeItem: null } }.
 */
#include "lib/util.jsx"

try {
  var ai = app.project ? app.project.activeItem : null;
  if (ai === null) {
    return jsonOk({ activeItem: null });
  }
  var projection = {
    type: ai.typeName || (ai instanceof CompItem ? "CompItem" : "Item"),
    name: ai.name,
    id: ai.id
  };
  if (ai instanceof CompItem) {
    projection.numLayers = ai.numLayers;
    projection.width = ai.width;
    projection.height = ai.height;
    projection.frameRate = ai.frameRate;
    projection.duration = ai.duration;
    projection.bgColor = ai.bgColor; // array [r,g,b]
  } else if (ai instanceof FootageItem) {
    projection.file = ai.file ? String(ai.file) : null;
    projection.width = ai.width;
    projection.height = ai.height;
    projection.frameRate = ai.frameRate;
    projection.duration = ai.duration;
  }
  return jsonOk({ activeItem: projection });
} catch (e) {
  return jsonErr("02-active-item failed: " + String(e));
}
