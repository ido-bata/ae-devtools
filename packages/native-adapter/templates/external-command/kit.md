# Native adapter kit — `external-command`

<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->

> **Coverage-matrix status: `inventory-only`** — implemented=`false`, verifiedOnRealHost=`false`, symbols=3766.
> Source: `inventories/sdk/generated/aggregate.coverage-matrix.json` (schema `ae-devtools/sdk-coverage-matrix/1`, SDK release 26.5 macOS).
> Evidence level — inventory: `source-reviewed`, verification: `not-run`, realHost: `not-run`.
> Selector strings attributed from headers. No adapter, no real-host dispatch evidence.

## What this status permits

Symbols in this family are **structurally attributed from headers only**. No adapter exists and no real-host dispatch evidence exists. The command/fixture templates below are contract shapes for a *future* adapter: filling them in does not make this family callable, and negotiation will refuse it unless the client explicitly widens `acceptableStates` for non-dispatch use (e.g. inspection).

## 1. Adapter command

### Adapter command envelope (template)

```json
{
  "commandId": "<uuid, unique per dispatch>",
  "family": "external-command",
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
  "family": "external-command",
  "sdkRelease": { "identifier": "<e.g. 26.5>", "distribution": "<e.g. macOS>" },
  "matrixState": "inventory-only",
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

There is no build/load path for this family yet; the load-proof
procedure in `experiments/native-sdk/LOAD-PROOF.md` is the template to
follow once an adapter exists.
