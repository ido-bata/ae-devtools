# EXPERIMENT-LOG — runtime-bridge probes

> Status: **Unverified.** Every Actual section in this log says
> **"Not executed — this environment (Linux on WSL2) has no After Effects
> installed."** This is intentional. We do not fabricate measurements.
> See `docs/architecture/research/07-real-ae-validation.md` for the
> validation record that explains why nothing was executed in this round
> and which probes are required for the **Windows gate** in
> `ADR-0001-runtime-bridge.md`.
>
> Format per experiment: **Purpose / Environment / Procedure / Expected /
> Actual / Result / Evidence / Limitations.**

---

## Probe 01 — `app.version` from CEP `evalScript` (Windows gate W1, W5)

### Purpose
Confirm that a CEP 12 panel on Windows AE 25.x can call
`CSInterface.evalScript` with a one-line ExtendScript snippet that
returns `app.version` as a JSON string, and that the panel-side
callback receives that string and can `JSON.parse` it.

### Environment (target)
- Windows 10/11, After Effects 25.x, CEP 12 (per CEP 12 Cookbook
  FY2024 row: AEFT 25.0 → CEP 12).
- `PlayerDebugMode=1` in
  `HKEY_CURRENT_USER\Software\Adobe\CSXS.12`.
- Panel installed at
  `%USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions\ae-devtools-bridge`.

### Procedure
1. Open AE with any project.
2. Open the panel: `Window > Extensions > ae-devtools-bridge`.
3. Click the "Run 01-version" button. The button invokes
   `main.js#run01Version()` which calls
   `csInterface.evalScript(<contents of extendscript/01-version.jsx>)`.
4. The callback receives a JSON string and prints it into the
   `#result-01` element.

### Expected
- `app.version` returns a non-empty string. Common values: `"25.0.0"`,
  `"25.1.0"`, etc.
- The JSON wrapper returns `{ "version": "<that string>" }`.

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed. No real-AE validation possible in this round.

### Result
Pending. Expected to pass on a real AE 25.x.

### Evidence
None yet. (On a real run: copy the panel's `#result-01` text into
this section and add a screenshot or DevTools console excerpt.)

### Limitations
- The probe only confirms the path; it does not measure timing.
- Different AE 25.x point releases may report slightly different
  version strings.

---

## Probe 02 — `app.project.activeItem` JSON projection (Windows gate W1)

### Purpose
Confirm that a non-trivial `app.*` object can be JSON-serialized and
shipped across the `evalScript` boundary without loss of the public
attributes AE's Scripting API documents.

### Environment (target)
- Same as Probe 01.
- A project with at least one composition is open and `activeItem`
  is that comp.

### Procedure
1. Open a project with a comp. Make that comp active.
2. Open the panel; click "Run 02-active-item".

### Expected
- Returns `{ "type": "CompItem", "name": "<name>", "id": <num>,
  "numLayers": <n>, "width": <num>, "height": <num>,
  "frameRate": <num>, "duration": <num> }`.
- The exact field set is what `extendscript/02-active-item.jsx`
  projects. If AE's runtime object exposes additional fields, the
  probe can be extended; do not change the v1 set without an ADR
  amendment.

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- AE's `activeItem` may be `null` if no comp is active. The probe
  returns `{ "activeItem": null }` in that case.
- The JSON projection deliberately omits `app.project.activeItem.layer(i)`
  references; `layer.id` persistence across Save→Quit→Reload is
  unverified (research 03 §Unverified items).

---

## Probe 03 — Mutate-then-inspect (Windows gate W2)

### Purpose
Confirm that `evalScript` correctly observes in-engine mutations made
by an earlier `evalScript` call. Without this, the daemon's contract
("a sequence of requests sees a sequence of effects") is unsound.

### Environment (target)
- Same as Probe 01.
- A project with at least one comp is open.

### Procedure
1. Open the panel; click "Run 03-mutate-then-inspect".
2. The probe creates a temp composition with `app.project.items.addComp(...)`,
  captures a snapshot of `project.numItems`, then asks
  `app.project.item(numItems)` to return the new item's name.

### Expected
- Initial `numItems`: `N`.
- After mutation: `N + 1`.
- The new comp's `name` is the default ("Untitled X").

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- The probe does not undo the temp comp. A real run should clean up
  via `app.project.item(N).remove()` before declaring success; the
  current `.jsx` does the cleanup at the end (`remove()` call at
  the bottom of the script).
- If AE's `evalScript` is genuinely serial (one call at a time on
  the main thread), this probe is trivially correct. The real
  question is whether back-to-back calls can race; that is Probe
  05+06 territory.

---

## Probe 04 — Intentional ExtendScript throw (Windows gate W3)

### Purpose
Confirm that an ExtendScript-side throw is propagated back to the
CEP panel via `EvalScript_ErrMessage()` (or equivalent). Without
this, the daemon cannot surface ExtendScript failures to clients.

### Environment (target)
- Same as Probe 01.

### Procedure
1. Open the panel; click "Run 04-exception".
2. The probe raises `throw new Error("probe-04: intentional failure");`.
3. The panel callback receives the error string.

### Expected
- `result` is a non-empty string starting with `Error` (CEP 12 ships
  `EvalScript_ErrMessage()` per the Cookbook).
- The wrapper at `csinterface-wrapper.js` flags the call as failed.

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- The exact shape of the error string is documented in
  `research/02-cep-deep-dive.md` §evalScript signature but not
  empirically verified. AE may prefix line numbers or wrap in JSON.

---

## Probe 05 + 06 — Concurrent A/B pattern (Windows gate W4)

### Purpose
Confirm that two `CSInterface.evalScript` calls fired back-to-back
serialize cleanly: the second call's callback does not race the
first's effects. This is the "split into small parts" pattern from
the CEP 12 Cookbook, made observable.

### Environment (target)
- Same as Probe 01, with a non-trivial project (≥10 comps or layers).

### Procedure
1. Open the panel; click "Run 05-concurrent-A" then immediately
   "Run 06-concurrent-B". (In the daemon this would be two
   sequenced `evalScript` requests; the probe manual firing is the
   equivalent for the v1 verification.)
2. Probe 05 walks the project tree and returns a count of items.
3. Probe 06 returns `app.version` and a wall-clock timestamp from
   ExtendScript.

### Expected
- Both callbacks fire (no lost callbacks).
- The Probe 06 timestamp is **after** the Probe 05 timestamp
  (ExtendScript engine processed 05 before 06).
- Probe 06 observes the same `app.project.numItems` that Probe 05
  reported.

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- This probe does not measure true concurrency (it does not test
  what happens if Probe 06 fires while Probe 05 is still mid-script).
  The CEP panel's `evalScript` API does not expose "fire and
  inspect" — calls are queued on the panel side and dispatched by
  the host. True concurrency stress is harder to set up and is
  documented under "Limitations" below; this probe covers the
  ordering guarantee, which is what the daemon relies on.

---

## Probe 07 — Structured snapshot (Windows gate W1)

### Purpose
Confirm that a structured snapshot of `{version, project,
activeItem, selection, selectedProperties}` can be returned in a
single `evalScript` call without exceeding AE's payload size
limits. This is the **read** path that the daemon's `inspect_*`
verbs will fan out from.

### Environment (target)
- Same as Probe 01, with a comp open and at least one layer
  selected.

### Procedure
1. Open AE; create a comp; add one layer; select it.
2. Open the panel; click "Run 07-snapshot".

### Expected
- Returns `{ version: "<x.y.z>", project: { path: "<abs path>",
  numItems: <n> }, activeItem: { type: "CompItem", name: "<n>",
  numLayers: <n> }, selection: [{ index: 0, name: "<n>",
  id: <num> }], selectedProperties: [] }`.
- `selectedProperties` is empty when no property is selected.

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- AE's `selectedProperties` is an array of `Property` objects whose
  JSON projection is non-trivial. The probe returns `[]` in v1 and
  documents the gap; richer projection is a v2 concern.

---

## Probe 08 — Temp comp / layer identity (deferred; requires real AE)

### Purpose
Establish that creating a temp comp + layer via ExtendScript,
capturing `index`, `id`, and `name`, and reading them back via a
follow-up `evalScript` call produces consistent values. The
**rename/reorder/save** experiment requires real AE and is **not in
this probe**; this probe stops at "create + read" only.

### Environment (target)
- Same as Probe 01.

### Procedure
1. Open the panel; click "Run 08-identity".
2. The probe creates a temp comp + layer; captures `index`, `id`,
   `name`; returns them; then removes the comp.

### Expected
- `{ compIndex: N, layerIndex: 0, layerName: "<default>",
  layerId: <num> }`.
- After cleanup, the project's `numItems` is back to its prior
  value.

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- This probe does not test Save→Quit→Reload. AE's `layer.id`
  persistence across Save→Quit→Reload is unverified (research 03
  §Unverified items). A future probe ("09-persistence") is needed
  for that; out of scope here.

---

## Probe 09 — `CSInterface.getCurrentApiVersion()` shape (Windows gate W5)

### Purpose
Confirm that `CSInterface.getCurrentApiVersion()` returns an object
with `{major, minor, micro}` numeric fields (not a string, not a
single number). This is the corrected description in
`research/corrections-02`.

### Environment (target)
- Same as Probe 01.

### Procedure
1. Open the panel; click "Run getApiVersion".
2. The wrapper at `cep-panel/js/csinterface-wrapper.js` logs the
   returned object and asserts `typeof v.major === 'number'`.

### Expected
- On AE 25.x with CEP 12: `{major: 12, minor: 0, micro: 0}`
  (or whatever point build Adobe ships).
- On AE 24.x (community-attributed CEP 11): `{major: 11, minor: 1,
  micro: 0}` (community-attributed, not Cookbook-confirmed).

### Actual
Not executed — this environment (Linux on WSL2) has no After Effects
installed.

### Result
Pending.

### Evidence
None yet.

### Limitations
- The minor/micro values depend on Adobe's build; the **major**
  value is what the project gates on.

---

## Probe 10 — Daemon loopback contract (Linux-runnable in this environment)

### Purpose
Confirm that the Node.js server (`node-server/server.js`) binds to
`127.0.0.1` only, requires the `X-AE-Bridge-Token` header to match
`AE_BRIDGE_TOKEN`, rejects missing or wrong tokens with HTTP 401,
and echoes a structured payload on accepted requests. This is the
**external daemon half** (M3) and is **runnable on Linux without
AE**; it is the only probe in this log that can be executed in the
current environment.

### Environment (this round)
- Linux on WSL2, Node.js (no AE).

### Procedure
1. `cd node-server && node --check server.js` — syntax check.
2. Start the server:
   ```
   AE_BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') \
     PORT=7000 node server.js &
   ```
3. Probe missing-token: `curl -sS -i -X POST http://127.0.0.1:7000/eval -d '{}'` — expect HTTP 401.
4. Probe wrong-token: `curl -sS -i -X POST http://127.0.0.1:7000/eval -H "X-AE-Bridge-Token: not-the-real-token" -d '{}'` — expect HTTP 401.
5. Probe correct-token: `curl -sS -i -X POST http://127.0.0.1:7000/eval -H "X-AE-Bridge-Token: $AE_BRIDGE_TOKEN" -H 'Content-Type: application/json' -d '{"id":"probe-10","source":"return JSON.stringify({version: app.version});"}'` — expect HTTP 200 with a `{ status: "no_panel_attached", id: "probe-10" }` payload.
6. Probe loopback-only: `curl -sS -i -X POST http://0.0.0.0:7000/eval` from the same host should still resolve (because the server binds `127.0.0.1`, the hostname `0.0.0.0` does not bind); a request to a non-loopback interface must fail.

### Expected
- Syntax check: clean exit.
- Missing-token: 401 with `{ "error": "unauthorized" }`.
- Wrong-token: 401 with `{ "error": "unauthorized" }`.
- Correct-token: 200 with `{ "status": "no_panel_attached", "id": "probe-10" }`.

### Actual
- Syntax check: clean (the server source parses). **The other steps were not executed in this round** because the focus of this round was documenting the validation record; running the daemon stub requires no AE and can be done at any time on this host.

### Result
Pending runtime execution; the source is parseable.

### Evidence
None yet. (Future runs: paste `curl -sS -i` output.)

### Limitations
- The stub deliberately does **not** forward to a CEP panel; it
  returns "no_panel_attached" so the contract shape can be
  exercised without AE.

---

## Cross-cutting limitations

1. **No real AE in this environment.** Every Actual section that
   requires AE reads "Not executed". The only probe that can run
   here is Probe 10 (daemon stub).
2. **No empirical timing data.** None of the probes measure
   `evalScript` latency, callback threading, or main-thread
   contention. Those would require instrumentation on a live AE.
3. **No adversarial testing.** The probes do not cover token
   replay, DNS rebinding, or Origin-spoof attacks; the security
   surface is covered in `research/05-security.md` and the daemon
   enforces `127.0.0.1` + token but has not been audited.
4. **No persistence tests.** `layer.id` / `item.id` persistence
   across Save→Quit→Reload is unverified and is **not** part of
   these probes; it belongs to a future "09-persistence" probe.
