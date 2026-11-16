/*
 * host.jsx — sample ExtendScript host script for this panel
 * (generated scaffold, Issue #36 devkit).
 *
 * ExtendScript is ES3: `var` / `function` only — no let/const, no
 * arrow functions, no classes, no JSON.*, no Array.prototype iteration
 * helpers (forEach/map/filter/...). `devkit.mjs validate` runs a
 * documented ES3 *subset* check over every *.jsx in the extension;
 * keep this file inside that subset.
 *
 * How the panel reaches this file (pick one):
 *   1. Inline its body into csWrap.evalScript("...", cb) — see
 *      js/main.js for the evalScript pattern already wired up.
 *   2. XHR-load this file from panel JS and evalScript the text
 *      (reference impl: evalScriptFile in
 *      experiments/runtime-bridge/cep-panel/js/csinterface-wrapper.js).
 *   3. From ExtendScript itself: $.evalFile("<abs path>/jsx/host.jsx").
 *
 * CSInterface.evalScript returns the script's completion value as a
 * string, so this file ends with an expression that produces a
 * JSON-shaped string built by concatenation (no JSON.stringify —
 * ExtendScript does not guarantee it).
 *
 * Contract notes:
 *   - app.version is an ExtendScript *attribute* (property), never
 *     app.version().
 *   - ExtendScript has no `try { } finally { }`-free error channel to
 *     the panel: a thrown error surfaces to evalScript as the
 *     "EvalScript error." sentinel string.
 */
(function () {
  var out = "{";
  out += '"appVersion":"' + String(app.version) + '"';
  var proj = app.project;
  if (proj) {
    // proj.file is null for an unsaved project; fsName is the
    // platform path. Both are ExtendScript properties, not calls.
    out += ',"project":"' +
      String(proj.file ? proj.file.fsName : "(unsaved)") + '"';
  }
  out += "}";
  // The IIFE's return value is the script's completion value, which
  // is what CSInterface.evalScript hands back to the panel callback.
  return out;
})();
