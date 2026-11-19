# Contract — native intake channel (`ae-devtools/native-channel/v1`)

- Status: **Implemented for Issue #267 Slice A** (merged via PR #268, `release-0-5-0` @ `a7ac89f`), implemented by `experiments/native-sdk/minimal-plugin/src/native_intake.cpp` inside the NativeProbe idle hook. Machine-readable shapes: `packages/native-adapter/src/dispatch.ts` (`NATIVE_INTAKE_*` constants).
- Sibling contracts: [native-dispatch.md](native-dispatch.md) (the semantic `native-dispatch/v1` envelope this channel carries), [native-probe-result.md](native-probe-result.md) (in-host `op `/marker evidence), [native-adapter.md](native-adapter.md) (pre-dispatch negotiation).
- Ownership: per ADR-0005 D7, transport / IPC / serialization / execution authorization / timeout / UNKNOWN non-resend are **ae-a8n-owned (©)**. This contract fixes only the **devtools-owned surface**: the on-disk encoding and the plug-in-side intake semantics for the first read-only vertical slice. It does not select a transport, does not mint or verify consent tokens, and does not claim process identity.

## 1. What this channel is — and is not

The NativeProbe plug-in's only execution context is its registered **idle hook** (AE main thread, host-dispatched). This contract defines an **opt-in, off-by-default** intake inside that hook: when explicitly enabled, each idle dispatch polls a private channel directory for read-only dispatch requests and publishes typed results.

```
external request file → claim → validate → one allowlisted read-only AEGP op → atomic result file + op/marker evidence
```

**Verification lane, not a dispatch grant.** Intake membership in `NATIVE_INTAKE_OPERATIONS` is an *explicitly authorized verification path* so the first real-host proof (Issue #223 / Slice C) has a defined way to reach the plug-in. It is **not** the `dispatchable` gate: registry entries stay `implemented-unverified`, `resolveDispatchOperation` keeps refusing every committed entry, and no operation is promoted by intake alone. Evidence-free capability is never publicly exposed — the lane is off unless an operator points the plug-in at a prepared channel.

## 2. Opt-in and channel layout

Intake is disabled unless the plug-in process environment carries:

```
AE_DEVTOOLS_NATIVE_CHANNEL=<absolute path to a prepared native channel root>
```

The channel root is prepared by the owning runtime (ae-a8n side, Slice B); the plug-in **never creates directories**. Layout mirrors the ae-a8n in-AE dispatcher conventions under a distinct namespace so native requests cannot be confused with ES3 dispatcher requests:

```
<channelRoot>/channel.json            {v:1, token, sessionAeVersion?}   (0600, preparer-written)
<channelRoot>/inbox/<requestId>.request.json                            (0600)
<channelRoot>/outbox/<requestId>.result.json                            (0600, atomic publish)
<channelRoot>/state.json              plug-in heartbeat                  (0600)
```

POSIX privacy is enforced per tick, fail-closed: root/`inbox`/`outbox`/`channel.json` must exist, must not be symlinks, and must not be group/other-accessible (`mode & 077 == 0`). Any violation disables intake for that tick (requests wait; deadlines refuse them later). Windows is UNVERIFIED — the permission model is POSIX-only for now.

`channel.json`:

| Field | Rule |
| --- | --- |
| `v` | `1` |
| `token` | 64 lowercase hex chars — the channel shared secret. The plug-in compares it verbatim and **never writes it** to the debug log, result files, or `state.json` |
| `sessionAeVersion` | optional `"M.m"` pin; when present it must equal the plug-in-attested driver implementation version or every request refuses `WRONG_TARGET` |

## 3. Request — `<requestId>.request.json`

```json
{
  "v": 1,
  "token": "<64hex>",
  "timeoutMs": 30000,
  "target": "<instance>",
  "request": {
    "schema": "ae-devtools/native-dispatch/v1",
    "requestId": "<id>",
    "session": {"sessionId": "…", "aeVersion": "26.5", "sdkRelease": {"identifier": "26.5", "distribution": "macos"}},
    "operationId": "AEGP_ProjSuite6.AEGP_GetNumProjects",
    "args": null,
    "authorizationRef": "…"
  }
}
```

| Field | Rule |
| --- | --- |
| `v` | `1` |
| `token` | must equal `channel.json`'s token |
| `timeoutMs` | finite number in `[0, 3600000]` (1 h ceiling); deadline = request-file mtime + `timeoutMs` (same convention as the ae-a8n dispatcher). Out-of-bounds values refuse `MALFORMED_REQUEST`; already-expired requests refuse `STALE_REQUEST` **before execution**; an unreadable mtime yields `not-sent` (freshness unproven) |
| `target` | optional instance binding. A request naming a different instance is **not claimed** (left for its instance); the plug-in's instance id is reported in `state.json` |
| `request` | the `native-dispatch/v1` envelope, unchanged. `requestId` must equal the file-name stem and, on this file channel, must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (the semantic envelope keeps "non-empty string"; the file channel narrows it so names are path-safe and JSON-escape-free) |
| `args` | Slice A accepts only absent/`null` — every allowlisted operation is zero-argument. Any other value refuses `MALFORMED_REQUEST` |
| `authorizationRef` | accepted and ignored; grant issuance/verification is ae-a8n-owned |

Parser bounds (file-channel implementation limits, stricter than the semantic envelope's): input ≤ 64 KiB, JSON depth ≤ 32, ≤ 8192 nodes, duplicate object keys rejected, trailing garbage rejected, non-finite numbers rejected. The parser is a self-contained unit (`src/native_json.{h,cpp}`, libc only) separate from channel logic for auditability.

## 4. Validation and refusal order

After claim (`*.request.json` → `*.claimed` rename; one request per idle dispatch, name-sorted), the plug-in validates in this order. Every verdict publishes a typed result — a claimed request never disappears silently:

1. JSON parse → `refused` `MALFORMED_REQUEST`; unreadable/oversized file same
2. envelope `v === 1` → `MALFORMED_REQUEST`
3. `token` === channel token → `refused` `CHANNEL_TOKEN_MISMATCH`
4. `request.requestId` === file-name stem → `MALFORMED_REQUEST`
5. `target` present and ≠ instance → `refused` `WRONG_TARGET` (defence in depth; the pre-claim filter normally prevents this)
6. `timeoutMs` finite and deadline (file mtime + `timeoutMs`) not passed → `refused` `STALE_REQUEST`
7. `request` envelope shape: `schema` exact, `requestId`/`session.sessionId`/`session.aeVersion` non-empty, `sdkRelease` shape when present, `operationId` string, `args` absent-or-null → `MALFORMED_REQUEST`
8. `operationId` ∈ `NATIVE_INTAKE_OPERATIONS` → `refused` `OPERATION_NOT_DISPATCHABLE` (unknown ids and non-allowlisted registry ids share this code)
9. duplicate `requestId` (seen-ring, last 64 claimed ids) → `refused` `DUPLICATE_REQUEST`
10. session attestation: `AEGP_GetDriverImplementationVersion` must succeed (`not-sent` otherwise — environment-proven non-dispatch), `session.aeVersion` must equal the observed `"M.m"` and any `channel.json` pin → `refused` `WRONG_TARGET`
11. execute the allowlisted getter → `completed` (`err==0`) or `failed` (`err!=0`, `mayHaveMutated:false` — allowlisted ops are read-only getters)

`not-sent` is the only outcome the client may re-issue (as a **new** request). `unknown` is never emitted by the plug-in: a crashed/interrupted claim leaves `*.claimed` behind and the client times out `UNKNOWN` — claimed requests are never replayed. The plug-in removes `*.claimed` only after a verdict has been published (or attempted); a crash mid-request leaves it as evidence, never re-executed. The duplicate `requestId` seen-ring is per plug-in session: after a plug-in restart the ring resets, so dedup across restarts relies on client-side requestId uniqueness (read-only allowlisted ops make a replay benign but it is still refused within a session).

## 5. Result — `<requestId>.result.json`

```json
{
  "v": 1,
  "instance": "<plug-in instance id>",
  "host": {"plugin": "ae-a8n NativeProbe", "pluginId": 4242, "aeVersion": "26.5"},
  "result": { "schema": "ae-devtools/native-dispatch/v1", "requestId": "…", "outcome": "completed", "result": {"numProjects": 1}, "opCalls": ["…"] }
}
```

- `result` is a pure `DispatchResult` — `validateDispatchResult` applies unchanged.
- `host` is the session-binding attestation: plug-in identity, numeric plugin id, and the driver implementation version `"M.m"` the session pin was checked against. **Process identity is explicitly not claimed** — this mirrors the ae-a8n instance-pinning guarantee ("same engine that answered", not "which process").
- The channel token is **never** written to result files or the debug log.
- Publish is atomic or fails: write `*.result.json.part` (`O_NOFOLLOW`, `0600`, fsync), rename to final (retried); **there is no non-atomic fallback** — if no atomic publish succeeds the caller sees `UNKNOWN`, never a partial result, and the request is never resent. The `*.claimed` file is removed afterwards whether or not publish succeeded.
- File safety: only regular files are claimable (a symlink/FIFO/device with a request-shaped name is left untouched → client `UNKNOWN`); all channel reads use `O_NOFOLLOW` + `fstat` regular-file checks; the staging `.part` path refuses symlinks so a pre-planted link can never be written through.
- `state.json` is refreshed on the first tick and every 8th tick thereafter (`{v, instance, pluginId, lastTick, aeVersion?, allowlist}`); outbox results older than 1 h are swept as unread deliveries.

## 6. Evidence

Every allowlisted AEGP call emits the standard `op <Suite>.<member> err=<n>` record plus `native.request id=<id>` / `native.result id=<id> outcome=<o>[ code=<c>]` marker lines in the debug log (see native-probe-result.md). `result.opCalls` lists the op-record ids emitted inside the request window, giving the `native-probe-result/v1` linkage. Intake-level failures (channel privacy violation, publish failure) emit `native.error:` diagnostics; channel-configuration violations are log-once guarded, per-request publish failures log per request.

## 7. `NATIVE_INTAKE_OPERATIONS` — the Slice A allowlist

```
AEGP_ProjSuite6.AEGP_GetNumProjects
AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion
```

Both are zero-argument read-only getters the probe already calls; both stay `implemented-unverified`. Widening the allowlist is a separate reviewed change — each addition must be a read-only getter with a defined serializable payload. Mutation operations are out of scope (FR-07/US3 permission model first).

## 8. Non-goals / explicit limitations

- No mutation/write operations; no consent-token issuance, storage, or verification (`authorizationRef` is opaque).
- No transport selection, no fallback policy beyond what the channel contract fixes, and no second transport in ae-devtools. The ae-a8n-owned client side (channel preparation, token issuance, request publication, result collection) is implemented in ae-a8n `src/driver/native-channel.ts` under ae-a8n Issue #238 (Slice B; Draft PR ae-a8n#239 at time of writing — merge state is ae-a8n's to report). The fake-environment end-to-end (external request → allowlisted getter → result matching) is the remaining Slice B step on the devtools side.
- File-channel privacy is not authentication — same limitation as the ae-a8n dispatcher, documented not hidden.
- `sessionId` is shape-validated only; the plug-in cannot prove which client process supplied it.
- Windows remains entirely UNVERIFIED.
- A `completed` result is a claim at fake-host level until Slice C produces `native-probe-result/v1` artifacts under LOAD-PROOF.md on an authorized session (#223).
