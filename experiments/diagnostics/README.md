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
| CAP064 | Diagnostics → source-position mapping | **partially implemented, automated-test level** — `source-map.mjs` resolves JSX `{line,column}` → original TS via jsx-toolchain sourcemaps (single-file one-hop, project two-hop); panel/plugin-binary mapping still pending consumers |

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
it pulls in esbuild/typescript, which this CI job does not install.

Result statuses are honest: `mapped` / `unmapped` / `no-map` /
`no-position` / `invalid-map` / `ambiguous`. Nothing is guessed —
`excerpt` comes only from the map's own `sourcesContent`.

Column convention: `source.column` on a record (and `--col` on the
CLI) is **1-based** per the schema's positive-integer rule; generated
map columns are 0-based and converted internally. ExtendScript host
errors normally carry a line and no column — a line-only query resolves
to the **first mapped segment on that generated line** (a real mapping,
recorded in `hops`), never an interpolated guess.

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
`packages/ae-devtools-cli/jsx-toolchain/fixtures/` sources (regeneration recipe in
the test file header). Tests deliberately do not invoke tsc/esbuild so
the diagnostics CI job stays dependency-free.

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
    └── source-map.test.mjs
```
