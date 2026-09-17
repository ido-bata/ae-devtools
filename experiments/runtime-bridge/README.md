# experiments/runtime-bridge

> Status: **Unverified.** This directory contains artifacts designed to
> validate (or invalidate) `docs/architecture/ADR-0001-runtime-bridge.md`
> on a real After Effects instance. **None of the CEP-side or
> ExtendScript-side code has been executed in the environment that
> produced this repository** — that environment is Linux on WSL2 with
> no After Effects installed. The Node.js server-side half can be
> syntax-checked and run on Linux without AE. See
> `docs/architecture/research/07-real-ae-validation.md` for the full
> validation record.

---

## Purpose

This directory holds the smallest set of runnable artifacts that, when
executed against a live After Effects 25.x instance, will produce the
evidence required to:

1. Promote `ADR-0001-runtime-bridge.md` from **Proposed** to **Accepted**
   by clearing the **Windows gate** conditions (W1–W7).
2. Begin the **macOS / Linux gate** conditions (M1–M4) on whatever
   platform becomes available.
3. Confirm or refute the corrected facts in
   `research/corrections-01-adobe-cep-org.md` and
   `research/corrections-02-cep-ae-mapping.md` against observed behavior.

The artifacts are deliberately thin. They are **not** a feature
implementation; they are probes. Each ExtendScript file is a single,
self-contained experiment; each one is paired with a section in
`EXPERIMENT-LOG.md`.

---

## Structure

```
experiments/runtime-bridge/
├── README.md                         # this file
├── EXPERIMENT-LOG.md                 # one section per probe; Actual = "Not executed"
├── spike.sh                          # one-line reproducer; clearly marked "requires Windows AE"
│
├── cep-panel/                        # the CEP 12 panel half (M1)
│   ├── CSXS/
│   │   └── manifest.xml              # CEP 12 manifest, host list = After Effects
│   ├── index.html                    # minimal HTML shell
│   └── js/
│       ├── main.js                   # minimal event wiring calling CSInterface.evalScript
│       └── csinterface-wrapper.js    # wrapper around CSInterface with corrected getCurrentApiVersion()
│
├── extendscript/                     # the ExtendScript probe library
│   ├── 01-version.jsx                # returns app.version as JSON
│   ├── 02-active-item.jsx            # returns JSON projection of app.project.activeItem
│   ├── 03-mutate-then-inspect.jsx    # two-stage: mutate, then return new snapshot
│   ├── 04-exception.jsx              # intentional throw to test error propagation
│   ├── 05-concurrent-A.jsx           # long-ish safe read, e.g., walk project tree
│   ├── 06-concurrent-B.jsx           # app.version, short read
│   ├── 07-snapshot.jsx               # structured snapshot
│   ├── 08-identity.jsx               # temp comp + layer, returns index/id/name
│   └── lib/
│       └── util.jsx                  # JSON.stringify helpers avoiding circular refs
│
└── node-server/                      # the external daemon half (M3); runnable on Linux without AE
    ├── server.js                     # HTTP loopback server with auth-token check
    ├── package.json                  # zero runtime deps
    └── README.md                     # how to run on Linux without AE
```

---

## What can run in this environment (Linux on WSL2, no AE)

- The Node.js server (`node-server/server.js`) can be syntax-checked
  with `node --check node-server/server.js` and run with
  `node node-server/server.js`. It binds to `127.0.0.1` only and
  requires the `AE_BRIDGE_TOKEN` env var.
- The shell artifact `spike.sh` is a no-op in this environment; it
  documents the Windows-AE invocation pattern but does not run.

## What cannot run in this environment

- **All CEP-panel code** (`cep-panel/...`). CEP panels require a
  CEP-enabled host (After Effects on Windows or macOS, with
  `PlayerDebugMode=1` and the panel installed in a CEP extension folder).
- **All ExtendScript code** (`extendscript/...`). ExtendScript evaluates
  inside a running After Effects ExtendScript engine; it cannot run on
  bare Linux without AE.

Each probe's `Actual` section in `EXPERIMENT-LOG.md` therefore reads
**"Not executed — this environment (Linux on WSL2) has no After Effects
installed."** We do not fabricate measurements.

---

## How to reproduce (on a Windows AE machine)

These steps assume a Windows host with After Effects 25.x installed.
`PlayerDebugMode=1` must be set per `research/02-cep-deep-dive.md`
§Signing model (Windows registry path:
`HKEY_CURRENT_USER\Software\Adobe\CSXS.<ver>` with string value
`PlayerDebugMode="1"`, where `<ver>` is `12` for CEP 12 / AE 25.x).

1. **Copy the panel into a CEP extension folder.** Either:
   - Symlink the panel + the probe tree together. The CEP panel
     references ExtendScript probes via relative paths
     (`../../extendscript/...`), so both `cep-panel/` and `extendscript/`
     must be siblings under the install root. Concretely:
     ```
     %USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions\ae-devtools-bridge\
       cep-panel\         <- this repo's cep-panel/
       extendscript\      <- this repo's extendscript/
     ```
     with the install root basename `ae-devtools-bridge` matching the
     manifest's `<ExtensionId>`. **or**
   - Run `spike.sh` which prints the install commands.

2. **Restart After Effects.** The CEP extension does not load until AE
   starts (research 02 §Load timing). The panel appears in
   `Window > Extensions > ae-devtools-bridge` after restart.

3. **Open a project with at least one composition.** Probes 02, 03,
   05, 07, and 08 require a non-null `app.project`.

4. **Run the ExtendScript probes from the Scripts menu.**
   - `File > Scripts > Run Script File...` and pick each `.jsx` file in
     turn.
   - Or have the CEP panel call `evalScript` on each file via the
     `main.js` button wiring.

5. **Start the daemon** on the same machine:
   ```
   cd node-server
   AE_BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') \
     PORT=7000 node server.js
   ```

6. **Send a probe request** from any HTTP client:
   ```
   curl -sS -X POST http://127.0.0.1:7000/eval \
     -H "Content-Type: application/json" \
     -H "X-AE-Bridge-Token: $AE_BRIDGE_TOKEN" \
     -d '{"id":"probe-01","source":"return JSON.stringify({version: app.version});"}'
   ```
   (The server stub in this repository is intentionally minimal; it
   accepts the request, verifies the token, and echoes a "no panel
   attached" payload. Wiring up the panel→daemon forwarding is part
   of the actual implementation, not the verification probes.)

7. **Record outcomes** by copying the Actual/Evidence sections from
   `EXPERIMENT-LOG.md` into the same file, replacing the
   `Not executed — …` placeholder.

---

## Conventions

- ExtendScript probes return **JSON strings** (built with
  `JSON.stringify`) so the panel side can `JSON.parse` directly.
  Complex AE objects are flattened with `lib/util.jsx` helpers
  (`toJsonSafe`) to avoid circular-reference errors.
- The CEP-side code calls `CSInterface.evalScript` from the panel's
  **top-level frame** only (research 02 §CSInterface — CEP 11 nested
  iframe regression, Adobe-CEP issue #364).
- `CSInterface.getCurrentApiVersion()` is consumed through the wrapper
  at `cep-panel/js/csinterface-wrapper.js`. The wrapper documents
  the actual API name and return shape so the next reader does not
  have to re-derive them.

---

## Source-quality rules

- All Adobe-official URLs cited in `docs/architecture/research/` are
  valid as of 2026-09-18 (see `research/corrections-01` for the
  `Adobe-CEP` org status update). The CEP 12 Cookbook remains the
  authoritative source for `evalScript`, `--enable-nodejs`,
  `PlayerDebugMode`, and CEF flags.
- This directory does not bundle `CSInterface.js` or `Vulcan.js`;
  those are provided by the host at runtime
  (`%COMMONPROGRAMFILES%\Adobe\CEP\resources\CEPHtmlEngine\CSInterface.js`
  on Windows per Adobe community documentation).
- No claim is "validated" until the corresponding probe runs against
  a live AE 25.x instance and the Actual section is filled in.
