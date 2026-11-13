# Runtime snapshot schema — CAP022

> Status: **experiment contract** (transport-agnostic). Defines the shape of
> a read-only runtime snapshot, the **reference-invalidation rules** for any
> handle-like field, and the invariants any implementation of this schema
> must uphold. Written so it does not assume a transport: what travels is
> JSON; how it travels is the candidate transport's business.

Related: [README](README.md) · [outcome-model.md](outcome-model.md) ·
spec.md FR-08 ("no serialized object handle is assumed persistent across
restart/undo/reorder without proof").

## 1. Snapshot envelope

```jsonc
{
  "kind": "probe.snapshot.v1",        // versioned schema discriminator, closed set
  "schemaVersion": 1,
  "takenAt": "2026-11-12T09:00:00.000Z",     // client-side RFC3339
  "hostClock": "2026-11-12T09:00:00.000Z",   // AE-side UTC instant at snapshot time (drift observable)
  "identity": { /* §2, mandatory */ },
  "runtime":  { /* §3, mandatory */ },
  "sessionContext": { /* §4 */ },
  "extensions": { /* optional, namespaced */ }
}
```

`schemaVersion` gates every consumer: an unknown `schemaVersion` or unknown
`kind` must be refused, not best-effort parsed (spec FR-06 fail-closed).

## 2. `identity` — target identification (CAP021/CAP023 cross-link)

| Field | Type | Source (AE scripting) | Purpose |
| --- | --- | --- | --- |
| `aeVersion` | string | `app.version` | AE build, e.g. `"27.0.0"` |
| `aeBuildName` | string | `app.buildName` | localized build label |
| `sessionId` | string (uuid-ish, host-generated) | generated once per activation by the dispatcher | distinguishes AE process instance / activation |
| `scriptingVersion` | string | `app.scriptingVersion` | engine version |
| `isoLanguage` | string | `$.locale` / `app.isoLanguage` | locale evidence (observable on real host) |
| `userName` | string | `$.getenv("USER")` (macOS/Linux), `$.getenv("USERNAME")` (Windows) — recorded as observed, may be empty | OS user that owns the AE process |
| `channelId` | string | `probe.json` channel id | binds replies to the channel the caller prepared |
| `dispatchId` | string | dispatcher instance id (per activation) | distinguishes re-activation inside one AE session |

These fields are **snapshot-level facts captured read-only**, and also the
mis-delivery check fields: a reply/snapshot from a different
(`sessionId`, `channelId`, `dispatchId`) than pinned is a wrong target
(`outcome-model.md` §5).

## 3. `runtime` — process facts (CAP024 measurements)

```jsonc
"runtime": {
  "os": "darwin",                        // Node-side fact, cross-checked
  "osRelease": "…",                       // Node-side
  "cpuModel": "Apple M5",
  "cpuCores": 10,
  "dispatch": {                          // how this snapshot reached us
    "transportId": "file-envelope-v1",   // harness instantiation, NOT a transport choice
    "pollIntervalMs": 250,
    "claimOverheadMs": 3                 // measured host tick → claim delay (evidence-only)
  },
  "measurements": {                      // per-run latency (CAP024)
    "roundTripMs": 251,                  // write → result observed
    "hostEvalMs": 1                      // host's own timing of the snapshot evaluation
  }
}
```

`runtime.dispatch.transportId` records **which harness produced evidence this
time** so different transports' V2 numbers can be compared later. It assigns
no preference.

## 4. `sessionContext` — project-scoped COUNT-ONLY facts (read-only safe)

Because "read-only" must mean *no project mutation and no information that
could be mistaken for state*, the snapshot deliberately records only
**counts and empty/non-empty flags** — never names of the user's items, never
paths that could leak the user's project layout, and never file contents:

```jsonc
"sessionContext": {
  "projectOpen": true,
  "projectItemCount": 0,        // app.project.numItems
  "activeItemPresent": false,   // app.project.activeItem != null
  "renderQueueItemCount": 0     // app.project.renderQueue.numItems
}
```

## 5. Reference-invalidation rules (the core of CAP022)

The schema treats **every AE-object-derived reference as invalidated by
default**. Rules, which every consumer and every future candidate transport
must adopt:

1. **R1 — No cross-operation handles.** The snapshot contains only
   primitives and counts. There is no field whose value is a promise that
   an AE object can be re-acquired later. `probe.snapshot` deliberately
   stops here: it hands out nothing that could be used as a durable handle.
   (The pre-existing `experiments/runtime-bridge/08-identity.jsx` shows
   comp/layer `index`/`id`/`name`; per FR-08 those are **not** assumed
   persistent across restart/undo/reorder without per-version proof, and
   this schema encodes that by not shipping them at all.)
2. **R2 — Snapshot is point-in-time.** Every field is true only at
   `takenAt`+`hostClock`. Any consumer acting on a snapshot older than its
   own freshness bound must re-take it; there is no "check if still valid"
   operation, precisely because AE has **no project-state event**
   (ADR-0005 common ground #4) that would make such a check meaningful.
3. **R3 — Anything below the schema is disposable.** `extensions` may carry
   extra observations but no extension field may add a handle semantics. A
   consumer seeing unknown keys must ignore them (forward compatibility)
   but **must not** promote them to identity or reference fields.
4. **R4 — Identity fields are the only stable references in the schema**,
   and they are references to *the process and channel*, not to project
   objects. Even `sessionId` is invalidated by **AE restart** and by
   **dispatcher re-activation** — in this harness `sessionId` is derived
   from `dispatchId` (`sess-` + dispatchId), so both events replace both
   fields. The invalidation table:

| Event | `sessionId` | `dispatchId` | counts | `aeVersion` |
| --- | --- | --- | --- | --- |
| (no event) | valid | valid | valid until any AE-side mutation; consumer cannot detect → treat as volatile | valid |
| dispatcher re-activated | **invalid** | **invalid** | volatile | valid |
| AE quit → relaunch (new activation) | **invalid** | **invalid** | volatile | may change |
| AE version change / upgrade | **invalid** | **invalid** | volatile | **invalid** |

5. **R5 — Volatile fields stay client-side.** `measurements`-like timing
   facts are annotation, never input to logic that must be deterministic.

## 6. Invariants (machine-checkable)

`tests/snapshot-schema.test.mjs` enforces, against a captured blob:

1. `kind === "probe.snapshot.v1"` and `schemaVersion === 1` (unknown → refuse).
2. `identity` present with *all* mandatory fields non-empty
   (`aeVersion`, `sessionId`, `channelId`, `dispatchId`).
3. No absolute filesystem paths, and no project item names, anywhere in the
   snapshot (regexp sweep: `/^\// ` on string leaves; known-name blacklist
   not needed — absence rule is stronger).
   Exception: none. `userName` is a name but not a path; it is allowed and
   recorded as observed (it may be empty; the schema does not require it).
4. Every numeric leaf ≥ 0 and integral where the type says so.
5. Timestamps parse as RFC3339.
6. Round-trip: JSON.parse(JSON.stringify(snapshot)) deep-equals the source
   (no `undefined` leaves, no functions, no NaN).
7. **Reference-invalidation conformance:** no leaf key named `handle` or
   `ref` may appear outside the §2 identity allowlist (`aeVersion`,
   `sessionId`, `channelId`, `dispatchId`, `requestId`) — a static guard
   against smuggling a project-handle field into the blob.
8. Two snapshots from **different** `sessionId` must never compare equal in
   `identity`; two snapshots from the same activation **must** be equal in
   `identity` (this is the evidence rule used by the wrong-target test).

## 7. What this schema does not claim

- It does not claim AE emits events on any of the invalidating events (it
  does not; the client must re-identify after any `UNKNOWN`, restart, or
  re-activation).
- It does not define how `probe.snapshot` is transported, nor that the
  file-envelope harness is retained for production (ADR-0005 R1 Open).
- It does not include Windows evidence: `userName` on Windows and the
  privacy check are **UNVERIFIED** on this machine (Windows row in
  `EVIDENCE.md`).
- It has been exercised against a real AE in the owned macOS sessions
  recorded in `EVIDENCE.md` (`run-20261113-2`, and the post-fix re-run
  recorded there); fields observed on a real host are listed per-run in
  `EVIDENCE.md`.
