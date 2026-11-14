# cep-extension — CEP/UXP extension development lifecycle groundwork (Issue #36, CAP057–CAP060)

> Status: **scaffold generator + gated procedure only.** This directory
> generates CEP extension project skeletons and records what a real-AE
> load proof requires. It is **not** a transport, not a shipped feature,
> and not evidence that any panel loads. Panel load/reload/unload inside
> After Effects (CAP059) requires an explicitly owned AE session and
> stays **UNVERIFIED** until LOAD-PROOF.md is executed with recorded
> evidence. UXP (CAP060) is tracked as BLOCKED/UNVERIFIED — see §UXP.

## What this is

| CAP | Requirement | State |
| --- | --- | --- |
| CAP057 | CEP scaffold generation (manifest/CSXS/host range/debug-load config) | **implemented, automated-test level** — `scaffold.mjs` + `tests/` |
| CAP058 | Build/install/reload/unload/cleanup mechanization per OS | **documented procedure** — `LOAD-PROOF.md`; not yet mechanized as commands |
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
```

The scaffold refuses to overwrite a non-empty `--out` without `--force`
(exit 3), validates the extension id (reverse-DNS shape, no path
separators), semver-ish version, CSXS dotted version and host version
range, and escapes all substituted values. `--force` regenerates the
scaffold's own outputs only — unrelated files in the directory are the
caller's responsibility.

## Evidence level

- Scaffold generation and validation: **automated test** (`node tests/run.mjs`, zero deps).
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
├── scaffold.mjs               # generator CLI (Node >= 22, zero deps)
├── schema/                    # vendored official ExtensionManifest_v_7_0.xsd
├── templates/                 # manifest/html/js templates + CSInterface.js + wrapper
└── tests/                     # node:test suite (fake-level only)
```
