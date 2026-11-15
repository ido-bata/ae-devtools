# Native adapter kit — `unsupported-or-unknown` (coverage-matrix class)

<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->

> **Coverage-matrix class: `unsupported-or-unknown` — reporting metadata only, never dispatchable.** State=`unsupported-or-unknown`, implemented=`false`, verifiedOnRealHost=`false`, symbols=552.
> Source: `inventories/sdk/generated/aggregate.coverage-matrix.json` (schema `ae-devtools/sdk-coverage-matrix/1`, SDK release 26.5 macOS).
> Evidence level — inventory: `source-reviewed`, verification: `not-run`, realHost: `not-run`.
> Extractor could not attribute; see unknownByReason. Requires per-family review (CAP047).

> This kit documents a **reporting class**, not a capability. No
> matrix class is dispatchable; only per-operation entries in
> `src/operations.ts` can be negotiated, and only with
> `implemented && verifiedOnRealHost` evidence.

## What this status permits

The extractor could not attribute these symbols to a call direction. They remain in the denominator and require per-cluster review (CAP047 child Issues) before any adapter work. The template below is a **refusal/waiver record**, not a command contract — do not invent operations for this class.

## 1. Adapter command

### Adapter command — refusal/waiver record (FR-013)

This class has no command contract. An implementer records a per-cluster
decision instead:

```json
{
  "matrixClass": "unsupported-or-unknown",
  "decision": "unsupported | deferred-to-issue | waived",
  "rationale": "<technical basis from inventories/sdk/constraints.md or header evidence>",
  "reevaluationCondition": "<what would change the decision, e.g. new SDK release, CAP047 review>",
  "followUpIssue": "<issue URL or number; required before exclusion from supported coverage>",
  "matrixState": "unsupported-or-unknown"
}
```

An explicit waiver or follow-up issue is required before this class is
excluded from supported coverage (spec FR-013).

## 2. Fixture

### Fixture — N/A

No fixture may be authored for this class until CAP047 review assigns
its symbols to concrete operation entries. A fixture here would
fabricate coverage.

## 3. Build-test

### Build-test — N/A

No build-test path exists for this class. Building or loading
anything here would assert coverage the matrix does not have.
