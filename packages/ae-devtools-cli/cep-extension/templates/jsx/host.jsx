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
 *   2. XHR-load this file from panel JS and evalScript the text —
 *      see evalScriptFile in the bundled js/csinterface-wrapper.js.
 *   3. From ExtendScript itself: $.evalFile("<abs path>/jsx/host.jsx").
 *
 * CSInterface.evalScript returns the script's completion value as a
 * string, so this file ends with an expression that produces a
 * JSON-shaped string built by concatenation (no JSON.stringify —
 * ExtendScript does not guarantee it). Interpolated values MUST go
 * through jsonString() below: a Windows path contains backslashes
 * that are illegal JSON escapes, and a raw '"' breaks the document.
 *
 * Contract notes:
 *   - app.version is an ExtendScript *attribute* (property), never
 *     app.version().
 *   - The only error signal crossing the panel boundary is the host's
 *     "EvalScript error." sentinel string — there is no structured
 *     error channel, so this sample cannot report which line failed.
 */
(function () {
  // ES3-safe JSON string encoder: quotes, backslashes and control
  // characters are escaped; everything else passes through. String
  // concatenation only — no JSON.*, no replace callbacks needed.
  function jsonString(value) {
    var s = String(value);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') { out += '\\"'; }
      else if (c === "\\") { out += "\\\\"; }
      else if (c === "\n") { out += "\\n"; }
      else if (c === "\r") { out += "\\r"; }
      else if (c === "\t") { out += "\\t"; }
      else if (code < 32 || (code > 126 && code < 160)) {
        var hex = code.toString(16);
        while (hex.length < 4) { hex = "0" + hex; }
        out += "\\u" + hex;
      } else {
        out += c;
      }
    }
    return out + '"';
  }

  var out = "{";
  out += '"appVersion":' + jsonString(app.version);
  var proj = app.project;
  if (proj) {
    // proj.file is null for an unsaved project; fsName is the
    // platform path. Both are ExtendScript properties, not calls.
    out += ',"project":' +
      jsonString(proj.file ? proj.file.fsName : "(unsaved)");
  }
  out += "}";
  // The IIFE's return value is the script's completion value, which
  // is what CSInterface.evalScript hands back to the panel callback.
  return out;
})();
