# Design note — unified AE diagnostics (Issue #37, CAP061–CAP064)

- Status: **Proposed design note**, not an accepted contract. Record
  schema versioning follows the catalog contract §7 compatibility rules
  once promoted; until then `experiments/diagnostics/` is the reference
  implementation at fake/mock level.
- Parent spec: [spec.md](../spec.md) FR-16, US9; plan: [plan.md](../plan.md);
  consumers: [#20](https://github.com/ido-bata/ae-devtools/issues/20)
  (VSCode/MCP diagnostics surface), [#38](https://github.com/ido-bata/ae-devtools/issues/38)
  (agent dev-loop E2E).

## 1. Why a single record model

Failure evidence today is scattered: the probe has an outcome taxonomy
(COMPLETED/REFUSED/FAILED/UNKNOWN/BLOCKED), the trusted-execution codec
has `aeError`, the catalog has `diagnostics[]` handshake entries, and
native/CEP failures have no shape at all. FR-16 requires one model so
that an agent can consume errors uniformly regardless of source. This
note fixes the record; it does not fix collection transports.

## 2. Record (`ae-devtools.diagnostics/v1`)

| Field | Rule |
| --- | --- |
| `recordVersion` | exact match; unknown versions refused, never coerced |
| `kind` | closed enum: `script-exception`, `expression-error`, `panel-log`, `native-crash`, `plugin-load-failure`, `render-failure`, `transport-outcome` |
| `severity` | `error` / `warning` / `info` |
| `message` | required, non-empty; host text carried verbatim, not rewritten |
| `source` | optional `{ assetKind, path?, line?, column?, symbol?, hostReported? }`; absent fields stay absent — no fabricated positions. `assetKind` ∈ `jsx-script`, `panel-asset`, `plugin-binary`, `manifest`, `render-output`, `transport`, `unknown` |
| `session` | optional `{ sessionId?, aeVersion?, dispatchId? }` — the probe pin shape, so a diagnostic binds to the same target identity as its request |
| `requestId` / `outcome` | optional linkage to the producing operation and its typed outcome |
| `artifactHashes` | sha256 of cited artifacts (log file, crash report, render output) |
| `occurredAt` | parseable timestamp |
| `collector` | which collector produced the record |
| `evidence` | `fake` / `real-host` / `source-reviewed` — the collection path's own level, mirroring the catalog vocabulary |

`hostReported` exists because position trust differs by source: an
`aeError.line/file` came from the host, while a client-side guess at a
JSX line is inference and must be marked as such (or omitted).

## 3. Collector status model

Every `kind` has an explicit collector status —
`implemented-fake`, `pending-real-host`, or `unsupported-with-reason` —
recorded in `experiments/diagnostics/collectors.mjs`. A kind with no
reachable collector is **still in the model**; it reports pending with
its upstream dependency named (#16 render adapters, #17/#18 plugin load
proofs, #36 panel logs). This mirrors FR-13: unreachable sources keep
their row with reason and re-evaluation condition.

## 4. Source-position mapping (CAP064)

Mapping is two-stage and stays honest at both:

1. **Host → record:** positions the host reports (ExtendScript error
   line/file via `aeError`, CEP panel stack traces, plugin crash binary
   images) are copied with `hostReported: true`.
2. **Record → source:** generated assets (scaffolded JSX, panel files,
   plugin binaries) carry build hashes in `artifactHashes`; a position
   resolves to source only when the artifact hash matches the bytes that
   produced it — the same same-bytes discipline as the conformance
   evidence record (design/conformance-evidence.md §3). A position that
   cannot be bound to hashed bytes stays `assetKind: "unknown"` with no
   `path`.

## 5. Explicit non-goals

- No diagnostic *transport*: records move over whatever channel the
  execution layer already has; this note defines the shape, not the pipe.
- No log scraping of the user's own AE/profile outside an owned session.
  `native-crash` collection is scoped to artifacts attributable to the
  owned session.
- No UI: #20 consumes records; it does not redefine them.
- No claim that `pending-real-host` kinds work. They are registered so
  the gap is visible, per the same rule that keeps unsupported SDK
  entrypoints in the denominator.
