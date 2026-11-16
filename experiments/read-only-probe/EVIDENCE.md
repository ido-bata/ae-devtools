# Evidence ledger — read-only probe (CAP021–CAP024)

- Issue: [#13](https://github.com/ido-bata/ae-devtools#13)
- Date: 2026-11-12 / updated 2026-11-13
- Levels used: `source-reviewed | automated-test | fake/mock only | verified on real host`.

## Status right now

| CAP | Requirement | Evidence level | What is proven | What is NOT proven |
| --- | --- | --- | --- | --- |
| CAP021 ping/version + target identity | **verified on real host (macOS)** | runs `run-20261113-2`, `run-20261113-3` | AE 2026 `26.5.3x9` answered `identify`/`ping`/`snapshot`/`sysinfo` with session identity (`sess-disp-1ccc5fa1-6af71e9e` in run-3), user, locale; wrong-target/mismatched-pin requests were REFUSED (`WRONG_TARGET`, `EXPIRED`) and a pre-activation timeout stayed `UNKNOWN` with no resend. Run-3 additionally proves: `ping` carries session identity, a same-session re-`identify` does **not** rewrite the pin, and `hostClock` is true UTC | AE 2027 real-host run; Windows; client-side wrong-target refusal against a real *second* session (fake-tested only) |
| CAP022 snapshot schema + invalidation | documented | source-reviewed + automated-test + real-host shape check | Schema, invalidation rules and invariants are written, fake-tested, and a live `probe.snapshot` reply matched the documented shape | Reference-invalidation behavior across project mutations (out of read-only scope) |
| CAP023 UNKNOWN/REFUSED/BLOCKED model | documented | automated-test + **real-host confirmations** | Outcome table, wrong-target refusal, no-retry regressions — `node tests/run.mjs` → 7/7 test files green (33 tests); on the real host an absent dispatcher produced `UNKNOWN NO_REPLY_BEFORE_DEADLINE`, a stale request was `REFUSED EXPIRED`, a version-pin mismatch was `REFUSED WRONG_TARGET`, and a REFUSED reply releases the in-flight guard immediately (post-fix) | Real busy/modal timeout under load (ADR-0005 V3/V4) |
| CAP024 macOS version/CPU/latency/trace | **verified on real host (macOS)** | runs `run-20261113-2`, `run-20261113-3` | Round trips 157–315 ms (50 ms poll granularity), true-UTC host clock (run-3), Apple M5 / 10 cores, macOS 27.2.1 (26B131), per-request JSONL trace persisted | Windows; CPU-under-load deltas; AE 2027 |

**Windows stays `UNVERIFIED`** — no Windows host is used (owner decision; see
#21 and #6 comment 6822775849). Nothing below claims Windows evidence.

## What is actually green

- `node tests/run.mjs` → **6/6 test files green, 31 tests** (2026-11-13,
  macOS, head `c11b1ad`; suite has since grown — current head runs
  7/7 files, 33 tests). Tests use a **fake responder**; they do
  not start After Effects.
- Real-host run `run-20261113-2` against **owned AE 2026 (26.5.3x9,
  pid 1054)**, activated via `osascript DoScriptFile` on the owned
  instance after owner authorization of CLI/AppleScript activation (the
  earlier human-menu plan was superseded). The user's interactive AE
  2027 session was never touched. **Caveat:** that run predates the
  supervision-review fixes below; its `hostClock` values are local time
  mislabeled as UTC and its `ping` reply carried no session identity, so
  the wrong-target check was not exercised for `ping` in that run. A
  post-fix re-run is recorded separately below.
- Artifacts: `evidence/run-20261113-2/` (`manifest.json`, `trace.jsonl`,
  `target.json`, `results/*.result.json` — channel token redacted).

## Real-run record (run-20261113-3, 2026-11-13, post-review head `c11b1ad`)

Owned AE 2026 **26.5.3x9** (pid 60663, launched via `open -na` for this
run; the user's interactive AE 2027 session was never touched).
Dispatcher activated via `osascript DoScriptFile` on the owned instance.

| AE build | OS | ping round trip | snapshot result | identify | CPU | trace | level |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 26.5.3x9 (AE 2026, owned, pid 60663) | macOS 27.2.1 (26B131), Apple M5 10c | 261–315 ms | COMPLETED — projectOpen=true, 0 items, 0 RQ items | COMPLETED — session/dispatch/user/locale pinned; **re-identify did not rewrite the pin** | AE 19.7 % CPU, 585 MB RSS at capture | `evidence/run-20261113-3/` (`manifest.json`, `trace.jsonl`, `target.json`, `results/*.result.json`, token redacted) | **verified on real host (macOS)** |

Post-run commits note: the host script `host/probe-dispatcher.jsx` is
unchanged since `c11b1ad`. Later client-only hardening (`9b4843a`:
dispatchId fail-closed, identify requires identity, no hollow pins) is
covered by the fake-responder suite; it does not alter host-observed
behavior, so the run-3 measurements remain bound to `c11b1ad` for the
executed code and to `9b4843a` for the current client.

Post-fix confirmations in this run:

- `hostClock` is a **true UTC instant** (e.g. `14:30:32.307Z` vs client
  `startedAt` in the same second — previously +9h mislabeled).
- `probe.echo` result carries the **full identity block**
  (`sessionId`/`aeVersion`/`dispatchId`), so the wrong-target check now
  applies to `ping`.
- `--expect-ae 27.0.0` against AE 26.5.3x9 → host `REFUSED WRONG_TARGET`
  before execution.
- Same-session re-`identify` → COMPLETED with `pinnedAt` **unchanged**
  (no silent re-pin).
- A REFUSED reply releases the in-flight guard immediately (verified on
  the real channel: the command after the WRONG_TARGET ping was not
  BLOCKED; regression covered by `tests/outcome-classification.test.mjs`).

Still not covered: a real *second* session attempting the same channel
(client-side `WRONG_TARGET` on live mis-delivery is fake-tested only —
only one owned AE was launched), AE 2027, Windows, busy/modal behavior.

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

### Defects found in supervision review of `d2348fd` (fixed post-run)

Recorded verbatim; the artifacts above are pre-fix and are not rewritten:

- `hostClock` in `run-20261113-2` artifacts is **local time mislabeled
  as UTC** (`isoNow()` used local getters + `"Z"`; observed +9h on this
  JST host). Not usable for clock-drift measurement. Fixed to `getUTC*`
  in the post-review head.
- `probe.echo` replies carried **no session identity**, so the
  wrong-target check could not fire for `ping` (fail-open). The host now
  returns the identity block on every method, and the client refuses a
  pinned-channel reply that lacks `sessionId`/`aeVersion`.
- `identify` **silently overwrote `target.json`** on every run, so a
  second session answering the same channel would have re-pinned without
  any `WRONG_TARGET`. Pins now survive refused re-identifies; overwriting
  requires the explicit `identify --pin-session`. `dispatchId` is pinned
  and checked to catch dispatcher re-activation inside one AE session.

## How a run is reproduced (macOS, owned session)

1. Launch your *own* AE (26.5.3 or 27.0.0), no project, or with a disposable
   scratch project. Do not use the user's working AE session.
2. `node probe.mjs prepare /abs/path/to/channel` (optionally
   `--expect-ae <exact app.version>`).
3. Activate `probe-start.jsx` inside the owned AE — File → Scripts → Run
   Script File, or an owner-authorized `DoScriptFile`. Never install into a
   Startup folder by tooling.
4. `node probe.mjs identify|ping|snapshot|sysinfo|diagnose <channel>`.
   The first successful `identify` pins the session in `target.json`;
   a later `identify` against a *different* session is REFUSED
   WRONG_TARGET — re-pinning an owned channel on purpose requires the
   explicit `identify --pin-session`.
5. Record build / OS / CPU / latency / trace into this file and
   `evidence/<run>/`.

Windows row stays UNVERIFIED until a dedicated Windows host is available
(see #21).

## How to evaluate a candidate transport

Any candidate transport (CEP panel + `evalScript`, in-AE dispatcher,
UXP, Apple Events, …) is scored against the **same transport-agnostic
contract** this probe implements — it is not scored by reusing this
file-envelope harness:

1. Map the candidate onto the outcome model (`outcome-model.md`): can it
   produce `not-sent / refused / completed / failed / unknown` with the
   same meaning, claim-before-run, one-in-flight, no auto-retry?
2. Map it onto the snapshot schema (`snapshot-schema.md`): does a reply
   carry `identity` (sessionId/dispatchId/channelId/aeVersion) sufficient
   for the wrong-target check on **every** method, including ping?
3. Run the V2 minimal round trip (ADR-0005): one read-only operation,
   request id + deadline + target identity, measure latency/CPU/trace on
   an **owned** AE session per OS row (macOS here; Windows UNVERIFIED).
4. Record build / OS / CPU / latency / trace in this file under a new
   `run-<date>-<n>` with `transportId` naming the candidate — never
   reuse this harness's numbers as another transport's evidence.

This harness (`file-envelope-v1`) is itself only one instantiation; its
numbers answer "what does the contract cost over files", not "which
transport wins".

## Feeding ADR-0005 V tasks

The `run-20261113-2`/`run-20261113-3` measurements map to ADR-0005's V2
(minimal round trip: ~150–315 ms end-to-end through a 250 ms
scheduled-task poll on an owned local session) and the observable parts
of V6/V7. They do **not** close
V1 (bootstrap UX), V3 (contention under render), V4 (unknown-outcome field
behavior under real busy/modal), or V5 (restart tolerance) — those runs were
not performed.
