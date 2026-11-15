/*
 * 06-concurrent-B.jsx — short read (app.version + project state).
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 05+06 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Pairs with 05-concurrent-A.jsx. When the panel fires
 * evalScript(A) then evalScript(B) in sequence, B's
 * `observedAtMs` should be later than A's `endedAtMs`, and B's
 * `numItems` should equal A's `counts.total`.
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
  var nowMs = new Date().getTime();
  var numItems = app.project ? app.project.numItems : null;
  return jsonOk({
    version: String(app.version),
    numItems: numItems,
    observedAtMs: nowMs
  });
} catch (e) {
  return jsonErr("06-concurrent-B failed: " + String(e));
}
