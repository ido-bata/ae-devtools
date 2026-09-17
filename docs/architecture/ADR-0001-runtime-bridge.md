# ADR-0001 — Runtime Bridge Architecture

> Status: **Proposed** (2026-09-18). See §Status for the conditions required
> to promote to Accepted.

---

## Status

**Proposed.**

The decision is consistent with `docs/vision.md`'s "shared core / daemon"
image and with community precedent, but evidence is **insufficient for
Accepted**: the five research files are explicit that every claim about
AE 25.x behavior under real load (callback threading, render-queue
contention, multi-instance port allocation, `app.scheduleTask` polling
granularity) is unverified. Promoting this ADR to Accepted requires at
minimum one round of real-AE testing on AE 25.x covering:

1. `CSInterface.evalScript` end-to-end while a render is running.
2. Daemon reconnection after AE restart, including panel re-launch UX.
3. Apple Silicon behavior of the CEP panel and (if it ever ships) the
   native fallback.

Until those three are exercised on a live AE instance, the architectural
shape below is provisional.

---

## Context

`vision.md` sketches a layered structure:

```
After Effects
     ↕
AE Bridge / Runtime
     ↕
Shared Core / Daemon
   ↙          ↘
VSCode        MCP
```

The five judgment points this ADR answers sit in the AE-Bridge layer and
its boundary with the Shared Core / Daemon.

The research under `docs/architecture/research/` established the
following facts that this ADR inherits without re-arguing:

- After Effects exposes no general event stream for project state; every
  "live" piece of state is reached as a chain of attribute reads from
  `app` (research 03 §Snapshot introspection).
- CEP `CSInterface.evalScript` is the only Adobe-documented in-process
  bridge that gives full `app.*` access from external code; it runs
  ExtendScript on AE's main thread and returns its value via a callback
  (research 01 §A, 02 §CSInterface / §evalScript signature).
- CEP has no background mode; a CEP-only design cannot survive AE restart
  or a closed panel (research 02 §Background / invisible mode).
- `evalScript` is the documented choke point — and therefore the natural
  security boundary — for everything ExtendScript does (research 05
  §T6 / §T12).
- Adobe's own VSCode ExtendScript Debugger bundles a native addon
  (`esdcorelibinterface.node` + `ESCoreLib`) that bypasses CEP entirely,
  but ships only for Windows + macOS x64, and the source repository is
  archived / 404 (research 01 §B, 04 §1.1).

The user's five judgment points — AE-side component, boundary placement,
daemon yes/no, request/response vs job-based, event sync yes/no — are
answered concretely in §Decision below.

---

## Decision

The decisions below are stated concretely. Each answers one of the five
judgment points. Evidence for each line is summarized in §Why and cited
inline; full evidence URLs with access dates are consolidated in
`docs/architecture/ae-bridge-research.md` §Evidence index.

### 1. AE-side Bridge first candidate

The AE-side Bridge is a **CEP 12 panel that drives ExtendScript through
`CSInterface.evalScript`**. The panel runs in AE's embedded CEF/Chromium
process (research 02 §CSInterface, §evalScript signature). **For v1**,
this is the only layer that holds an `app.project` handle and executes
ExtendScript. Native-addon-based execution (research 04 §3.5 案A',
`esdcorelibinterface.node`) is **reserved as a future escape hatch, not
adopted now**: Adobe's source repository is archived and the addon is
platform-locked to Windows + macOS x64.

The panel is loaded by the user via `Window > Extensions` after a
one-time install (research 02 §Extension lifecycle). For development,
`PlayerDebugMode=1` is set per CSXS version. The distribution channel
itself is **not pre-decided** by this ADR — `vision.md` §未確定
currently lists 配布形態 as undecided. If and when the panel is
distributed as a `.zxp`, the documented signing flow applies (research
02 §Signing model); if distributed by another channel, the equivalent
integrity requirement applies.

UXP Scripting (AE 25.0+) is **not adopted for v1**. The AE-side UXP
Scripting API surface is not yet a public, versioned reference (research
01 §E, 02 §Unverified); adopting it would commit to a surface that
cannot yet be characterized. It is parked as a deferred alternative and
revisited when Adobe publishes the AE UXP scripting reference or sets a
clearer ExtendScript deprecation timeline.

### 2. Boundary placement

The boundary between the AE Bridge and the external tool is **at the
daemon's IPC contract**. The boundary is drawn so that:

- All ExtendScript execution happens inside the CEP panel; nothing
  outside AE ever holds a live ExtendScript handle (research 03 §Object
  identity — handles are session-local and can be invalidated by undo /
  reorder).
- Every payload crossing the boundary is JSON-serialized at the AE side;
  complex AE objects are flattened by ExtendScript's `JSON.stringify`
  before the value reaches `CSInterface.evalScript`'s callback (research
  01 §Return value passing, §A).
- The daemon exposes a single privileged execution primitive (working
  name `eval`) plus a closed set of typed read-only verbs (working
  family `inspect_*`) — research 05 §T6 rule 1. Verb names and payloads
  are illustrative; the contract-level commitment is that `eval` is
  privileged and the read surface is closed. All `CSInterface.evalScript`
  calls funnel through one chokepoint module in the codebase (rationale:
  research 05 §T6 rule 1); the exact call-site count is an
  implementation detail.
- `evalScript` is always called from the panel's top-level frame
  (research 02 §CEP 11 nested-iframe regression — Adobe-CEP issue #364).
- Identifiers crossing the boundary are path-based and stable:
  `{projectPath}::{compName}::{layerIndexOrName}::{propertyPath}`
  (research 03 §Recommended pattern for external tools). `layer.id` is
  exposed by AE but not documented as persistent across Save → Quit →
  Reload (research 03 §Unverified items, item 15).

### 3. Daemon

**Yes, a daemon is required.** Three independent reasons converge:

- CEP panels cannot run without UI and are torn down on AE restart
  (research 02 §Background / invisible mode). A persistent bridge
  requires something that outlives the panel.
- Two front-ends (VSCode Extension, MCP Server) need concurrent access
  to a single AE session; AE's ExtendScript engine has one connection
  per `targetengine`, so the multiplexer belongs outside AE.
- The vision document's "shared core / daemon" separation (vision.md
  §shared core を持つ理由) is the project's architectural anchor;
  collapsing it would force every front-end to re-implement AE
  communication.

The daemon runs as an external OS process (implementation language
deferred — Rust-vs-TypeScript is not decided by this ADR). It binds
`127.0.0.1` only, communicates on an ephemeral port or a randomized
Unix domain socket, and requires a per-launch 256-bit shared-secret
token (research 05 §Mitigations required for first implementation,
items 1–3; Premiere Pro MCP precedent `PREMIERE_UXP_TOKEN`).

### 4. Request/response vs job-based

**Request/response is the default.** The IPC contract is shaped so that:

- Each client call is one request → one response, with a request id and
  a deadline. `evalScript`'s callback maps 1:1 onto a response. The
  daemon serializes requests so the panel does not stack them, in
  keeping with the CEP 12 Cookbook's "split into small parts" guidance
  (research 01 §Multiple evalScript calls).
- Long-running operations (e.g., batch property edits across many
  layers) are expressed as one request that returns a single final
  response, not as a job with progress events. This matches the
  development-loop cadence the vision describes (vision.md §MCP Server
  の方向性 — agents drive a human-paced loop, not a real-time UI loop).
- A `subscribe` verb is **reserved in the contract** but unimplemented
  in v1 (see Decision 5).
- Cancellation is handled client-side: the client gives up; the daemon
  drops the response when its eventual `evalScript` callback arrives.
  This is an **inference from research 01 §Unknowns, item 1**, not a
  directly cited decision: Adobe does not document server-side
  cancellation of `evalScript`, so the daemon cannot promise it in v1.

### 5. Event sync in initial design

**Not in v1.** The IPC contract reserves `subscribe` / `unsubscribe`
verbs but does not implement them. The first version is request/response
only; the bridge never claims to push.

Rationale, drawing on research 03 §Change events:

- AE exposes no project-state events for selection, active comp,
  property changes, expression changes, layer add/remove/reorder, or
  project modification. The scripting guide has no `app.addEventListener`
  and no equivalent on `project`, `comp`, or `property` (research 03
  §Per-event-type summary — every row under "Change type" is "none" /
  "yes (≈500 ms)").
- The only documented push channel is `CSEvent` from ExtendScript to
  the panel, which requires ExtendScript-side code to detect the change
  first. Detection means `app.scheduleTask` polling on AE's main thread.
- Main-thread polling competes with `evalScript` calls. The Cookbook's
  "split into small parts" guidance (research 01 §Multiple evalScript
  calls) is itself a hint that the engine's main-thread budget is
  constrained, and `app.scheduleTask` strings evaluate in global scope
  with documented modal-dialog pause behavior (research 03
  §app.scheduleTask caveats).

Adding event sync in v1 would mean building a change-detection system
on top of an AE version whose polling behavior has not been measured
(research 03 §Unverified items, items 4 and 5). The contract reservation
is enough to keep clients honest: when a future version adds
`subscribe`, the request shape does not change.

---

## Why

Each decision above tracks one of the five judgment points and rests on
the strongest evidence available in the research. The shape is
deliberately conservative:

- **CEP panel + `evalScript`** — the only Adobe-documented path that
  gives full Scripting access from a stable, code-driven runtime. The
  other Adobe-blessed paths are either a debugger (not an execution
  API), a different host (Photoshop's UXP), or a future direction whose
  surface is not yet published (AE UXP Scripting).
- **Boundary at the daemon IPC** — the security threat model is
  sharpest there (research 05 §T1–T5, §Mitigations required). One
  well-defended boundary is easier to audit than two or three, and the
  ten first-implementation mitigations all line up against one surface.
- **Daemon required** — three independent failure modes (panel lifetime,
  concurrent front-ends, vision-driven separation) all converge on
  needing it. None of the "no daemon" alternatives survives more than
  one of the three.
- **Request/response** — AE's API is attribute-driven (research 03) and
  the agent loop is human-paced (vision.md); job semantics add
  complexity without buying latency the project needs.
- **No event sync in v1** — AE gives us no events to subscribe to;
  implementing our own poller on day one is a project decision, not a
  vendor capability, and the contract can stay honest by *reserving*
  `subscribe` without implementing it.

---

## Alternatives considered

| Alternative | Where it failed | Reference |
|---|---|---|
| **Native addon (Adobe VSCode Debugger pattern) as primary AE-side component** | Platform coverage limited to Win + macOS x64; Adobe-CEP source archived; not an execution API, a debugger. | research 04 §1, §3.1 (案A) |
| **CEP panel as the server (no external daemon)** | Pushes the entire bridge into CEP-Node 17.7.1; panel becomes single point of failure; module-loading fragility. | research 04 §3.3 (案C) |
| **File-polling bridge as primary IPC** | Second-scale latency, no push, polling on both sides. Useful as a degraded fallback when WebSocket cannot bind; not a default. | research 04 §2.1, §3.5 (案B' analogue) |
| **UXP Scripting (AE 25.0+) as primary AE-side component** | AE-side UXP Scripting API surface is not yet publicly documented; cannot commit to a contract that cannot yet be characterized. | research 01 §E, 02 §Unverified items |
| **ESTK legacy TCP port 2018** | ESTK is deprecated; protocol undocumented; Adobe's own debugger may or may not use it. | research 04 §1.4, §5 |
| **Direct ExtendScript `Socket` listener (no CEP, AE startup-scripts folder)** | AE startup-scripts is the only way to make ExtendScript run at launch, but `Socket` is plain TCP with no documented auth, and it gives up CEP's signing model. | research 02 §Auto-load patterns, 04 §3.5 (案B') |
| **AEX / native plugin (C++)** | Out of scope by intent. | vision.md, research 01 §F |
| **Event sync in v1** | AE exposes no project-state events; building a poller on day one is a project decision, not a vendor capability. | research 03 §Change events |

---

## Consequences

### Positive

- **Sharp trust boundary.** A single daemon IPC contract is the only
  attack surface to defend (research 05 §Mitigations required). All ten
  first-implementation mitigations (bind to 127.0.0.1, ephemeral port,
  per-launch token, Origin allowlist, Host validation, audit log, MCP
  consent UI, panel CSP, signed panel, closed read-only verb surface)
  line up against one surface.
- **Testable core.** The daemon can be unit-tested without AE; the
  panel can be integration-tested against a mock daemon (research 04
  §3.4 test row).
- **Concurrent front-ends.** VSCode Extension and MCP Server can both
  connect to the same daemon without contending for AE's single
  ExtendScript engine connection (research 04 §3.4 shared-session row).
- **Crash isolation.** Four processes (AE / panel / daemon / front-end)
  fail independently; an AE crash does not take the editor down
  (research 04 §3.4 crash-isolation row).
- **Aligned with vision.** The shape matches `vision.md`'s diagram and
  §shared core を持つ理由 exactly.
- **Multi-AE-instance friendly.** One daemon, many AE panel sockets;
  each instance keeps its own port file (research 02 §Multiple AE
  instances).
- **Forward path is open.** UXP Scripting, native-addon fallback, and
  event sync can each be added later without changing the IPC
  contract's request shape.

### Negative

- **Process boundary tax.** Three process boundaries (front-end →
  daemon → panel → engine) means three places where serialization,
  lifecycle, and auth each have to be right (research 04 §3.4
  implementation complexity).
- **CEP distribution friction.** The panel requires either a signed
  `.zxp` or `PlayerDebugMode=1` on the user's machine (research 02
  §Signing model), and Adobe Community reports ZXPSignCmd stability
  issues in 2024–2025 (research 02 §Signing model —
  `KnownIssue2024.md`). Distribution channel itself is not pre-decided
  by this ADR.
- **Linux + Apple Silicon uncertainty for the fallback.** If the v1
  path (M1 + M3) proves insufficient on Linux or Apple Silicon, M4
  (native addon) is not a clean escape — it does not run there either
  (research 04 §1.6). This is acceptable for v1 because the primary
  path is M1+M3 and runs everywhere CEP runs (Windows + macOS), but is
  worth surfacing now rather than later.
- **No push semantics in v1.** Selection / active-comp / property-change
  updates must be polled by the agent. The contract reservation makes
  this an additive future change, not a breaking one, but the v1
  latency cost is real and acknowledged.

### Neutral

- **Language choice for the daemon is open.** This ADR commits to the
  shape, not the language. Rust-vs-TypeScript belongs to a future ADR.
- **MCP tool enumeration is out of scope.** The contract gives the
  daemon primitives (`eval`-family exec, `inspect_*`-family read, future
  `subscribe`); which of these become MCP tools is an MCP-layer decision
  and explicitly not pre-decided here. vision.md §MCP Server の方向性
  is the guardrail.
- **LSP, type generation, expression editor, frame capture, branding,
  marketplace distribution.** All untouched; this ADR does not extend
  scope into them.

---

## Open questions

1. **Real-AE behavior under load** (research 01 §Unverified items 1–3,
   03 §Unverified items 4–5). Until AE 25.x is exercised end-to-end with
   `evalScript` against a render, a save, and an expression evaluation,
   every "split into small parts" assumption is provisional. **Required
   before this ADR can move from Proposed to Accepted.**
2. **Multiple AE instances** — confirmed port-per-instance is the
   community pattern (research 02 §Multiple AE instances), but Adobe
   does not document an officially blessed allocation strategy. Decide
   before shipping multi-instance UX.
3. **Apple Silicon behavior of the panel and any future native
   fallback.** CEP 12 itself is Apple Silicon native;
   `esdcorelibinterface.node` is not (research 04 §1.2 platform
   restrictions). Verify before committing to a Linux-arm story.
4. **Adobe's posture on third-party tools invoking ExtendScript from
   outside the host** (research 05 §Unverified items, item 22).
   Adobe's ESTK and the VSCode debugger use Adobe's own code paths;
   there is no public API for what this project is doing. This is the
   **fundamental legitimacy question** and should be answered before
   any public release, not deferred.
5. **`app.scheduleTask` repeat granularity and modal-dialog pause
   behavior** (research 03 §Unverified items, items 4 and 5). Relevant
   the moment v2 plans event sync. Out of scope for v1.
6. **CEP 13 / AE 26.x** — research 02 §Unverified items, items 1–2. If
   AE 26 ships with a new CEP, a new Node version, or a changed
   `evalScript` contract, this ADR needs revisiting.
7. **Unix domain socket vs TCP loopback** for the daemon IPC (research
   05 §Mitigations deferred, item 5). First cut uses `127.0.0.1` +
   token; the Unix-socket variant is a one-day change once the IPC
   layer stabilizes.
8. **`ALREADY_INITIALIZED` recovery for any future native-addon
   fallback** (research 04 §Unverified items, item 11). Not v1, but
   worth tracking.
9. **File-polling bridge (M6) as a reserved degraded fallback**
   (synthesis §Candidate mechanisms M6). When the daemon cannot bind
   its loopback port (port collision, firewall, sandboxed environment),
   the same ExtendScript surface can run a `ae_command.json` /
   `ae_result.json` polling bridge via `app.scheduleTask` with no
   daemon. This is not adopted in v1 and is not pre-decided here, but
   the contract should not foreclose it. Worth tracking alongside
   M4 (native addon) as a second escape hatch.

---

## Risks

The decision above is sound against the public evidence base, but
**one project-level risk sits above the open questions** and deserves
visibility:

**Adobe legitimacy question** — research 05 §Unverified items, item 22
and §Open questions 4 above. The architecture in this ADR routes every
ExtendScript execution through `CSInterface.evalScript` from a CEP panel
that is, at the protocol level, the same kind of integration that Adobe's
own ESTK and the (now-archived) VSCode debugger use. Adobe has not
publicly blessed third-party external-ExtendScript invocation from
outside the host. The community precedents this ADR cites
(`Dakkshin/after-effects-mcp`, `a-y-ibrahim/after-effects-mcp`,
`hodor/ae-mcp`, `leancoderkavy/premiere-pro-mcp`) operate without
documented Adobe sanction. If Adobe formally objects, the entire
M1+M3 stack requires revisiting.

This is not a documentation gap. It is a constraint the entire
architecture inherits. It must be answered before public release. It
is not a reason to halt v1 development in a closed / development-only
distribution, but it is a reason to keep distribution channels
ungated by Adobe's blessing until the question is resolved.

---

## Evidence

All URLs accessed **2026-09-18** unless otherwise noted. Inline
citations point at the source research files; the consolidated URL list
with full access dates lives in `docs/architecture/ae-bridge-research.md`
§Evidence index.

### Internal research (this repository)

- `docs/architecture/research/01-execution-surface.md` — execution
  surface candidates; `evalScript` signature; main-thread constraint;
  sync semantics; AE busy states; unverified items 1–10.
- `docs/architecture/research/02-cep-deep-dive.md` — CEP 12 integration
  matrix; `CSInterface`; Node.js 17.7.1; network capabilities;
  lifecycle; signing; no background mode; debugger / inspector
  integration; unverified items 1–6.
- `docs/architecture/research/03-state-events.md` — `app` / `project` /
  `CompItem` / `Layer` / `Property` / `PropertyGroup` attribute
  surfaces; handle-vs-snapshot guidance; absence of project-state
  events; `app.scheduleTask` polling pattern; unverified items 1–5.
- `docs/architecture/research/04-process-architecture.md` — Adobe
  VSCode Debugger structure (`esdcorelibinterface.node` + `ESCoreLib`);
  community patterns (Dakkshin, a-y-ibrahim, hodor, leancoderkavy);
  three architecture options (A native, B daemon+CEP, C CEP-as-server)
  and their evaluation matrix; unverified items 1–11.
- `docs/architecture/research/05-security.md` — threat surface; ranked
  threats T1–T14; mitigations required for first implementation (bind
  to 127.0.0.1, ephemeral port, per-launch token, Origin allowlist,
  Host validation, audit log, consent UI, panel CSP, signed panel,
  read-only `inspect_*` defaults); mitigations deferred; unverified
  items 1–9.

### Project context

- `docs/vision.md` — background, problem framing, intended audience,
  VSCode Extension direction, MCP Server direction, "shared core /
  daemon" rationale, architecture sketch, deliberately undecided
  areas.
- `AGENTS.md` — guardrails. §1 ("ユーザーが決めていない仕様を勝手に固定
  しない") and §8 ("スコープの最終確認") are the constraints that
  bound this ADR's scope. §9 ("AI が AE を勝手にいじることを主目的に
  しない") constrains the MCP-tool surface this ADR does not pre-decide.

### Source-quality policy

- All evidence URLs were accessed **2026-09-18**.
- Adobe official sources (CEP 12 Cookbook, `docsforadobe.dev`,
  Adobe HelpX FAQ, Adobe-CEP/CEP-Resources) are preferred over
  community material.
- **Pre-2022 third-party CEP guides are not relied on.** CEP 9 and
  earlier did not have `--enable-nodejs`; many older articles encode
  assumptions that no longer hold (research 01 §Notes). Where a
  pre-2022 source is the only available reference, it is flagged.
- Adobe's posture on third-party external-ExtendScript invocation
  is **not documented**; community precedents are operating without
  Adobe's blessing. See §Risks above and research 05 §Unverified
  items, item 22.

### External sources cited inline (consolidated in ae-bridge-research.md)

- Adobe CEP 12 Cookbook — `raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md`. Authoritative for `evalScript` signature, main-thread execution, Node.js 17.7.1, CORS / CSP / SameSite, signing, `PlayerDebugMode`.
- `extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/` — launch / attach, `Evaluate Script in Host...`, targetengine.
- `extendscript.docsforadobe.dev/extendscript-toolkit/debugging-in-the-toolkit/` — ESTK model, `#target`, `#targetengine`.
- `extendscript.docsforadobe.dev/external-communication/socket-object/` — ExtendScript `Socket` API.
- `ae-scripting.docsforadobe.dev/` and subpages (`general/application/`, `general/project/`, `compitem/compitem/`, `layer/layer/`, `layer/avlayer/`, `property/property/`, `property/propertygroup/`) — attribute-driven Scripting API reference.
- `github.com/Adobe-CEP/CEP-Resources/issues/364` — CEP 11 nested-iframe `evalScript` callback regression.
- `github.com/Adobe-CEP/CEP-Resources/blob/master/ZXPSignCMD/KnownIssue2024.md` — `PlayerDebugMode` registry path; ZXPSignCmd 2024–2025 stability.
- `github.com/psyirius/extendscript-debugger-core` and its raw `src/index.ts` / `types/esdcorelibinterface.d.ts` — community-extracted Adobe debugger core.
- `github.com/leancoderkavy/premiere-pro-mcp` — Premiere Pro MCP precedent (`127.0.0.1:7777` + shared secret).
- `github.com/Dakkshin/after-effects-mcp`, `github.com/a-y-ibrahim/after-effects-mcp`, `github.com/hodor/ae-mcp` — community AE bridges.
- `community.adobe.com/t5/after-effects-discussions/cep-extension-development-how-to-detect-user-selection-changes-in-active-project/m-p/1424843` — confirms no built-in selection-change event.
- `helpx.adobe.com/after-effects/faq/uxp-for-after-effects-early-access.html` — UXP for AE FAQ (25.0, Oct 2024).
- `modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices` — MCP security best practices.
- `github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/` — DNS rebinding guidance.
- `ox.security/blog/cve-2025-65717-live-server-vscode-vulnerability/` — Live Server CVE writeup.
- `gh api repos/Adobe-CEP/extendscript-debugger-vscode` — 404 status check 2026-09-18.
