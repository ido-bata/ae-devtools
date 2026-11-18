# Tasks — AE capability coverage (Spec Kit)

- Parent: [ae-devtools #6](https://github.com/ido-bata/ae-devtools/issues/6); draft plan [PR #7](https://github.com/ido-bata/ae-devtools/pull/7).
- Canonical requirements: [spec.md](spec.md). Architecture and gates: [plan.md](plan.md). Catalog shape: [contracts/capability-catalog.md](contracts/capability-catalog.md).
- **This is a planning inventory.** Creating an Issue is not implementation; checkboxes record evidence-backed completion (see Delivery rule). Child Issue owns exact acceptance, affected files, dependencies and evidence. Task IDs are stable within this feature; do not reuse ae-a8n's existing T001–T108.

## Delivery rule

One independently reviewable Issue/PR per implementation slice. No speculative native bridge before #17/#18 proof. For SDK suite families not implementable in one slice, #19 creates additional tracked Issues, preserving the full public SDK denominator. Fake tests do not satisfy real-host gates.

Checkboxes track evidence-backed completion at the level recorded inline next to each CAP: a CAP is checked when its deliverable exists and its declared evidence level (fake / real-host / etc.) is met, with any residual acceptance noted inline. A checked CAP under an Issue that stays open for other CAPs or higher-level acceptance is **not** real-host or release verified — the inline note and the section Status line carry that distinction. Section Status lines mirror the linked GitHub Issue state — they are not a substitute for it.

### [#8](https://github.com/ido-bata/ae-devtools/issues/8) — Tool parity research

Dependencies: none. Status: **closed — research delivered** (`inventories/tools/` snapshot + generated parity data; Issue closed). Ongoing parity deltas are handled by inventory regeneration, not by this Issue staying open.

- [x] **CAP001** Discover and snapshot AE control tools with commit/license. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))
- [x] **CAP002** Extract real implemented operations from source. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))
- [x] **CAP003** Normalize operation IDs and compare existing repo surfaces. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))
- [x] **CAP004** Record ongoing discovery and parity delta process. ([Issue #8](https://github.com/ido-bata/ae-devtools/issues/8))

### [#9](https://github.com/ido-bata/ae-devtools/issues/9) — Scripting inventory

Dependencies: none. Status: **closed — research delivered** (`inventories/scripting/` generated typings + `sources.lock.json`; Issue closed). Unsupported/unknown symbols continue under #70 triage.

- [x] **CAP005** Extract public scripting classes/methods/properties/enums. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))
- [x] **CAP006** Record AE/ExtendScript version and OS deltas. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))
- [x] **CAP007** Classify ES3/handle/undo/UI/permission constraints. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))
- [x] **CAP008** Cross-check Adobe references vs community docs and live AE. ([Issue #9](https://github.com/ido-bata/ae-devtools/issues/9))

### [#10](https://github.com/ido-bata/ae-devtools/issues/10) — SDK inventory

Dependencies: none. Status: **closed — research delivered** (`inventories/sdk/` header extraction + `constraints.md` + coverage matrix; Issue closed). SDK redistribution rules keep per-symbol detail build-time derived.

- [x] **CAP009** Record SDK releases, headers, samples, hashes and license. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))
- [x] **CAP010** Extract suites, functions, selectors, callbacks and types. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))
- [x] **CAP011** Classify external command vs host lifecycle vs unsupported. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))
- [x] **CAP012** Record ABI, MFR, GPU, thread, signing and OS constraints. ([Issue #10](https://github.com/ido-bata/ae-devtools/issues/10))

### [#11](https://github.com/ido-bata/ae-devtools/issues/11) — Catalog and schema

Dependencies: #8, #9, #10. Status: **closed — catalog + drift gate merged** (`packages/capability-catalog`, automated test).

- [x] **CAP013** Define stable IDs, provenance, execution and evidence schema, distinguishing rows persisted in the repository from rows supplied at build time (SDK symbols). ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))
- [x] **CAP014** Import and dedupe scripting/SDK/tool inventories. ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))
- [x] **CAP015** Generate coverage denominators and drift/false-green gates; a report produced without SDK-derived input reports `unknown`, not "no drift". ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))
- [x] **CAP016** Add versioned capability handshake and refusal tests; absence of a row in the repository must not be reported as absence of the capability. ([Issue #11](https://github.com/ido-bata/ae-devtools/issues/11))

### [#12](https://github.com/ido-bata/ae-devtools/issues/12) — Cross-repo ADR

Dependencies: #8–#10 initial; ae-a8n #97–#99. Status: **closed — ADR-0005 recorded as Proposed** (`docs/architecture/decisions/ADR-0005-*.md`); promotion gates (real-host evidence, ae-a8n #97–#99) remain open upstream.

- [x] **CAP017** Reconcile ae-devtools ADR-0001 with ae-a8n ADR-0003. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))
- [x] **CAP018** Compare CEP, in-AE JSX, UXP, native and CLI routes. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))
- [x] **CAP019** Define trust, serialization, lifecycle and repo ownership. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))
- [x] **CAP020** Record decision/evidence/owner gates and alternatives. ([Issue #12](https://github.com/ido-bata/ae-devtools/issues/12))

### [#13](https://github.com/ido-bata/ae-devtools/issues/13) — Read-only AE probe

Dependencies: #12; ae-a8n #98. Status: **closed — read-only probe merged** (`experiments/read-only-probe`; verified on real host for read-only ops).

- [x] **CAP021** Prove AE host version/ping and target identity. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))
- [x] **CAP022** Define runtime snapshot and handle invalidation rules. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))
- [x] **CAP023** Test missing/wrong/busy/timeout/reconnect failure paths. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))
- [x] **CAP024** Capture real-host OS/AE/CPU/latency/trace evidence. ([Issue #13](https://github.com/ido-bata/ae-devtools/issues/13))

### [#14](https://github.com/ido-bata/ae-devtools/issues/14) — Script runtime

Dependencies: #11, #12, #13. Status: **open — pipeline merged, coverage expansion pending** (`packages/ae-devtools-cli/trusted-execution`: codec/permissions/outcomes/mutation-guard/runner, automated test + fake/mock). Real-host dispatch itself is verified via the #49/#52 runs; remaining work is broader real-host coverage, not the pipeline.

- [ ] **CAP025** Separate read-only/write/trusted-dev-script permissions. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))
- [ ] **CAP026** Implement ES3 codec, values, errors and source map. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))
- [ ] **CAP027** Guard writes with identity, intent and non-retry policy. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))
- [ ] **CAP028** Test undo/timeout/late result/unknown outcomes. ([Issue #14](https://github.com/ido-bata/ae-devtools/issues/14))

### [#15](https://github.com/ido-bata/ae-devtools/issues/15) — Scripting DOM A

Dependencies: #9, #11, #14. Status: **open — metadata + registry merged** (domain coverage metadata, automated test + fake/mock). Registry now carries 26 ops incl. read-side inspection ops (`read.compLayers`/`layerDetail`/`propertyValue`/`keyframes`/`renderQueueStatus`/`itemDetail`, Issue #254) at adapter-present + fake-verified level; real-host execution remains UNVERIFIED.

- [ ] **CAP029** Map project/item/footage/import/save symbols to adapters. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))
- [ ] **CAP030** Map comp/layer/parent/selection/timing symbols. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))
- [ ] **CAP031** Test object identity, duplicate names and invalidation. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))
- [ ] **CAP032** Track uncovered and version-limited symbols. ([Issue #15](https://github.com/ido-bata/ae-devtools/issues/15))

### [#16](https://github.com/ido-bata/ae-devtools/issues/16) — Scripting DOM B

Dependencies: #9, #11, #14, #15. Status: **open — domain coverage metadata merged** (animation/effects/render, automated test + fake/mock). Real-host execution UNVERIFIED.

- [ ] **CAP033** Map property/keyframe/expression/text/shape/mask. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))
- [ ] **CAP034** Map effects/parameters and plugin availability. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))
- [ ] **CAP035** Map render/output/IO/menu/preferences with constraints. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))
- [ ] **CAP036** Test locale, value kind, render and failure cases. ([Issue #16](https://github.com/ido-bata/ae-devtools/issues/16))

### [#17](https://github.com/ido-bata/ae-devtools/issues/17) — AEGP native proof

Dependencies: #10, #11, #12, #13. Status: **open — SDK facts + minimal read-only AEGP build probe merged** (macOS build probe only). Plugin load/lifecycle proof pending; host-process ownership boundary stays ADR-0005 R3 Open.

- [ ] **CAP037** Select reproducible SDK/ABI/toolchain/license. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))
- [ ] **CAP038** Build and load minimal read-only AEGP plugin. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))
- [ ] **CAP039** Prove safe host command boundary and response. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))
- [ ] **CAP040** Record install/restart/unload/crash/version proof. ([Issue #17](https://github.com/ido-bata/ae-devtools/issues/17))

### [#18](https://github.com/ido-bata/ae-devtools/issues/18) — Effect SDK proof

Dependencies: #10, #11, #12, #17. Status: **open — spike.** Effect/SmartFX/MFR/GPU callback execution path not proven; GPU work blocked on GPU SDK addendum + Boost (see Issue comments for the AE 27.0 SDK delta survey).

- [ ] **CAP041** Map PF selectors, UI, sequence/arbitrary data. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))
- [ ] **CAP042** Build/load/render one real Effect SDK plugin. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))
- [ ] **CAP043** Design SmartFX/MFR/GPU/callback lifecycle tests. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))
- [ ] **CAP044** Capture render/artifact/CPU-GPU and negative evidence. ([Issue #18](https://github.com/ido-bata/ae-devtools/issues/18))

### [#19](https://github.com/ido-bata/ae-devtools/issues/19) — Native SDK expansion

Dependencies: #10, #11, #17, #18. Status: **open — coverage matrix + adapter negotiation contract merged** (`packages/native-adapter`, automated test). CAP047 decomposition registered as #63–#70 — open deliverables, not completed coverage.

- [ ] **CAP045** Generate suite-family host lifecycle coverage matrix. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))
- [ ] **CAP046** Build adapter/fixture/build-test templates. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))
- [ ] **CAP047** Split uncovered suite families into independent Issues. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))
- [ ] **CAP048** Verify every public SDK entrypoint has explicit status. ([Issue #19](https://github.com/ido-bata/ae-devtools/issues/19))

#### CAP047 decomposition (recorded 2026-11-15, branch `19`)

Rationale: the coverage matrix's five classes are extractor **reporting buckets**, not capabilities; decomposition is therefore by header/suite cluster, not by class. Clusters were chosen coarse enough to be real tickets and fine enough to map to `packages/native-adapter/src/operations.ts` registry entries. Per-symbol detail cannot be committed (SDK redistribution rules, `inventories/sdk/README.md`), so each child Issue scopes by suite/header and requires per-entry evidence flags.

| Child Issue | Cluster | Matrix classes touched | Primary dependency |
| --- | --- | --- | --- |
| [#63](https://github.com/ido-bata/ae-devtools/issues/63) | AEGP project & item suites (`AE_GeneralPlug*.h`) | external-command | #17 |
| [#64](https://github.com/ido-bata/ae-devtools/issues/64) | AEGP comp/layer/render-queue/output-module suites | external-command | #17, #63 |
| [#65](https://github.com/ido-bata/ae-devtools/issues/65) | AEGP utility & misc suites (hash/channel/compute-cache/cache-on-load) | external-command | #17, #63/#64 |
| [#66](https://github.com/ido-bata/ae-devtools/issues/66) | PF/Effect CPU commands, custom UI, sequence/arbitrary data | in-host-plugin-command, host-callback | #18 (CAP041–043) |
| [#67](https://github.com/ido-bata/ae-devtools/issues/67) | IO/import-export/pixel-format suites (`AE_IO*`, `PR_Public`, `PT_Public`, `FIEL_Public`) | in-host-plugin-command, unsupported-or-unknown | #19 |
| [#68](https://github.com/ido-bata/ae-devtools/issues/68) | GPU/SmartFX/MFR + host-callback lifecycle | host-callback, external-command | #18 CAP043; **blocked** on GPU SDK addendum + Boost |
| [#69](https://github.com/ido-bata/ae-devtools/issues/69) | PICA/SP plug-in runtime suites (`SP/*`) | external-command, host-callback | #17 |
| [#70](https://github.com/ido-bata/ae-devtools/issues/70) | unsupported/unknown triage (534 pure-data-type, 13 unattributed-callable, 5 reserved-selector) | unsupported-or-unknown | #19; review, not implementation |

CAP047 is left **unchecked**: the decomposition exists and is tracked, but the child Issues are open deliverables, not completed coverage. Re-derivation path: `inventories/sdk/generated/aggregate.coverage-matrix.json` `headers[].byClass` + `inventories/sdk/README.md` kind/class tables + `inventories/sdk/constraints.md`.

### [#20](https://github.com/ido-bata/ae-devtools/issues/20) — VSCode/MCP developer interface

Dependencies: #11–#15. Status: **open — dev-loop core + MCP tools merged** (`dev-loop/`, `mcp-server/`; automated test + fake/mock, packaged in `@ido-bata/ae-devtools-cli`). VSCode extension scaffold + diagnostics surface + debugger-attach commands merged (`vscode-extension/`; PRs #159–#161, fake level; `vsce package` produces an installable VSIX), plus the `vscode-debugger/` attach-config generator and preflight checks (fake level). Real-editor acceptance and a8n-session acceptance remain release-candidate items.

- [ ] **CAP049** Expose shared discovery/session/API metadata. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))
- [x] **CAP050** Implement VSCode run/inspect/diagnostic vertical slice. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20)) — fake-level verified; real-editor acceptance pending
- [x] **CAP051** Define minimal MCP inspect/execute/verify interface. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))
- [x] **CAP052** Audit explicit consent and privileged SDK/script operations. ([Issue #20](https://github.com/ido-bata/ae-devtools/issues/20))

### [#21](https://github.com/ido-bata/ae-devtools/issues/21) — Conformance/evidence

Dependencies: #8–#20; ae-a8n #97–#99; ae-test #19. Status: **open — conformance record + layer-2 claim gate + release gate wiring merged** (`src/conformance.ts` PR #146, `src/release-gate.ts` + `release-scope.json` + `evidence/conformance/` PR #148, release-PR CI job PR #149). Gate verdict semantics and release-acceptance connection are recorded in `docs/release.md` §conformance gate (no-claims ≠ pass ≠ usability proof; supportedRelease stays an owner decision; unverified platforms are never claimed to force a block). First verified-real-host evidence recorded: `evidence/conformance/run-2026-11-18-ae2026-a8n-020/` and `run-2026-11-18-ae2026-a8n-021/` — 9 scripting claims PASS on macOS arm64 / AE 26.5.3x9 / ae-a8n 0.2.0 tarball each (020 via the direct a8n-transport harness, 021 additionally exercising the MCP stdio + CLI doctor paths), sourceSha `f6cfbdff` (Issue #177, PR #178); `real-host-claims.json` feeds the release gate claim set. Remaining: native/security conformance lanes, Windows matrix (UNVERIFIED), ae-test/farm binding, and the supportedRelease owner decision (plan §6.1).

- [x] **CAP053** Define real-host fixture and immutable evidence manifest. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21)) — disposable-project harnesses (`conformance/real-run.mjs`, `mcp-real-run.mjs`, PR #177) + `ae-devtools.conformance-record/v1` with `artifactHashes` same-bytes verification
- [ ] **CAP054** Run script/native/transport/security conformance. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21)) — partial: 9 scripting claims verified-real-host PASS (darwin/AE2026, run-2026-11-18); native / transport / security lanes and non-darwin platforms not yet run
- [ ] **CAP055** Bind ae-a8n/ae-test/farm evidence to exact SHA. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21)) — partial: record binds `sourceSha` + ae-a8n 0.2.0 tarball hash; ae-test / farm evidence not yet bound
- [x] **CAP056** Reject stale/fake-only/unknown coverage release claims. ([Issue #21](https://github.com/ido-bata/ae-devtools/issues/21)) — gate semantics + acceptance rules in `docs/release.md` §conformance gate

### [#36](https://github.com/ido-bata/ae-devtools/issues/36) — CEP/UXP extension lifecycle

Dependencies: #11, #13. Status: **open — CEP scaffold/validate + lifecycle devkit merged** (`cep-extension/`; static/fake level, `loadProof` always NOT RUN). Real panel load → evalScript → reload → unload proof (CAP059) pending an owned-session run; UXP stays BLOCKED/UNVERIFIED per ADR-0005 D5. Registered 2026-11-14; extension *development* lifecycle is a distinct axis from transport selection (ADR-0005 D5).

- [ ] **CAP057** Generate CEP extension scaffolds (manifest.xml, CSXS version, host version range, debug-load configuration) from inventory and Adobe-official specs. ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))
- [ ] **CAP058** Mechanize CEP panel build/install/reload/unload/cleanup per OS; record `.zxp` signing, `PlayerDebugMode` and registry/plist handling. ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))
- [ ] **CAP059** Prove panel load → `CSInterface.evalScript` round trip → reload → unload on an owned AE session only. ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))
- [ ] **CAP060** Track UXP plugin development lifecycle as BLOCKED/UNVERIFIED per row until Adobe released builds provide plugin loading and remote IPC; beta adoption stays forbidden (ADR-0005 D5). ([Issue #36](https://github.com/ido-bata/ae-devtools/issues/36))

### [#37](https://github.com/ido-bata/ae-devtools/issues/37) — Unified AE diagnostics

Dependencies: #14, #15, #16, #17, #18, #36. Status: **open — schema + collector registry + sourcemap resolution merged** (`diagnostics/`; automated test + fake/mock, wired into CLI execute/verify evidence and the VSCode Problems surface); recovery-orchestrator verdicts → diagnostics records merged (`recovery-orchestrator/diagnostics.mjs`, PR #156). native-crash / CEP-log collectors await the ae-a8n #107–#109 publish. Registered 2026-11-14.

- [x] **CAP061** Define the diagnostics record schema (source kind, severity, source position, session/target pin, artifact hash). ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))
- [x] **CAP062** Connect ExtendScript exceptions, expression errors and render-queue failures to the host-side collection path via the trusted-execution codec. ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37)) — fake-level; real-host path rides the same codec
- [ ] **CAP063** Investigate and adapt collection of CEP/UXP panel logs, AE plug-in load failures and OS crash reports; unreachable sources are `unsupported-with-reason`. ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))
- [x] **CAP064** Implement diagnostics→source-position mapping (generated JSX / panel asset / plugin binary) with fake-responder tests. ([Issue #37](https://github.com/ido-bata/ae-devtools/issues/37))

### [#38](https://github.com/ido-bata/ae-devtools/issues/38) — Agent development-loop E2E

Dependencies: #14, #20, #21, #37. Status: **open — agent-loop merged + loop evidence serialization merged** (`agent-loop/`; fake/mock level, packaged library; `evidence.mjs` emits `ae-devtools.agent-loop-evidence/v1`, `evidenceLevel` accepts only `"fake"` — PR #151). Joined TS→JSX→execute→diagnostics→source-map→fix→rerun→regression chain with boundary coverage (UNKNOWN, timeout, consent denial, state fingerprint regression) merged as one fake-level fixture + evidence chain (PR #162). Real-host promotion of error→fix→rerun→regression awaits a contract-satisfying ae-a8n publish and release-candidate real-device acceptance. Registered 2026-11-14.

- [ ] **CAP065** Prove the minimal loop on an owned AE session: intentionally broken JSX fixture → execute → diagnostics with source position → fix → re-run → PASS, scripting only first. ([Issue #38](https://github.com/ido-bata/ae-devtools/issues/38)) — fake-level chain proven (PR #162); owned-session proof pending
- [x] **CAP066** Bind loop evidence (per-iteration request/result/diagnostics/regression artifacts) to the #21 conformance evidence schema; fake-only success never promotes to real-host verified. ([Issue #38](https://github.com/ido-bata/ae-devtools/issues/38))

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
