# EVIDENCE — cep-extension scaffold (Issue #36 groundwork)

Measured locally on the macOS dev host. **Scaffold/build-host evidence
only** — nothing here has been loaded into After Effects.

## Environment

| Fact | Value |
| --- | --- |
| Host | macOS arm64 dev machine |
| Node | v24.22.1 (tests also target Node >= 22 per CI) |
| AE installed | After Effects 2026 (26.5.3) and 2027 (27.0.0) — **not launched for this work** |

## Results

| Item | Command | Result | Level |
| --- | --- | --- | --- |
| Scaffold generation + validation | `node tests/run.mjs` | 11/11 tests green (2026-11-14, post-review) | **automated test** |
| CLI happy path / refusal paths | same suite (spawnSync CLI cases) | exit 0 / 2 / 3 as specified | **automated test** |
| Manifest vs official XSD | `xmllint --schema schema/ExtensionManifest_v_7_0.xsd` | valid (Version pinned to schema's enumerated `7.0`; emitted `12.0` asserted separately — published XSD is stale vs CEP 12 sample) | **automated test** |
| Manifest structure | official CEP 12 sample + cookbook | `ExtensionList`/`ExecutionEnvironment`/`DispatchInfoList` shape; corrected from pre-CEP5 attribute form | **source-reviewed + XSD** |
| `CSInterface.js` provisioning | official cookbook: "include these JavaScript files in your HTML extension" | **bundled** (official CEP_12.x file copied to extension root); earlier host-provided assumption was wrong | **source-reviewed** |
| `evalScript` callback contract | official `CSInterface.js` + cookbook | single `result` arg; `EvalScript error.` sentinel on failure; regression-tested | **source-reviewed + automated test** |
| `app.version` usage | scripting inventory `provisional.ae.scripting.app.version` (kind=attribute) | read as property `app.version`, never called; regression-tested | **source-reviewed + automated test** |
| Panel load into AE | — | not run | **UNVERIFIED** (LOAD-PROOF.md gate) |
| `CSInterface.evalScript` round trip on real host | — | not run | **UNVERIFIED** |
| Panel reload / unload / cleanup | — | not run | **UNVERIFIED** |
| UXP plugin lifecycle | — | not run; Adobe released-build surface absent | **BLOCKED/UNVERIFIED** |
| Windows anything | — | no Windows host | **UNVERIFIED** |

## Blockers recorded

1. **Real-AE load proof** requires an explicitly owned, authorized AE
   session (LOAD-PROOF.md §1). The operator's interactive AE session is
   off-limits; no dedicated host exists yet.
2. **`PlayerDebugMode` key/version** for AE 2026/2027's CEP runtime is
   documented in repo research but not yet confirmed against the exact
   installed builds — first checklist item of the load proof.
3. **`CSInterface.js` provisioning** — resolved: bundled per official
   cookbook. Real-host confirmation that the bundled copy initializes
   remains a load-proof item, not an assumption.
4. **`.zxp` signing** is out of scope for the dev loop (`PlayerDebugMode`
   path); ZXPSignCmd distribution-signing is a separate, later concern.
5. **UXP** has no released-build plugin loading/remote IPC evidence;
   tracked per CAP060, not scaffolded.

## Reproduce

```sh
cd experiments/cep-extension
node tests/run.mjs
node scaffold.mjs --id com.example.demo --out /tmp/cep-demo --title "Demo"
```
