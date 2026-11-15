# Native adapter kit — `unsupported-or-unknown`

<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->

> **Coverage-matrix status: `unsupported-or-unknown`** — implemented=`false`, verifiedOnRealHost=`false`, symbols=552.
> Source: `inventories/sdk/generated/aggregate.coverage-matrix.json` (schema `ae-devtools/sdk-coverage-matrix/1`, SDK release 26.5 macOS).
> Evidence level — inventory: `source-reviewed`, verification: `not-run`, realHost: `not-run`.
> Extractor could not attribute; see unknownByReason. Requires per-family review (CAP047).

## What this status permits

The extractor could not attribute these symbols to a call direction. They remain in the denominator and require per-family review (CAP047) before any adapter work. The template below is a **refusal/waiver record**, not a command contract — do not invent operations for this family.

## 1. Adapter command

### Adapter command — refusal/waiver record (FR-013)

This family has no command contract. An implementer records a per-family
decision instead:

```json
{
  "family": "unsupported-or-unknown",
  "decision": "unsupported | deferred-to-issue | waived",
  "rationale": "<technical basis from inventories/sdk/constraints.md or header evidence>",
  "reevaluationCondition": "<what would change the decision, e.g. new SDK release, CAP047 review>",
  "followUpIssue": "<issue URL or number; required before exclusion from supported coverage>",
  "matrixState": "unsupported-or-unknown"
}
```

An explicit waiver or follow-up issue is required before this family is
excluded from supported coverage (spec FR-013).

## 2. Fixture

### Fixture — N/A

No fixture may be authored for this family until CAP047 review assigns
it a concrete class. A fixture here would fabricate coverage.

## 3. Build-test

### Build-test — N/A

No build-test path exists for this family. Building or loading
anything here would assert coverage the matrix does not have.
