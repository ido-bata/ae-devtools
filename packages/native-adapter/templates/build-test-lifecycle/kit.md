# Native adapter kit — `build-test-lifecycle` (coverage-matrix class)

<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->

> **Coverage-matrix class: `build-test-lifecycle` — reporting metadata only, never dispatchable.** State=`build-probe-only`, implemented=`false`, verifiedOnRealHost=`false`, symbols=74.
> Source: `inventories/sdk/generated/aggregate.coverage-matrix.json` (schema `ae-devtools/sdk-coverage-matrix/1`, SDK release 26.5 macOS).
> Evidence level — inventory: `source-reviewed`, verification: `not-run`, realHost: `not-run`.
> Sample projects compile (Sweetie/Checkout, macOS arm64). Load/execution UNVERIFIED.

> This kit documents a **reporting class**, not a capability. No
> matrix class is dispatchable; only per-operation entries in
> `src/operations.ts` can be negotiated, and only with
> `implemented && verifiedOnRealHost` evidence.

## What this status permits

SDK sample projects compile on this build host (macOS arm64); plug-in **load and execution inside After Effects are UNVERIFIED**. Build-test templates below exercise the compile path only. Do not report load/execution evidence from a successful build.

## 1. Adapter command

### Adapter command envelope (template)

Dispatch is per **operation id** (`"<Suite>.<member>"`), never per
matrix class. Operation ids come from the committed registry in
`src/operations.ts`; a class name here is malformed.

```json
{
  "commandId": "<uuid, unique per dispatch>",
  "operation": "<operation id from src/operations.ts; never an invented remote name>",
  "params": {},
  "deadlineMs": 30000
}
```

Result states are exactly: `not-sent`, `refused`, `completed`, `failed`, `unknown`.
A timeout after possible dispatch is `unknown` and is never retried.
Negotiation precondition: `negotiate()` in `src/negotiate.ts` must return
`compatible` for this **operation** at an acceptable state before any
command is sent. A compatible negotiation is not dispatch authorization —
the capability-catalog per-capability gate still applies.

## 2. Fixture

### Fixture template

```json
{
  "fixtureId": "<stable id>",
  "matrixClass": "build-test-lifecycle",
  "operations": ["<operation ids under test>"],
  "sdkRelease": { "identifier": "<e.g. 26.5>", "distribution": "<e.g. macOS>" },
  "matrixState": "build-probe-only",
  "preconditions": ["<owned or explicitly-attached AE session>", "<negotiation compatible for each operation>"],
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
(Sweetie = AEGP, Checkout = Effect/CPU, minimal-plugin = NativeProbe)
and the gated load procedure in
`experiments/native-sdk/LOAD-PROOF.md`.

## Concrete example — Sweetie/Checkout/NativeProbe build probe

Tied to `experiments/native-sdk/` (Issue #17 groundwork, CAP037/CAP038):

- `build-macos.sh` compiles SDK samples with xcodebuild on macOS arm64:
  - **Sweetie** — AEGP plug-in sample (external-command class surface)
  - **Checkout** — Effect/CPU plug-in sample (in-host-plugin-command surface)
- `minimal-plugin/build.sh` builds **NativeProbe**, our own read-only
  AEGP plug-in (`src/probe.cpp`); its 21 AEGP/SPBasicSuite calls are the
  committed per-operation entries in `src/operations.ts` — all
  `implemented-unverified`, none dispatchable.
- `EVIDENCE.md` records BUILD SUCCEEDED for all three; `Effect/SDK_Invert_ProcAmp`
  (GPU) BUILD FAILED — `metal_common` and Boost headers absent.
- `LOAD-PROOF.md` is the gated procedure for real-AE load proof; it has
  **not been run** — load/execution remain UNVERIFIED.

A build-test fixture for this class starts from
`templates/build-test-lifecycle/fixture.sweetie-checkout.json`.

