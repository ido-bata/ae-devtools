# Evidence ledger — read-only probe (CAP021–CAP024)

- Issue: [#13](https://github.com/ido-bata/ae-devtools#13)
- Date: 2026-11-12 / updated 2026-11-13
- Levels used: `source-reviewed | automated-test | fake/mock only | verified on real host`.

## Status right now

| CAP | Requirement | Evidence level | What is proven | What is NOT proven |
| --- | --- | --- | --- | --- |
| CAP021 ping/version + target identity | **verified on real host (macOS)** | run `run-20261113-2` | AE 2026 `26.5.3x9` answered `identify`/`ping`/`snapshot`/`sysinfo` with session identity (`sess-disp-cc004b7d-6af716bd`), user, locale; wrong-target/mismatched-pin requests were REFUSED (`WRONG_TARGET`, `EXPIRED`) and a pre-activation timeout stayed `UNKNOWN` with no resend | AE 2027 real-host run; Windows |
| CAP022 snapshot schema + invalidation | documented | source-reviewed + automated-test + real-host shape check | Schema, invalidation rules and invariants are written, fake-tested, and a live `probe.snapshot` reply matched the documented shape | Reference-invalidation behavior across project mutations (out of read-only scope) |
| CAP023 UNKNOWN/REFUSED/BLOCKED model | documented | automated-test + **real-host confirmations** | Outcome table, wrong-target refusal, no-retry regressions — `node tests/run.mjs` → 6/6 test files green; on the real host an absent dispatcher produced `UNKNOWN NO_REPLY_BEFORE_DEADLINE`, a stale request was `REFUSED EXPIRED`, and a version-pin mismatch was `REFUSED WRONG_TARGET` | Real busy/modal timeout under load (ADR-0005 V3/V4) |
| CAP024 macOS version/CPU/latency/trace | **verified on real host (macOS)** | run `run-20261113-2` | Round trips 157–260 ms (50 ms poll granularity), host clock, Apple M5 / 10 cores, macOS 27.2.1 (26B131), per-request JSONL trace persisted | Windows; CPU-under-load deltas; AE 2027 |

**Windows stays `UNVERIFIED`** — no Windows host is used (owner decision; see
#21 and #6 comment 6822775849). Nothing below claims Windows evidence.

## What is actually green

- `node tests/run.mjs` → **6/6 test files green** (2026-11-13, macOS).
  Tests use a **fake responder**; they do not start After Effects.
- Real-host run `run-20261113-2` against **owned AE 2026 (26.5.3x9, pid 1054)**,
  activated via `osascript DoScriptFile` on the owned instance after owner
  authorization of CLI/AppleScript activation (the earlier human-menu plan
  was superseded). The user's interactive AE 2027 session was never touched.
- Artifacts: `evidence/run-20261113-2/` (`manifest.json`, `trace.jsonl`,
  `target.json`, `results/*.result.json` — channel token redacted).

## Real-run record (run-20261113-2, 2026-11-13)

| AE build | OS | ping round trip | snapshot result | identify | CPU | trace | level |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 26.5.3x9 (AE 2026, owned, pid 1054) | macOS 27.2.1 (26B131), Apple M5 10c | 157 ms | COMPLETED — projectOpen=true, 0 items, 0 RQ items | COMPLETED — session/dispatch/user/locale pinned | AE 26.6 % CPU, 563 MB RSS at capture | `trace.jsonl` + outbox results in `evidence/run-20261113-2/` | **verified on real host (macOS)** |

Additional completed calls in the same session: `identify` 208 ms,
`sysinfo` 208 ms, `diagnose` (client-side OS observation).

### Anomalies recorded verbatim (not smoothed over)

- `app.scriptingVersion` evaluated to the string `"undefined"` on AE
  26.5.3x9 — the property appears unset/absent in this build; recorded as
  returned, not coerced.
- `sysinfo` returned empty `systemFolderName` and `hostName`.
- `snapshot` reported `projectOpen: true` with `projectItemCount: 0`
  (untitled/empty project state).
- `prepare --expect-ae "26.5"` pinned a prefix that mismatched
  `app.version === "26.5.3x9"`; the host correctly answered
  `REFUSED WRONG_TARGET`. Version pinning requires the exact
  `app.version` string.
- A request sent before dispatcher activation timed out
  `UNKNOWN NO_REPLY_BEFORE_DEADLINE`; when the dispatcher later claimed it
  the host answered `REFUSED EXPIRED`. No resend occurred (CAP023 rule).
- The first generated `probe-start.jsx` (channel `run-20261113`) was
  syntactically invalid — a placeholder double-quoting bug in `prepare`.
  Fixed in `874b2ad` with a `node --check` regression test
  (`tests/prepare.test.mjs`). The AE `-r` launch flag did **not** activate
  the dispatcher on macOS; activation used `DoScriptFile` instead.

## How a run is reproduced (macOS, owned session)

1. Launch your *own* AE (26.5.3 or 27.0.0), no project, or with a disposable
   scratch project. Do not use the user's working AE session.
2. `node probe.mjs prepare /abs/path/to/channel` (optionally
   `--expect-ae <exact app.version>`).
3. Activate `probe-start.jsx` inside the owned AE — File → Scripts → Run
   Script File, or an owner-authorized `DoScriptFile`. Never install into a
   Startup folder by tooling.
4. `node probe.mjs identify|ping|snapshot|sysinfo|diagnose <channel>`.
5. Record build / OS / CPU / latency / trace into this file and
   `evidence/<run>/`.

Windows row stays UNVERIFIED until a dedicated Windows host is available
(see #21).

## Feeding ADR-0005 V tasks

The `run-20261113-2` measurements map to ADR-0005's V2 (minimal round trip:
~150–260 ms end-to-end through a 250 ms scheduled-task poll on an owned
local session) and the observable parts of V6/V7. They do **not** close
V1 (bootstrap UX), V3 (contention under render), V4 (unknown-outcome field
behavior under real busy/modal), or V5 (restart tolerance) — those runs were
not performed.
