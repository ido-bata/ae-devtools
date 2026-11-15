# Contract — NativeProbe result / diagnostics / evidence

- Status: **Proposed for Issue #19**, schema `ae-devtools/native-probe-result/v1`. Machine-readable shape and validator: `packages/native-adapter/src/probe-result.ts`.
- Parent contract: [native-adapter.md](native-adapter.md). Probe source: `experiments/native-sdk/minimal-plugin/src/probe.cpp` (Issue #17, CAP038).

## What this is — and is not

This contract describes the **structured result an adapter would collect** from the NativeProbe AEGP plug-in after an authorized real-host load, per `experiments/native-sdk/LOAD-PROOF.md`.

**It does NOT mean native dispatch is implemented.** No transport exists to move these values out of AE's debug log, no authorized AE session has loaded the plug-in, and every field below is UNVERIFIED until a real run produces it. `validateProbeResult` checks shape only; it cannot assert provenance or real-host observation.

## Emission surface (what probe.cpp actually writes)

All output goes through `AEGP_WriteToDebugLog` with subsystem `ae-a8n`, event `nativeprobe`:

| Marker/line | Meaning |
| --- | --- |
| `probe.start` / `probe.end` | run boundaries; `probe.end` is unreachable without `probe.start` |
| `driver.pluginInitVersion=%d.%d` | AE plug-in API version (maj.min) |
| `driver.implementationVersion=%d.%d` | AE implementation version |
| `host.suppressInteractiveUI=%d` | host UI-suppression flag |
| `host.isActivated=%d` | license-activation boolean |
| `app.numProjects=%ld` | open project count (≤1 in modern AE) |
| `project[%ld].name=%s` | project name (UTF-8 console buffer) |
| `project[%ld].isDirty=%d` | dirty flag |
| `project[%ld].bitDepth=%d` | bit-depth enum |
| `project.rootFolder.name: <utf8>` | root folder item name via mem handle |
| `project.items.firstType=%d` | first item type enum |
| `project.items[%ld].name: <utf8>` | item names, capped at 8 |
| `project.items.count=%ld`(+` (capped)`) | item count, capped at 4096 |
| `<label>: <null handle>` / `lock failed` / `... err=%ld` | per-call failure diagnostics |

Names arrive as UTF-16 in AE-allocated mem handles and are converted to **UTF-8** by `Utf16ToUtf8` (BMP + surrogate pairs) before logging; the contract carries them already normalized.

## Schema `ae-devtools/native-probe-result/v1`

```json
{
  "schema": "ae-devtools/native-probe-result/v1",
  "plugin": { "name": "ae-a8n NativeProbe", "entryPoint": "AEProbePluginEntry",
              "sdkRelease": { "identifier": "26.5", "distribution": "macOS" } },
  "environment": { "driverPluginInitVersion": "13.29",
                   "driverImplementationVersion": "26.5.3",
                   "suppressInteractiveUI": false, "hostIsActivated": true },
  "suiteAcquisition": [
    { "suite": "AEGP_ProjSuite6", "registration": "AEGP Proj Suite",
      "versionRequested": 9, "status": "acquired", "errorCode": 0 }
  ],
  "calls": [
    { "call": "AEGP_ProjSuite6.AEGP_GetNumProjects", "suite": "AEGP_ProjSuite6",
      "status": "ok", "value": 1 },
    { "call": "...", "suite": "...", "status": "error", "errorCode": -1 }
  ],
  "markers": { "probeStart": true, "probeEnd": true },
  "projects": [
    { "index": 0, "name": "probe.aep", "isDirty": false, "bitDepth": 8,
      "rootFolderName": "Root",
      "items": { "count": 3, "capped": false, "firstType": 1,
                 "names": ["Comp 1", "…UTF-8…"] } }
  ],
  "outcome": "completed | failed | partial",
  "firstError": { "call": "...", "errorCode": -1 },
  "evidence": { "aeVersion": "...", "os": "...", "arch": "...", "debugLogRef": "..." }
}
```

Field rules (enforced by `validateProbeResult`):

- `suiteAcquisition[]` records each `AcquireSuite` attempt **in acquisition order** with the registration string and requested version; probe.cpp aborts on first failure, so a `failed` entry implies all later suites are absent.
- `calls[]` has one entry per AEGP/SPBasicSuite call: `status` ∈ `ok | error | skipped`; `error` requires a numeric `errorCode` (`A_Err`, `A_long`).
- `markers.probeEnd` without `probeStart` is impossible and rejected.
- `projects[].items.count` ≥ 0; `names` are UTF-8 strings only; `capped` records the 4096-item scan cap.
- `outcome` ≠ `completed` requires `firstError {call, errorCode}`.

## Error taxonomy

| Class | Source | Contract field |
| --- | --- | --- |
| `A_Err` numeric | every AEGP call | `calls[].errorCode`, `firstError.errorCode`, `suiteAcquisition[].errorCode` |
| suite-acquisition failure | `AcquireSuite` non-zero/NULL | `suiteAcquisition[].status: "failed"` + probe returns `A_Err_STRUCT` |
| null/truncated handle | `AEGP_LockMemHandle` fail or null handle | `calls[].status: "error"` |
| probe-level outcome | aggregate of the above | `outcome`, `firstError` |

AE `A_Err` code *names* are not committed (symbol-table licensing); codes stay numeric with the calling suite/member as context.

## Evidence level

`unverified` until a real run under LOAD-PROOF.md produces a debug-log excerpt referenced by `evidence.debugLogRef`. Promotion to `verified-real-host` additionally requires the load/execution proof gates in Issue #17.
