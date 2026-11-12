# Evidence ledger — read-only probe (CAP021–CAP024)

- Issue: [#13](https://github.com/ido-bata/ae-devtools#13)
- Date: 2026-11-12 / updated 2026-11-13
- Levels used: `source-reviewed | automated-test | fake/mock only | verified on real host`.

## Status right now

| CAP | Requirement | Evidence level | What is proven | What is NOT proven |
| --- | --- | --- | --- | --- |
| CAP021 ping/version + target identity | **not run on a real host** | artifact + design only | The probe client refuses mismatched sessions (`WRONG_TARGET`) and unreadable replies; identity pinning is tested with fakes | That any probe ran against AE 2026/2027, or what version/latency it returned |
| CAP022 snapshot schema + invalidation | documented | source-reviewed + automated-test | Schema, invalidation rules and invariants are written and fake-tested | Behavior of a live snapshot against an actually-running AE |
| CAP023 UNKNOWN/REFUSED/BLOCKED model | documented | automated-test | Outcome table, wrong-target refusal, no-retry regressions — `node tests/run.mjs` → 5/5 test files green | A real AE timeout/modal producing UNKNOWN in the field |
| CAP024 macOS version/CPU/latency/trace | **UNVERIFIED** | — | The procedure below can produce it | Any of it. No run has been performed or recorded on macOS either |

**Nothing here is `verified on real host`.** No measurement was taken against
After Effects 2026 or 2027. The README previously described a 2026-11-12
run against an owned AE 2027 session; that run was never performed and its
claim was removed on 2026-11-13 (see the README "Non-interference rules"
section). The file must never describe an evidence row that does not exist.

## What is actually green

- `node tests/run.mjs` → **5/5 test files green** (2026-11-12, macOS).
  Tests use a **fake responder**; they do not start After Effects.
- 0 real-host measurements for CAP021/CAP024 on **any** OS.
- Windows: **UNVERIFIED / blocked** — see #21 and #6 comment 6822775849.
  No Windows evidence exists; the dedicated-host path is not yet available.

## How CAP021/CAP024 can be closed (macOS, owned session)

1. Launch your *own* AE (26.5.3 or 27.0.0), no project, or with a disposable
   scratch project. Do not use the user's working AE session.
2. `node probe.mjs prepare /abs/path/to/channel`
3. In the owned AE: File → Scripts → Run Script File →
   `<channel>/probe-start.jsx` (human consent; never automated).
4. `node probe.mjs identify <channel>` — record exact AE build, OS build,
   CPU, and identify result into this file.
5. `node probe.mjs snapshot <channel>` — record result or outcome + trace.
6. Fill the table below with real numbers. Until then it stays open.

### Results table (to fill on the first real run)

| AE build | OS | ping round trip | snapshot result | identify | CPU delta | trace | level |
| --- | --- | --- | --- | --- | --- | --- | --- |
| (not run) | macOS | — | — | — | — | — | UNVERIFIED |

Estimated work: 30–60 minutes including owned-AE launch and console reading.
Windows row stays UNVERIFIED until a dedicated Windows host is available
(see #21).

## Feeding ADR-0005 V tasks

When the table above is filled in, the measurements map 1:1 to ADR-0005's
V2 (minimal round trip) and the parts of V6/V7 that are observable from a
read-only probe. It will NOT close V1 (bootstrap UX), V3 (contention under
render), V4 (unknown-outcome field behavior), or V5 (restart tolerance)
without those runs being performed and recorded.
