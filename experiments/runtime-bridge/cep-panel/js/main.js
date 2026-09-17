/*
 * main.js — minimal event wiring for the ae-devtools bridge panel.
 *
 * Status: UNVERIFIED. This file has not been executed against a real
 * After Effects instance in the environment that produced this
 * repository (Linux on WSL2, no AE installed). See
 * ../EXPERIMENT-LOG.md and
 * docs/architecture/research/07-real-ae-validation.md.
 *
 * Wiring:
 *   - Each button calls csWrap.evalScriptFile(<probe .jsx path>, cb).
 *   - The callback writes its (err, value) pair into #result as JSON.
 *   - The "getCurrentApiVersion()" button writes into #api-version.
 *
 * The probes live under ../../extendscript/ relative to this panel
 * once installed into the CEP extension folder
 * (%USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions\ae-devtools-bridge\).
 * Adjust the paths if the install layout differs.
 */
(function () {
  "use strict";

  // Resolve the probes directory once. The panel's install root is
  // its own folder; the extendscript probes sit alongside it.
  var PROBES = {
    "01": "../../extendscript/01-version.jsx",
    "02": "../../extendscript/02-active-item.jsx",
    "03": "../../extendscript/03-mutate-then-inspect.jsx",
    "04": "../../extendscript/04-exception.jsx",
    "05": "../../extendscript/05-concurrent-A.jsx",
    "06": "../../extendscript/06-concurrent-B.jsx",
    "07": "../../extendscript/07-snapshot.jsx",
    "08": "../../extendscript/08-identity.jsx"
  };

  function setResult(label, err, value) {
    var el = document.getElementById("result");
    var payload = {
      probe: label,
      err: err || null,
      value: value !== undefined ? value : null
    };
    el.textContent = JSON.stringify(payload, null, 2);
  }

  function setApiVersion(v) {
    var el = document.getElementById("api-version");
    el.textContent = JSON.stringify(v);
  }

  function runProbe(probeKey) {
    if (!window.csWrap) {
      setResult(probeKey, { kind: "no_csinterface" }, null);
      return;
    }
    var path = PROBES[probeKey];
    if (!path) {
      setResult(probeKey, { kind: "unknown_probe" }, null);
      return;
    }
    csWrap.evalScriptFile(path, function (err, value) {
      setResult(probeKey, err, value);
    });
  }

  function runApiVersion() {
    if (!window.csWrap) {
      setApiVersion({ error: "no_csinterface" });
      return;
    }
    setApiVersion(csWrap.getCurrentApiVersion());
  }

  function wire() {
    var ids = ["01", "02", "03", "04", "05", "06", "07", "08"];
    ids.forEach(function (k) {
      var btn = document.getElementById("btn-" + k);
      if (btn) btn.addEventListener("click", function () { runProbe(k); });
    });
    var apiBtn = document.getElementById("btn-api-version");
    if (apiBtn) apiBtn.addEventListener("click", runApiVersion);
    var clearBtn = document.getElementById("btn-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        document.getElementById("result").textContent = "(cleared)";
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
