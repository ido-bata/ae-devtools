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
#include "lib/util.jsx"

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
