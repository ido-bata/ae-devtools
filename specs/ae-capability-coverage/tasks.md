# Tasks — AE capability coverage (Spec Kit)

- Parent: [ae-devtools #6](https://github.com/ido-bata/ae-devtools/issues/6); draft plan [PR #7](https://github.com/ido-bata/ae-devtools/pull/7).
- Canonical requirements: [spec.md](spec.md). Architecture and gates: [plan.md](plan.md). Catalog shape: [contracts/capability-catalog.md](contracts/capability-catalog.md).
- **This is a planning inventory.** Every task is unchecked; creating an Issue is not implementation. Child Issue owns exact acceptance, affected files, dependencies and evidence. Task IDs are stable within this feature; do not reuse ae-a8n's existing T001–T108.

## Delivery rule

One independently reviewable Issue/PR per implementation slice. No speculative native bridge before #17/#18 proof. For SDK suite families not implementable in one slice, #19 creates additional tracked Issues, preserving the full public SDK denominator. Fake tests do not satisfy real-host gates.

### [#8](https://github.com/ido-bata/ae-devtools/issues/8) — Tool parity research

Dependencies: none. Status: **open / not verified**.

- [ ] **CAP001** Discover and snapshot AE control tools with commit/license. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))
- [ ] **CAP002** Extract real implemented operations from source. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))
- [ ] **CAP003** Normalize operation IDs and compare existing repo surfaces. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))
- [ ] **CAP004** Record ongoing discovery and parity delta process. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))

### [#9](https://github.com/ido-bata/ae-devtools/issues/9) — Scripting inventory

Dependencies: none. Status: **open / not verified**.

- [ ] **CAP005** Extract public scripting classes/methods/properties/enums. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))
- [ ] **CAP006** Record AE/ExtendScript version and OS deltas. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))
- [ ] **CAP007** Classify ES3/handle/undo/UI/permission constraints. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))
- [ ] **CAP008** Cross-check Adobe references vs community docs and live AE. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))

### [#10](https://github.com/ido-bata/ae-devtools/issues/10) — SDK inventory

Dependencies: none. Status: **open / not verified**.

- [ ] **CAP009** Record SDK releases, headers, samples, hashes and license. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))
- [ ] **CAP010** Extract suites, functions, selectors, callbacks and types. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))
- [ ] **CAP011** Classify external command vs host lifecycle vs unsupported. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))
- [ ] **CAP012** Record ABI, MFR, GPU, thread, signing and OS constraints. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))

### [#11](https://github.com/ido-bata/ae-devtools/issues/11) — Catalog and schema

Dependencies: #8, #9, #10. Status: **open / not verified**.

- [x] **CAP013** Define stable IDs, provenance, execution and evidence schema, distinguishing rows persisted in the repository from rows supplied at build time (SDK symbols). ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))
- [x] **CAP014** Import and dedupe scripting/SDK/tool inventories. ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))
- [x] **CAP015** Generate coverage denominators and drift/false-green gates; a report produced without SDK-derived input reports `unknown`, not "no drift". ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))
- [x] **CAP016** Add versioned capability handshake and refusal tests; absence of a row in the repository must not be reported as absence of the capability. ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))

### [#12](https://github.com/ido-bata/ae-devtools/issues/12) — Cross-repo ADR

Dependencies: #8–#10 initial; ae-a8n #97–#99. Status: **open / not verified**.

- [ ] **CAP017** Reconcile ae-devtools ADR-0001 with ae-a8n ADR-0003. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))
- [ ] **CAP018** Compare CEP, in-AE JSX, UXP, native and CLI routes. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))
- [ ] **CAP019** Define trust, serialization, lifecycle and repo ownership. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))
- [ ] **CAP020** Record decision/evidence/owner gates and alternatives. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))

### [#13](https://github.com/ido-bata/ae-devtools/issues/13) — Read-only AE probe

Dependencies: #12; ae-a8n #98. Status: **open / not verified**.

- [x] **CAP021** Prove AE host version/ping and target identity. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))
- [x] **CAP022** Define runtime snapshot and handle invalidation rules. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))
- [x] **CAP023** Test missing/wrong/busy/timeout/reconnect failure paths. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))
- [x] **CAP024** Capture real-host OS/AE/CPU/latency/trace evidence. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))

### [#14](https://github.com/ido-bata/ae-devtools/issues/14) — Script runtime

Dependencies: #11, #12, #13. Status: **open / not verified**.

- [ ] **CAP025** Separate read-only/write/trusted-dev-script permissions. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))
- [ ] **CAP026** Implement ES3 codec, values, errors and source map. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))
- [ ] **CAP027** Guard writes with identity, intent and non-retry policy. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))
- [ ] **CAP028** Test undo/timeout/late result/unknown outcomes. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))

### [#15](https://github.com/ido-bata/ae-devtools/issues/15) — Scripting DOM A

Dependencies: #9, #11, #14. Status: **open / not verified**.

- [ ] **CAP029** Map project/item/footage/import/save symbols to adapters. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))
- [ ] **CAP030** Map comp/layer/parent/selection/timing symbols. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))
- [ ] **CAP031** Test object identity, duplicate names and invalidation. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))
- [ ] **CAP032** Track uncovered and version-limited symbols. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))

### [#16](https://github.com/ido-bata/ae-devtools/issues/16) — Scripting DOM B

Dependencies: #9, #11, #14, #15. Status: **open / not verified**.

- [ ] **CAP033** Map property/keyframe/expression/text/shape/mask. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))
- [ ] **CAP034** Map effects/parameters and plugin availability. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))
- [ ] **CAP035** Map render/output/IO/menu/preferences with constraints. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))
- [ ] **CAP036** Test locale, value kind, render and failure cases. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))

### [#17](https://github.com/ido-bata/ae-devtools/issues/17) — AEGP native proof

Dependencies: #10, #11, #12, #13. Status: **open / not verified**.

- [ ] **CAP037** Select reproducible SDK/ABI/toolchain/license. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))
- [ ] **CAP038** Build and load minimal read-only AEGP plugin. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))
- [ ] **CAP039** Prove safe host command boundary and response. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))
- [ ] **CAP040** Record install/restart/unload/crash/version proof. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))

### [#18](https://github.com/ido-bata/ae-devtools/issues/18) — Effect SDK proof

Dependencies: #10, #11, #12, #17. Status: **open / not verified**.

- [ ] **CAP041** Map PF selectors, UI, sequence/arbitrary data. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))
- [ ] **CAP042** Build/load/render one real Effect SDK plugin. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))
- [ ] **CAP043** Design SmartFX/MFR/GPU/callback lifecycle tests. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))
- [ ] **CAP044** Capture render/artifact/CPU-GPU and negative evidence. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))

### [#19](https://github.com/ido-bata/ae-devtools/issues/19) — Native SDK expansion

Dependencies: #10, #11, #17, #18. Status: **open / not verified**.

- [ ] **CAP045** Generate suite-family host lifecycle coverage matrix. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))
- [ ] **CAP046** Build adapter/fixture/build-test templates. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))
- [ ] **CAP047** Split uncovered suite families into independent Issues. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))
- [ ] **CAP048** Verify every public SDK entrypoint has explicit status. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))

### [#20](https://github.com/ido-bata/ae-devtools/issues/20) — VSCode/MCP developer interface

Dependencies: #11–#15. Status: **open / not verified**.

- [ ] **CAP049** Expose shared discovery/session/API metadata. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))
- [ ] **CAP050** Implement VSCode run/inspect/diagnostic vertical slice. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))
- [ ] **CAP051** Define minimal MCP inspect/execute/verify interface. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))
- [ ] **CAP052** Audit explicit consent and privileged SDK/script operations. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))

### [#21](https://github.com/ido-bata/ae-devtools/issues/21) — Conformance/evidence

Dependencies: #8–#20; ae-a8n #97–#99; ae-test #19. Status: **open / not verified**.

- [ ] **CAP053** Define real-host fixture and immutable evidence manifest. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21))
- [ ] **CAP054** Run script/native/transport/security conformance. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21))
- [ ] **CAP055** Bind ae-a8n/ae-test/farm evidence to exact SHA. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21))
- [ ] **CAP056** Reject stale/fake-only/unknown coverage release claims. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21))

### [#36](https://github.com/ido-bata/ae-devtools/issues/36) — CEP/UXP extension lifecycle

Dependencies: #11, #13. Status: **open / not verified**. Registered 2026-11-14; extension *development* lifecycle is a distinct axis from transport selection (ADR-0005 D5).

- [ ] **CAP057** Generate CEP extension scaffolds (manifest.xml, CSXS version, host version range, debug-load configuration) from inventory and Adobe-official specs. ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))
- [ ] **CAP058** Mechanize CEP panel build/install/reload/unload/cleanup per OS; record `.zxp` signing, `PlayerDebugMode` and registry/plist handling. ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))
- [ ] **CAP059** Prove panel load → `CSInterface.evalScript` round trip → reload → unload on an owned AE session only. ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))
- [ ] **CAP060** Track UXP plugin development lifecycle as BLOCKED/UNVERIFIED per row until Adobe released builds provide plugin loading and remote IPC; beta adoption stays forbidden (ADR-0005 D5). ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))

### [#37](https://github.com/ido-bata/ae-devtools/issues/37) — Unified AE diagnostics

Dependencies: #14, #15, #16, #17, #18, #36. Status: **open / not verified**. Registered 2026-11-14.

- [ ] **CAP061** Define the diagnostics record schema (source kind, severity, source position, session/target pin, artifact hash). ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))
- [ ] **CAP062** Connect ExtendScript exceptions, expression errors and render-queue failures to the host-side collection path via the trusted-execution codec. ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))
- [ ] **CAP063** Investigate and adapt collection of CEP/UXP panel logs, AE plug-in load failures and OS crash reports; unreachable sources are `unsupported-with-reason`. ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))
- [ ] **CAP064** Implement diagnostics→source-position mapping (generated JSX / panel asset / plugin binary) with fake-responder tests. ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))

### [#38](https://github.com/ido-bata/ae-devtools/issues/38) — Agent development-loop E2E

Dependencies: #14, #20, #21, #37. Status: **open / not verified**. Registered 2026-11-14.

- [ ] **CAP065** Prove the minimal loop on an owned AE session: intentionally broken JSX fixture → execute → diagnostics with source position → fix → re-run → PASS, scripting only first. ([Issue #38](https://github.com/ido-bata/ae-devtools/issues/38))
- [ ] **CAP066** Bind loop evidence (per-iteration request/result/diagnostics/regression artifacts) to the #21 conformance evidence schema; fake-only success never promotes to real-host verified. ([Issue #38](https://github.com/ido-bata/ae-devtools/issues/38))

## Cross-repository integration tasks (not duplicated in ae-devtools)

### [ae-a8n #102](https://github.com/ido-bata/ae-a8n/issues/102) — execution and capability negotiation

- [ ] **A8NCAP01–04** Read-only capabilities query; map to built-ins/static extensions; native adapter only via proven lifecycle; fake and real-host refusal/ownership tests. Depends on ae-devtools #11/#12 and ae-a8n #97–#99. No new release authorized.

### [ae-test #21](https://github.com/ido-bata/ae-test/issues/21) — conformance

- [ ] **TESTCAP01–04** Fixture matrix; scripting/native real-host E2E; failure/unknown/teardown; immutable SHA/AE/SDK/OS/plugin evidence. Depends on ae-test #19 and ae-devtools #11/#17/#18/#21 and ae-a8n #102.

### [ae-farm #4](https://github.com/ido-bata/ae-farm/issues/4) — optional future worker integration

- [ ] **FARMCAP01–04** Contract ownership decision; worker advertisement; scheduler refusal; remote host quarantine/non-interference. This is design-only until ae-test real-host gate passes. Do not overturn ae-farm README by assumption.

## Acceptance gate matrix

| Gate | Depends on | Cannot be claimed by |
| --- | --- | --- |
| Inventory complete for a specific version | #8–#11, source snapshot and drift check | A README claim or sample-only enumeration |
| Scripting executable | #13–#16, owned target, explicit permission, real AE evidence | Fake ES3 tests only |
| Native SDK reachable | #17–#19, ABI/plugin lifecycle and real AE evidence | One AEGP plugin or arbitrary JSON RPC wrapper |
| Local/remote transport ready | ae-a8n #97–#99/#102 | #98 fake dispatcher or console-local ping |
| Cross-repo verified | #21, ae-test #21, exact artifacts and host matrix | Unmatched npm/source SHA, missing AE/SDK build |
| Extension lifecycle verified | #36, owned AE session, per-OS evidence | Scaffold-only output or UXP beta assumption |
| Diagnostics collected | #37, source-position mapping where available | Unsourced error strings or fabricated positions |
| Agent loop proven | #38 on real host, #21 evidence schema | Fake-responder loop reported as real-host |
| Stable release | existing ae-a8n #63/#75, human authorization | This planning epic or a draft PR |

## Reconciliation checklist

- [ ] Source versions, symbol counts and competitor inventory independently verified.
- [ ] Proposed ADR decision promoted only after owner/evidence gates.
- [ ] Each child Issue's completion changes the catalog status but does not silently close other domains.
- [ ] New AE release or SDK header delta generates new inventory rows and follow-up Issues.
- [ ] No Issue is closed solely because this planning PR merges.
