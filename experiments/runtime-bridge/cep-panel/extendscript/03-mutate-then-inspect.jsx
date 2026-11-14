/*
 * 03-mutate-then-inspect.jsx — two-stage probe: mutate, then return a
 * new snapshot. Confirms that CSInterface.evalScript observes in-engine
 * mutations made earlier in the same session.
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 03 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Steps:
 *   1. Snapshot: app.project.numItems before mutation.
 *   2. Mutate: app.project.items.addComp("probe-03-temp", 100, 100, 1.0, 5.0).
 *   3. Snapshot: app.project.numItems after mutation.
 *   4. Capture the new comp's name.
 *   5. Cleanup: app.project.item(N + 1).remove().
 *
 * Returns:
 *   { ok: true,
 *     payload: {
 *       numItemsBefore: <n>,
 *       numItemsAfter:  <n+1>,
 *       newCompName:    "<Untitled X>",
 *       numItemsAfterCleanup: <n>
 *     },
 *     error: null
 *   }
 *
 * Note: The two snapshots live in the SAME evalScript call here
 * because a single evalScript call is one ExtendScript job. To
 * observe mutations across SEPARATE evalScript calls, run probe 05
 * + 06 back-to-back. Both probes are part of the Windows gate W2
 * (and W4 for the cross-call case).
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
    return jsonErr("03-mutate-then-inspect: no app.project (open a project first)");
  }
  var before = app.project.numItems;
  var newComp = app.project.items.addComp("probe-03-temp", 100, 100, 1.0, 5.0);
  var after = app.project.numItems;
  var newName = newComp ? newComp.name : null;
  // Cleanup. addComp appends to the end; index == after (1-based
  // items API).
  if (newComp) {
    newComp.remove();
  }
  var afterCleanup = app.project.numItems;
  return jsonOk({
    numItemsBefore: before,
    numItemsAfter: after,
    newCompName: newName,
    numItemsAfterCleanup: afterCleanup
  });
} catch (e) {
  return jsonErr("03-mutate-then-inspect failed: " + String(e));
}
