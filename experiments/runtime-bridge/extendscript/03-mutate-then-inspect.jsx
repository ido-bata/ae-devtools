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
#include "lib/util.jsx"

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
