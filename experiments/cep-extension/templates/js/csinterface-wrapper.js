/*
 * csinterface-wrapper.js
 *
 * Thin wrapper around the host-provided CSInterface with corrected
 * documentation of getCurrentApiVersion().
 *
 * Status: UNVERIFIED. This file has not been executed against a real
 * After Effects instance in the environment that produced this
 * repository (Linux on WSL2, no AE installed). It exists to SUPPORT
 * the verification probes, not to claim any behavior is validated.
 * See ../EXPERIMENT-LOG.md and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Corrected facts (per docs/architecture/research/corrections-02):
 *   - The API is `CSInterface.prototype.getCurrentApiVersion`.
 *   - Underlying native call: `window.__adobe_cep__.getCurrentApiVersion()`
 *     (a host-injected function).
 *   - The native side returns a JSON-encoded string, which the wrapper
 *     JSON.parses into an ApiVersion object.
 *   - The return shape is `{major: <num>, minor: <num>, micro: <num>}`.
 *   - It is NOT a string like "12.0" and NOT a single number.
 *   - This API has existed since CSInterface 4.2.0; on CEP 4.0 / 4.1
 *     hosts the call does not exist and extensions targeting those
 *     hosts must use `manifest.xml` RequiredRuntime instead.
 *   - There is NO `CSInterface.VERSION_11` / `CSInterface.VERSION_12`
 *     constant on the current shipped CSInterface prototype or class.
 *     Compare against `apiVersion.major` directly.
 *
 * The wrapper exposes:
 *   - `csWrap`                  : the singleton wrapper instance
 *   - `csWrap.cs`               : the underlying CSInterface instance
 *   - `csWrap.evalScript(src, cb)` : thin pass-through to cs.evalScript
 *   - `csWrap.getCurrentApiVersion()` : returns the corrected shape
 *   - `csWrap.evalScriptJson(src, cb)` : convenience wrapper that
 *     JSON.parses the callback result if it is non-empty.
 *   - `csWrap.evalScriptFile(path, cb)` : convenience wrapper that
 *     loads a script from a fixed path and evalScripts it. Used by
 *     main.js to fire the .jsx probes.
 *
 * Note: CSInterface.js is provided by the host at runtime; this
 * wrapper relies on `new CSInterface()` being available in the global
 * scope. See research/02-cep-deep-dive.md §CSInterface for the
 * contract.
 */
(function (root) {
  "use strict";

  if (typeof CSInterface !== "function") {
    // CSInterface.js is host-provided. If it is missing, surface a
    // clear error in the console instead of throwing at first use.
    console.error(
      "[csinterface-wrapper] CSInterface is not defined. " +
      "This panel expects CSInterface.js to be provided by the host " +
      "(see research/02-cep-deep-dive.md §CSInterface)."
    );
  }

  function CsWrap() {
    if (typeof CSInterface !== "function") {
      throw new Error("CSInterface is not defined (host did not provide CSInterface.js).");
    }
    this.cs = new CSInterface();
  }

  /**
   * Calls CSInterface.evalScript from the panel's TOP-LEVEL frame.
   *
   * Per research/02-cep-deep-dive.md §CSInterface and
   * Adobe-CEP issue #364 (CEP 11 nested-iframe regression):
   * evalScript callbacks are not reliably delivered when called from
   * a nested iframe. main.js must call this from the top-level
   * document only.
   */
  CsWrap.prototype.evalScript = function (source, callback) {
    // If we are inside a nested iframe, refuse the call and surface
    // a console error rather than silently dropping the callback.
    if (window.parent && window.parent !== window) {
      console.error(
        "[csinterface-wrapper] evalScript called from a nested iframe. " +
        "Call from the panel's TOP-LEVEL frame only (research 02, " +
        "Adobe-CEP issue #364)."
      );
    }
    return this.cs.evalScript(source, callback);
  };

  /**
   * Convenience: evalScript + JSON.parse the callback result.
   * The callback receives `err` (non-null on failure) and `value`
   * (parsed JSON object, or the raw string on parse failure).
   *
   * ExtendScript-side scripts MUST JSON.stringify their return value.
   * CSInterface.evalScript's callback always receives a string.
   */
  CsWrap.prototype.evalScriptJson = function (source, callback) {
    var self = this;
    self.evalScript(source, function (raw) {
      if (typeof raw === "string" && raw.length > 0) {
        try {
          callback(null, JSON.parse(raw));
          return;
        } catch (parseErr) {
          // Some ExtendScript errors are returned as plain strings
          // (EvalScript_ErrMessage). Forward them as a structured error.
          callback({ kind: "parse_error", raw: raw, cause: parseErr }, null);
          return;
        }
      }
      callback({ kind: "empty_result", raw: raw }, null);
    });
  };

  /**
   * Convenience: load a fixed-path script file and evalScript it.
   *
   * CEP panels cannot include() arbitrary local files in panel JS;
   * the path is loaded via XHR and evalScript'd. This is the pattern
   * research/02 documents for "<ScriptPath> in manifest" + evalScript.
   */
  CsWrap.prototype.evalScriptFile = function (jsxPath, callback) {
    var self = this;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", jsxPath, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200) {
        callback({ kind: "xhr_error", status: xhr.status, body: xhr.responseText }, null);
        return;
      }
      self.evalScriptJson(xhr.responseText, callback);
    };
    xhr.send();
  };

  /**
   * Returns the host's CEP engine version as
   *   { major: <num>, minor: <num>, micro: <num> }
   *
   * CORRECTED DESCRIPTION (per research/corrections-02):
   *   - API name: `CSInterface.prototype.getCurrentApiVersion`.
   *   - The wrapper parses JSON returned by the host-injected
   *     `window.__adobe_cep__.getCurrentApiVersion()`.
   *   - The return is an object with three numeric fields, NOT a
   *     string and NOT a single number.
   *   - For CEP 12: e.g. {major: 12, minor: 0, micro: 0}.
   *   - For CEP 11 (AE 24.x, community-attributed): e.g.
   *     {major: 11, minor: 1, micro: 0}.
   *
   * IMPORTANT: Do NOT use a non-existent `CSInterface.VERSION_11` /
   * `CSInterface.VERSION_12` constant. Compare against
   * `apiVersion.major` directly.
   */
  CsWrap.prototype.getCurrentApiVersion = function () {
    // Delegate to CSInterface.prototype.getCurrentApiVersion so the
    // host-provided implementation is used. The wrapper does not
    // reimplement the parse step.
    if (typeof this.cs.getCurrentApiVersion !== "function") {
      return {
        error:
          "getCurrentApiVersion is not a function on the host-provided " +
          "CSInterface. The host is running CSInterface < 4.2.0 (or CEP " +
          "< 4.2.0). See research/corrections-02."
      };
    }
    var v = this.cs.getCurrentApiVersion();
    // Sanity-check the shape; per research/corrections-02, it must
    // be {major, minor, micro} with numeric fields.
    if (
      !v ||
      typeof v.major !== "number" ||
      typeof v.minor !== "number" ||
      typeof v.micro !== "number"
    ) {
      return {
        error:
          "getCurrentApiVersion returned an unexpected shape; " +
          "expected {major: number, minor: number, micro: number}. " +
          "Got: " + JSON.stringify(v),
        raw: v
      };
    }
    return v;
  };

  root.csWrap = new CsWrap();
})(window);
