# Research — AE operation surface and evidence

- Status: **research baseline, not a complete API inventory**.
- Recorded: **2026-11-12**. This record describes repository state read at that date; external API claims below still require source-version and real-host verification.
- Owner: [ae-devtools #6](https://github.com/ido-bata/ae-devtools/issues/6). Execution-specific truth remains in the respective consumer repositories.

## 1. Current ecosystem and source-of-truth boundaries

| Repository | Observed state | Canonical authority / integration |
| --- | --- | --- |
| [ae-devtools](https://github.com/ido-bata/ae-devtools) | Early design/experiments; no shipped shared core, MCP, VSCode extension or complete bridge. Proposed [ADR-0001](../../docs/architecture/ADR-0001-runtime-bridge.md) considers CEP+daemon; [experiments/runtime-bridge](../../experiments/runtime-bridge/) has CEP/JSX/Node probes. | Vision, capability inventory/metadata, developer interface and shared contract. |
| [ae-a8n](https://github.com/ido-bata/ae-a8n) | Actual TS public API, ES3 host dispatcher, Windows/macOS transports, static named extensions and npm prerelease; [#97](https://github.com/ido-bata/ae-a8n/issues/97) / [#98](https://github.com/ido-bata/ae-a8n/issues/98) / [#99](https://github.com/ido-bata/ae-a8n/issues/99) hold proposed transport, read-only proof and product gates. | Host execution/ownership/security/consumer API. [New integration #102](https://github.com/ido-bata/ae-a8n/issues/102). |
| [ae-test](https://github.com/ido-bata/ae-test) | Runner, fake host, fixture and artifact contract; [#19](https://github.com/ido-bata/ae-test/issues/19) already owns static extension pass-through and unresolved real-host gate. | Conformance and evidence; [capability E2E #21](https://github.com/ido-bata/ae-test/issues/21). |
| [ae-farm](https://github.com/ido-bata/ae-farm) | README-only design. Queue/worker/isolation/artifacts planned; README explicitly says ae-devtools is a separate axis and **does not assume a shared dependency**. | Future optional contract reuse requires decision; [#4](https://github.com/ido-bata/ae-farm/issues/4). |
| [Ae_LayerNote](https://github.com/ido-bata/Ae_LayerNote) | CEP/JSX extension with an actual bridge implementation. | Potential adapter/conformance consumer; not an execution engine or SDK authority. |

### Existing decisions that must not be overwritten

1. [ae-devtools vision](../../docs/vision.md) distinguishes **developer tools** from a large list of low-level MCP automation primitives. A complete *underlying operation surface* is compatible with a small inspect/execute/verify MCP interface; no one-tool-per-property explosion.
2. [ae-devtools ADR-0001](../../docs/architecture/ADR-0001-runtime-bridge.md) is **Proposed** and contingent on real AE validation. Its CEP+daemon path is not a shipped dependency.
3. [ae-a8n ADR-0001](https://github.com/ido-bata/ae-a8n/blob/main/docs/adr/0001-bridge-transport.md) is **Accepted** for the current file-envelope OS-script transport; its current public contract is not superseded by ae-devtools research.
4. [ae-a8n ADR-0003 draft PR #100](https://github.com/ido-bata/ae-a8n/pull/100) proposes local/dedicated-host/experimental same-machine separation; [#98 / draft PR #101](https://github.com/ido-bata/ae-a8n/pull/101) is fake/automated read-only proof, **not** real-host verification.
5. [ae-a8n #99](https://github.com/ido-bata/ae-a8n/issues/99) requires bootstrap G0, local trust G1, API G2, dedicated host G3, consumer/release G4. [#63](https://github.com/ido-bata/ae-a8n/issues/63) / [#75](https://github.com/ido-bata/ae-a8n/issues/75) retain release authority.
6. [ae-a8n extension contract](https://github.com/ido-bata/ae-a8n/blob/main/specs/isolated-ae/contracts/extensions.md) is static/named/ES3 and refuses arbitrary runtime caller-supplied eval; native SDK adapters must not bypass it.

## 2. Evidence and source hierarchy

| Source | Use | Quality/limitation |
| --- | --- | --- |
| [Adobe After Effects scripts guide](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html) | Official execution/permission/user workflow reference | Official, but not a complete symbol inventory. |
| [AE scripting guide (docsforadobe)](https://ae-scripting.docsforadobe.dev/) | Class/member and version-index discovery | **Community maintained**; compare against official docs and running AE, not sole authority for newest versions. |
| [AE SDK guide (docsforadobe)](https://ae-plugins.docsforadobe.dev/) | SDK suites/callback taxonomy and samples | **Community maintained**; verify against actual Adobe SDK headers/release notes and SDK distribution terms. |
| Adobe-distributed AE SDK headers/samples for an exact release | Native symbol inventory, ABI, threading, plugin lifecycle | **Obtained locally for 26.5/macOS** (598-entry package, 42 headers under `Examples/Headers`); not yet exhaustively reviewed, and the Windows distribution is not obtained. Headers carry an `ADOBE CONFIDENTIAL` no-reproduction notice, so symbol-level output is not published — see the [persistence policy](contracts/capability-catalog.md). Do not copy SDK source. |
| [Adobe CEP Resources](https://github.com/Adobe-CEP/CEP-Resources), [Adobe CEP Samples](https://github.com/Adobe-CEP/Samples) | CEP bridge/lifecycle/version references | Official Adobe GitHub, host-version applicability requires testing. |
| [Adobe AE UXP announcement](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications) | Future host direction | Announcement is not evidence of AE UXP parity with ExtendScript or SDK. Treat AE UXP support in Nov 2026 as beta/provisional per ae-a8n #97 until independently verified. |
| [ae-devtools bridge research](../../docs/architecture/ae-bridge-research.md) and [research/](../../docs/architecture/research/) | CEP, debugger, socket/file bridge, event polling, security candidates | Historical research, with documented unverified real-AE claims and version corrections. |
| [ae-a8n code](https://github.com/ido-bata/ae-a8n/tree/main/src/api), [host](https://github.com/ido-bata/ae-a8n/tree/main/host) | Existing implemented operations and safety envelopes | Source and tests exist; real-host/packaged release evidence is per version and must not be generalized. |
| [BenZed/after-effects](https://github.com/BenZed/after-effects) | Existing external AE invocation precedent, cited by ae-a8n ADR-0001 | Candidate competitor; implementation/version/support must be re-verified in CAP001–004. |

**Unverified at this planning baseline:** exhaustive competitor list; exact Scripting API symbol count; exact SDK suite/function count; AE 2026/2027 per-feature support; any real-host SDK bridge; AE UXP production API parity. Do not publish numeric completeness percentages until CAP005–016 produces denominators, and do not publish any percentage at all until the supported-release set is recorded (§6.1 of the [plan](plan.md)).

**Locally observed 2026-11-12 (environment fact, not capability evidence):** After Effects 2026 (26.5.3) and 2027 (27.0.0) are installed on the macOS development host, and the AE SDK 26.5 macOS distribution is available locally. This makes the macOS side of #10 and #13 startable; it proves nothing about Windows, about SDK plug-in loading, or about any API's behaviour.

## 3. Capability families and execution routes

| Family | Likely execution context | Major limitation to record | Inventory issue |
| --- | --- | --- | --- |
| App/project/items/comps/layers/selection | ExtendScript in AE, optionally CEP/in-AE dispatcher | Host state and object handles can change; read vs write and explicit target identity | [#9](https://github.com/ido-bata/ae-devtools/issues/9), [#15](https://github.com/ido-bata/ae-devtools/issues/15) |
| Property/keyframes/expressions/text/shapes/effects | ExtendScript; effect plugin presence is runtime-dependent | Value kinds, interpolation, localization, plugin availability, undo | [#9](https://github.com/ido-bata/ae-devtools/issues/9), [#16](https://github.com/ido-bata/ae-devtools/issues/16) |
| Render queue/output/frame/IO/preferences/UI | ExtendScript, aerender, native plugin or host UI as appropriate | Blocking render, modal dialogs, file permissions, non-idempotent effects | [#16](https://github.com/ido-bata/ae-devtools/issues/16) |
| AEGP suites and host-managed handles | Compiled AE native AEGP plug-in | Suites/handles valid only in host and SDK lifetime; ABI and thread rules | [#10](https://github.com/ido-bata/ae-devtools/issues/10), [#17](https://github.com/ido-bata/ae-devtools/issues/17) |
| PF/Effect/SmartFX/MFR/GPU callbacks | Compiled Effect plug-in executing inside AE render lifecycle | Host callbacks/selectors cannot generally be arbitrary external RPC; thread safety, GPU device and host scheduling | [#10](https://github.com/ido-bata/ae-devtools/issues/10), [#18](https://github.com/ido-bata/ae-devtools/issues/18) |
| SDK IO, custom UI, arbitrary data, other public extension points | Native plug-in/harness in specific lifecycle | Registration, UI thread, buffer ownership, plug-in build/load/signing | [#19](https://github.com/ido-bata/ae-devtools/issues/19) |
| CEP/UXP/OS automation/aerender | Transport, panel or CLI layer | Transport is not an automatic expansion of underlying scripting/SDK API; host/version/consent differences | [#12](https://github.com/ido-bata/ae-devtools/issues/12), [#13](https://github.com/ido-bata/ae-devtools/issues/13) |

## 4. Competitor parity discovery protocol (CAP001–004)

For each candidate tool, capture: project URL, exact commit/release, license, last observed activity, supported AE/OS versions, actual source path implementing each operation, host execution route, parameter/result type, side-effect classification, and a reproducible minimal invocation. Normalize semantic operations to catalog IDs; do **not** count multiple wrappers as distinct Adobe APIs.

Sources to examine first: [existing ae-devtools research 04](../../docs/architecture/research/04-process-architecture.md), [ae-a8n ADR-0001](https://github.com/ido-bata/ae-a8n/blob/main/docs/adr/0001-bridge-transport.md), AE MCP repositories discovered through GitHub code/repository search, Adobe SDK samples and publicly available CEP/UXP plugins. Search must be periodically repeatable; a closed-source product is tagged `claimed/unverifiable` until independently reproduced.

## 5. Explicit research gates

- **R1:** Official/current Adobe documentation and exact SDK headers reviewed with release-specific source links. Missing docs do not imply missing capability.
- **R2:** Real AE probe in both Windows/macOS against the exact claimed build; record project, ownership, AE/SDK versions, source SHA and traces.
- **R3:** SDK native AEGP/effect build/load/test and thread/lifecycle evidence; one successful plug-in does not verify all suites.
- **R4:** Runtime/transport security and startup G0–G4 from ae-a8n #99; no cross-user/console fallback, unsafe quit or consent automation.
- **R5:** Cross-repo consumer evidence from ae-test and (when ready) ae-farm, tied to exact packaged artifacts.

## 6. Follow-up questions that must remain open

- What exact Adobe SDK releases, license conditions, toolchains, plugin signing and AE builds are available on each host?
- Can an AEGP or effect plug-in safely expose a command/telemetry surface for the targeted suite, or is a build-test-only harness required?
- Which CEP/UXP versions and API surfaces are verified in AE 2026/2027, rather than assumed from other Adobe products?
- Which SDK callbacks are host-initiated only, and which suite operations may run from explicit user commands? Per-entrypoint answer required.
- How will cross-repo capability schema be distributed without creating a mandatory ae-devtools runtime dependency in ae-farm?
