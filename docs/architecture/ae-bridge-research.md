# AE Bridge Research — Consolidated Record

> Synthesis of `docs/architecture/research/01-execution-surface.md`,
> `02-cep-deep-dive.md`, `03-state-events.md`, `04-process-architecture.md`,
> `05-security.md`. All five files are dated 2026-09-18 and this synthesis
> inherits that date. No real-AE testing has been performed; every claim
> about AE 25.x behavior under load remains unverified in the source files.

---

## Scope and methodology

### What was researched

The five research files cover four threads, plus one orthogonal thread that the synthesis pulls forward because it constrains every decision below:

1. **Execution surface** (01) — how an external tool can invoke ExtendScript inside a running After Effects and observe its results. The candidates surveyed are CEP `CSInterface.evalScript`, the Adobe VSCode ExtendScript Debugger, CEP with Node.js enabled, standalone ExtendScript (ESTK lineage), UXP Scripting (AE 25.0+), and AEX native plugins (explicitly excluded from scope).
2. **CEP capabilities and constraints** (02) — the Adobe-blessed panel runtime that hosts ExtendScript bridges. Covers CEP 12's CEF 99 / Chromium 99 / Node.js 17.7.1, the `cep_node` global, network and IPC capabilities, lifecycle, signing, the absence of background mode, and debugger integration via CDP.
3. **Runtime state and events** (03) — what AE exposes for live introspection. Documents the `app` → `project` → `Item` → `Layer` → `PropertyGroup` → `Property` attribute chain, the absence of project-state events, the handle-vs-snapshot distinction, and the recommended path-based stable identifier format.
4. **Process architecture** (04) — the candidate process topologies for an external tool. Surveys Adobe's VSCode debugger pattern (single Node process + native addon), three community AE bridges (Dakkshin / a-y-ibrahim file-polling, hodor WebSocket, Premiere Pro MCP's two-tier), and three candidate architecture options (native, daemon+CEP, CEP-as-server).
5. **Security threat model** (05) — what an `eval`-capable local daemon must defend against. Pulls forward here because it constrains the IPC contract shape, not just the implementation.

### What was not researched

- **Real-AE behavior under load.** Every source file is explicit: every Adobe-internal wire detail, every callback-threading question, every main-thread contention scenario, every multi-instance port allocation rule, and every Apple Silicon / Linux behavior of the native addon needs verification on a live AE instance. The research environment did not include a running AE 25.x; no empirical timings, no live `evalScript` traces, no observed crashes are recorded.
- **UXP Scripting API surface for AE.** Adobe has published UXP scripting reference for Photoshop and is rolling out UXP for AE in 25.0+; the AE equivalent is not yet a public, versioned reference. The research treats AE UXP scripting as "exists since 25.0, surface undocumented" and does not attempt to characterize its shape.
- **MCP tool enumeration.** The vision document explicitly disclaims `createLayer` / `moveLayer` / `setPosition` style primitives; the research did not enumerate MCP tools, and this synthesis does not pre-decide that surface either.
- **LSP protocol details, TypeScript type generation, expression editor UX, frame capture, visual verification, marketplace distribution, branding, Rust-vs-TypeScript final choice.** All of these were intentionally excluded from the research surface and from this synthesis; each belongs to a later decision.

### The no-AE caveat

Every claim in the five research files that touches AE 25.x behavior — `evalScript` callback threading, render-queue contention, multiple-instance port allocation, `app.scheduleTask` repeat granularity, `CSInterface` availability inside ExtendScript, UXP scripting parity with `app.project` — is explicitly marked **unverified** in the source. The synthesis inherits that caveat verbatim. Any decision below is *provisional on real-AE validation*; the ADR that follows this record carries Status: Proposed for the same reason.

### Source-quality rules inherited from the research files

- Adobe-official sources (`developer.adobe.com`, `raw.githubusercontent.com/Adobe-CEP`, `helpx.adobe.com`) are treated as authoritative.
- Community-maintained Adobe mirrors (`extendscript.docsforadobe.dev`, `ae-scripting.docsforadobe.dev`, `theiviaxx.github.io/photoshop-docs`) are treated as faithful to Adobe originals but flagged as third-party.
- Pre-2022 third-party blog posts are flagged when relied on (CEP 9 and earlier did not have `--enable-nodejs`, so older guides do not transfer cleanly to CEP 12).
- Items that could not be verified from current public documentation are listed in §Unverified items at the end of this document.

---

## Candidate mechanisms

The union of mechanisms considered across the five research files. Verdict column reflects this synthesis's reading, not a prior commitment — anything marked "deferred" surfaced as a candidate but did not have enough evidence to adopt now.

| # | Mechanism | Source file | Verdict | Why |
|---|---|---|---|---|
| M1 | CEP 12 panel + `CSInterface.evalScript` (top-level frame, JSON-serialized payloads) | 01, 02 | **Adopted** | Only Adobe-documented AE-side runtime that gives `app.*` access from a stable, code-driven process; works in AE 25.0 with CEP 12; the only viable bridge layer today. |
| M2 | CEP 12 panel with Node.js enabled (`--enable-nodejs`) | 01, 02 | **Adopted (conditional)** | Needed only when the panel itself must open outbound sockets (e.g., binding a port). Adopt when M1 needs networking; otherwise the daemon (M3) carries networking instead. |
| M3 | External daemon (Node.js or equivalent) outside AE, owning the IPC surface | 04 | **Adopted** | Matches vision.md "shared core / daemon" image; gives headless testability, crash isolation, and a stable contract for VSCode and MCP front-ends. |
| M4 | VSCode ExtendScript Debugger native addon (`esdcorelibinterface.node` / `ESCoreLib`) | 01, 04 | **Rejected (for v1)** | Platform coverage Windows + macOS x64 only; the two legacy `extendscript-debug*` repos return 404 (the `Adobe-CEP` org itself is not archived — see research/corrections-01); source not directly verifiable from Adobe's own repos. Keep as a future escape hatch if M1+M3 prove insufficient on a particular host. |
| M5 | WebSocket bridge via CEP-Node (panel as server, no external daemon) | 04 | **Rejected (for v1)** | Pushes every dependency into CEP-Node 17.7.1 with all the module-loading fragility that implies; makes the panel a single point of failure. Revisit if M3's external daemon proves heavier than expected. |
| M6 | File-polling bridge (`ae_command.json` / `ae_mcp_result.json` + `app.scheduleTask`) | 04 | **Rejected (for v1)** | Lowest implementation complexity but second-scale latency and no push. Re-introduce as a degraded fallback when WebSocket cannot bind (port collision, firewall), not as the default. |
| M7 | ExtendScript `Socket` listener (AE startup-scripts folder, no panel) | 02, 04 | **Rejected (for v1)** | AE's startup-scripts folder is the documented way to make ExtendScript run at launch; `Socket` is plain TCP only with no documented auth. The CEP panel pattern subsumes this without giving up AE's signing model. Revisit only if a "panel-less" mode is ever needed. |
| M8 | UXP Scripting (AE 25.0+) | 01, 02, 04 | **Deferred** | Adobe's forward direction; AE-side UXP Scripting API surface is not yet a public, versioned reference. Revisit when Adobe publishes the surface or when ExtendScript's deprecation timeline clarifies. |
| M9 | VSCode ExtendScript Debugger used as an SDK (DAP as a library) | 01, 04 | **Rejected** | Adobe ships it as a debugger, not as a programmatic execution surface; "silent eval" endpoints are thin; same constraints as M4 plus the DAP coupling. |
| M10 | AEX / native plugin (C++) | 01 | **Rejected (out of scope)** | `vision.md` is explicit that this is the AE-internal-scripting-development side, not the AE-plugin side. |

The synthesis adopts **M1 + M3** as the v1 baseline, with **M2** as a conditional inside M1 and **M6** reserved as a degraded fallback. M8 is parked as deferred.

---

## Decision points

The five judgment points the user asked answered. Each is summarized here; the ADR carries the binding decisions and the evidence each one rests on.

### 1. AE-side Bridge first candidate

**CEP 12 panel + `CSInterface.evalScript`**, with `--enable-nodejs` enabled when the panel itself must reach out (e.g., to the daemon). This is the only Adobe-documented path that gives the project full access to AE's Scripting object model from a stable, code-driven runtime. The CEP 12 Cookbook is the authoritative source; Adobe's design here (in-process bridge, no network endpoint) means the *only* trust boundary the AE-side component has to defend is its own JavaScript context — see research 05 §T5 (CEP panel compromise) and §T12 (`evalScript` is in-process, not a network endpoint).

UXP Scripting is parked as a deferred alternative — not because it is wrong, but because its AE-side API surface cannot yet be characterized.

### 2. Boundary placement between AE Bridge and external tool

The bridge terminates **inside AE**: every ExtendScript call is made by JS running in the CEP panel, every result is JSON-serialized at that boundary, and no AE handle ever leaves AE. External tools (VSCode, MCP, future CLI) never read or call AE's Scripting API directly; they speak only to the daemon's IPC contract.

The boundary is sharp on three axes:

- **Serialization**: payloads are JSON at the AE side; complex AE objects are flattened by ExtendScript `JSON.stringify` before they reach `CSInterface.evalScript`'s callback.
- **Identity**: identifiers crossing the boundary are path-based (`{projectPath}::{compName}::{layerIndexOrName}::{propertyPath}`), not handle-based. `layer.id` is exposed by AE but not documented as persistent across Save → Quit → Reload.
- **Execution surface**: the daemon exposes a single privileged execution primitive (working name `eval`) plus a closed set of typed read-only verbs (working family `inspect_*`). All `CSInterface.evalScript` calls funnel through one chokepoint module.

### 3. Whether a daemon is needed

**Yes.** Three independent reasons converge:

- CEP has no background / invisible mode (research 02 §Background); a CEP-only design cannot survive AE restart or the panel being closed.
- Both VSCode and MCP front-ends must access the same AE session concurrently; the daemon is the single connection-multiplexer to AE's single ExtendScript engine.
- The vision document's "shared core / daemon" intent (vision.md §shared core を持つ理由) is the architectural anchor; without a daemon, that separation collapses into either a duplicated bridge or a duplicated AE-side component.

### 4. Request/response vs job-based model

**Request/response by default**, with the IPC contract reserving room for a future subscription channel. Rationale:

- AE's Scripting API is attribute-driven (research 03 §Snapshot introspection) and naturally maps to synchronous-ish "give me the current state of X" calls; `evalScript` already returns the value at the end of the script via the panel callback.
- Job-based semantics are valuable for long-running operations (rendering, batch edits); these should be opt-in per-call, not the default contract.
- The agent's loop is human-paced, not real-time (vision.md §MCP Server の方向性); the latency target for v1 is set by the development cadence, not by a pre-decided poll rate.

The contract's request shape must be identical for `list` (snapshot now) and `subscribe` (future); v1 implements only `list`.

### 5. Whether to include event sync in initial design

**Defer.** AE exposes no project-state event API (research 03 §Change events — the AE scripting guide has no `addEventListener` on `app`, `project`, `comp`, or `property`). The only way to detect selection / active-comp / property changes today is ExtendScript-side `app.scheduleTask` polling that pushes a `CSEvent` back to the panel. That mechanism is real and well-documented, but it is also AE-main-thread work, has a known modal-dialog pause (research 03 §app.scheduleTask caveats), and competes with `evalScript` calls.

The recommendation: **ship request/response in v1; reserve `subscribe` in the contract without implementing it**. This keeps the boundary honest (the user can ask; the bridge doesn't claim to push) and avoids building a change-detection system on top of an AE version whose polling behavior has not been measured.

---

## Evidence index

All URLs cited across the five research files, consolidated. All access dates are **2026-09-18** unless otherwise noted. Duplicates across files are listed once.

### Adobe official

- `raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md` — CEP 12 Cookbook (raw GitHub). `evalScript` signature, main-thread execution, Node.js 17.7.1, CORS / CSP enforcement, signing, `PlayerDebugMode`, debug port, Browser Features table.
- `github.com/Adobe-CEP/CEP-Resources` — Authoritative CEP source repo. The `Adobe-CEP` org itself is **not** archived as of 2026-09-18 (`gh api orgs/Adobe-CEP` returns `archived_at: null`, `public_repos: 3`); `CEP-Resources` (last commit 2026-02-20), `Samples` (2026-03-24), and `Getting-Started-guides` (last release 2025-06-18) remain active. The two legacy `extendscript-debug*` repos do return 404 (`Adobe-CEP/extendscript-debugger-vscode`, `Adobe/extendscript-debug`) — these 404 checks remain reproducible but the inference that the org is archived does **not** hold (research/corrections-01).
- `github.com/Adobe-CEP/CEP-Resources/issues/364` — CEP 11 nested-iframe `evalScript` callback regression.
- `github.com/Adobe-CEP/CEP-Resources/blob/master/ZXPSignCMD/KnownIssue2024.md` — `PlayerDebugMode` registry path; ZXPSignCmd 2024-2025 stability issues.
- `marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug` — Adobe VSCode ExtendScript Debugger Marketplace entry.
- `helpx.adobe.com/after-effects/faq/uxp-for-after-effects-early-access.html` — UXP for AE FAQ (25.0, Oct 2024).
- `adobe.com/content/dam/cc/en/think-tank/uxp-in-after-effects/uxp-in-after-effects.pdf` — Adobe UXP in AE whitepaper (URL exists; WebFetch returned 404 on 2026-09-18 — URL existence is the verified fact; the whitepaper content is unverified).
- `helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html` — Adobe scripting introduction.
- `helpx.adobe.com/after-effects/using/selected-layers-active-item-and-the-active-composition.html` — Adobe user docs on active item / active comp.
- `blog.developer.adobe.com/en/publish/2019/06/debugging-your-adobe-panel` — Adobe CEP debugging guide.
- `ae-plugins.docsforadobe.dev` — AEX SDK docs (cited as out-of-scope reference).

### Adobe-community-maintained docs

- `extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/` — Launch / attach, `Evaluate Script in Host...`, targetengine selection.
- `extendscript.docsforadobe.dev/extendscript-toolkit/debugging-in-the-toolkit/` — ESTK model, `#target`, `#targetengine`, Data Browser.
- `extendscript.docsforadobe.dev/external-communication/socket-object/` — ExtendScript `Socket` API (TCP only, no SSL/TLS, no UDP).
- `extendscript.docsforadobe.dev/user-interface-tools/defining-behavior-with-event-callbacks-and-listeners/` — `addEventListener` is for UI controls, not AE state.
- `ae-scripting.docsforadobe.dev/` and subpages — `general/application/`, `general/project/`, `compitem/compitem/`, `layer/layer/`, `layer/avlayer/`, `property/property/`, `property/propertygroup/`, `other/glob.html`. Authoritative scripting guide; attribute-driven model; no app-level events.
- `theiviaxx.github.io/photoshop-docs/CEP/csinterface.html` — `CSInterface` API reference (third-party but cross-referenced).
- `adobedocs.github.io/uxp-photoshop/ps_reference/media/uxpscripting/` — Photoshop UXP scripting (not AE, comparison only).

### Adobe Community / forum threads

- `community.adobe.com/questions-529/after-effects-25-2-2-win-cep-remote-debugging-port-not-opening-netstat-confirms-no-listening-pr-59962` — AE 25.2.2 Windows CEP remote-debug port quirks; base64-encoded `--remote-debugging-port`.
- `community.adobe.com/questions-729/how-to-start-node-js-server-in-cep-1414669` — `cep_node` module-loading limits.
- `community.adobe.com/questions-628/rest-api-calls-from-inside-cep-are-canceled-685370` — CEP CORS enforcement confirmation.
- `community.adobe.com/t5/after-effects-discussions/cep-extension-development-how-to-detect-user-selection-changes-in-active-project/m-p/1424843` — No built-in selection-change event.
- `community.adobe.com/questions-529/extendscript-debugger-for-vscode-is-not-maintained-42460` — Community evaluation of Adobe's VSCode debugger stability.

### Community reference implementations

- `github.com/Dakkshin/after-effects-mcp` — File-polling AE bridge; 250 ms server poll, 2000 ms bridge poll.
- `raw.githubusercontent.com/Dakkshin/after-effects-mcp/main/src/index.ts` — Server-side polling loop, `ae_command.json` / `ae_mcp_result.json` IPC.
- `raw.githubusercontent.com/Dakkshin/after-effects-mcp/main/src/scripts/mcp-bridge-auto.jsx` — Bridge panel ExtendScript.
- `github.com/a-y-ibrahim/after-effects-mcp` — Per-command unique IDs to avoid result-file staleness.
- `github.com/hodor/ae-mcp` — CEP panel + WebSocket bridge (port 3000).
- `github.com/leancoderkavy/premiere-pro-mcp` — Premiere Pro MCP; CEP file-polling + UXP WebSocket (`127.0.0.1:7777` + shared secret `PREMIERE_UXP_TOKEN`).
- `github.com/psyirius/extendscript-debugger-core` — Community-extracted Adobe debugger core (`esdcorelibinterface`).
- `raw.githubusercontent.com/psyirius/extendscript-debugger-core/main/src/index.ts` — Native addon loader, singleton `_coreLib`.
- `raw.githubusercontent.com/psyirius/extendscript-debugger-core/main/types/esdcorelibinterface.d.ts` — `esdInitialize` / `esdCompileToJSXBin` / `esdCheckSyntax` / `esdCleanup` / `ESDCoreStatus` types.
- `aenhancers.com/jsobjectref` — Community `comp('name')` / `activeItem` conventions.
- `creativecow.net/forums/thread/cep-panel-event-listener-layer-selection/` — `setInterval` polling pattern for selection.
- `creativecow.net/forums/thread/appscheduletask/` — `app.scheduleTask` patterns and caveats.
- `github.com/TLKorjak/copy-ease-values-script/blob/main/Knowledge%20Base/reference_ae_egp_scripting.md` — `app.scheduleTask` reference.
- `github.com/pushREC/after-effects-sdk-kb/blob/main/scripting/01-extendscript-complete-reference.md` — Property / PropertyGroup / Effect reference; keyframe API.
- `ivg-design.github.io/cep/`, `forums.adobe.com/thread/1331599` — Community CEP docs and panel code samples.
- `stackoverflow.com/questions/58070522/csinterface-evalscript-returns-undefined-when-extendscript-function-has-no-return` — `evalScript` return-value conventions.
- `mapsoft.com/posts/extendscript.html` — ExtendScript / ESTK / UXP transition summary (community).

### Security references

- `wicg.github.io/private-network-access/` — WICG Private Network Access spec.
- `developer.chrome.com/blog/private-network-access-preflight` — Chrome PNA preflight rollout.
- `github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/` — GitHub Security: localhost dangers, DNS rebinding.
- `ox.security/blog/cve-2025-65717-live-server-vscode-vulnerability/` — Live Server CVE-2025-65717 writeup.
- `github.com/kunchenguid/chrome-devtools-axi/security/advisories/GHSA-x439-jhfh-v9x2` — DNS rebinding against unauthenticated local bridge.
- `issues.chromium.org/40090537` — Chromium DevTools + DNS rebinding UXSS bug.
- `modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices` — MCP security best practices (2026-07 spec).
- `modelcontextprotocol.io/specification/2025-11-25/basic/authorization` — MCP authorization spec.
- `anthropic.com/engineering/code-execution-with-mcp` — Anthropic "Code execution with MCP".
- `cymulate.com/blog/cve-2025-53109-53110-escaperoute-anthropic/` — EscapeRoute CVE writeup.

### Status checks

- `gh api repos/Adobe-CEP/extendscript-debugger-vscode` — 404 confirmed 2026-09-18.
- `gh api repos/Adobe/extendscript-debug` — 404 confirmed 2026-09-18.

---

## Unverified items

Consolidated from the per-document "Unverified" sections. **None of the items below are confirmed decisions; each requires real-AE testing, an Adobe documentation update, or both before a decision can lean on it.** Items are grouped by the kind of evidence gap.

### A. AE-internal behavior (need live AE 25.x)

1. `CSInterface.evalScript` callback threading — whether it fires on AE's main thread or the CEPHtmlEngine process thread. The Cookbook says "split into small parts" but does not name the thread.
2. `evalScript` payload size limits and back-pressure behavior under load.
3. Behavior of `evalScript` when AE is rendering, saving, loading a project, or evaluating expressions. Cookbook is silent on main-thread contention.
4. `app.scheduleTask` repeat granularity on Windows (community reports ~10–30 ms; Adobe does not publish).
5. `CSInterface` availability from ExtendScript inside AE 25.x — newer builds appear to expose it; Adobe does not commit.
6. `selectedLayers` semantics when focus is on the Project panel vs a comp viewer (community reports `[]` in some cases).
7. `do javascript file` (AppleScript) on AE 25.x — community reports of breakage; not verified.
8. AE 26.x CEP version (working assumption: CEP 12; no public matrix yet).
9. UXP Scripting API surface in AE — no Adobe-published equivalent of the Photoshop UXP scripting reference.
10. ExtendScript → UXP cross-call mechanism (and inverse) — neither documented.
11. Whether `system.callSystem()` runs synchronously or asynchronously.

### B. Wire-protocol internals (Adobe has not published)

12. PlugPlug OOP messaging format between CEPHtmlEngine and the AE main process.
13. `ESCoreLib` wire protocol used by the VSCode debugger.
14. Whether the VSCode debugger uses ESTK's legacy TCP port 2018 or a fresh channel.
15. `esdInitialize` `spec` argument shape and `processId` source.
16. Whether ExtendScript exposes any `Socket.open` audit hook.

### C. Identity / handle stability

17. `layer.id` / `item.id` persistence across Save → Quit → Reload — exposed but not documented as stable.
18. Whether `app.activeItem` on the Application object is an alias for `app.project.activeItem` (older guides mention it directly; current guide places it on Project only).

### D. Platform coverage

19. Linux and Apple Silicon support for `esdcorelibinterface.node` — only Win x64/ia32 and macOS x64 are bundled today; Apple Silicon behavior (Rosetta or native) is not documented.
20. macOS Sequoia / Linux 6.x loopback ACL changes affecting multi-user isolation.

### E. Security posture

21. AE 25.x / 26.x enforcement level for `Access-Control-Allow-Private-Network` (PNA roll-out is phased).
22. Adobe's official posture on third-party tools invoking ExtendScript from outside the host process — undocumented. This is the **fundamental legitimacy question** for the project, not just a technical detail.
23. Premiere Pro MCP `PREMIERE_UXP_TOKEN` exact placement (header vs query vs subprotocol).
24. Whether the VSCode Extension Host exposes a stable, documented `Origin` header for outbound IPC (`vscode-webview://` IDs change per window).

### F. Community-pattern specifics

25. CEF Node.js (`cep_node`) WebSocket-server stability under Node 17.7.1 — `ws` module load reliability.
26. `ALREADY_INITIALIZED` state recovery procedure for the native addon — Adobe does not document it.
27. CEF command-line flags Adobe ships in AE 25.x vs 26.x — relevant to whether `--disable-features=SameSiteByDefault...` is on by default.

### G. UX / API surface

28. Exact multi-AE-instance debug port allocation behavior (community: pick different ports; Adobe's blessed strategy, if any, is undocumented).
29. Programmatic auto-launch of a CEP panel without user click — no documented API.
30. `app.scheduleTask` repeat granularity, modal-dialog pause behavior, eval-string scope limitations.
31. `expression.canSetExpression` availability across AE versions.
