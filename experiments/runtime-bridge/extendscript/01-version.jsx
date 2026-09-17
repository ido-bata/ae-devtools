/*
 * 01-version.jsx — returns app.version as JSON.
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 01 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * This is the simplest probe. It exists to confirm that the
 * CSInterface.evalScript round-trip works end-to-end. Returns:
 *   { ok: true, payload: { version: "<x.y.z>" }, error: null }
 *
 * Per the CEP 12 Cookbook, `app.version` is a string; the exact
 * format ("25.0.0", "25.1.2", etc.) depends on the AE point
 * release. This probe does not assert any particular shape; the
 * Actual / Evidence sections of the EXPERIMENT-LOG entry are where
 * the observed value gets recorded.
 */
#include "lib/util.jsx"

try {
  var v = app.version;
  return jsonOk({ version: String(v) });
} catch (e) {
  return jsonErr("01-version failed: " + String(e));
}
