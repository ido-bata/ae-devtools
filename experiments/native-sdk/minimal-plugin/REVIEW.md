# REVIEW — ABI, callback lifetime, thread affinity (Issue #17)

Review of `src/probe.cpp` against the After Effects SDK 26.5 headers
(`Examples/Headers`, operator-supplied, never committed) and the
canonical AEGP samples (`Examples/AEGP/Sweetie`, `ProjDumper`,
`Commando`, `FBIO`, `IO`, `Grabba`, `Easy_Cheese`, `Mangler`).
Original analysis; no sample code is copied.

## Entry-point contract

- `AEProbePluginEntry` matches `AEGP_PluginInitFuncPrototype`
  (`AE_GeneralPlug.h`): `(struct SPBasicSuite*, A_long, A_long,
  AEGP_PluginID, AEGP_GlobalRefcon*) -> A_Err`. ✔
- Exported `extern "C"` with default visibility so the unmangled
  symbol resolves against the PiPL `CodeMacIntel64`/`CodeMacARM64`
  entry names. Verified: `nm -gU` shows `_AEProbePluginEntry`. ✔
- `global_refconP` is unused — correct: it is only "passed to all
  hooks", and the probe's idle hook takes `NULL` refcons (same as
  `Commando`/`Grabba`). ✔
- Driver version parameters are accepted and ignored; the probe
  queries `AEGP_GetDriverPluginInitFuncVersion` /
  `AEGP_GetDriverImplementationVersion` itself inside the hook.
  ✔

## Callback lifetime

- Statics (`s_basicP`, plugin ids, `s_last_num_projectsL`) follow the
  SDK-sample convention: AEGPs are not unloaded by AE
  (`Commando.cpp` documents this explicitly), so static lifetime is
  safe. No `AEGP_RegisterDeathHook` is registered — there is nothing
  to clean up (all suites are acquired/released per call, no
  persistent allocations). ✔
- Suites are **never held across callbacks**: init acquires
  Utility+Register and releases before returning; each idle-hook
  invocation acquires its four suites, uses them, and releases them
  before returning. This matches `AEGP_SuiteHandler` usage in the
  samples (suites re-acquired inside every hook). ✔
- The idle-hook function pointer is passed to
  `AEGP_RegisterIdleHook` once at init and must remain valid for the
  plug-in lifetime — it is a static function, so it does. ✔
- `AEGP_RegisterWithAEGP` is called at init with a `NULL`
  `AEGP_GlobalRefcon`, identical to `FBIO.cpp:778` /
  `IO.cpp:942`. The returned `AEGP_PluginID` is kept for
  `AEGP_GetItemName` calls inside the hook. ✔

## Thread affinity

- `A.h` defines `A_Err_WRONG_THREAD`: "calls back to AE can only be
  made from the same thread AE called you on." All AEGP project
  queries therefore run **only** inside `ProbeIdleHook`, which the
  host dispatches; the entry point performs registration calls only
  (the same calls the samples make at init).
- Whether AE dispatches idle hooks strictly on the main thread is
  **inferred**, not header-guaranteed: the hook-dispatch model plus
  `A_Err_WRONG_THREAD` semantics imply it, and every SDK sample that
  touches AEGP state does so inside a host-dispatched hook
  (`CommandHook`, `UpdateMenuHook`, `IdleHook`). Real-host
  confirmation remains **UNVERIFIED** (LOAD-PROOF).
- `max_sleepPL` is passed through untouched — the probe does not
  request idle throttling.

## Execution-context choice: idle hook vs. menu command

Two SDK-sanctioned contexts were candidates:

- **Menu command + `AEGP_RegisterCommandHook`** (`ProjDumper` pattern):
  requires `AEGP_GetUniqueCommand` + `AEGP_InsertMenuCommand` +
  `AEGP_EnableCommand` via an update-menu hook, and a user click.
- **Idle hook** (`AEGP_RegisterIdleHook`; `Commando`/`Grabba`/
  `Easy_Cheese`/`Mangler` pattern): automatic, no UI, re-runs when
  the project-set fingerprint changes.

The idle hook was chosen because the probe is a UI-less diagnostic:
no user interaction keeps the future load proof automatable. The
trigger is a project-set fingerprint (count + per-project name/path,
first 4 projects), not the raw count — a same-count project switch
re-probes, and failure windows invalidate the fingerprint so the
next good tick recovers with `probe.reason=recovery`. No PiPL change is
required — hooks are runtime registrations, not resources (the
`ProjDumper` PiPL likewise declares no commands).

## PiPL / resource correctness

- `ProbePiPL.r` declares Kind `AEGP`, Name `NativeProbe`, Category
  `General Plugin`, Version `65536`, and `CodeMacIntel64` +
  `CodeMacARM64` → `AEProbePluginEntry` — mirrors `Sweetie_PiPL.r`
  structure with original content.
- `plugin-Info.plist`: `CFBundlePackageType AEGx`, `CFBundleSignature
  FXTC`, `PkgInfo "AEgxFXTC"` — matches SDK sample convention.
- macOS-only verification: `CodeMacIntel64` + `CodeMacARM64` cover
  both macOS arches. The Windows branch declares `CodeWin64X86` only
  (no `CodeWinARM64`, unlike `Sweetie_PiPL.r`) — acceptable because
  Windows is entirely UNVERIFIED (Issue #21); if a Windows build is
  ever attempted the ARM64 entry must be added deliberately, not
  assumed.

## Findings fixed during this review

1. Project queries previously ran inside the entry point — moved to
   the idle hook (context legality).
2. `LogMemHandleUtf16` leaked the handle on lock failure and read the
   UTF-16 payload unbounded — now size-bounded via
   `AEGP_GetMemHandleSize` and freed on every path.
3. UTF-16 conversion did not validate surrogates or bounds — now
   bounded by code-unit count with lone-surrogate → U+FFFD.
4. No null checks on suite function-table entries — added
   per-suite validation, fail closed.
5. `AEGP_GetNumProjects` result was fetched inside `ProbeProject`
   with no "no project" semantics — now fetched once in the hook;
   0 is a normal logged state.
6. The re-arm trigger was the raw project **count** — a same-count
   project switch (close A, open B) went unobserved, and a failure
   window could hide changes. Replaced by a project-set fingerprint
   (count + per-project name/path, first 4 projects) with
   invalidation-on-failure so the next good tick recovers.

## Remaining UNVERIFIED

- Whether AE actually dispatches `AEGP_IdleHook` in all launch modes
  (interactive, `-nogui`/service) and on which thread.
- Whether idle hooks fire before/without any project open (probe
  handles `numProjects=0`, but dispatch itself is unproven).
- Real `AEGP_MemHandle` size semantics (bytes assumed per
  `AEGP_NewMemHandle` usage in samples; the odd-size path is
  defensive either way).
- Everything below `verified on real host` — see `../EVIDENCE.md`.
