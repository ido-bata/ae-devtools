# Outcome model — CAP023

> Status: **experiment contract** (transport-agnostic). This document defines
> the classification every probe run (and, later, every candidate transport
> assessed with this probe) must produce. It does not assume any particular
> transport: each classification below is defined by **what is observable**,
> not by how the message traveled.

Related: [README](README.md) · [snapshot-schema.md](snapshot-schema.md) ·
spec.md FR-07 ("non-retry on unknown outcomes"), `plan.md` §6.2
(`NOT_RUN | BLOCKED | PASS | FAIL | UNKNOWN`), ae-a8n #98 review
("busy AE and absent dispatcher can be indistinguishable: use UNKNOWN"),
ADR-0005 D4 (V4: error vs unknown-outcome distinction).

## 1. Why three-way classification

A read-only dispatch has exactly three observably different failure stories:

- **`REFUSED`** — the request *reached the host/bridge* and was rejected
  *before any operation ran*. Evidence exists: a refusal reply naming the
  reason. Deterministic, safe to re-issue as a *new* request (new id).
- **`BLOCKED`** — the request could not *reach* dispatch for a reason that
  is *proven from the environment*, without needing the host to say so:
  target absent (AE not running / wrong channel), transport not installed,
  environment precondition failing (channel not private, channel missing).
  Nothing ran. Safe to re-issue as a *new* request after the environment
  changes.
- **`UNKNOWN`** — the request *may have reached* dispatch but no reply
  arrived before the deadline, or the reply could not be attributed.
  Includes every case where "host is busy with a modal / render / long
  operation" and "bridge never activated / died / lost permission" cannot be
  distinguished from out here. **Never retried, never re-sent.**

The partial-overlap rule (from ae-a8n #98 review, binding here):

> busy/modal AE and an absent dispatcher can be indistinguishable from the
> client side. Any such case is `UNKNOWN`, diagnosed only as
> `unknownCategory: "no-reply-before-deadline"`. It is forbidden to report
> `BLOCKED` with a modal/busy reason unless the host *itself* reported it
> (e.g. a typed refusal from inside AE or an OS-visible, attributable
> signal).

## 2. Outcome objects (wire shape, transport-agnostic)

```jsonc
// success
{ "outcome": "COMPLETED",
  "requestId": "<32hex>", "method": "probe.identify",
  "startedAt": "…", "endedAt": "…", "durationMs": 123,
  "result": { … } }

// host refused before running (has a host reply)
{ "outcome": "REFUSED",
  "requestId": "<32hex>", "method": "…",
  "refusal": { "code": "WRONG_TARGET" | "BAD_REQUEST" | "UNSUPPORTED_METHOD"
                     | "EXPIRED" | "CHANNEL_TOKEN_MISMATCH",   // closed set
               "message": "…" },
  "durationMs": 123, "result": null }
// only REFUSED carries a refusal; only from a host-issued reply.

// environment provenly blocked (never a guess about AE's internal state)
{ "outcome": "BLOCKED",
  "blocker": { "code": "TARGET_NOT_RUNNING" | "CHANNEL_NOT_PREPARED"
                     | "CHANNEL_NOT_PRIVATE" | "BRIDGE_NOT_INSTALLED",   // closed set
               "message": "…" },
  "requestId": "<32hex>", "requestState": "NOT_SENT",   // nothing was dispatched
  "durationMs": 0, "result": null }

// no attributable reply before deadline, or reply corrupt/unattributable
{ "outcome": "UNKNOWN",
  "unknownCategory": "NO_REPLY_BEFORE_DEADLINE" | "UNREADABLE_REPLY"
                     | "UNATTRIBUTABLE_REPLY",          // closed set
  "requestId": "<32hex>", "requestState": "SENT_NOT_ACKNOWLEDGED",
  "durationMs": 10000, "result": null,
  "note": "the request may have been claimed and executed; do not resend; diagnostics: channel=…, aeProcessObservation=…" }
```

`requestState` ∈ { `NOT_SENT`, `SENT`, `SENT_NOT_ACKNOWLEDGED`, `ACKED` } is
part of every outcome and is the anti-double-send evidence hook: a request
whose state is anything other than `NOT_SENT` **can never be re-issued**, and
never with the same id (§4).

## 3. Classified situations (CAP023 matrix)

| Situation | Classification | Reasoning / required evidence |
| --- | --- | --- |
| **Wrong target** — host replies but target identity ≠ expected (≠ expected AE build, ≠ expected session id, ≠ expected channel token) | `REFUSED` with `refusal.code = "WRONG_TARGET"` | The host answered; the *client* then rejects it. A reply from the wrong AE/band is never silently accepted (mis-delivery test in `tests/wrong-target.test.mjs`). The channel token in the reply must match; a mismatched token is `UNKNOWN` (`UNATTRIBUTABLE_REPLY`) because we cannot prove *which* host wrote it, not `REFUSED`. |
| **Bridge missing / not activated** — request written to a prepared channel, no reply before deadline, and *no other evidence* | `UNKNOWN` (`NO_REPLY_BEFORE_DEADLINE`) | Indistinguishable from busy AE. Not `BLOCKED`, not `REFUSED`. Exception: `BRIDGE_NOT_INSTALLED`/`TARGET_NOT_RUNNING` `BLOCKED` **only** when the environment itself proves it (e.g. no AE process at all exists on the machine, or the channel was never prepared). |
| **Modal dialog up in AE** (host busy, `app.scheduleTask` delayed) | `UNKNOWN` unless the host *said so* | From outside, "AE has a modal" and "dispatcher dead" look identical. If a future transport has an attributable in-host signal for modality, it may produce a typed refusal; until then this stays `UNKNOWN`. The real-host record must say which case occurred. |
| **Timeout after possible dispatch** | `UNKNOWN`. **No automatic retry.** | The rule is absolute: the client never re-sends, never removes/recreates the request, and must leave any request file in place so the host's own late refusal (`EXPIRED`) is observable. The next manual ping uses a *new* id. Regression: `tests/no-resend.test.mjs`. |
| **Reconnect** (AE quit + relaunched, dispatcher reactivated on the same channel) | new `COMPLETED` on a **new** request id, with re-derived `sessionId` | Reconnect is *not* recovery of the old in-flight request — that one stays `UNKNOWN` forever. What reconnect proves is that the *channel + activation model* survives a host restart: measured in `evidence/` as a separate row. Old session's ids are never reused (id-registry test). |
| **Stale / expired request** (`deadlineMs` past) | `REFUSED` with `refusal.code = "EXPIRED"` — issued by the host | Host-side claim-before-run means an expired request is refused atomically by the host, not guessed by the client. |
| **Duplicate request id** | cannot occur by construction; host renames to `.claimed` before evaluating | Client refuses to build two requests with the same id (`tests/duplicate-id.test.mjs`); host-side rename prevents replay after a host restart. |
| **Corrupt / unparseable reply** | `UNKNOWN` (`UNREADABLE_REPLY`) + quarantine note | A half-written or alien file must not be treated as "no result yet"; publish-by-rename makes this rare, but if seen: never retry, quarantine. |
| **Channel not private** (POSIX group/other bits set; note: POSIX modes are insufficient on Windows — see `evidence/windows-UNVERIFIED.md`) | `BLOCKED` (`CHANNEL_NOT_PRIVATE`) before anything is written | Environment-proven, pre-dispatch. `requestState = NOT_SENT`. |
| **AE not running at all** (probe pre-check, owned-session gate) | `BLOCKED` (`TARGET_NOT_RUNNING`) | Pre-dispatch environment fact. This pre-check is **only** about *process existence of the intended owned target*; it never inspects or touches the user's AE instance. |

Client-side classification happens in `probe.mjs` `classify()`;
`tests/outcome-classification.test.mjs` pins the mapping table.

## 4. Anti-double-send (no-resend) invariants

These are the invariants any candidate transport evaluated with this probe
must uphold, and the fake-responder tests enforce for this harness:

1. **Id-life:** a request id is generated once, persists until a terminal
   outcome (`COMPLETED`/`REFUSED`/`BLOCKED`) is recorded; after `UNKNOWN` the
   id is burned in a local registry and **never** used again.
2. **One in flight:** a second request while the first is
   `SENT`/`SENT_NOT_ACKNOWLEDGED` is refused client-side (`BLOCKED`,
   `code=ONE_IN_FLIGHT`) without writing anything.
3. **No automatic retry:** no timer, loop, or error path re-issues a
   request. Timeout yields `UNKNOWN` and returns. The only re-run is a
   human-issued, new-id command.
4. **Request persistence:** after `UNKNOWN`, any request artifact (file /
   message) is left in place for post-mortem and host-side expiry; never
   deleted or overwritten by the client.
5. **No same-id rewrite:** the client never writes a request with an id that
   already exists in the outbox/inbox (both checked).

## 5. Mis-delivery protection (wrong-target test)

`CAP021` requires recording *what identifies the target*; `CAP023` requires
proving a reply from the *wrong* target is rejected:

- Every reply must carry the channel token, the AE build string
  (`buildName`), the host-generated `sessionId` (one per activation), and
  the probe's `dispatchId`. The client accepts a reply only when
  `token`, `buildName` (when the caller pinned one), and `sessionId` (once
  pinned by the first `identify`) all match expectation.
- Any mismatch is *never* accepted, never re-requested with the same id, and
  recorded as `REFUSED` (provably-answerable mismatch: `WRONG_TARGET`) or
  `UNKNOWN` (unattributable: token mismatch).
- `tests/wrong-target.test.mjs` runs a fake responder that speaks the right
  protocol but answers with another AE's identity; it must produce
  `REFUSED`/`WRONG_TARGET`, not a silent pass.

## 6. Deliberately not decided here

- Which transport produces these outcomes in production (ADR-0005 R1).
- Whether `BLOCKED` may ever be derived from OS-level signals beyond the
  two closed codes above (`TARGET_NOT_RUNNING`, `CHANNEL_*`,
  `BRIDGE_NOT_INSTALLED`): any addition must come with a real-host
  observation record; until then "I think AE is busy" is `UNKNOWN`.
- Windows ACL evidence: POSIX mode checks are insufficient on Windows; the
  channel-privacy rule cannot be evaluated there on this machine
  (UNVERIFIED — see the Windows row in `EVIDENCE.md`).
