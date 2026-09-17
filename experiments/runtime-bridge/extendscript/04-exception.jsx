/*
 * 04-exception.jsx — intentional throw to test error propagation.
 *
 * Status: UNVERIFIED. See ../EXPERIMENT-LOG.md Probe 04 and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Per the CEP 12 Cookbook, evalScript returns the value of
 * EvalScript_ErrMessage() on failure. This probe throws an Error
 * with a known message; the CEP-side wrapper at
 * `cep-panel/js/csinterface-wrapper.js` checks for non-empty
 * strings and treats them as a structured error.
 *
 * Expected panel-side observation:
 *   csInterface.evalScript(<this file>, function (result) {
 *     // result is a string starting with "Error" (or similar)
 *   });
 *
 * We do NOT catch the throw inside the probe on purpose; the
 * failure must propagate to the engine boundary.
 */
#include "lib/util.jsx"

// We can't `throw new Error(...)` because ExtendScript's Error
// constructor behaves inconsistently across engine builds. The
// canonical pattern is to call $.error(msg) or evaluate a
// non-existent identifier. $.error(msg) writes to the engine log
// AND triggers EvalScript_ErrMessage() on the engine side.
//
// Note: research/02 §CSInterface documents "the callback receives
// the string returned by ExtendScript's EvalScript_ErrMessage() on
// evaluation failure" — but the exact shape is unverified. This
// probe does not assume a particular prefix.
$.error("probe-04: intentional failure for evalScript error-path verification");
