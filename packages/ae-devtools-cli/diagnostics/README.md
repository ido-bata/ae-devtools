# diagnostics — unified AE diagnostics record (Issue #37, CAP061–CAP064 groundwork)

> Status: **record schema + collector registry at fake/mock level.** This
> directory defines the single diagnostics model every failure source
> feeds (spec FR-16) and registers honest per-source collection status.
> It is not a transport, not a UI surface, and not real-host evidence.
> Packaged inside `@ido-bata/ae-devtools-cli` (Issue #113) and consumed by
> `ae-devtools diagnose` / failure-evidence diagnostics blocks.
> Design note: `../../../specs/ae-capability-coverage/design/diagnostics.md`.

## What this is

| CAP | Requirement | State |
| --- | --- | --- |
| CAP061 | Diagnostics record schema | **implemented, automated-test level** — `schema.mjs` |
| CAP062 | Script exception / expression error / render failure host collection | **partially** — `fromAeError` + `fromRenderItem` normalizers done (fake); expression-error collector `pending-real-host` |
| CAP063 | Panel logs / native crash / plugin load failure collection | **partially** — `fromCrashEvidence` (recovery-orchestrator manifest bridge) + `fromPanelLog`/`collectPanelLogs` (CEPHtmlEngine*.log fixture parser) done at fake level; plugin-load-failure `pending-real-host`; real-host inputs unverified |
| CAP064 | Diagnostics → source-position mapping | **partially implemented, automated-test level** — `source-map.mjs` resolves JSX `{line,column}` → original TS via jsx-toolchain sourcemaps (single-file one-hop, project two-hop); `plugin-binary` reports `unsupported-with-reason` (no symbol source); panel-asset mapping still pending consumers |

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
with the reason and upstream dependency recorded. Normalizers that work
today without AE:

- `fromAeError(aeError, ctx)` — trusted-codec `aeError` → `script-exception`.
- `fromTransportOutcome(outcome, ctx)` — probe/trusted-execution outcome → `transport-outcome`.
- `fromCrashEvidence(manifest, ctx)` — recovery-orchestrator crash-evidence
  manifest → `native-crash` records (delegates to the tested
  `crashEvidenceToDiagnostics`; preserves sha256 `artifactHashes`).
- `fromPanelLog(text, { path })` / `collectPanelLogs({ logDir })` — tolerant
  `CEPHtmlEngine*.log` parser → `panel-log` records; a missing/unreadable
  log dir is an explicit incomplete result, never fabricated positions.
- `fromRenderItem(item, ctx)` — synthetic `rqItem.status` shape →
  `render-failure` record (real status strings unverified).

`expression-error` and `plugin-load-failure` remain `pending-real-host`;
no collector claims a source it cannot reach.

## Source-position mapping (`source-map.mjs`, CAP064)

Resolves a diagnostics record's `source` block — an ExtendScript
`{line, column?}` position inside a generated `.jsx` artifact — back to
the original TypeScript `{file, line, column, excerpt}` using the
Source Map v3 files emitted by `packages/ae-devtools-cli/jsx-toolchain`:

- single-file `build` → `<name>.jsx.map` (one hop, jsx → TS)
- project `build-project` → `<name>.jsx.map` + `<name>.bundle.js.map`
  (two hops: jsx → bundle → original TS, mirroring `resolvePosition`)

The VLQ consumer is **imported** from
`../jsx-toolchain/src/sourcemap.mjs` (`lookup`/`parseMappings`), not
copied. `jsx-toolchain/src/bundle.mjs` cannot be imported here because
it pulls in esbuild/typescript; `lookup` is dependency-free, so the
tests never invoke tsc/esbuild.

Result statuses are honest: `mapped` / `unmapped` / `no-map` /
`no-position` / `invalid-map` / `ambiguous`. Nothing is guessed —
`excerpt` comes only from the map's own `sourcesContent`.

Column convention: `source.column` on a record (and `--col` on the
CLI) is **1-based** per the schema's positive-integer rule; generated
map columns are 0-based and converted internally. ExtendScript host
errors normally carry a line and no column — a line-only query resolves
to the **first mapped segment on that generated line** (a real mapping,
recorded in `hops`), never an interpolated guess.

Result convention: `original.line` is **1-based**; `original.column` is
**0-based** (raw Source Map convention — the same parity as
jsx-toolchain's `resolvePosition`). `hops[].generated.column` is the
effective 0-based generated column used for the lookup.

### CLI

```sh
node source-map.mjs <record.json> [--jsx p] [--map-dir d] [--jsx-map p] [--bundle-map p]
node source-map.mjs --jsx file.jsx --line N [--col N] [--jsx-map p] [--bundle-map p]
```

Prints the result JSON; exit 0 when `mapped`, 1 otherwise, 2 on
usage/IO errors.

### Test fixtures

`tests/fixtures/{single,project}/` are committed build outputs produced
by jsx-toolchain's own `buildFile`/`buildProject` against
`../jsx-toolchain/fixtures/` sources (regeneration recipe in
the test file header). Tests deliberately do not invoke tsc/esbuild.

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
├── source-map.mjs       # diagnostics source → TS position via jsx-toolchain maps
└── tests/               # node:test suite (fake-level only)
    ├── fixtures/        # committed jsx-toolchain build outputs (jsx + maps)
    │   └── panel-logs/  # clearly-fake CEPHtmlEngine*.log fixtures
    └── *.test.mjs
```
