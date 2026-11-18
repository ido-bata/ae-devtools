# EVIDENCE — diagnostics groundwork (Issue #37; collectors extended under Issue #194)

Recorded 2026-11-14 on the macOS dev host; collector rows updated for
Issue #194. **Fake/mock-level evidence only** — no After Effects was
launched and no real diagnostic source was contacted.

## Environment

| Fact | Value |
| --- | --- |
| Host | macOS arm64 dev machine |
| Node | v24.22.1 |
| AE | installed (26.5.3 / 27.0.0) — not launched for this work |

## Results

| Item | Command | Result | Level |
| --- | --- | --- | --- |
| Schema validation + collector normalizers | `node tests/run.mjs` | green (incl. collectors.test.mjs) | **automated test** |
| `script-exception` normalization (`fromAeError`) | same | works against codec `aeError` shape | **automated test / fake** |
| `transport-outcome` normalization | same | COMPLETED/REFUSED/FAILED/UNKNOWN mapped | **automated test / fake** |
| `native-crash` manifest normalization (`fromCrashEvidence`) | same | real `collectCrashEvidence` manifest (synthetic .ips) → `native-crash` record with sha256 `artifactHashes` | **automated test / fake** — real OS crash artifacts still unverified |
| `panel-log` collection (`fromPanelLog`/`collectPanelLogs`) | same | tolerant CEPHtmlEngine*.log fixture parser; missing dir → explicit incomplete | **automated test / fake** — console.* → host log routing UNVERIFIED |
| `render-failure` normalization (`fromRenderItem`) | same | synthetic `rqItem.status` shape → record | **automated test / fake** — real status strings unverified |
| `expression-error` collection | — | AE surface unverified | **pending-real-host** |
| `plugin-load-failure` collection | — | needs #17/#18 real load attempt | **pending-real-host** |
| Source-position mapping to generated assets | — | schema supports it; consumers pending | **implemented (schema) / consumers pending** |
| JSX→TS sourcemap resolution (`source-map.mjs`) | `node tests/run.mjs` | 22 tests green: single-file one-hop, project two-hop, unmapped/no-map/no-position/invalid-map/ambiguous, CLI | **automated test** (fixtures are committed jsx-toolchain build outputs; no AE, no real host error) |
| Windows | — | no Windows host | **UNVERIFIED** |

## Blockers recorded

1. `expression-error` and `plugin-load-failure` cannot be collected until
   their upstream real-host proofs exist (#16, #17, #18, #21). The
   registry marks each `pending-real-host` with the reason — none is
   dropped. `native-crash`/`panel-log`/`render-failure` normalizers are
   `implemented-fake`: their REAL inputs remain unverified (owned-session
   .ips artifacts, CEP console.* → host log routing, real rqItem.status
   strings).
2. `native-crash` additionally needs a scoping rule: only artifacts from
   the owned session's crash reports may be collected; the user's own
   crash history is out of bounds.
3. Whether CEP `console.*` reaches a readable host log on AE 2026/2027 is
   unknown until the #36 load proof runs.
4. `plugin-binary` source positions report `unsupported-with-reason` in
   source-map.mjs — native offsets have no symbol source to map.

## Reproduce

```sh
cd packages/ae-devtools-cli/diagnostics
node tests/run.mjs
```
