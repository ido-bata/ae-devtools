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
| Scaffold generation + validation | `node tests/run.mjs` | 8/8 tests green (2026-11-14) | **automated test** |
| CLI happy path / refusal paths | same suite (spawnSync CLI cases) | exit 0 / 2 / 3 as specified | **automated test** |
| Manifest shape vs CEP schema | manual review vs `runtime-bridge` manifest + research 02 | consistent structure; XSD not validated | **source-reviewed** |
| Panel load into AE | — | not run | **UNVERIFIED** (LOAD-PROOF.md gate) |
| `CSInterface.evalScript` round trip | — | not run | **UNVERIFIED** |
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
3. **`CSInterface.js` provisioning** (host-provided vs bundled) is
   unverified; the scaffold references it as host-provided per the
   runtime-bridge panel's assumption.
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
