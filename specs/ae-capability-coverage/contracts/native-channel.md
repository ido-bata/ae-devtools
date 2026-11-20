# Contract — native intake channel (`ae-devtools/native-channel/v1`)

- Status: **Implemented for Issue #267 Slice A** (merged via PR #268, `release-0-5-0` @ `a7ac89f`), extended for **Issue #270 Stage 1** (per-operation read-only args codec + `AEGP_ItemSuite9.AEGP_GetTypeName`), implemented by the `experiments/native-sdk/minimal-plugin/src/native_*.cpp` modules (routing/dispatch: `native_intake.cpp`; allowlist: `native_registry.cpp`; executors: `native_ops.cpp`) inside the NativeProbe idle hook. Machine-readable shapes: `packages/native-adapter/src/dispatch.ts` (`NATIVE_INTAKE_*` constants, `NATIVE_INTAKE_ARG_SCHEMAS`).
- Sibling contracts: [native-dispatch.md](native-dispatch.md) (the semantic `native-dispatch/v1` envelope this channel carries), [native-probe-result.md](native-probe-result.md) (in-host `op `/marker evidence), [native-adapter.md](native-adapter.md) (pre-dispatch negotiation).
- Ownership: per ADR-0005 D7, transport / IPC / serialization / execution authorization / timeout / UNKNOWN non-resend are **ae-a8n-owned (©)**. This contract fixes only the **devtools-owned surface**: the on-disk encoding and the plug-in-side intake semantics for the first read-only vertical slice. It does not select a transport, does not mint or verify consent tokens, and does not claim process identity.

## 1. What this channel is — and is not

The NativeProbe plug-in's only execution context is its registered **idle hook** (AE main thread, host-dispatched). This contract defines an **opt-in, off-by-default** intake inside that hook: when explicitly enabled, each idle dispatch polls a private channel directory for read-only dispatch requests and publishes typed results.

```
external request file → claim → validate → consent (mutating ops only) → one allowlisted AEGP op → atomic result file + op/marker evidence
```

**Verification lane, not a dispatch grant.** Intake membership in `NATIVE_INTAKE_OPERATIONS` is an *explicitly authorized verification path* so the first real-host proof (Issue #223 / Slice C) has a defined way to reach the plug-in. It is **not** the `dispatchable` gate: registry entries stay `implemented-unverified`, `resolveDispatchOperation` keeps refusing every committed entry, and no operation is promoted by intake alone. Evidence-free capability is never publicly exposed — the lane is off unless an operator points the plug-in at a prepared channel.

## 2. Opt-in and channel layout

Intake is disabled unless the plug-in process environment carries:

```
AE_DEVTOOLS_NATIVE_CHANNEL=<absolute path to a prepared native channel root>
```

The channel root is prepared by the owning runtime (ae-a8n side, Slice B); the plug-in **never creates directories**. Layout mirrors the ae-a8n in-AE dispatcher conventions under a distinct namespace so native requests cannot be confused with ES3 dispatcher requests:

```
<channelRoot>/channel.json            {v:1, token, consentKey?, sessionAeVersion?}   (0600, preparer-written)
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
| `consentKey` | optional 64 lowercase hex chars — the consent MAC key (Issue #326, §7g). Same secrecy domain as `token`: preparer-written, never logged or published. When absent, consent-requiring operations refuse `CONSENT_REQUIRED` — a channel without a consent key cannot authorize mutations |
| `sessionAeVersion` | optional `"M.m"` pin; when present it must equal the plug-in-attested driver implementation version or every request refuses `WRONG_TARGET` |

## 3. Request — `<requestId>.request.json`

```json
{
  "v": 1,
  "token": "<64hex>",
  "consent": {"v": 1, "mac": "<64hex>"},
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
| `consent` | optional `{"v":1,"mac":"<64hex>"}` — per-request authorization proof for consent-requiring operations (§7g). `v` must be `1`; `mac` is 64 lowercase hex. Ignored entirely for read-only operations; mandatory and verified for allowlist entries whose executor binding is marked mutating |
| `timeoutMs` | finite number in `[0, 3600000]` (1 h ceiling); deadline = request-file mtime + `timeoutMs` (same convention as the ae-a8n dispatcher). Out-of-bounds values refuse `MALFORMED_REQUEST`; already-expired requests refuse `STALE_REQUEST` **before execution**; an unreadable mtime yields `not-sent` (freshness unproven) |
| `target` | optional instance binding. A request naming a different instance is **not claimed** (left for its instance); the plug-in's instance id is reported in `state.json` |
| `request` | the `native-dispatch/v1` envelope, unchanged. `requestId` must equal the file-name stem and, on this file channel, must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (the semantic envelope keeps "non-empty string"; the file channel narrows it so names are path-safe and JSON-escape-free) |
| `args` | Per-operation schema (Issue #270 Stage 1, §7a): absent/`null` for zero-argument operations; for argument-bearing operations a JSON object whose key set is **exactly** the declared argument names, each value satisfying its declared type/range constraint. Any deviation refuses `MALFORMED_REQUEST` before session attestation and before any AEGP call. Identity-bearing arguments (host handles) are never expressible — external JSON never becomes a host handle or pointer |
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
7. `request` envelope shape: `schema` exact, `requestId`/`session.sessionId`/`session.aeVersion` non-empty, `sdkRelease` shape when present, `operationId` string → `MALFORMED_REQUEST` (`args` shape is checked per-operation at step 8a)
8. `operationId` ∈ `NATIVE_INTAKE_OPERATIONS` → `refused` `OPERATION_NOT_DISPATCHABLE` (unknown ids and non-allowlisted registry ids share this code)
8a. `args` satisfies the operation's declared argument schema (§7a) → `refused` `MALFORMED_REQUEST`. Runs before the duplicate check, session attestation, and any AEGP call — unpermitted input never reaches the host
9. duplicate `requestId` (seen-ring, last 64 claimed ids) → `refused` `DUPLICATE_REQUEST`
10. session attestation: `AEGP_GetDriverImplementationVersion` must succeed (`not-sent` otherwise — environment-proven non-dispatch), `session.aeVersion` must equal the observed `"M.m"` and any `channel.json` pin → `refused` `WRONG_TARGET`
11. consent verification — **only when the allowlist entry's executor binding is mutating** (§7g; the mutation class lives in the C++ executor binding table, `NATIVE_INTAKE_CONSENT_OPS` mirrors it devtools-side): `consent` present and well-formed → `refused` `CONSENT_REQUIRED`; `channel.json` has no `consentKey` → `CONSENT_REQUIRED`; recomputed MAC ≠ presented `mac` → `refused` `CONSENT_INVALID`. Read-only entries skip this step entirely — a `consent` field on a read-only request is ignored, never an error
12. execute the allowlisted op → `completed` or `failed`. Read-only ops: `mayHaveMutated:false` always (structurally — read-only executors receive no mutation channel). Mutating ops (§7h): `mayHaveMutated:true` whenever the mutating AEGP call was attempted — `completed` and `failed` alike, since the host may have applied the change before reporting an error; `false` on `not-sent`/`refused` (pre-execution) and on client-side `unknown` the field is `true` in trace

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

## 7. `NATIVE_INTAKE_OPERATIONS` — the intake allowlist

```
AEGP_ProjSuite6.AEGP_GetNumProjects                                  (zero-arg)
AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion               (zero-arg)
AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion               (zero-arg, #270 stage 2)
AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI                     (zero-arg, #270 stage 2)
AEGP_UtilitySuite6.AEGP_HostIsActivated                              (zero-arg, #270 stage 2)
AEGP_ItemSuite9.AEGP_GetTypeName                                     (args: see §7a)
AEGP_ItemSuite9.AEGP_GetItemName                                     (args: aeRef descriptor, see §7a/§7b)
AEGP_ItemSuite9.AEGP_GetItemID                                       (args: aeRef descriptor — descriptor issuance, see §7a/§7b)
AEGP_ItemSuite9.AEGP_GetFirstProjItem                                (args: projectIndex+offset+limit — item discovery, see §7a/§7b)
AEGP_CompSuite13.AEGP_GetCompFramerate                                (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompFrameDuration                            (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompWorkAreaStart                            (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration                         (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompDisplayStartTime                         (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame                         (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompDownsampleFactor                         (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName                    (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetShowBlendModes                               (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples               (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit            (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompBGColor                                   (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase                         (args: projectIndex+comp aeRefItem — comp-handle getter, see §7a/§7c)
AEGP_ItemSuite9.AEGP_GetItemType                                       (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemFlags                                      (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_IsItemSelected                                    (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemLabel                                      (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemDuration                                   (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemCurrentTime                                (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemDimensions                                 (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio                           (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_GetItemComment                                    (args: projectIndex+item aeRefItem — item detail getter, see §7a)
AEGP_ItemSuite9.AEGP_SetItemComment                                    (args: projectIndex+item aeRefItem+comment — first mutating op, requiresConsent, see §7h)
AEGP_LayerSuite9.AEGP_GetCompNumLayers                                 (args: projectIndex+comp aeRefItem — comp-scoped, see §7d)
AEGP_LayerSuite9.AEGP_GetCompLayerByIndex                              (args: projectIndex+comp aeRefItem+layerIndex — layer descriptor issuance, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerIndex                                    (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerName                                     (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerFlags                                    (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerQuality                                  (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerObjectType                               (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_IsLayer3D                                        (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_IsLayer2D                                        (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerCurrentTime                              (args: projectIndex+layer aeRefLayer+timeMode — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerInPoint                                  (args: projectIndex+layer aeRefLayer+timeMode — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerDuration                                 (args: projectIndex+layer aeRefLayer+timeMode — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerID                                       (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerLabel                                    (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality                          (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetLayerSourceItemID                             (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn                             (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn                             (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte                          (args: projectIndex+layer aeRefLayer — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte                          (args: projectIndex+layer aeRefLayer+fillMustBeActive — layer-handle getter, see §7d)
AEGP_LayerSuite9.AEGP_GetTrackMatteLayer                               (args: projectIndex+layer aeRefLayer — emits aeRefLayer, see §7d)
AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState                      (zero-arg, #270 stage 2)
AEGP_RQItemSuite4.AEGP_GetNumRQItems                                 (zero-arg, #270 stage 2)
AEGP_ProjSuite6.AEGP_ProjectIsDirty                                  (args: project aeRefProject — project-handle getter, see §7e)
AEGP_ProjSuite6.AEGP_GetProjectBitDepth                              (args: project aeRefProject — project-handle getter, see §7e)
AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay                           (args: project aeRefProject — project-handle getter, see §7e)
AEGP_RQItemSuite4.AEGP_GetRQItemByIndex                              (args: offset+limit — RQ-item discovery/descriptor issuance, see §7f)
AEGP_RQItemSuite4.AEGP_GetRenderState                                (args: projectIndex+rqItem aeRefRQItem — RQ-item getter, see §7f)
AEGP_RQItemSuite4.AEGP_GetStartedTime                                (args: projectIndex+rqItem aeRefRQItem — RQ-item getter, see §7f)
AEGP_RQItemSuite4.AEGP_GetElapsedTime                                (args: projectIndex+rqItem aeRefRQItem — RQ-item getter, see §7f)
AEGP_RQItemSuite4.AEGP_GetLogType                                    (args: projectIndex+rqItem aeRefRQItem — RQ-item getter, see §7f)
AEGP_RQItemSuite4.AEGP_GetComment                                    (args: projectIndex+rqItem aeRefRQItem — RQ-item getter, see §7f)
AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem                  (args: projectIndex+rqItem aeRefRQItem — RQ-item getter, see §7f)
AEGP_RQItemSuite4.AEGP_GetCompFromRQItem                             (args: projectIndex+rqItem aeRefRQItem — emits bound comp aeRefItem, see §7f)
```

All are read-only getters; all stay `implemented-unverified`. Stage 2 added only operations needing **no identity resolution**. Stage 3 (#270) added the first identity-bearing op through the §7b aeRef descriptor path — host handles are still never taken from the wire; `AEGP_ItemH` is resolved host-side inside the request window. The identity slice (#270) completes the project-item identity path: `AEGP_GetItemID` is the **descriptor issuance** operation and `AEGP_GetFirstProjItem` is the **discovery/enumeration** operation, so a client never hand-assembles a descriptor — it enumerates items (or re-issues one descriptor) and stores the returned `aeRef` verbatim. Stage 4 (#318) extends the same pattern to **derived handles and item detail**: the thirteen `AEGP_CompSuite13` read-only getters take the item descriptor and derive the `AEGP_CompH` host-side via `AEGP_GetCompFromItem` inside the request window (§7c), and nine `AEGP_ItemSuite9` read-only detail getters (`GetItemType`/`GetItemFlags`/`IsItemSelected`/`GetItemLabel`/`GetItemDuration`/`GetItemCurrentTime`/`GetItemDimensions`/`GetItemPixelAspectRatio`/`GetItemComment`) run directly on the resolved `AEGP_ItemH` — same `{projectIndex, item}` contract, no derived handle. `AEGP_GetItemParentFolder` and `AEGP_GetItemMRUView` stay out: they return host handles of other identity kinds (folder item / item-view) needing their own descriptor story. `AEGP_GetCompShutterFrameRange` is deliberately excluded: it takes an `A_Time` input argument, and arg-bearing (non-descriptor) inputs are a separate slice. The layer slice (#318) adds twenty-one `AEGP_LayerSuite9` read-only members on the same pattern extended one level deeper (§7d): the layer handle is never taken from the wire — `layer` is an `aeRefLayer` descriptor that embeds its parent comp's §7b item descriptor, and `AEGP_GetCompLayerByIndex` is the layer **descriptor issuance** operation. `AEGP_GetActiveLayer`, members needing `A_Time`/`A_FloatRect`/stream arguments, source/parent-handle paths needing additional identity kinds, and all mutating members stay out. The project/RQ-item slice (#318 Stage 4) completes the remaining handle kinds on the same pattern (§7e/§7f): projects use the corroborated-positional `aeRefProject` descriptor (the SDK has no project id) and RQ items use the atomic-select `aeRefRQItem` descriptor with an observable fingerprint — `AEGP_GetRQItemByIndex` is the RQ-item **descriptor issuance** operation. Widening further is a separate reviewed change — each addition must be a read-only getter with a defined serializable payload. Mutation operations are out of scope (FR-07/US3 permission model first).

## 7a. Per-operation argument schemas (Issue #270 Stage 1)

The machine-readable canonical statement is `NATIVE_INTAKE_ARG_SCHEMAS` in `packages/native-adapter/src/dispatch.ts`; the plug-in enforces the mirror in `native_registry.cpp` (`S_ALLOWLIST` arg specs). Both refuse identically — validation runs host-side before any AEGP call, so the TS schema is the client-facing contract and the C++ table is the enforcement.

| operationId | args contract |
| --- | --- |
| `AEGP_ProjSuite6.AEGP_GetNumProjects` | none — `args` absent or `null` |
| `AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion` | none — `args` absent or `null` |
| `AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion` | none — `args` absent or `null`; result `{"major","minor"}` |
| `AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI` | none — `args` absent or `null`; result `{"interactiveUiSuppressed": <bool>}` |
| `AEGP_UtilitySuite6.AEGP_HostIsActivated` | none — `args` absent or `null`; result `{"hostActivated": <bool>}` |
| `AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState` | none — `args` absent or `null`; result `{"state": <uint>}` (`AEGP_RenderQueueState`); plug-in acquires `AEGP Render Queue Suite` v1 in-window |
| `AEGP_RQItemSuite4.AEGP_GetNumRQItems` | none — `args` absent or `null`; result `{"numRQItems": <int>}`; plug-in acquires `AEGP Render Queue Item Suite` v4 in-window |
| `AEGP_ItemSuite9.AEGP_GetTypeName` | `{"itemType": <integer>}` — exactly one field; `itemType` is the `AEGP_ItemType` (`A_short`) enum, permitted range **[1, 4]** = the defined non-`NONE` values (`FOLDER`=1, `COMP`=2, `SOLID_defunct`=3, `FOOTAGE`=4; `NUM_TYPES1`=5 per `AE_GeneralPlug.h`). `NONE`=0 and any undefined/out-of-range/non-integral/wrong-typed value refuses `MALFORMED_REQUEST`. `SOLID_defunct` is a defined enum value passed through to the host; what real AE returns for it is a real-host question this contract does not settle |
| `AEGP_ItemSuite9.AEGP_GetItemName` | `{"projectIndex": <integer 0..1000000>, "item": <aeRefItem>}` — exactly these two fields. `projectIndex` selects the project via `AEGP_GetProjectByIndex`, bounds-checked against `AEGP_GetNumProjects` at resolution time. `item` is the §7b descriptor (legacy or identity-bearing form). Result `{"name": "<string>"}` — the item's UTF-16 name converted to UTF-8, JSON-escaped, bounded |
| `AEGP_ItemSuite9.AEGP_GetItemID` | `{"projectIndex": <integer 0..1000000>, "item": <aeRefItem>}` — exactly these two fields, same descriptor contract as `GetItemName`. This is the **issuance** operation: the supplied descriptor is resolved host-side exactly like `GetItemName`, then `AEGP_GetItemID` plus the project identity fields are read and a canonical descriptor is returned. Result `{"itemId": <integer>, "item": {"aeRef": {…}}}` — `result.item` is stored verbatim and reused as `args.item` in later requests; the client never assembles descriptor fields itself |
| `AEGP_ItemSuite9.AEGP_GetFirstProjItem` | `{"projectIndex": <integer 0..1000000>, "offset": <integer 0..1000000>, "limit": <integer 1..32>}` — exactly these three fields. This is the **discovery/enumeration** operation: walks the project's top-level items in `AEGP_GetFirstProjItem`/`AEGP_GetNextProjItem` order and emits ready-to-use descriptors. Result `{"project": {"index","name","path"}, "total": <int>, "offset": <int>, "items": [{"item": {"aeRef": {…}}}…], "truncated": <bool>}` — each `items[]` entry's `item` value is a complete §7b descriptor (including `itemId`/`projectName`/`projectPath`) usable verbatim as `args.item`. `truncated:true` means more items exist beyond the emitted window or the result-size budget; page with `offset`. Items whose live name exceeds the identity bound are emitted as `{"index","type","itemId","nameTruncated":true}` without a usable descriptor; live item kinds with no descriptor tag (e.g. solid) are emitted as `{"index","unsupportedType":true}` — never a partial or invalid `aeRef` |
| `AEGP_CompSuite13.*` (the thirteen getters listed in §7) | `{"projectIndex": <integer 0..1000000>, "comp": <aeRefItem>}` — exactly these two fields. `comp` is the same §7b descriptor; resolution and corroboration are identical to `GetItemName` (the descriptor's `type` must corroborate the live item — a `comp`-typed descriptor against a non-comp item refuses `STALE_REFERENCE`). The resolved `AEGP_ItemH` is then mapped to `AEGP_CompH` via `AEGP_GetCompFromItem` inside the request window (§7c). Result payloads are typed per getter — see §7c |
| `AEGP_ItemSuite9.*` detail getters (`GetItemType`, `GetItemFlags`, `IsItemSelected`, `GetItemLabel`, `GetItemDuration`, `GetItemCurrentTime`, `GetItemDimensions`, `GetItemPixelAspectRatio`, `GetItemComment`) | `{"projectIndex": <integer 0..1000000>, "item": <aeRefItem>}` — exactly these two fields, identical to `GetItemName`. The resolved `AEGP_ItemH` is used directly (no derived handle, no extra suite). Result payloads: `GetItemType` → `{"itemType": <int>}` (`AEGP_ItemType`); `GetItemFlags` → `{"flags": <int>}`; `IsItemSelected` → `{"selected": <bool>}`; `GetItemLabel` → `{"label": <int>}` (`AEGP_LabelID`); `GetItemDuration`/`GetItemCurrentTime` → `{"duration"|"currentTime": {"value": <int>, "scale": <uint>}}` (`A_Time`); `GetItemDimensions` → `{"width": <int>, "height": <int>}`; `GetItemPixelAspectRatio` → `{"pixelAspectRatio": {"num": <int>, "den": <uint>}}` (`A_Ratio`); `GetItemComment` → `{"comment": "<string>"}` — the item's UTF-16 comment via `AEGP_MemHandle`, converted to UTF-8 and JSON-escaped, bounded at 2048 UTF-8 bytes (a longer comment is `failed`, never silently truncated) |
| `AEGP_LayerSuite9.AEGP_GetCompNumLayers` | `{"projectIndex": <integer 0..1000000>, "comp": <aeRefItem>}` — comp-scoped (§7d); result `{"numLayers": <int>}` |
| `AEGP_LayerSuite9.AEGP_GetCompLayerByIndex` | `{"projectIndex": <integer 0..1000000>, "comp": <aeRefItem>, "layerIndex": <integer 0..1000000>}` — `layerIndex` is the `AEGP_GetCompLayerByIndex` position (0-based). **Layer descriptor issuance**: result `{"index": <int>, "layer": {"aeRef": {<aeRefLayer>}}}` — store `result.layer` verbatim as `args.layer` |
| `AEGP_LayerSuite9.*` layer-handle getters (`GetLayerIndex`, `GetLayerName`, `GetLayerFlags`, `GetLayerQuality`, `GetLayerObjectType`, `IsLayer3D`, `IsLayer2D`, `GetLayerID`, `GetLayerLabel`, `GetLayerSamplingQuality`, `GetLayerSourceItemID`, `IsLayerVideoReallyOn`, `IsLayerAudioReallyOn`, `DoesLayerHaveTrackMatte`, `GetTrackMatteLayer`) | `{"projectIndex": <integer 0..1000000>, "layer": <aeRefLayer>}` — exactly these two fields (§7d). Result payloads are typed per getter — see §7d |
| `AEGP_LayerSuite9.AEGP_GetLayerCurrentTime` / `GetLayerInPoint` / `GetLayerDuration` | `{"projectIndex": <integer 0..1000000>, "layer": <aeRefLayer>, "timeMode": <integer 0..1>}` — `timeMode` is `AEGP_LTimeMode` (`LayerTime`=0, `CompTime`=1); required, never defaulted. Result `{"currentTime"|"inPoint"|"duration": {"value": <int>, "scale": <uint>}}` (`A_Time`) |
| `AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte` | `{"projectIndex": <integer 0..1000000>, "layer": <aeRefLayer>, "fillMustBeActive": <integer 0..1>}` — required boolean-as-integer; result `{"isTrackMatte": <bool>}` |
| `AEGP_ItemSuite9.AEGP_SetItemComment` | `{"projectIndex": <integer 0..1000000>, "item": <aeRefItem>, "comment": <string ≤ 2048 UTF-8 bytes>}` — exactly these three fields (§7h). `comment` is bounded UTF-8; empty string clears the comment. **requiresConsent**: the request must carry a valid §7g envelope-level `consent` MAC or it refuses `CONSENT_REQUIRED`/`CONSENT_INVALID` before any AEGP call. Result `{"commentSet": true}`; `mayHaveMutated:true` whenever the AEGP call was attempted |
| `AEGP_ProjSuite6.*` project getters (`AEGP_ProjectIsDirty`, `AEGP_GetProjectBitDepth`, `AEGP_GetProjectTimeDisplay`) | `{"project": <aeRefProject>}` — exactly one field (§7e); the descriptor carries the index, no separate `projectIndex`. Result payloads: `AEGP_ProjectIsDirty` → `{"dirty": <bool>}`; `AEGP_GetProjectBitDepth` → `{"bitDepth": <int>}`; `AEGP_GetProjectTimeDisplay` → `{"timeDisplay": {…}}` (`AEGP_TimeDisplay3`) |
| `AEGP_RQItemSuite4.AEGP_GetRQItemByIndex` | `{"offset": <integer 0..1000000>, "limit": <integer 1..32>}` — exactly these two fields (§7f). **RQ-item discovery/descriptor issuance**: result `{"items": [{"index","projectIndex","rqItem":{"aeRef":{…}}}], "numRQItems": <int>}` — `rqItem` may be `null` for undescribable slots |
| `AEGP_RQItemSuite4.*` RQ-item getters (`GetRenderState`, `GetStartedTime`, `GetElapsedTime`, `GetLogType`, `GetComment`, `GetNumOutputModulesForRQItem`, `GetCompFromRQItem`) | `{"projectIndex": <integer 0..1000000>, "rqItem": <aeRefRQItem>}` — exactly these two fields (§7f). Result payloads: `GetRenderState` → `{"status": <int>}`; `GetStartedTime`/`GetElapsedTime` → `{"startedTime"\|"elapsedTime": {"value":<int>,"scale":<uint>}\|null}`; `GetLogType` → `{"logType": <int>}`; `GetComment` → `{"comment": "<string>"}`; `GetNumOutputModulesForRQItem` → `{"numOutputModules": <int>}`; `GetCompFromRQItem` → `{"comp": {"aeRef": {<§7b item descriptor>}}, "projectIndex": <int>}` |

Result payload for `GetTypeName`: `{"typeName": "<string>"}` — the `A_char[AEGP_MAX_TYPE_NAME_SIZE]` name buffer, JSON-escaped, bounded. The plug-in acquires `AEGP Item Suite` v9 and releases it inside the request's evidence window (`SPBasicSuite.AcquireSuite`/`ReleaseSuite` op records bracket the `AEGP_GetTypeName` record in `opCalls`); suite-acquire failure or a missing suite entry is `not-sent` (environment-proven non-dispatch), an AEGP error is `failed` with `mayHaveMutated:false`.

## 7b. `aeRefItem` identity descriptors (Issue #270, CAP027 groundwork)

Identity-bearing arguments never cross the wire as handles. An operation that needs an `AEGP_ItemH` takes an **aeRef descriptor** — the same wire shape as the trusted-codec `aeRef` wrapper (trusted-execution.md §2/§3):

```json
{"aeRef": {"type": "folder" | "comp" | "footage",
           "name": "<string>",
           "path": [<non-negative integer>],
           "itemId": <integer>,
           "projectName": "<string>",
           "projectPath": "<string>"}}
```

- `type` maps to `AEGP_ItemType`: `folder`=1, `comp`=2, `footage`=4. `SOLID_defunct` has no live identity and is not expressible.
- `name` must be non-empty; comparison against the live item is **exact UTF-8 byte equality** after the host's UTF-16→UTF-8 conversion. The identity bound for names is **1024 UTF-8 bytes** — a live name longer than that cannot be described (issuance fails, enumeration reports `nameTruncated`, resolution of such a descriptor refuses `STALE_REFERENCE`).
- `path` is **exactly one** index — the position in `AEGP_GetFirstProjItem`/`AEGP_GetNextProjItem` order within the selected project. `AEGP_ItemSuite9` exposes no folder-children enumeration, so deeper paths are `MALFORMED_REQUEST`, not a silent best-effort.
- `itemId`, `projectName`, `projectPath` are the **identity-bearing optional fields** (identity slice, #270). `itemId` is the `AEGP_ItemSuite9.AEGP_GetItemID` value — an integer in `[0, 4294967295]`. `projectName`/`projectPath` are the `AEGP_GetProjectName`/`AEGP_GetProjectPath` values (`projectPath` may be `""` for an untitled project); each is a string of at most 4096 characters when present.
- `contentHash` and any other inner key are `MALFORMED_REQUEST` — the resolver cannot verify a content hash cheaply, so its presence is refused rather than ignored. The permitted key set is exactly `{type, name, path}` plus any subset of `{itemId, projectName, projectPath}`; duplicate keys are already rejected by the JSON parser.

### Identity semantics — what each field guarantees

The descriptor is **identity, not authorization** (trusted-execution.md §1/§3 unchanged). Resolution is fail-closed: any mismatch is `STALE_REFERENCE`, never a best-effort re-resolution.

1. **Project selection.** `projectIndex` selects via `AEGP_GetProjectByIndex`, bounds-checked against `AEGP_GetNumProjects`. Out-of-range → `STALE_REFERENCE`.
2. **Project corroboration.** When the descriptor carries `projectName` and/or `projectPath`, the live project at `projectIndex` must match **exactly** (`AEGP_GetProjectName` byte equality; `AEGP_GetProjectPath` UTF-16→UTF-8 byte equality, `""` matching only an empty path). A mismatch means the index now names a different project → `STALE_REFERENCE`. This is what prevents project reordering/close-open from silently re-targeting a descriptor.
3. **Item resolution — `itemId` present (authoritative).** The resolver walks the project's top-level items and calls `AEGP_GetItemID` on each, looking for exactly one match. Zero matches → `STALE_REFERENCE` (the item is gone — including the delete/recreate ABA case, where a same-name/same-type/same-index replacement is a *different* SDK item). More than one match → `STALE_REFERENCE` (ambiguous; fail closed). `path` is **not** consulted for positioning when `itemId` is present — reordering items does not stale a descriptor. The scan is bounded at 100000 items; exceeding it is `failed` (environment limitation, `mayHaveMutated:false`), not a silent partial scan.
4. **Item resolution — `itemId` absent (legacy Stage-3 form).** `path[0]` positional walk via `AEGP_GetFirstProjItem`/`AEGP_GetNextProjItem`, then type and name verification — the weaker pre-identity semantics, retained for backward compatibility. New descriptors should always carry `itemId` (issuance/enumeration emit it).
5. **Corroboration.** After the item handle is found, `AEGP_GetItemType` must equal the mapped type tag and `AEGP_GetItemName` must equal `aeRef.name` — in **both** resolution modes. A renamed item stales its descriptor (the client re-issues); this is deliberate conservatism, not an oversight.

`STALE_REFERENCE` means *well-formed descriptor, drifted state* — distinct from `MALFORMED_REQUEST` (shape violations refused before any AEGP call, no `opCalls`) per trusted-execution.md §3/§4. AEGP errors during resolution or the op itself are `failed` with `mayHaveMutated:false` (read-only); missing suite/entry is `not-sent`. Resolution emits its own op records (`(resolve)`/`(resolve+result)` extras) inside `opCalls`, so the evidence window shows exactly which host calls produced the handle.

### Guarantee boundary — what is and is not proven

- `AEGP_GetItemID` exists in `AEGP_ItemSuite9` (`AE_GeneralPlug.h`, suite frozen in AE 14.1). The SDK exposes **no** `GetItemByID` lookup — resolution is necessarily walk-and-compare inside the request window, which is also what makes the corroborating checks possible in the same evidence window.
- **ABA safety (design-level):** a deleted-then-recreated item is a different SDK item. Per AE's id allocation the replacement receives a different `itemId`, so the old descriptor resolves nothing → `STALE_REFERENCE`. Whether AE ever reuses an `itemId` within a project session is **not SDK-guaranteed** — the type+name corroboration is the second factor, and a hypothetical id-reuse *plus* identical type *and* name would be indistinguishable. This residual is recorded, not hidden; real-host behavior is a #223 question.
- **Project scope:** `itemId` is meaningful only within its project — ids from different projects are never compared (resolution never leaves the `projectIndex`-selected project). Project binding is `index + name + path`; two simultaneously open projects with identical name *and* identical (or both empty) path cannot be distinguished by this contract — recorded limitation.
- **Session/lifetime:** descriptors carry no plug-in state; a plug-in or AE restart simply re-resolves against live state. If AE reassigns ids across project close/reopen, old descriptors go `STALE_REFERENCE` (fail closed); if AE persists ids in the project file they keep resolving the same item — either outcome is safe. In-memory `AEGP_ItemH` handles never cross request boundaries.
- **Real-host status:** all of the above is fake-host verified (`probe_test`) only. `implemented-unverified` stands; `dispatchable` promotion still requires #223 real-host evidence.

### Descriptor issuance and discovery

Clients never hand-assemble descriptors:

- **Issuance** — `AEGP_ItemSuite9.AEGP_GetItemID` with `{projectIndex, item}` resolves the supplied descriptor (legacy or v2) and returns `{"itemId":N,"item":{"aeRef":{…}}}` where the inner `aeRef` carries `type`, `name`, live `path` index, `itemId`, `projectName`, `projectPath`. Store `result.item` verbatim.
- **Discovery** — `AEGP_ItemSuite9.AEGP_GetFirstProjItem` with `{projectIndex, offset, limit}` enumerates top-level items and returns per-item `{"item":{"aeRef":{…}}}` entries plus a single `project` block — each entry is a complete usable descriptor.

Issuance/enumeration perform the same project corroboration fetches (`AEGP_GetProjectName`, `AEGP_GetProjectPath`) inside the request window; a project-name/path read failure is `failed` (`mayHaveMutated:false`), never a partially-populated descriptor.

## 7c. Derived comp handles — `AEGP_CompSuite13` getters (Issue #318 / #64)

The thirteen `AEGP_CompSuite13` read-only getters are the first **derived-handle** operations: they need an `AEGP_CompH`, but the wire still carries only the §7b item descriptor. There is exactly one resolver — `ResolveAeRefItem` — and exactly one derivation step:

1. `comp` arg → `ResolveAeRefItem` (identical semantics to `GetItemName`: project bounds + optional name/path corroboration, `itemId`-authoritative or legacy positional item resolution, type + exact-name corroboration). Any failure is the same `STALE_REFERENCE`/`failed`/`not-sent` verdict — no comp-specific resolution path exists.
2. `AEGP_CompSuite13` (suite `"AEGP Comp Suite"`, `kAEGPCompSuiteVersion13`) is acquired inside the request window via `SPBasicSuite.AcquireSuite`; acquire failure → `not-sent`.
3. The specific getter entry and `AEGP_GetCompFromItem` must both be present in the suite table — a missing entry is `not-sent` (environment-proven non-dispatch), checked **before** any comp call.
4. `AEGP_GetCompFromItem(itemH, &compH)` derives the comp handle. `AEGP_CompH` is **borrowed** — it is never freed by the plug-in and never crosses the request boundary; it exists only inside this request's evidence window. An AEGP error (e.g. the resolved item is a footage/folder item — reachable only when the descriptor's `type` legitimately matches a non-comp live item) is `failed` with `mayHaveMutated:false`.
5. The allowlisted getter runs, its result is emitted as typed JSON, the comp suite is released, and the item/memory suites are released via `ReleaseResolution` — all inside the same `opCalls` evidence window (`AEGP_GetCompFromItem` and `SPBasicSuite.AcquireSuite`/`ReleaseSuite` records bracket the getter record).

Result payloads (all `completed` carry `mayHaveMutated:false` semantics — read-only):

| operationId | result `result` payload |
| --- | --- |
| `AEGP_GetCompFramerate` | `{"fps": <number>}` (`A_FpLong`, `%.12g`) |
| `AEGP_GetCompFrameDuration` | `{"frameDuration": {"value": <int>, "scale": <uint>}}` (`A_Time`) |
| `AEGP_GetCompWorkAreaStart` | `{"workAreaStart": {"value","scale"}}` |
| `AEGP_GetCompWorkAreaDuration` | `{"workAreaDuration": {"value","scale"}}` |
| `AEGP_GetCompDisplayStartTime` | `{"displayStartTime": {"value","scale"}}` |
| `AEGP_GetCompDisplayDropFrame` | `{"displayDropFrame": <bool>}` |
| `AEGP_GetCompDownsampleFactor` | `{"downsampleFactor": {"x": <int>, "y": <int>}}` (`A_short` fields) |
| `AEGP_GetShowLayerNameOrSourceName` | `{"showLayerNameOrSourceName": <bool>}` |
| `AEGP_GetShowBlendModes` | `{"showBlendModes": <bool>}` |
| `AEGP_GetCompSuggestedMotionBlurSamples` | `{"suggestedMotionBlurSamples": <int>}` |
| `AEGP_GetCompMotionBlurAdaptiveSampleLimit` | `{"motionBlurAdaptiveSampleLimit": <int>}` |
| `AEGP_GetCompBGColor` | `{"bgColor": {"alpha","red","green","blue": <number>}}` (`AEGP_ColorVal`, `%.12g`, range [0,1] per SDK) |
| `AEGP_GetCompShutterAnglePhase` | `{"shutterAngle": {"num","den"}, "shutterPhase": {"num","den"}}` (`A_Ratio`) |

`AEGP_GetCompShutterFrameRange` is excluded from the allowlist: it takes an `A_Time comp_timeP` input argument. Non-descriptor scalar/struct arguments are a separate arg-schema slice; until then only zero-extra-arg getters are admitted. The same §7c pattern — resolve item descriptor → derive handle via the owning suite → typed getter — is the template for layer and RQ-item handles in later stages; each new handle kind reuses `ResolveAeRefItem` and the suite acquire/release discipline rather than growing a parallel resolver.

## 7d. `aeRefLayer` descriptors and `AEGP_LayerSuite9` getters (Issue #318 / #64)

The twenty-one `AEGP_LayerSuite9` read-only members extend the §7c derived-handle pattern one level deeper: a layer needs an `AEGP_LayerH`, which the wire never carries. There is still exactly one item resolver — `ResolveAeRefItem` — plus one layer-resolution step:

```json
{"aeRef": {"type": "layer",
           "name": "<string>",
           "layerId": <integer>,
           "comp": {"aeRef": {<§7b item descriptor>}}}}
```

- `type` is exactly `"layer"`. `name` must be non-empty and within the same 1024-UTF-8-byte identity bound as §7b. `layerId` is the live `AEGP_GetLayerID` value (`AEGP_LayerIDVal` = `A_long`, full int32 range `[-2147483648, 2147483647]`).
- `comp` is **required** and uses the same `{"aeRef":{…}}` item-descriptor arg shape as §7b — the parent-comp binding is part of the layer's identity, so a layer descriptor can never resolve against the wrong composition. All four inner keys (`type`, `name`, `layerId`, `comp`) are required and no others are accepted; the comp descriptor's own `type` must corroborate `"comp"` at resolution time (a footage/ folder binding is `STALE_REFERENCE`).
- Shape validation is identical in kind to §7b: the TS `aeRefLayer` constraint and the C++ `ValidateAeRefLayer` refuse the same inputs with `MALFORMED_REQUEST` before any AEGP call.

### Layer resolution semantics

1. `comp` → `ResolveAeRefItem`; `wantProjectIdentity` is set for the two operations that emit descriptors (`GetCompLayerByIndex`, `GetTrackMatteLayer`) so the embedded comp `aeRef` carries live `itemId`/`projectName`/`projectPath`, and unset for plain getters. The resolved item's live type must be `AEGP_ItemType_COMP` — otherwise `STALE_REFERENCE`.
2. `AEGP_CompSuite13` (v13) and `AEGP_LayerSuite9` (`kAEGPLayerSuiteVersion9`) are both acquired inside the request window; either acquire failure is `not-sent`. The specific getter entry, `AEGP_GetCompFromItem`, `AEGP_GetCompNumLayers`, `AEGP_GetCompLayerByIndex`, `AEGP_GetLayerID`, and `AEGP_GetLayerName` must all be present before any layer call — a missing entry is `not-sent`.
3. `AEGP_GetCompFromItem(itemH, &compH)` derives the comp handle (borrowed, never freed, never crosses the request boundary).
4. The comp's layers are enumerated via `AEGP_GetCompNumLayers` + `AEGP_GetCompLayerByIndex` (bounded by the 100000-layer scan limit), and each candidate's live `AEGP_GetLayerID` is compared to `layerId`. Zero matches → `STALE_REFERENCE` (deleted/recreated layer, or wrong comp); more than one → `STALE_REFERENCE` (ambiguous; fail closed). The matched layer's `AEGP_GetLayerName` must equal `aeRef.name` exactly — a renamed layer stales its descriptor. Layer **order is not consulted**: reordering layers does not stale a descriptor (verified: `GetLayerIndex` reports the live position after a swap).
5. `AEGP_LayerH` is likewise borrowed — never freed, never crosses the request boundary. All suite releases and resolution cleanup happen inside the same `opCalls` evidence window.

### Comp-scoped members and issuance

- `AEGP_GetCompNumLayers` takes `{projectIndex, comp}` and returns `{"numLayers": <int>}`.
- `AEGP_GetCompLayerByIndex` takes `{projectIndex, comp, layerIndex}` (`layerIndex` = the 0-based `AEGP_GetCompLayerByIndex` position, bound 0..1000000). It is **layer descriptor issuance**: the plug-in resolves the comp, fetches the layer at `layerIndex`, reads its live `AEGP_GetLayerID` + `AEGP_GetLayerName`, and emits `{"index": <int>, "layer": {"aeRef": {<aeRefLayer>}}}` where the inner `comp.aeRef` is the full §7b descriptor (live `itemId` + `projectName`/`projectPath`). Store `result.layer` verbatim as `args.layer`. An out-of-range index is an AEGP error → `failed`.

### Getter result payloads

All `completed` results carry `mayHaveMutated:false` (read-only):

| operationId | result `result` payload |
| --- | --- |
| `AEGP_GetCompNumLayers` | `{"numLayers": <int>}` |
| `AEGP_GetCompLayerByIndex` | `{"index": <int>, "layer": {"aeRef": {<aeRefLayer>}}}` |
| `AEGP_GetLayerIndex` | `{"index": <int>}` — live position in the comp's layer stack |
| `AEGP_GetLayerName` | `{"name": "<string>", "sourceName": "<string>"}` — UTF-16 pair via `AEGP_MemHandle`, UTF-8 + JSON-escaped, each bounded at 1024 bytes (overflow/unreadable → `failed`) |
| `AEGP_GetLayerFlags` | `{"flags": <int>}` (`AEGP_LayerFlags`) |
| `AEGP_GetLayerQuality` | `{"quality": <int>}` (`AEGP_LayerQuality`) |
| `AEGP_GetLayerObjectType` | `{"objectType": <int>}` (`AEGP_ObjectType`) |
| `AEGP_IsLayer3D` / `AEGP_IsLayer2D` | `{"is3D": <bool>}` / `{"is2D": <bool>}` |
| `AEGP_GetLayerCurrentTime` / `GetLayerInPoint` / `GetLayerDuration` | `{"currentTime"|"inPoint"|"duration": {"value": <int>, "scale": <uint>}}` (`A_Time`) |
| `AEGP_GetLayerID` | `{"layerId": <int>}` (`AEGP_LayerIDVal`, int32) |
| `AEGP_GetLayerLabel` | `{"label": <int>}` (`AEGP_LabelID`) |
| `AEGP_GetLayerSamplingQuality` | `{"samplingQuality": <int>}` (`AEGP_LayerSamplingQuality`) |
| `AEGP_GetLayerSourceItemID` | `{"sourceItemId": <int>}` |
| `AEGP_IsLayerVideoReallyOn` / `AEGP_IsLayerAudioReallyOn` | `{"videoOn": <bool>}` / `{"audioOn": <bool>}` |
| `AEGP_DoesLayerHaveTrackMatte` | `{"hasTrackMatte": <bool>}` |
| `AEGP_IsLayerUsedAsTrackMatte` | `{"isTrackMatte": <bool>}` |
| `AEGP_GetTrackMatteLayer` | `{"trackMatteLayer": {"aeRef": {<aeRefLayer>}}}` or `{"trackMatteLayer": null}` — the matte layer is emitted as a descriptor, never a handle |

### Deferred layer members

- `AEGP_GetActiveLayer` — the SDK signature takes no comp argument; there is no comp binding to resolve against, so a descriptor cannot name its scope. Excluded until an explicit comp-scoped variant exists.
- Getters taking `A_Time`/`A_FloatRect`/stream inputs or returning additional host handles (`GetLayerSourceItem`, `GetLayerParentComp`, `GetLayerSourceTextDocument`, etc.) — each needs its own serializable argument/identity story first.
- All mutating members — out of scope until the FR-07/US3 permission model and the ae-a8n-owned authorization/audit/`UNKNOWN` contract exist.

## 7e. `aeRefProject` descriptors and `AEGP_ProjSuite6` getters (Issue #318)

The SDK exposes **no stable project identifier** — `AEGP_ProjSuite6` offers only `AEGP_GetNumProjects`/`AEGP_GetProjectByIndex`/`AEGP_GetProjectName`/`AEGP_GetProjectPath`. Project identity is therefore a *corroborated positional* contract, not an id contract:

```json
{"aeRef": {"type": "project",
           "index": <integer>,
           "name": "<string>",
           "path": "<string>"}}
```

- `type` is exactly `"project"`. `index` is the 0-based `AEGP_GetProjectByIndex` position (bound 0..1000000). `name` is the live `AEGP_GetProjectName` (non-empty, ≤1024 UTF-8 bytes). `path` is the live `AEGP_GetProjectPath` UTF-8 string — **empty string for an unsaved project**; required key, may be empty.
- Project-scoped ops take `{"project": <aeRefProject>}` — one argument, no separate `projectIndex` (the descriptor carries it).

### Project resolution semantics

1. `AEGP_GetNumProjects` bounds-checks `index` (out of range → `STALE_REFERENCE`), `AEGP_GetProjectByIndex` yields `projectH` inside the request window.
2. `AEGP_GetProjectName` + `AEGP_GetProjectPath` are read and compared: `name` must match exactly; `path` must match exactly **when the descriptor's path is non-empty**. An empty descriptor path accepts any live path — saving an untitled project does not rebind its identity (documented tolerance, not a detection claim).
3. **Collision rule**: every open project is scanned; if more than one project satisfies the descriptor's (name, path) corroboration, resolution refuses `STALE_REFERENCE` ("project identity ambiguous"). Two identically-named untitled projects therefore cannot be addressed — fail closed rather than risk a silent project switch after a close/reopen shifts indices. There is no project-reorder API in the SDK, but project close/open shifts `GetProjectByIndex` positions, which is exactly the ABA this rule covers.
4. `projectH` is borrowed for the request window only; all suite acquires/releases stay inside the `opCalls` evidence window.

### Project getter payloads

| operationId | args | result `result` payload |
| --- | --- | --- |
| `AEGP_ProjSuite6.AEGP_ProjectIsDirty` | `{"project": <aeRefProject>}` | `{"dirty": <bool>}` |
| `AEGP_ProjSuite6.AEGP_GetProjectBitDepth` | `{"project": <aeRefProject>}` | `{"bitDepth": <int>}` (`AEGP_ProjBitDepth`: 8=0, 16=1, 32=2) |
| `AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay` | `{"project": <aeRefProject>}` | `{"timeDisplay": {"displayMode": <int>, "footageDisplayMode": <int>, "displayDropFrame": <bool>, "useFeetFrames": <bool>, "timebase": <int>, "framesPerFoot": <int>, "framesDisplayMode": <int>}}` (`AEGP_TimeDisplay3`) |

`AEGP_GetProjectRootFolder` is deferred: it returns an `AEGP_ItemH`, but the root folder is not a top-level project item — its `AEGP_GetItemID` is outside the `GetFirstProjItem` scan, so an emitted aeRef could never resolve. It needs a folder-scoped identity story first.

## 7f. `aeRefRQItem` descriptors and `AEGP_RQItemSuite4` getters (Issue #318)

The SDK exposes **no stable render-queue-item identifier**, and `AEGP_RQItemRefH` is explicitly invalidated by *any* queue reordering, addition, or removal (`AEGP_RQItemSuite4` header note: "DO NOT CACHE THEM"). The safe operation model is therefore **atomic select+read inside a single dispatch**: the descriptor pins (queue index, bound comp identity, observable fingerprint); resolution re-derives the handle and re-verifies every pin before the getter runs — the handle never survives the request window.

```json
{"aeRef": {"type": "rqItem",
           "index": <integer>,
           "comp": {"aeRef": {<§7b item descriptor, type must corroborate "comp">>},
           "status": <integer>,
           "numOutputModules": <integer>}}
```

- `type` is exactly `"rqItem"`. `index` is the 0-based `AEGP_GetRQItemByIndex` position (bound 0..1000000). `comp` is a required §7b item descriptor — the queue entry's bound composition is the primary identity. `status` (`AEGP_RenderItemStatusType`) and `numOutputModules` (`AEGP_GetNumOutputModulesForRQItem`) are the **observable fingerprint** captured at issuance.
- RQ-item ops take `{"projectIndex": <int>, "rqItem": <aeRefRQItem>}` — `projectIndex` selects the project that owns the bound comp, exactly like the comp/layer ops.

### RQ-item resolution semantics (all inside one dispatch)

1. `comp` → `ResolveAeRefItem` (the same shared resolver; `wantProjectIdentity` set for issuance/enumeration). Live type must be `AEGP_ItemType_COMP`.
2. `AEGP_RQItemSuite4` + `AEGP_CompSuite13` are acquired inside the request window; `AEGP_GetNumRQItems` bounds-checks `index`; `AEGP_GetRQItemByIndex` yields the borrowed `AEGP_RQItemRefH`.
3. `AEGP_GetCompFromRQItem(rqH)` → `compH` → `AEGP_GetItemFromComp` → `itemH`; that item's live `AEGP_GetItemID` must equal the descriptor comp's live `AEGP_GetItemID`. A queue shift that rebinds the slot to a different comp → `STALE_REFERENCE`.
4. Fingerprint: live `AEGP_GetRenderState` must equal `status` and `AEGP_GetNumOutputModulesForRQItem` must equal `numOutputModules` — mismatch → `STALE_REFERENCE`.
5. **Honest residual**: the SDK exposes no per-entry id, so a queue mutation that leaves (index, comp, status, numOutputModules) all unchanged is indistinguishable — e.g. swapping two queue entries bound to the *same* comp with identical status/module count, or a settings change fully reverted. This is documented, not claimed-detectable. Mutations are out of scope regardless.

### RQ-item enumeration and getter payloads

`AEGP_GetRQItemByIndex` doubles as the **descriptor issuance / discovery** op: `{"offset": <int 0..1000000>, "limit": <int 1..32>}` → `{"items": [{"index": <int>, "projectIndex": <int>, "rqItem": {"aeRef": {<aeRefRQItem>}}}], "numRQItems": <int>}`. For each slot the plug-in resolves the bound comp to its owning project (bounded scan over open projects for the comp's live `AEGP_GetItemID`), reads the live fingerprint, and emits a ready-to-use descriptor plus the `projectIndex` needed to use it. A slot whose comp cannot be resolved to a project item is emitted with `"rqItem": null` (undescribable, counted — never a fabricated descriptor).

| operationId | args | result `result` payload |
| --- | --- | --- |
| `AEGP_RQItemSuite4.AEGP_GetRenderState` | `{projectIndex, rqItem}` | `{"status": <int>}` (`AEGP_RenderItemStatusType`) |
| `AEGP_RQItemSuite4.AEGP_GetStartedTime` / `AEGP_GetElapsedTime` | `{projectIndex, rqItem}` | `{"startedTime"\|"elapsedTime": {"value": <int>, "scale": <uint>}}` or `null` when never started/rendered (`{0,1}` sentinel → `null`) |
| `AEGP_RQItemSuite4.AEGP_GetLogType` | `{projectIndex, rqItem}` | `{"logType": <int>}` (`AEGP_LogType`) |
| `AEGP_RQItemSuite4.AEGP_GetComment` | `{projectIndex, rqItem}` | `{"comment": "<string>"}` — UTF-16 mem handle → UTF-8, ≤1024 bytes |
| `AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem` | `{projectIndex, rqItem}` | `{"numOutputModules": <int>}` |
| `AEGP_RQItemSuite4.AEGP_GetCompFromRQItem` | `{projectIndex, rqItem}` | `{"comp": {"aeRef": {<§7b item descriptor>}}, "projectIndex": <int>}` — bound comp emitted as a descriptor, never a handle |

## 7g. Mutation consent — per-request authorization proof (Issue #326)

Read-only operations are gated by the channel token alone: it filters accidental writers inside the private channel directory, and a forged read is at worst information disclosure the directory's POSIX privacy already bounds. Mutating operations need more — a request hand-written into `inbox/` must not execute. `consent` is the per-request proof, verified host-side before any AEGP call.

### Threat model and honest boundary

- `consentKey` is a **second shared secret** in `channel.json` (same 0600/private-dir domain as `token`). Anyone who can read `channel.json` can compute valid MACs — the consent layer does not defend against an attacker already inside the channel's trust boundary; POSIX privacy is the outer boundary and stays so.
- What consent *does* guarantee inside that boundary: (a) the request passed through the consent-issuing code path — the MAC covers the exact scope fields, so a consent minted for one request cannot be re-serialized into another (tamper-evident, replay-bound to `requestId`); (b) the plug-in enforces scope binding cryptographically rather than trusting `authorizationRef` shape; (c) consent issuance policy (when a human/agent may mutate) stays ae-a8n-owned — the plug-in only verifies proof-of-consent-protocol, never decides authorization.
- `authorizationRef` remains the opaque grant reference for ae-a8n's own audit; `consent.mac` is the channel-verifiable proof. They are complementary, not substitutes.
- Future hardening (documented, not implemented): asymmetric consent signatures (ae-a8n-held signing key, plug-in-held verify key) would move forgery resistance outside the shared-secret domain. Proportionate for the current single-user private-channel threat model; revisit if the channel ever crosses a trust boundary.

### Wire format

```json
"consent": {"v": 1, "mac": "<64 lowercase hex>"}
```

`mac = HMAC-SHA256(key = hexDecode(consentKey), msg = utf8(canonicalConsentString))`, rendered lowercase hex.

### canonicalConsentString

```
"native-consent/v1\n" ++ operationId ++ "\n" ++ requestId ++ "\n"
  ++ canonicalJson(session) ++ "\n" ++ canonicalJson(args ?? null) ++ "\n"
  ++ (target ?? "")
```

- `operationId`, `requestId`: the request envelope's string values verbatim.
- `session`: the request's `session` object (`{sessionId, aeVersion, sdkRelease?}`) as canonicalJson.
- `args`: the request's `args` value as canonicalJson; absent → `null`.
- `target`: the envelope-level `target` string, or empty when absent.
- Fields are `\n`-separated; every embedded string is JSON-escaped inside canonicalJson so no field can contain a raw newline — the encoding is unambiguous.

### canonicalJson (restricted JSON canonical form)

Both implementations (C++ plug-in, TS adapter/ae-a8n) MUST produce byte-identical output:

- `null`, `true`, `false` → literals.
- **Numbers: integers only.** A number is canonical iff `Number.isInteger(v)` and `|v| ≤ 9007199254740991`; it serializes as its decimal integer (`String(v)` / `%lld`). Any non-integer or out-of-range number makes canonicalization **fail** — the consent is then unverifiable and the request refuses `CONSENT_INVALID` (mutation arg schemas are integer-bounded anyway; floats are not consent-encodable in v1).
- Strings → JSON string escaping identical to `JSON.stringify`: `"`→`\"`, `\`→`\\`, `\b \f \n \r \t` short escapes, other C0 controls → `\u00xx` (lowercase hex), all other characters emitted as raw UTF-8. Object keys follow the same rule. Strings containing **lone UTF-16 surrogates are not consent-encodable**: the plug-in's JSON parser maps them to U+FFFD while `JSON.stringify` re-emits `\uDXXX` escapes, so no shared canonical form exists — issuance MUST reject them and verification fails closed (`CONSENT_INVALID`).
- Arrays → `[e0,e1,…]`; objects → `{"k0":v0,"k1":v1,…}` with **no whitespace**, keys sorted ascending by **UTF-8 byte order** (equivalently code-point order for the ASCII keys all current schemas use).
- No other value kinds exist (the dispatch arg set is ES3-serializable already).

### Verification and refusals

- Applies only to allowlist entries whose executor binding is mutating (contract term: `requiresConsent`); `AEGP_ItemSuite9.AEGP_SetItemComment` (§7h) is the first.
- `consent` absent, or present but not exactly `{"v":1,"mac":"<64hex>"}` → `refused` `CONSENT_REQUIRED`.
- `channel.json` lacks `consentKey`, or the key fails shape check → `CONSENT_REQUIRED` (fail closed — the channel cannot authorize what it cannot verify).
- canonicalization fails (non-integer number in args) or recomputed MAC ≠ `mac` (constant-time compare) → `refused` `CONSENT_INVALID`. One code covers tampering, forgery, and scope mismatch — the MAC binds every scope field, so there is no separate "valid MAC, wrong scope" case.
- Verification runs after session attestation and before execution; `opCalls` records no AEGP mutation call on any consent refusal.
- `consent` on a read-only request is ignored — never an error, never logged.
- `consentKey`/`mac` are secrets-adjacent: never written to result files, `state.json`, or the debug log (same rule as `token`).

### Shared test vectors and wire fixtures

The canonical cross-repo fixture is [`packages/native-adapter/tests/fixtures/native-consent-vectors.json`](../../../packages/native-adapter/tests/fixtures/native-consent-vectors.json) (Issue #337):

- `canonicalVectors` — scope inputs (`operationId`/`requestId`/`sessionJson`/`argsJson`/`target`) → expected `canonicalString` bytes and expected `mac` under the fixture `consentKey`. Both `native_consent.cpp` (`test_main.cpp` `TestConsentVectors`, path passed via `-DCONSENT_VECTORS_PATH` in `run_tests.sh`) and `consent.ts` (`tests/consent.test.ts`) verify against the same entries — any divergence is a contract bug, not an implementation detail.
- `wireCases` — the §7g/§7h wire contract executed **in array order** by the fake-host suite (`TestConsentWireCases`): envelope `consent` shape (`{"v":1,"mac":"<64hex>"}`), `CONSENT_REQUIRED`/`CONSENT_INVALID` refusals, scope-mismatch tamper cases, stale descriptor, failed mutation → `failed`+`mayHaveMutated:true`, missing suite entry → `not-sent`, and requestId replay → `DUPLICATE_REQUEST`. `expect.mayHaveMutated`/`expect.opCallsInclude`/`expect.opCallsExclude` pin the result-document semantics; `consent.expectedMac` pins the MAC ae-a8n must present.
- **ae-a8n consumption** (ae-a8n#245): mint `consentKey` into `channel.json`, compute `mac = issueConsentMac(consentKey, {operationId, requestId, session, args, target})` over the *parsed* request scope, and publish `"consent":{"v":1,"mac":<hex>}` at envelope level. The fixture's `canonicalVectors`/`wireCases` are the acceptance vectors for that issuance path.

## 7h. Mutating operations — `AEGP_ItemSuite9.AEGP_SetItemComment` (Issue #327)

The first mutating-binding allowlist entry (`requiresConsent` in contract terms) and the template for every future mutation:

- **Identity**: identical to the read-only item getters — `{projectIndex, item:<aeRefItem>}` resolves through the shared `ResolveAeRefItem` inside the request window; a stale/ambiguous/cross-project descriptor refuses `STALE_REFERENCE` *before* the mutation call, and consent never bypasses identity checks.
- **Consent**: mandatory §7g envelope `consent` — verified after session attestation, before the AEGP call. `opCalls` contains no `AEGP_SetItemComment` record on any consent refusal.
- **Arg**: `comment` is bounded UTF-8 (≤ 2048 bytes, matching the `GetItemComment` payload bound); the plug-in encodes to NUL-terminated UTF-16 for `AEGP_SetItemComment` (`UNDOABLE`). Empty string clears the comment.
- **Result**: `completed` → `{"commentSet": true}`; AEGP error → `failed`; missing suite entry → `not-sent`. `mayHaveMutated:true` on every attempted call (completed or failed); `false` on all pre-execution outcomes.
- **Reconciliation**: the effect is observable through the read-only `AEGP_GetItemComment` getter on the same descriptor — `UNKNOWN` reconciliation is state read-back per trusted-execution.md §8.3 (`state-consistent` is evidence, never causal proof). The op is `idempotent:true` (setting the same comment twice converges) and `reconcilable:true`.
- **Audit**: inherits the §8.2 evidence window — `opCalls` records the resolution calls plus `AEGP_ItemSuite9.AEGP_SetItemComment`; the request file (with its consent scope) and retained `*.claimed` artifact are the audit input. Consent issuance policy and `authorizationRef` grants remain ae-a8n-owned.

## 8. Non-goals / explicit limitations

- One mutating operation exists: `AEGP_ItemSuite9.AEGP_SetItemComment` (§7h, Issue #327) — consent-gated, UNDOABLE, reconcilable via `GetItemComment`. Consent-token *issuance policy* and `authorizationRef` grant verification remain ae-a8n-owned; the channel-side consent *proof* (HMAC verification, §7g) is implemented for mutating-binding allowlist entries. The concrete mutation-path design — authorization scope, audit trail, `UNKNOWN`/reconciliation semantics — is fixed in [trusted-execution.md §8](../design/trusted-execution.md#8-native-channel-mutation-path--concrete-design-issue-318-follow-up).
- No transport selection, no fallback policy beyond what the channel contract fixes, and no second transport in ae-devtools. The ae-a8n-owned client side (channel preparation, token issuance, request publication, result collection) is implemented in ae-a8n `src/driver/native-channel.ts` under ae-a8n Issue #238 (Slice B; merged to ae-a8n `release-0-4-0` via PR ae-a8n#239 `ba4ae1b`, including an opt-in interop test that runs the real client against `probe_test --channel-server`). A devtools-side fake E2E (`experiments/native-sdk/minimal-plugin/test/e2e_channel.ts` + `probe_test --channel-server`) already proves the file-channel vertical slice — external request → claim → allowlisted getter → atomic result → contract validation — at fake/mock level; the real ae-a8n client has since been verified against the same channel via ae-a8n's opt-in interop test (`AE_DEVTOOLS_PROBE_TEST=<probe_test> npx vitest run test/native-channel-interop.test.ts`), completing the Slice B fake-level vertical slice on both sides.
- File-channel privacy is not authentication — same limitation as the ae-a8n dispatcher, documented not hidden.
- `sessionId` is shape-validated only; the plug-in cannot prove which client process supplied it.
- Windows remains entirely UNVERIFIED.
- A `completed` result is a claim at fake-host level until Slice C produces `native-probe-result/v1` artifacts under LOAD-PROOF.md on an authorized session (#223).
