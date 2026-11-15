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
