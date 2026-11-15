# Native adapter kit — `external-command` (coverage-matrix class)

<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->

> **Coverage-matrix class: `external-command` — reporting metadata only, never dispatchable.** State=`inventory-only`, implemented=`false`, verifiedOnRealHost=`false`, symbols=3766.
> Source: `inventories/sdk/generated/aggregate.coverage-matrix.json` (schema `ae-devtools/sdk-coverage-matrix/1`, SDK release 26.5 macOS).
> Evidence level — inventory: `source-reviewed`, verification: `not-run`, realHost: `not-run`.
> Selector strings attributed from headers. No adapter, no real-host dispatch evidence.

> This kit documents a **reporting class**, not a capability. No
> matrix class is dispatchable; only per-operation entries in
> `src/operations.ts` can be negotiated, and only with
> `implemented && verifiedOnRealHost` evidence.

## What this status permits

Symbols in this class are **structurally attributed from headers only**. No adapter exists and no real-host dispatch evidence exists. The command/fixture templates below are contract shapes for *future per-operation entries*: a class row can never be dispatched — only concrete operation ids in `src/operations.ts` can, and only when the registry marks them `implemented && verifiedOnRealHost`.

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
  "matrixClass": "external-command",
  "operations": ["<operation ids under test>"],
  "sdkRelease": { "identifier": "<e.g. 26.5>", "distribution": "<e.g. macOS>" },
  "matrixState": "inventory-only",
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

There is no build/load path for this class yet; the load-proof
procedure in `experiments/native-sdk/LOAD-PROOF.md` is the template to
follow once per-operation adapters exist.
