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
/*
 * util.jsx — JSON.stringify helpers that avoid circular refs and
 * projection-only fields for AE Scripting objects.
 *
 * Status: UNVERIFIED. This file has not been executed against a real
 * After Effects instance in the environment that produced this
 * repository (Linux on WSL2, no AE installed). It exists to SUPPORT
 * the verification probes, not to claim any behavior is validated.
 * See ../../EXPERIMENT-LOG.md and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * ExtendScript engine is ES3-ish. Avoid modern syntax. No arrow
 * functions, no `let`, no `const`, no `Promise`, no `Symbol`.
 * `var`, `function`, `for`, `if`, `try/catch`, `JSON.stringify`
 * (with the second-arg replacer for circular-ref detection).
 */

// toJsonSafe(obj) — JSON.stringify with circular-ref protection.
// AE's Scripting object model has back-pointers (e.g.
// app.project.activeItem.parentProject === app.project) that crash
// JSON.stringify. The replacer drops anything that would close a
// cycle by tracking already-seen objects.
function toJsonSafe(obj, maxDepth) {
  if (maxDepth === undefined) maxDepth = 8;
  var seen = [];
  function replacer(key, value) {
    if (value === null || typeof value !== "object") return value;
    if (seen.indexOf(value) !== -1) return "[Circular]";
    seen.push(value);
    // Cap depth so we don't blow up on deep property trees.
    var path = key;
    var depth = 0;
    while (path.indexOf(".") !== -1) {
      depth++;
      path = path.substring(path.indexOf(".") + 1);
    }
    if (depth > maxDepth) return "[MaxDepth]";
    return value;
  }
  return JSON.stringify(obj, replacer);
}

// jsonWrap(payload) — wraps a payload as `{ ok: <bool>, payload: <obj>, error: <string> }`
// and returns the JSON string. Probes use this so the panel side can
// rely on a uniform envelope.
function jsonWrap(ok, payload, error) {
  return JSON.stringify({
    ok: ok === true,
    payload: payload === undefined ? null : payload,
    error: error === undefined ? null : error
  });
}

// jsonOk(payload) — short form for the success path.
function jsonOk(payload) {
  return jsonWrap(true, payload, null);
}

// jsonErr(message) — short form for the failure path.
function jsonErr(message) {
  return jsonWrap(false, null, String(message));
}

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
