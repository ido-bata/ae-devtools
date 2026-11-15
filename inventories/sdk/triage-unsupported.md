# Triage — `unsupported-or-unknown` symbol candidates (Issue #70)

- Status: **Provisional**, source-reviewed only. No AE execution.
- Parent inventory: [README.md](README.md); aggregate: [generated/aggregate.json](generated/aggregate.json).
- Method: per-symbol rows regenerated locally with `inventories/sdk/scripts/extract-sdk-inventory.ts --headers <SDK>/Examples/Headers` into the git-ignored `.local/symbols.json`; each candidate below was then re-read in its header context. Per-symbol detail stays local per the redistribution rules — this document records **name + header:line + disposition**, the same citation granularity the operation registry uses.

## Aggregate verification (552 symbols)

| Reason | Count | Disposition |
| --- | ---: | --- |
| `pure-data-type` | 534 | Struct/enum/typedef declarations with no call direction. Aggregate rationale: the extractor only assigns a class when a declaration has a caller/callee direction (suite slot, proc table, entry point, selector). Plain data types have none by construction; they are counted in the denominator for completeness but carry no callable surface. No per-symbol re-review needed — re-evaluate only if the extractor gains type-level call-direction rules. |
| `unattributed-callable` | 13 | Investigated individually below. |
| `reserved-selector` | 5 | Investigated individually below. |
| `deprecated-header-only` | 0 | — |

Total: **552 = 534 + 13 + 5 + 0** ✓ (matches `aggregate.json → totals.unknownByReason`).

## `reserved-selector` (5) — all `PF_Cmd_*` slots in `AE_Effect.h`

The `PF_Cmd` enum declares "The order of this enumeration must not be altered!" Reserved slots are numeric placeholders for Adobe-private commands; they have no public name contract, no documented parameters, and no dispatch surface a client could call.

| Symbol | Header:line | Finding | Disposition | Re-evaluation | Follow-up |
| --- | --- | --- | --- | --- | --- |
| `PF_Cmd_UNUSED_0` | `AE_Effect.h:1245` | Unused slot between `GLOBAL_SETUP` and `GLOBAL_SETDOWN`. | Keep `unsupported-or-unknown`. | Adobe documents or ships a build where the slot carries a public command. | #18 (Effect SDK cluster) |
| `PF_Cmd_RESERVED1` | `AE_Effect.h:1276` | "private command" per header comment. | Keep `unsupported-or-unknown`. | Same as above; also if PF command dispatch docs name it. | #18 |
| `PF_Cmd_RESERVED2` | `AE_Effect.h:1277` | "private command". | Keep `unsupported-or-unknown`. | Same. | #18 |
| `PF_Cmd_RESERVED3` | `AE_Effect.h:1278` | "private command". | Keep `unsupported-or-unknown`. | Same. | #18 |
| `PF_Cmd_RESERVED4` | `AE_Effect.h:1283` | "private command". | Keep `unsupported-or-unknown`. | Same. | #18 |

## `unattributed-callable` (13)

| Symbol | Header:line | Kind | Finding | Disposition | Re-evaluation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| `PF_DeletePreRenderDataFunc` | `AE_Effect.h:2528` | callback-type | Function-pointer typedef the **host calls** to release SmartFX/pre-render data. Direction is host→plugin callback, but it is a bare typedef outside any proc table, so the extractor cannot attribute it. | Reattribute → `host-callback`; register as a PF/Effect-suite operation entry, not an unknown. | When #66 implements the PF sequence/pre-render path. | #66 |
| `PF_IteratePixelFloatFunc` | `AE_EffectCB.h:624` | callback-type | Pixel-iteration callback typedef (float variant of the `PF_IteratePixelFunc` family). Same bare-typedef attribution gap; direction needs the iterator contract review (callback supplied by plug-in vs host-invoked). | Reattribute → `host-callback` pending direction confirmation in #66; do not register until direction is confirmed. | #66 header-context review of `AE_EffectCB.h` iterate contract. | #66 |
| `AE_BlitCompleteFunc` | `AE_Hook.h:106` | callback-type | Completion callback inside `AE_BlitHook` signature — host→plugin (plugin registers the hook; host invokes `complete_func`). | Reattribute → `host-callback`; part of the legacy `AE_Hooks` entry-point mechanism. | When the hook/entry-point cluster is scheduled. | #65 (utility/misc) or hook cluster |
| `AE_HookPluginEntryFunc` | `AE_Hook.h:137` | callback-type | Plug-in entry-point typedef in `AE_Hooks` — the host calls this to enter the plug-in. Classic host→plugin entry point. | Reattribute → `host-callback` (host dispatches entry point). | Same as above. | #65 or hook cluster |
| `AEIO_MessageFunc` | `AE_IO.h:74` | callback-type | Message callback field of `AEIO_InData` — host→plugin message sink for IO plug-ins. | Reattribute → `host-callback`. | When #67 (IO/import-export) is scheduled. | #67 |
| `PR_MessageFunc` | `PR_Public.h:97` | callback-type | Same pattern as `AEIO_MessageFunc` for the `PR_InData` block (render/painter entry data). | Reattribute → `host-callback`. | When the PR/paint cluster is scheduled. | #67 or render cluster |
| `SPAddPiPLFilterProc` | `SP/SPFiles.h:266` | callback-type | Marked `/** Internal */` in the header — internal PiPL-filter callback with no public registration path. | Keep `unsupported-or-unknown`; reason: internal, undocumented, no public call direction. | Adobe documents it or a public header exposes a registration path. | #69 (PICA/SP) |
| `SPGetHostAccessInfoProc` | `SP/SPRuntme.h:266` | callback-type | `/** Internal */` typedef; platform access-info getter with no suite slot or public proc table referencing it in the committed corpus. | Keep `unsupported-or-unknown`; reason: internal. | Same. | #69 |
| `SPAcquireSuiteFunc` | `SP/SPRuntme.h:481` | callback-slot | Function-type typedef underlying the `SPBasicFuncStruct.SPAcquireSuiteFunc` slot — the **same operation** as registry entry `SPBasicSuite.AcquireSuite` (host-provided, external-command direction). | Reattribute → `external-command`; operation identity is the suite-slot row `SPBasicSuite.AcquireSuite`, already registered `implemented-unverified` under #19. This row is the type declaration, not a second operation. | n/a — covered. | #69 (closed by registry entry) |
| `SPReleaseSuiteFunc` | `SP/SPRuntme.h:487` | callback-slot | Same: type declaration underlying `SPBasicSuite.ReleaseSuite`. | Reattribute → `external-command`; covered by `SPBasicSuite.ReleaseSuite`. | n/a — covered. | #69 |
| `spAllocateBlockFunc` | `SP/SPRuntme.h:489` | callback-slot | Block-allocator typedef in `SPBasicFuncStruct`; corresponds to the SP memory-block allocation path the host provides. | Reattribute → `external-command`; register under the SPBasicSuite block-memory members when #69 enumerates them. | #69 registry pass. | #69 |
| `spFreeBlockFunc` | `SP/SPRuntme.h:490` | callback-slot | Same family — block free. | Reattribute → `external-command`; #69. | #69 registry pass. | #69 |
| `spReallocateBlockFunc` | `SP/SPRuntme.h:491` | callback-slot | Same family — block realloc. | Reattribute → `external-command`; #69. | #69 registry pass. | #69 |

## Summary

- **5 reserved-selector**: all correctly `unsupported-or-unknown` (Adobe-private enum slots, no public contract).
- **13 unattributed-callable**: 2 stay unknown (Adobe `Internal` typedefs), 11 reattribute — 5 to `host-callback` (PF/Effect/IO/PR/Hook callback typedefs → #66/#67/#65), 6 to `external-command` (SPBasicFuncStruct function types → covered by #69 suite-slot entries).
- **534 pure-data-type**: aggregate rationale above; no individual review required by construction.

## "調査済み" と "未分類・unsupported" の区別

Three different states must not be conflated:

1. **Aggregate-classified** — all 552 rows carry `class: unsupported-or-unknown` with rule `unknown:*` and `evidence: none` in the extractor output. That is the *committed classification*: structurally unattributable under the current rule set.
2. **Individually investigated** — the 18 `unattributed-callable` + `reserved-selector` rows above were re-read in header context. "Investigated" records a *finding and disposition*; it does **not** change the committed class. Reattribution lands only when the follow-up Issue implements the operation entry or extends the extractor rules — until then these symbols remain `unsupported-or-unknown` in the aggregate.
3. **Aggregate-rationale covered** — the 534 `pure-data-type` rows are classified by construction (no call direction exists to attribute); they are "covered" by the aggregate rationale, not individually investigated.

Cross-check against extractor rule families: every unknown row's rule is `unknown:pure-data-type | unknown:unattributed-callable | unknown:reserved-selector` — i.e. the extractor emitted no directional evidence (`evidence: none`) for any of them. The reattribution targets above (`host-callback`, `external-command`) are the classes the *direction* implies; they are claims about call direction from header context, pending the follow-up Issues named per row.

## Re-evaluation conditions (shared)

- New SDK release changes the header surface → re-run extraction + this triage.
- An `Internal` typedef gains a public registration path in headers.
- The follow-up Issue lands and attributes the symbol to a suite/operation.
- Real-host evidence contradicts the direction finding.
