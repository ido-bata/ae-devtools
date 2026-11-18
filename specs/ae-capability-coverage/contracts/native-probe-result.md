# Contract — NativeProbe result / diagnostics / evidence

- Status: **Proposed for Issue #19**, schema `ae-devtools/native-probe-result/v1`. Machine-readable shape and validator: `packages/native-adapter/src/probe-result.ts`.
- Parent contract: [native-adapter.md](native-adapter.md). Probe source: `experiments/native-sdk/minimal-plugin/src/probe.cpp` (Issue #17, CAP038; fingerprint trigger + per-call op records added under the #19 audit).

## What this is — and is not

This contract describes the **structured result an adapter would collect** from the NativeProbe AEGP plug-in after an authorized real-host load, per `experiments/native-sdk/LOAD-PROOF.md`.

**It does NOT mean native dispatch is implemented.** No transport exists to move these values out of AE's debug log, no authorized AE session has loaded the plug-in, and every field below is UNVERIFIED until a real run produces it. `validateProbeResult` checks shape and provenance bookkeeping only; it cannot assert provenance truth or real-host observation.

## Emission surface (what probe.cpp actually writes)

All output goes through `AEGP_WriteToDebugLog` with subsystem `ae-a8n`, event `nativeprobe`. Two grammars coexist:

### `op ` records — per-call evidence

```
op <Suite>.<member> err=<A_Err> [k=v ...]
```

- `<Suite>.<member>` uses the **same identity space as `DISPATCH_ENTRIES`** (`packages/native-adapter/src/operations.ts`). `tests/registry-reconcile.test.ts` proves the two sets are identical — an op record can never name an operation the registry does not know, and vice versa.
- `err=` is always the raw numeric `A_Err`/`SPErr`; `0` = success.
- `k=v` extras, verbatim: `suite="..." version=N` (Acquire/ReleaseSuite), `value=N` (scalar results: counts, booleans, plugin id), `v=M.m` (driver versions), `i=N` (project/item index).
- `op __overflow err=-1` marks a dropped record — the buffer is bounded; an overflow means **evidence is incomplete** and `completeness.recordsWellFormed` must be false.
- `AEGP_WriteToDebugLog` itself produces no op record (it is the sink); its evidence is the existence of the emitted lines.

### Marker / diagnostic / data lines

| Line | Meaning |
| --- | --- |
| `probe.start` / `probe.reason=<initial\|identity-change\|recovery>` / `probe.end` | probe-run boundaries; `probe.end` is unreachable without `probe.start`; `probe.reason` always follows `probe.start` |
| `probe.error: <msg>` | tick-level failure (`AEGP_GetNumProjects failed`, `project fingerprint failed`, `AEGP Item Suite acquire failed`) — emitted with **no** op records (they stay buffered and are discarded) |
| `probe.aborted: required suite entry missing` | infrastructure failure; logged once per streak |
| `native.request id=<id>` / `native.result id=<id> outcome=<completed\|refused\|failed\|not-sent>[ code=<c>]` | native-channel intake markers (Issue #267, `native-channel.md`): bracket the op records emitted for one claimed dispatch request. `id` is the file-channel requestId (restricted charset, never a secret). Intake requests are **not** probe runs — they carry no `probe.*` markers; a tick containing intake activity but no `probe.start` segments as `tick`-class diagnostics plus these markers |
| `native.error: <msg>` | intake-level failure (channel privacy violation, result publish failure); log-once guarded |
| `driver.pluginInitVersion=M.m` / `driver.implementationVersion=M.m` | AE plug-in API / implementation versions (err==0 getters only) |
| `host.suppressInteractiveUI=0\|1` / `host.isActivated=0\|1` | host flags |
| `app.numProjects=N` | open project count |
| `project[i].name=<utf8>` / `.isDirty=0\|1` / `.bitDepth=N` | project metadata |
| `project[i].path: <utf8>` | project path; `<null handle>` / `lock failed` / `size query failed` / `<truncated>` / `memory suite entries missing` on failure. **Local paths reach the debug log — redact before sharing.** |
| `project.rootFolder.name: <utf8>` or `AEGP_GetProjectRootFolder err=N` / `AEGP_GetItemName(root) err=N` | root folder item |
| `project.items.firstType=N`, `project.items[k].name: <utf8>`, `project.items.count=N[ (capped)]` | item enumeration, names capped at 8, count capped at 4096 |
| `AEGP_GetProjectByIndex(i) failed`, `AEGP_GetProjectPath(i) err=N`, `AEGP_GetFirstProjItem err=N` | per-call failure diagnostics (the op record carries the same `err=`) |

Names/paths arrive as UTF-16 in AE-allocated mem handles, bounded by `AEGP_GetMemHandleSize`, and are converted to **UTF-8** (BMP + surrogate pairs) before logging; the contract carries them already normalized.

## Executions — segmenting the log stream

The debug log is a stream; the collector attributes contiguous segments and assigns `execution.ordinal` (1-based, per `evidence.debugLogRef` session):

| `kind` | Content | Boundaries |
| --- | --- | --- |
| `registration` | entry-phase flush: `AcquireSuite`×2, `RegisterWithAEGP`, `RegisterIdleHook`, `ReleaseSuite` op records. No `probe.*` markers exist. | collector attribution of the entry flush |
| `probe-run` | `probe.start`, `probe.reason`, flushed trigger-phase op records, environment `op` records + `driver.*`/`host.*` lines, `app.numProjects`, `project[i].*` data, `probe.end`, then the trailing `ReleaseSuite` op records (emitted after `probe.end` by design, one per acquired suite). | `probe.start`…`probe.end` + trailing releases |
| `tick` | diagnostics-only: `probe.error:`/`probe.aborted:` lines from an idle dispatch that never reached `probe.start`; its buffered op records were discarded and are **not** call evidence. A stage-1 suite-acquire failure emits **no** line at all (fail-closed with silent discard) — absence of a tick segment is itself the evidence that the tick produced nothing observable. | diagnostic lines only |

`execution.bounded` (derived) is true when the segment's observable boundaries are present: probe-run ⇒ start+end pair; registration ⇒ ≥1 op record; tick ⇒ ≥1 diagnostic line.

## Observed / derived / supplied — the anti-confusion rule

Every populated field belongs to exactly one provenance class, declared in `provenance` and enforced by `validateProbeResult`:

- **OBSERVED** — parsed verbatim from debug-log lines: `environment.*` (err==0 `driver.*`/`host.*` lines), `execution.kind`/`execution.reason`, `calls[]` (one per `op ` record, `err` numeric, `status` = `err===0`), `diagnostics[]` (verbatim lines), `projects[]`.
- **DERIVED** — computed by the collector, carrying no independent evidence: `execution.ordinal`, `execution.bounded`, `outcome`, `firstError`, `completeness.*`.
- **SUPPLIED** — not present in the log at all; sourced from build manifest / session context: `plugin.*` (name, entryPoint, sdkRelease — the log records only the numeric plugin id via `RegisterWithAEGP value=`), `evidence.*` (aeVersion, os, arch, debugLogRef, sessionRef).

A field with no emitting line is **absent**, never inferred. In particular: a query that failed has an `op` record with `err!=0` (or, in a `tick`, no record at all plus a diagnostic line) — the contract never fabricates a value for it.

## Completeness

`completeness` is DERIVED and answers "is this result complete enough to act on?":

- `recordsWellFormed` — every `op ` record in the segment parsed cleanly; false if `op __overflow` or a malformed line appears.
- `bounded` — mirrors `execution.bounded`.
- `operationsEvidenced` — sorted unique `call` ids with ≥1 `err===0` record **in this execution**. This is the per-operation real-host evidence set.
- `operationsFailed` — sorted unique `call` ids observed only with `err!==0`.

A `probe-run` with `outcome=completed`, `bounded=true`, `recordsWellFormed=true` is a **complete run**. `partial` = `probe.start` observed without `probe.end` (truncated log/crash mid-run). `failed` = `tick` executions and registration flushes with no successful records.

## Per-operation evidence and promotion criteria

`verifiedOnRealHost` on a `DISPATCH_ENTRIES` entry may be set **only** when ALL of the following hold:

1. A `native-probe-result/v1` artifact exists for an execution on the **target platform** (OS/arch/AE version/SDK release matching the entry's claim), referenced by `evidence.debugLogRef` + `sessionRef`.
2. The execution is `kind: "registration"` for registration-phase operations (`SPBasicSuite.AcquireSuite/ReleaseSuite` entry records, `AEGP_UtilitySuite6.AEGP_RegisterWithAEGP`, `AEGP_RegisterSuite5.AEGP_RegisterIdleHook`) or `kind: "probe-run"` with `outcome=completed`, `bounded=true`, `recordsWellFormed=true` for probe-phase operations.
3. `completeness.operationsEvidenced` contains the operation's registry id — i.e. ≥1 `err===0` op record for `"<Suite>.<member>"` in that execution.
4. The artifact's `provenance` declares the section classes above; supplied fields (`plugin.sdkRelease`, `evidence.os/arch`) must match the build manifest and session record independently.

Mock-host (`fake/mock only`) and build-host (`implemented`) evidence **never** promotes an entry — they are different verification levels, not weaker versions of the same evidence. `AEGP_WriteToDebugLog` is self-evidencing: any emitted `op `/marker line proves it ran; promotion requires the artifact to exist at all.

Windows requires its own artifact set; macOS evidence never promotes a Windows claim.

## Error taxonomy

| Class | Source | Contract field |
| --- | --- | --- |
| `A_Err`/`SPErr` numeric | every suite call | `calls[].err`, `firstError.errorCode` |
| suite-acquisition failure | `AcquireSuite` non-zero/NULL | `calls[]` AcquireSuite `err!=0`; probe aborts (fail closed) |
| null/truncated handle | `AEGP_LockMemHandle` fail or null handle | `op` records `err!=0` + `<label>: <status>` data lines; `projects[].pathStatus` uses the normalized tokens `null-handle`, `lock-failed`, `size-query-failed`, `truncated`, `entries-missing` (the log emits `<null handle>`, `lock failed`, `size query failed`, `<truncated>`, `memory suite entries missing` — the collector maps verbatim strings to these tokens) |
| tick-level failure | fingerprint/count/acquire failure before `probe.start` | `kind:"tick"` + `diagnostics[]` + `outcome:"failed"` |
| probe-level outcome | aggregate of the above | `outcome`, `firstError`, `completeness` |

AE `A_Err` code *names* are not committed (symbol-table licensing); codes stay numeric with the calling suite/member as context.

## Schema field rules (enforced by `validateProbeResult`)

- `provenance` is required; its three classes must be disjoint and use only the vocabulary in `probe-result.ts` (`PROVENANCE_OBSERVED`/`DERIVED`/`SUPPLIED`).
- `execution.ordinal` ≥ 1; `reason` is valid only on `kind:"probe-run"` and only `initial|identity-change|recovery`.
- `calls[]`: `err` numeric, `status === (err===0 ? "ok":"error")` enforced — a status/err contradiction is rejected; `fields` values are strings.
- `projects[].items.count` ≥ 0; `names` are UTF-8 strings; `path`/`pathStatus` typed when present.
- `outcome` ∈ `completed|failed|partial`; `failed|partial` requires `firstError` (whose `call`/`errorCode`/`detail` are all optional — a diagnostic line may carry no numeric code).
- `completeness` and `evidence` are required objects with typed fields.

## Evidence level

`unverified` until a real run under LOAD-PROOF.md produces a debug-log excerpt referenced by `evidence.debugLogRef`. Promotion to `verified-real-host` per operation follows the criteria above; the load/execution proof gates in Issue #17 remain the session-level gate.
