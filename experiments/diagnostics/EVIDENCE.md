# EVIDENCE — diagnostics groundwork (Issue #37)

Recorded 2026-11-14 on the macOS dev host. **Fake/mock-level evidence
only** — no After Effects was launched and no real diagnostic source was
contacted.

## Environment

| Fact | Value |
| --- | --- |
| Host | macOS arm64 dev machine |
| Node | v24.22.1 |
| AE | installed (26.5.3 / 27.0.0) — not launched for this work |

## Results

| Item | Command | Result | Level |
| --- | --- | --- | --- |
| Schema validation + collector normalizers | `node tests/run.mjs` | 13/13 tests green | **automated test** |
| `script-exception` normalization (`fromAeError`) | same | works against codec `aeError` shape | **automated test / fake** |
| `transport-outcome` normalization | same | COMPLETED/REFUSED/FAILED/UNKNOWN mapped | **automated test / fake** |
| `expression-error` collection | — | AE surface unverified | **pending-real-host** |
| `panel-log` collection | — | needs #36 panel load proof + log location | **pending-real-host** |
| `native-crash` collection | — | needs owned-session crash artifact + parser | **pending-real-host** |
| `plugin-load-failure` collection | — | needs #17/#18 real load attempt | **pending-real-host** |
| `render-failure` collection | — | needs #16 render-queue adapter | **pending-real-host** |
| Source-position mapping to generated assets | — | schema supports it; consumers pending | **implemented (schema) / consumers pending** |
| Windows | — | no Windows host | **UNVERIFIED** |

## Blockers recorded

1. Five of seven source kinds cannot be collected until their upstream
   real-host proofs exist (#16, #17, #18, #36, #21). The registry marks
   each `pending-real-host` with the reason — none is dropped.
2. `native-crash` additionally needs a scoping rule: only artifacts from
   the owned session's crash reports may be collected; the user's own
   crash history is out of bounds.
3. Whether CEP `console.*` reaches a readable host log on AE 2026/2027 is
   unknown until the #36 load proof runs.

## Reproduce

```sh
cd experiments/diagnostics
node tests/run.mjs
```
