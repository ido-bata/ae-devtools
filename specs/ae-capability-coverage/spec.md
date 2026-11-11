# Feature specification — AE capability coverage

- Status: **Proposed / planning**, not an implementation or release claim.
- Parent: [ae-devtools #6](https://github.com/ido-bata/ae-devtools/issues/6)
- Authority: [vision](../../docs/vision.md), [ADR-0001 (Proposed)](../../docs/architecture/ADR-0001-runtime-bridge.md), [Constitution](../../constitution/CONSTITUTION.md).
- Related execution contracts: [ae-a8n #97](https://github.com/ido-bata/ae-a8n/issues/97), [#98](https://github.com/ido-bata/ae-a8n/issues/98), [#99](https://github.com/ido-bata/ae-a8n/issues/99).
- Detail: [research](research.md), [plan](plan.md), [tasks](tasks.md), [capability contract](contracts/capability-catalog.md).

## Outcome

Enable developer-facing access to the complete **documented and practically reachable** After Effects operation surface: (A) functions evidenced in existing AE control tools, (B) the complete public AE scripting/ExtendScript object model, and (C) the complete public AE SDK, including AEGP suites, effect plug-in APIs and other native extension points. Consumers include VSCode/MCP development workflows, ae-a8n automation, ae-test verification and future ae-farm execution.

**Complete scope is a coverage obligation, not a claim that all APIs are callable as remote JSON RPC.** The SDK exposes host-owned callbacks, suite acquisition, render/threading and plug-in registration lifecycle; some capabilities are implemented by building/loading native plug-ins rather than by calling a host method. Record each public entry point, its lifecycle and a supported path to use/test it; classify inherently non-remotable, undocumented or unsupported cases with evidence instead of dropping them. Maintain a versioned universe, not an impossible claim to enumerate every tool ever written.

## User stories

- **US1 (P1) — Auditable universe.** A developer can query a versioned capability catalog, trace every item to an Adobe source or actual competitor implementation, and distinguish inventoried, implemented, fake-tested and real-host-verified coverage.
- **US2 (P1) — Script reachability.** A developer can inspect and, after explicit authorization, mutate the complete supported scripting object model through a bounded AE-host execution path; ES3, host object identity, permissions and version-dependent semantics are explicit.
- **US3 (P1) — Safe development loop.** An agent or VSCode user can inspect runtime state, run trusted development scripts, capture errors/results and verify changes without exposing one MCP tool per primitive or silently modifying an unrelated project.
- **US4 (P2) — Native SDK reachability.** A native developer can discover, compile, install/activate, exercise and verify SDK functions through an AEGP/effect/IO/custom UI/renderer plug-in harness or host-appropriate adapter, with ABI/version/threading restrictions recorded.
- **US5 (P1) — Shared consumer contract.** ae-a8n exposes capabilities through its existing public API and static named extension model; ae-test and future ae-farm can consume the same contract without copying host logic or weakening session/ownership rules.
- **US6 (P1) — Conformance and refusal.** A capability is reported available only on a proven host/AE build/plug-in set; unknown outcome, unsupported version, missing permission, wrong AE target and plugin absence produce distinct, testable outcomes.
- **US7 (P2) — Competitive parity.** When an existing AE-control tool implements a reachable operation not covered by the catalog, the gap is recorded and either mapped to an existing operation or given a concrete implementation/refusal ticket.

## Functional requirements

- **FR-01:** Maintain a reproducible, dated inventory of real AE-control tools, repositories and actual implemented operations (not README marketing claims), with links to source/commit/license and discovery method.
- **FR-02:** Enumerate the public Scripting API by version and domain: app/project, footage/items, comp/layer, property/keyframe/expression, effects/masks/shapes/text, render queue/output, files/preferences/menus/UI, undo/redo and error/runtime behavior. Track version additions, removals and behavioral differences.
- **FR-03:** Enumerate public SDK header suites/functions/types/callbacks and samples by SDK release: AEGP, PF/effect, SmartFX, MFR, render, GPU, IO, custom UI, arbitrary data, plugin registration/lifecycle, threading and platform ABI.
- **FR-04:** Each inventory entry has stable identity, source/version/license, category, read/write/effect class, host execution context, prerequisites, platform/version bounds, representation/serialization policy, risk, adapter path, availability and verification evidence.
- **FR-05:** Generated coverage reports distinguish **documented**, **reachable**, **implemented**, **automated/fake-tested**, **verified on real host**, **unsupported with reason**, and **unknown**. Neither partial implementation nor a green fake test yields 100% verified coverage.
- **FR-06:** A versioned capability handshake is queried before use; incompatible major versions, missing permissions, unavailable plug-ins, wrong host/session and unknown capabilities fail closed.
- **FR-07:** Host calls use bounded typed requests/results, per-operation identity/deadline, one-in-flight/serialization as required, explicit read/write permission and non-retry on unknown outcomes. Arbitrary runtime code execution is a separate privileged development action, never an implicit untrusted parameter.
- **FR-08:** Script adapters expose complete categories progressively and use host-specific object identity/snapshot semantics; no serialized object handle is assumed persistent across restart/undo/reorder without proof.
- **FR-09:** Native adapters run only in supported AE plug-in lifecycle contexts; the developer surface can build, load, inspect, invoke supported commands and test them. Never claim that raw SDK C callbacks can all be invoked by generic external JS.
- **FR-10:** Preserve ae-a8n's static named extension API, envelope/report/trace, explicit attach/owned/quit and local-vs-dedicated-host safety guarantees; transport adoption depends on #97–#99 and real-host evidence.
- **FR-11:** VSCode and MCP consume a shared core/metadata contract; the MCP surface remains a small development-loop interface, not a generated tool per layer/property operation.
- **FR-12:** Run version/OS-specific real AE conformance tests on disposable projects and packaged consumers, recording exact source SHA, AE/SDK version, OS, plugin build, session identity, traces and artifacts.
- **FR-13:** For unsupported, inaccessible or undocumented APIs, retain the inventory row, evidence and alternative/limitation; an explicit waiver or follow-up issue is required before excluding it from supported coverage.
- **FR-14:** Existing tool parity and API coverage are re-evaluated on a documented cadence or version update; a newly discovered API/tool creates a tracked delta rather than silently redefining 100%.

## Safety and nonfunctional requirements

- No unintended attach, quit, original-project mutation, duplicate execution, automatic Adobe/TCC consent or unsafe GUI recovery. Dedicated-host non-interference is not implied by local script execution.
- File/network permissions, code provenance, path traversal, symlink/ACL, same-user adversary, plug-in signing, code loading, SDK ABI and Adobe distribution terms must be threat-modeled per adapter.
- ES3 host restrictions and native thread/render callback restrictions are enforced or explicitly marked unsupported; render callbacks may not be blocked by external synchronous IPC.
- Host operations must report `not-sent`, `refused`, `completed`, `failed`, `unknown` with evidence. A timeout after possible dispatch is `unknown` and is never automatically retried.
- Compatibility is negotiated by capability + protocol version, not inferred from the AE marketing year or a single successful probe.
- No SDK headers or competitor code are copied into the repository without reviewing redistribution licenses; generated inventory may use identifiers and links subject to source terms.

## Acceptance / success metrics

1. Every discovered public scripting symbol and SDK entry point for **each explicitly supported release** is represented or explicitly excluded with a traceable reason; reports state denominator, exclusions, uncovered count and discovery timestamp. No unsupported version is called complete.
2. A repeatable parser/manual-review process catches removed, added or renamed API entries and competitor operations, and fails CI on unexplained catalog drift.
3. A minimal read-only host probe, then a disposable-project mutation, then one native plug-in lifecycle operation pass real AE tests **separately** on claimed Windows/macOS versions before their respective statuses are promoted.
4. ae-a8n, ae-test and other adopted consumers negotiate the same capability IDs and reject unsupported calls without bypassing their existing ownership, extension or release gates.
5. Every child Issue links task IDs, dependencies, a testable slice and evidence required to close. A future SDK suite/AE version cannot be marked complete by a blanket epic closure.

## Scope boundaries / decisions still open

- The full public operation universe is in scope; **private/unpublished Adobe internals, bypassing Adobe/OS restrictions, and unrestricted arbitrary remote C function invocation are not promised**. Investigate and document them as limitations.
- `ae-devtools` remains a developer platform, not a competing monolithic AE automation app. The owner explicitly expanded its operation reach; this does **not** authorize replacing its VSCode/MCP vision with a primitive-tool flood.
- [ADR-0001](../../docs/architecture/ADR-0001-runtime-bridge.md) proposes CEP + daemon for the devtools bridge; [ae-a8n ADR-0003 draft](https://github.com/ido-bata/ae-a8n/pull/100) evaluates an AE-internal dispatcher and separate isolation. Neither is a cross-repository Accepted transport decision. Reconcile through a dedicated ADR Issue.
- Exact AE version matrix, SDK versions, catalog generator, core language, packaging and SDK bridge form are selected only after inventory/real-host gates; no arbitrary assumptions in implementation.
- `ae-farm` currently explicitly disclaims a shared dependency with ae-devtools. Cross-project reuse is a **proposed contract** requiring a separate consumer decision, not an existing implementation.

## Existing evidence (read 2026-11-12)

- [ae-devtools vision](../../docs/vision.md), [ADR-0001](../../docs/architecture/ADR-0001-runtime-bridge.md), [bridge research](../../docs/architecture/ae-bridge-research.md) — design and experiments, not production proof.
- [ae-a8n static extensions](https://github.com/ido-bata/ae-a8n/blob/main/specs/isolated-ae/contracts/extensions.md) and [ADR-0003 draft](https://github.com/ido-bata/ae-a8n/pull/100) — existing contract and proposed transport direction.
- [ae-a8n #98](https://github.com/ido-bata/ae-a8n/issues/98) — read-only in-AE dispatcher fake tests only; Windows/macOS real-host evidence still required.
- [Adobe scripting documentation](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html); [community-maintained scripting reference](https://ae-scripting.docsforadobe.dev/); [community-maintained SDK reference](https://ae-plugins.docsforadobe.dev/). The latter two are **not Adobe-official mirrors** and require cross-checks against shipped headers and current Adobe docs.
