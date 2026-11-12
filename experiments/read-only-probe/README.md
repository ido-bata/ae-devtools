# read-only-probe — CAP021–CAP024 (Issue #13)

> Status: **experiment / evidence collector.** This directory is a
> read-only After Effects probe and its verification record. It is not a
> transport decision, not a production bridge, and not a shipped feature.
> Transport selection is **out of scope** here (ADR-0005 Open question 1);
> this probe defines and executes the **transport-agnostic verification
> tasks** (ADR-0005 D4, primarily V2) that any candidate transport must be
> measured against.

## What this is

A minimal, explicitly activated, **read-only** probe that answers, with
evidence, the four CAPs of [Issue #13](https://github.com/ido-bata/ae-devtools/issues/13):

| CAP | Requirement | Where |
| --- | --- | --- |
| **CAP021** | Prove read-only ping/version and target identification (AE version / session / user / channel) on a real host | [`evidence/`](evidence/) + [`EVIDENCE.md`](EVIDENCE.md) |
| **CAP022** | Runtime snapshot schema with reference-invalidation rules and invariants | [`snapshot-schema.md`](snapshot-schema.md) |
| **CAP023** | Distinguish wrong-target / bridge-missing / modal / timeout / reconnect as UNKNOWN vs REFUSED vs BLOCKED, no auto-retry | [`outcome-model.md`](outcome-model.md) + [`tests/`](tests/) |
| **CAP024** | Collect AE version / CPU / latency / trace on macOS; feed results back to ADR-0005 V tasks | [`evidence/`](evidence/) + [`EVIDENCE.md`](EVIDENCE.md) |

## Transport-agnostic by construction

ADR-0005 D4 fixes **what must be measured** (V1–V7) and forbids picking a
first transport candidate before real-host evidence exists on both macOS and
Windows. This probe therefore separates two things very deliberately:

1. **The measurement contract** (transport-agnostic): what a *candidate
   transport* must make observable — request/result round trip of one
   read-only operation (V2), per-operation identity (request id, target
   identity, deadline), claim-before-run, typed outcomes, non-retry on
   unknown, latency/CPU/trace capture (V-file). This is defined in
   [`outcome-model.md`](outcome-model.md) and
   [`snapshot-schema.md`](snapshot-schema.md) without assuming CEP,
   in-AE dispatcher, Apple Event, or file envelopes.
2. **One measurement harness** (a candidate instantiation): the file-based
   channel in [`probe.mjs`](probe.mjs) / [`host/probe-dispatcher.jsx`](host/probe-dispatcher.jsx)
   is *how this experiment reaches a real AE today*. It is recorded as an
   instantiation of the contract, comparable with ae-a8n #98's harness
   (re-bound to its SHA, not counted as real-host evidence of its own).
   Choosing it for measurement is **not** choosing it as *the* transport.

Every future candidate (CEP panel + evalScript, in-AE dispatcher, UXP,
aerender, …) can be scored against the same V2 criteria by running this same
probe contract through it; see `EVIDENCE.md` §"How to evaluate a candidate".

## Non-interference rules (hard)

This experiment touched a real machine that has the user's real work on it.
The following rules were followed and must be followed by any re-run:

1. **Never attach to, modify, launch Apple Events at, or quit an AE instance
   the user already has open.** In the 2026-11-12 run, AE 2026 (26.5.3) was
   running with the user's project and was **not touched in any way** — no
   script delivery, no Apple Events, no focus change, no attach. The probe
   ran only against an AE **this probe itself launched** (AE 2027 27.0.0,
   owned session, no project).
2. **Read-only.** The dispatcher answers exactly one method set
   (`probe.echo`, `probe.identify`, `probe.sysinfo`, `probe.snapshot`) — all
   pure `app`/`Folder`/`File` reads that mutate nothing, save nothing,
   quit nothing. See `host/probe-dispatcher.jsx` §Verify-before-use.
3. **Human-consented activation only.** The host script is started by a human
   via File → Scripts → Run Script File inside the *owned* AE, not by
   Startup-folder install. No AE preference, no scripting-permission
   database, no TCC/consent dialog is ever auto-approved or modified.
4. **No automatic retry after timeout.** A timeout after possible dispatch
   is `UNKNOWN` (see `outcome-model.md`), the request file is never removed
   or re-created, and no second request with the same id can be issued.
5. If a run cannot be performed, the measurement is recorded **UNVERIFIED
   with the reason** — never fabricated. (Windows rows are UNVERIFIED.)

## Layout

```
experiments/read-only-probe/
├── README.md                  # this file
├── EVIDENCE.md                # CAP021–024 evidence ledger, per-OS rows
├── outcome-model.md           # CAP023: UNKNOWN/REFUSED/BLOCKED + wrong-target + no-resend
├── snapshot-schema.md         # CAP022: runtime snapshot schema, invalidation, invariants
├── probe.mjs                  # Node client: prepare/identify/ping/snapshot/diagnose
├── host/
│   └── probe-dispatcher.jsx   # ES3 dispatcher template (read-only, activated by a human)
├── tests/
│   ├── run.mjs                # test runner (node:test, zero deps)
│   └── *.test.mjs             # fake-responder tests incl. no-resend regression
└── evidence/
    ├── capture.sh             # macOS evidence capture helper (owned session only)
    ├── 2026-11-12-macos/      # real-run artifacts from the owned AE 2027 session
    └── windows-UNVERIFIED.md  # why Windows evidence is unobtainable now
```

## Quick start (macOS, owned session only)

```sh
# 0. AE must NOT be the user's running instance. Launch your own AE, or skip.
# 1. Prepare a private channel (inbox/outbox/probe.json, 0700/0600)
node probe.mjs prepare /absolute/path/to/channel
# 2. In the OWNED AE: File → Scripts → Run Script File → <channel>/probe-start.jsx
#    (if AE shows its scripting-permission prompt, the human decides; never automate)
# 3. From the same OS user:
node probe.mjs identify /absolute/path/to/channel 10000
node probe.mjs ping       /absolute/path/to/channel 10000
node probe.mjs snapshot   /absolute/path/to/channel 10000
node probe.mjs sysinfo    /absolute/path/to/channel 10000
# 4. Diagnostics (never auto-retry):
node probe.mjs diagnose   /absolute/path/to/channel 3000
# 5. When done: quit the OWNED AE normally. Delete the channel after AE is gone.
```

Every invocation appends a JSONL trace line to `<channel>/trace.jsonl` and
prints a typed outcome object. Nothing retries. Nothing writes to AE.

## Evidence levels used in this directory

Labels from the repo's verification taxonomy (AGENTS.md of ae-a8n /
`plan.md` §6.2 of the capability spec), restated so each measurement is
unambiguous:

| Label | Meaning |
| --- | --- |
| `source-reviewed` | claim grounded in reviewed source/docs only |
| `automated-test` | covered by a green test against the in-repo fake responder (no AE) |
| `fake/mock only` | verified against the in-repo fake AE host, not a real AE |
| `verified on real host` | observed on a real, installed After Effects, at a recorded build |

`EVIDENCE.md` states, per measurement and per OS row, which level was
reached. `fake/mock only` is never presented as working.

## Relation to other work

- **ae-a8n #98** (PR #101, head `273b1d2`): the in-AE dispatcher proof is
  `fake/automated only` at that SHA. This experiment re-binds to that SHA for
  design comparison (claim/one-in-flight/typed-outcome rules) and **does not
  count it as real-host evidence** for CAP021–024. What runs here is this
  repo's own probe, and only its own real-run records count as real-host
  evidence.
- **ADR-0005 (branch `12`, PR #27)**: status Proposed; owns the V tasks and
  the transport decision. `EVIDENCE.md` §"Feeding ADR-0005 V tasks" reports
  which V items this probe advanced and with what evidence level.
- **Windows**: blocked (#21; no dedicated Windows host). See
  `evidence/windows-UNVERIFIED.md`.
