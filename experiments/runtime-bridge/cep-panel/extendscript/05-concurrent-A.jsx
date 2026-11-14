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
