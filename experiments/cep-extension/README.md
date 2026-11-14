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

UXP plugin development lifecycle is tracked per-row as **BLOCKED /
UNVERIFIED**: Adobe's UXP-for-AE availability is beta/provisional
(research.md §2, ADR-0005 D5). No UXP scaffold is generated, no UXP
load is claimed, and beta adoption is not assumed. Re-evaluation trigger:
Adobe released build with documented plugin loading + remote IPC for AE.

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
