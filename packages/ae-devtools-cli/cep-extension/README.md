# cep-extension — CEP/UXP extension development lifecycle groundwork (Issue #36, CAP057–CAP060)

> Status: **scaffold generator + lifecycle CLI + gated procedure.** This
> directory generates CEP extension project skeletons, mechanizes the
> machine-level install/uninstall/status/log operations around them, and
> records what a real-AE
> load proof requires. It is **not** a transport, not a shipped feature,
> and not evidence that any panel loads. Panel load/reload/unload inside
> After Effects (CAP059) requires an explicitly owned AE session and
> stays **UNVERIFIED** until LOAD-PROOF.md is executed with recorded
> evidence. UXP (CAP060) is tracked as BLOCKED/UNVERIFIED — see §UXP.

## What this is

| CAP | Requirement | State |
| --- | --- | --- |
| CAP057 | CEP scaffold generation (manifest/CSXS/host range/debug-load config) | **implemented, automated-test level** — `scaffold.mjs` + `devkit.mjs validate` + `tests/` |
| CAP058 | Build/install/reload/unload/cleanup mechanization per OS | **partially mechanized** — `cep-lifecycle.mjs` (install/uninstall/status/cleanup/logs, `PlayerDebugMode` status check); real CEP load/reload stays **UNVERIFIED** — `LOAD-PROOF.md` |
| CAP059 | Real-host panel load → `evalScript` round trip → reload → unload | **UNVERIFIED** — gated on owned AE session |
| CAP060 | UXP plugin development lifecycle | **BLOCKED/UNVERIFIED** — see below |

## Scaffold usage

```sh
node scaffold.mjs --id com.example.my-panel --title "My Panel" \
    --version 0.1.0 --host "[25.0,99.0]" --csxs 12.0 --out ./my-panel
```

Output tree:

```
<out>/CSXS/manifest.xml          # official CEP 5.0+/12 shape: ExtensionList +
                                #   ExecutionEnvironment(HostList/LocaleList/
                                #   RequiredRuntimeList) + DispatchInfoList
<out>/index.html                 # panel shell, CSP, wires js/main.js
<out>/CSInterface.js             # official Adobe-CEP CEP_12.x file, bundled
                                #   (the host does NOT provide it)
<out>/js/main.js                 # ES5 panel logic: api version, app.version
                                #   (attribute, not a call), error probe
<out>/js/csinterface-wrapper.js  # copied verbatim from templates/
<out>/jsx/host.jsx               # ES3 ExtendScript sample the panel can
                                #   evalScript (subset-linted by validate)
```

The scaffold refuses to overwrite a non-empty `--out` without `--force`
(exit 3), validates the extension id (reverse-DNS shape, no path
separators), semver-ish version, CSXS dotted version and host version
range, and escapes all substituted values. `--force` regenerates the
scaffold's own outputs only — unrelated files in the directory are the
caller's responsibility.

## Using from an external project

This directory ships inside the `@ido-bata/ae-devtools-cli` npm package
(`packages/ae-devtools-cli/cep-extension/`, Issue #115) and is
self-contained: **Node >= 22, zero dependencies of its own, no
network, no AE**.

### Option A — installed bins (recommended)

After `npm install @ido-bata/ae-devtools-cli` (or the tarball), two bins are
available:

```sh
# scaffold a new panel project in the current directory
ae-devtools-cep scaffold \
    --id com.example.my-panel --title "My Panel" \
    --version 0.1.0 --host "[25.0,99.0]" --csxs 12.0 \
    --out ./my-panel

# static validation of any extension dir (fresh scaffold or your own)
ae-devtools-cep validate ./my-panel
```

`ae-devtools-cep scaffold` forwards all arguments to `scaffold.mjs`
unchanged; `ae-devtools-cep validate` prints a JSON report and exits 0
when no check fails, 1 on failures, 2 on usage/io errors.

A second bin, `ae-devtools-cep-lifecycle`, exposes the machine-level
lifecycle CLI (`install` / `uninstall` / `status` / `cleanup` / `logs` /
`playerdebugmode`). It operates on the OS CEP extension/log directories
by default (pass `--target`/`--log-dir` to redirect); it never launches
or configures After Effects. See "Lifecycle CLI" below for what is
mechanized vs UNVERIFIED.

### Option B — run in place (repo checkout)

```sh
node packages/ae-devtools-cli/cep-extension/devkit.mjs scaffold \
    --id com.example.my-panel --out ./my-panel
node packages/ae-devtools-cli/cep-extension/devkit.mjs validate ./my-panel
```

### Option C — vendor the directory

Copy `cep-extension/` into your project (e.g. `tools/cep-extension/`).
`scaffold.mjs` resolves its templates relative to its own location.
Two CLI entry points (`scaffold.mjs`, `cep-lifecycle.mjs`) import the
shared helpers `devtools-cli/argv.mjs` and
`devtools-cli/is-main-entry.mjs` from the sibling directory, so vendor
those two files alongside, preserving the relative layout:

```sh
cp -R /path/to/ae-devtools/packages/ae-devtools-cli/cep-extension tools/cep-extension
mkdir -p tools/devtools-cli
cp /path/to/ae-devtools/packages/ae-devtools-cli/devtools-cli/{argv,is-main-entry}.mjs tools/devtools-cli/
node tools/cep-extension/devkit.mjs scaffold --id com.example.my-panel --out ./my-panel
node tools/cep-extension/devkit.mjs validate ./my-panel
```

`validate` checks: required files (`CSXS/manifest.xml`, `index.html`),
manifest well-formedness (`xmllint` when available, otherwise a
documented XML subset tag-balance check — reported as such), required
CEP 5+/12 manifest elements, that every local `<script src>`/`<link
href>` in `index.html` resolves inside the extension dir, that a
referenced `CSInterface.js` is bundled (the host does NOT provide it),
and that every `*.jsx` host script stays inside a documented ES3
*subset* (heuristic — for a real ES3 grammar proof use the sibling
`jsx-toolchain` package's `lintOutput` when its deps are installed).
It also reports `.debuggable` marker presence informationally and
always reports `loadProof: "NOT RUN"`.

### Loading the result into AE (gated — not done by this devkit)

`validate` is **static/fake-level evidence only** — it never loads the
extension. Real loading follows `LOAD-PROOF.md`: install via
`cep-lifecycle.mjs install`, ensure `PlayerDebugMode` for unsigned
debug loads (or sign for the production path), restart/refresh an
**owned** AE session, then verify panel load → `evalScript` round trip
→ reload → unload. Windows paths are modeled but UNVERIFIED.

## Lifecycle CLI — what is mechanized vs what stays UNVERIFIED

`cep-lifecycle.mjs` (Node >= 22, zero deps) automates the **machine-level**
file operations around a scaffolded extension. It never launches,
signals, or configures After Effects:

```sh
node cep-lifecycle.mjs install --source <ext-dir> [--id <id>] [--target <dir>]
node cep-lifecycle.mjs uninstall --id <id> [--target <dir>]
node cep-lifecycle.mjs status --id <id> [--source <dir>] [--target <dir>]
node cep-lifecycle.mjs cleanup [--target <dir>]
node cep-lifecycle.mjs logs [--log-dir <dir>]
node cep-lifecycle.mjs playerdebugmode
```

Mechanized (automated-test level, `tests/lifecycle.test.mjs`):

- platform CEP extensions dirs (`darwin`/`win32` paths; other platforms
  refused) and the CEPHtmlEngine log dir (`darwin` verified on real
  host; `win32` modeled as `%TEMP%` per Adobe's Debugging Handbook —
  never exercised on a Windows host, **UNVERIFIED**)
- `install` — copies the extension into the CEP extensions dir via
  tmp-dir + rename (rollback on failure), writes an ownership marker
  `.ae-devtools-owned.json`, verifies the manifest `Id` matches;
  refuses foreign dirs, idempotent on identical content, replaces
  drifted owned content
- `uninstall` / `cleanup` — remove only dirs carrying our ownership
  marker; absent is idempotent; foreign content is never touched
- `status` — installed/present/drift report against a source dir
- `logs` — lists `CEPHtmlEngine` panel logs with sizes
- `playerdebugmode` — **read-only** report of the `PlayerDebugMode`
  defaults for the CSXS domains; writes nothing, reports `unknown`
  (never a guess) off-darwin

Still **REAL-HOST-UNVERIFIED** (requires the LOAD-PROOF.md authorization
gate and an owned AE session):

- actual CEP panel load inside After Effects, extension host behavior,
  panel reload semantics, unload behavior, `CSInterface.evalScript`
  round trip on a real host
- whether AE 2026/2027 honors the documented extensions path unchanged
  (path itself was observed on this host — see EVIDENCE.md — but our
  extension was never loaded)
- Windows: dirs are modeled but nothing was exercised on a Windows host

## Evidence level

- Scaffold generation and validation: **automated test** (`node tests/run.mjs`, zero deps; 11 scaffold tests + 10 devkit/validate tests).
- Devkit `validate` (manifest well-formedness, structure, panel refs, CSInterface bundling, JSX ES3 subset): **automated test** — static checks only; `loadProof` is always reported `NOT RUN`.
- Lifecycle install/uninstall/status/cleanup/logs/`PlayerDebugMode` check: **automated test** (8 lifecycle tests, fixture dirs only — no real CEP dir touched unless `--target` is passed explicitly).
- Manifest correctness: **XSD-validated** — `tests/scaffold.test.mjs` validates generated output against the vendored official `schema/ExtensionManifest_v_7_0.xsd` (Adobe states the schema is unchanged CEP 7→12) via `xmllint`. Note: the published XSD enumerates manifest `Version` as `7.0` only while the official CEP 12 sample ships `Version="12.0"`; the test pins the emitted copy to `7.0` for schema validation and asserts `12.0` separately — the schema is stale relative to Adobe's own sample.
- `CSInterface.js`: **bundled** — the official CEP 12 cookbook requires including it in the extension ("include these JavaScript files in your HTML extension"); the earlier host-provided assumption was wrong and is corrected.
- Panel load in AE: **UNVERIFIED** — see `LOAD-PROOF.md`.
- Windows: **UNVERIFIED** — no Windows host; agents never touch Windows (Issue #21).

## Install / debug-load background (from repo research, to be re-verified at proof time)

- Unsigned development panels require `PlayerDebugMode=1` per CSXS version
  (`docs/architecture/research/02-cep-deep-dive.md` §Signing model,
  `05-security.md`). Exact key for the target AE/CEP version is a
  load-proof checklist item, not an assumption.
- Extension folder: `%APPDATA%\Adobe\CEP\extensions\` (Windows) /
  `~/Library/Application Support/Adobe/CEP/extensions/` (macOS)
  (`docs/troubleshooting.md`). Whether AE 2026/2027 honors this path
  unchanged is unverified.
- CEP log folder: `~/Library/Logs/CSXS/` (macOS, verified on this host)
  / `%TEMP%` directly (Windows, per Adobe CEP Debugging Handbook
  CEP_11.x/12.x "Logs Folders" — modeled in `cepLogDir`, **UNVERIFIED**
  on a real Windows host). Note: logs are NOT under
  `%APPDATA%\Adobe\CEP\logs`.
- Remote debugging / `.zxp` signing: see `REMOTE-DEBUGGING.md` and
  `ZXP-SIGNING.md` — decision/feasibility notes, all real-host claims
  UNVERIFIED.
- `CSInterface.js` is **bundled** at the extension root (official CEP_12.x
  file). Whether a given AE/CEP runtime additionally resolves a host copy
  is irrelevant to correctness — bundling is the documented requirement.

## UXP status (CAP060)

Re-investigated 2026-11-14 against current Adobe public sources:

- **Public beta is live.** Adobe opened AE UXP private beta 2026-10-05
  (AE beta 27.0.0.63) and announced public beta "by mid-November 2026";
  `developer.adobe.com/after-effects/uxp/` now serves public docs
  (quickstart, After Effects API reference, UXP API reference) "throughout
  the beta".
- **Still beta.** Per our acceptance rule (released build with documented
  plugin loading + remote IPC), every UXP lifecycle row stays
  **BLOCKED/UNVERIFIED**: beta DOM stability, packaging/signing path, and
  remote-IPC surface are not GA-contract. Hybrid (Node-capable) plugins
  are "on the roadmap for GA" per Adobe staff — not available in beta.
- **CEP transition context (Adobe blog, 2026-09):** AE public beta UXP
  Nov 2026; new CEP submissions stop ~2027; CEP removed from new AE
  versions Dec 2029; **ExtendScript is explicitly not affected**. This
  raises the long-term value of the CEP dev-loop work here but does not
  change today's evidence level.

Re-evaluation trigger: AE UXP GA (or a documented stable beta contract)
with plugin load + IPC evidence on an owned host.

## Layout

```
cep-extension/
├── README.md                  # this file
├── EVIDENCE.md                # evidence ledger
├── LOAD-PROOF.md              # gated real-AE load procedure + fixtures
├── REMOTE-DEBUGGING.md        # .debug/remote-debugging feasibility note (UNVERIFIED claims marked)
├── ZXP-SIGNING.md             # .zxp signing decision record (no signing executed)
├── scaffold.mjs               # generator CLI (Node >= 22, zero deps)
├── devkit.mjs                 # external-project entry: scaffold | validate
├── validate.mjs               # static extension-dir validator (JSON report)
├── cep-lifecycle.mjs          # lifecycle CLI (install/uninstall/status/cleanup/logs/playerdebugmode)
├── lifecycle.mjs              # lifecycle machine (ownership marker, tmp+rename, foreign-dir refusal)
├── schema/                    # vendored official ExtensionManifest_v_7_0.xsd
├── templates/                 # manifest/html/js templates + jsx/host.jsx
│                              #   + CSInterface.js + wrapper
└── tests/                     # node:test suite (fake-level only)
```
