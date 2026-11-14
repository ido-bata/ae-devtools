# diagnostics — unified AE diagnostics record (Issue #37, CAP061–CAP064 groundwork)

> Status: **record schema + collector registry at fake/mock level.** This
> directory defines the single diagnostics model every failure source
> feeds (spec FR-16) and registers honest per-source collection status.
> It is not a transport, not a UI surface, and not real-host evidence.
> Design note: `../../specs/ae-capability-coverage/design/diagnostics.md`.

## What this is

| CAP | Requirement | State |
| --- | --- | --- |
| CAP061 | Diagnostics record schema | **implemented, automated-test level** — `schema.mjs` |
| CAP062 | Script exception / expression error / render failure host collection | **partially** — `fromAeError` normalizer done (fake); expression-error and render-failure collectors `pending-real-host` |
| CAP063 | Panel logs / native crash / plugin load failure collection | **pending-real-host** — sources unverified until #36/#17/#18 real-host runs; registry records why |
| CAP064 | Diagnostics → source-position mapping | **schema-level** — `source` block with `hostReported` flag; generated-JSX/panel/plugin-binary mapping pending consumers (#15/#16/#36) |

## Record model (`schema.mjs`)

`ae-devtools.diagnostics/v1` — closed enums for `kind` (7 source kinds),
`severity` (error/warning/info), `source.assetKind` (7 asset kinds).
Position fields (`path`, `line`, `column`, `symbol`) are optional and
stay absent when unobserved; `hostReported` distinguishes host-reported
positions (e.g. `aeError.line/file`) from client inference. Session pin,
`requestId`, `outcome`, `artifactHashes` and `evidence` level link each
record back to the conformance evidence model (#21).

Validation is strict: wrong `recordVersion`, unknown kind/severity,
malformed positions and bad timestamps are refused, never coerced.

## Collector registry (`collectors.mjs`)

`COLLECTOR_STATUS` gives every kind an explicit status —
`implemented-fake` / `pending-real-host` / `unsupported-with-reason` —
with the reason and upstream dependency recorded. Two normalizers work
today without AE:

- `fromAeError(aeError, ctx)` — trusted-codec `aeError` → `script-exception`.
- `fromTransportOutcome(outcome, ctx)` — probe/trusted-execution outcome → `transport-outcome`.

Everything else is honestly marked pending; no collector claims a source
it cannot reach.

## Evidence level

All tests are **automated test / fake-level**: records are built and
validated in-process. No After Effects is involved. Real-host collection
evidence is a separate gate under Issue #21's matrix; Windows stays
`UNVERIFIED`.

## Layout

```
diagnostics/
├── README.md            # this file
├── EVIDENCE.md          # evidence ledger
├── schema.mjs           # record schema + validation
├── collectors.mjs       # collector status registry + normalizers
└── tests/               # node:test suite (fake-level only)
```
