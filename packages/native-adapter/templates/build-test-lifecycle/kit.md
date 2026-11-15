# Native adapter kit — `build-test-lifecycle`

<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->

> **Coverage-matrix status: `build-probe-only`** — implemented=`false`, verifiedOnRealHost=`false`, symbols=74.
> Source: `inventories/sdk/generated/aggregate.coverage-matrix.json` (schema `ae-devtools/sdk-coverage-matrix/1`, SDK release 26.5 macOS).
> Evidence level — inventory: `source-reviewed`, verification: `not-run`, realHost: `not-run`.
> Sample projects compile (Sweetie/Checkout, macOS arm64). Load/execution UNVERIFIED.

## What this status permits

SDK sample projects compile on this build host (macOS arm64); plug-in **load and execution inside After Effects are UNVERIFIED**. Build-test templates below exercise the compile path only. Do not report load/execution evidence from a successful build.

## 1. Adapter command

### Adapter command envelope (template)

```json
{
  "commandId": "<uuid, unique per dispatch>",
  "family": "build-test-lifecycle",
  "operation": "<suite-or-selector name from the inventory; never an invented remote name>",
  "params": {},
  "deadlineMs": 30000
}
```

Result states are exactly: `not-sent`, `refused`, `completed`, `failed`, `unknown`.
A timeout after possible dispatch is `unknown` and is never retried.
Negotiation precondition: `negotiate()` in `src/negotiate.ts` must return
`compatible` for this family at an acceptable state before any command is
sent. A compatible negotiation is not dispatch authorization — the
capability-catalog per-capability gate still applies.

## 2. Fixture

### Fixture template

```json
{
  "fixtureId": "<stable id>",
  "family": "build-test-lifecycle",
  "sdkRelease": { "identifier": "<e.g. 26.5>", "distribution": "<e.g. macOS>" },
  "matrixState": "build-probe-only",
  "preconditions": ["<owned or explicitly-attached AE session>", "<negotiation compatible>"],
  "steps": ["<ordered adapter commands>"],
  "expected": { "resultState": "<one of the result states>", "evidence": "<artifact paths>" },
  "evidenceLevel": "unverified"
}
```

`evidenceLevel` must be promoted only by real recorded runs; a fixture
that has never executed stays `unverified`.

## 3. Build-test

### Build-test template

1. **Build**: compile the plug-in/adapter against the exact SDK release
   advertised by negotiation (`sdkRelease` must match; mismatch refuses).
2. **Load proof**: follow `experiments/native-sdk/LOAD-PROOF.md` —
   owned/dedicated AE session only; no implicit attach or quit.
3. **Execute**: run the fixture steps; record result state, trace and
   artifacts per run.
4. **Record**: update evidence level honestly — compile success is
   `build-probe-only`, never load/execution evidence.

For the concrete compile probe see `experiments/native-sdk/build-macos.sh`
(Sweetie = AEGP, Checkout = Effect/CPU) and the gated load procedure in
`experiments/native-sdk/LOAD-PROOF.md`.

## Concrete example — Sweetie/Checkout build probe

Tied to `experiments/native-sdk/` (Issue #17 groundwork, CAP037):

- `build-macos.sh` compiles two SDK samples with xcodebuild on macOS arm64:
  - **Sweetie** — AEGP plug-in sample (external-command family surface)
  - **Checkout** — Effect/CPU plug-in sample (in-host-plugin-command surface)
- `EVIDENCE.md` records BUILD SUCCEEDED for both; `Effect/SDK_Invert_ProcAmp`
  (GPU) BUILD FAILED — `metal_common` and Boost headers absent.
- `LOAD-PROOF.md` is the gated procedure for real-AE load proof; it has
  **not been run** — load/execution remain UNVERIFIED.

A build-test fixture for this family starts from
`templates/build-test-lifecycle/fixture.sweetie-checkout.json`.

