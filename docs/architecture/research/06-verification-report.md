# Verification Report

> Adversarial review of `docs/architecture/ADR-0001-runtime-bridge.md`
> against the five research files (`01-execution-surface.md`,
> `02-cep-deep-dive.md`, `03-state-events.md`,
> `04-process-architecture.md`, `05-security.md`) and the synthesis
> (`docs/architecture/ae-bridge-research.md`). Default stance: refuting.
> Date: **2026-09-18**. No real-AE testing performed (this review
> inherits the same caveat as the underlying research).

---

## Verdicts on each judgment point (1–5 from user)

### Judgment 1 — AE-side Bridge first candidate

**Covered, evidence-backed, but slightly over-specified.**

The ADR §Decision 1 commits to "CEP 12 panel + `CSInterface.evalScript`".
This is supported by research 01 §A and research 02 §CSInterface /
§evalScript signature, and by the synthesis's M1 verdict. The
deferral of UXP Scripting is supported by research 01 §E and
research 02 §Unverified items. The framing is honest about why
UXP Scripting is parked (surface cannot be characterized).

However, the ADR adds: "It is the only layer that holds an
`app.project` handle, and it is the only place where ExtendScript is
executed." This is a strong architectural commitment that the
research does not prove as exclusive — research 04 §3.5 案A'
(`daemon + native addon`) explicitly imagines the daemon executing
ExtendScript via `esdcorelibinterface.node` without a panel. The
synthesis marks M4 (the native addon) as **Rejected for v1**, which
is the right answer, but the ADR does not state that the
"only place" claim is contingent on that rejection. A reader who
consults only the ADR could believe CEP is the only theoretical
option; it is the only **adopted** option. **Recommend softening
the "only" language to "for v1".**

### Judgment 2 — Boundary placement between AE Bridge and external tool

**Covered but with two pieces of scope creep.**

The boundary-at-daemon-IPC decision is supported (research 02
§Background, research 04 §3.2, synthesis Decision 2). The
JSON-serialization-at-the-AE-side rule is supported by research 01
§Return value passing.

Two items go beyond what the research pinned down:

1. The ADR specifies "**exactly one place in the codebase** that
   calls `CSInterface.evalScript`". Research 05 §T6 #1 calls for a
   "single execution primitive" as a mitigation principle. That is
   not the same as a structural codebase rule about a single call
   site. The ADR is locking down an implementation discipline that
   the research only suggests as a principle.
2. The ADR names the verbs: "**single execution primitive (`eval`)
   plus a closed set of typed snapshot verbs (`inspect_*`)**".
   Research 05 §T6 #1 mentions "single execution primitive" and
   research 05 Mitigations required #10 mentions "read-only
   `inspect_*` tools". But the ADR is fixing the *verb names*
   (`eval`, `inspect_*`) and the *shape* (one exec primitive +
   closed typed read surface). The research did not enumerate the
   snapshot verbs or name them; the ADR is pre-deciding an API
   surface.

### Judgment 3 — Whether a daemon is needed

**Covered, evidence-backed, scope-respecting.**

The ADR §Decision 3's three reasons (panel lifetime, concurrent
front-ends, vision-driven separation) are all supported by the
research:
- Panel lifetime: research 02 §Background / invisible mode.
- Concurrent front-ends: research 04 §3.4 ("VSCode + MCP 共有
  セッション" row).
- Vision-driven separation: vision.md §shared core を持つ理由.

The deferral of the daemon implementation language
("Rust-vs-TypeScript is not decided by this ADR") is correct and
respects AGENTS.md §1.

**Concern:** vision.md is explicit that the "実装言語、プロセスモデル、
ローカル IPC 方式、デーモン構成" are "まだ決めていない". The ADR's
Decision 3 commits to a daemon *process model*, an IPC contract
shape (with token, ephemeral port, loopback bind), and 256-bit
shared-secret token specifics. These are reasonable things to lock
in given the user's judgment-point framing ("whether a daemon is
needed"), but the line between "daemon needed" and "what kind of
daemon" is thin. **Verdict: in-scope but a hair closer to scope
than necessary.**

### Judgment 4 — Request/response vs job-based model

**Covered, evidence-backed.**

The ADR §Decision 4 maps `evalScript`'s callback 1:1 to a response,
and the synthesis Decision 4 also concludes request/response. The
vision.md cadence argument (human-paced loop, not real-time) is
correct. The reservation of `subscribe` for v2 is supported by
research 03 §Per-event-type summary. The note that "Adobe does not
document `evalScript` cancellation (research 01 §Unknowns, item
1)" is honest about a real limitation.

The "client-side cancellation; the daemon drops the response when
its eventual `evalScript` callback arrives" decision is an
implementation choice the research did not make. It is consistent
with the research (no server-side cancellation documented), so it
is a *reasonable inference*, but the ADR presents it as if it
were researched. **Recommend marking it as an inference, not a
citation.**

### Judgment 5 — Whether to include event sync in initial design

**Covered, evidence-backed, scope-respecting.**

The ADR §Decision 5 defers `subscribe` to v2 and reserves the verb.
Research 03 §Change events and §Per-event-type summary support the
absence of project-state events. The argument that polling
competes with `evalScript` for the main thread is supported by
research 01 §Multiple evalScript calls ("split into small parts").
The deferral is correctly framed as an additive future change.

**No scope creep here.** The ADR names the verbs (`subscribe` /
`unsubscribe`) and reserves them, which is a contract design
choice, not an implementation decision.

---

## Claims to verify

| # | Claim (paraphrased from ADR) | Citation | Verdict |
|---|---|---|---|
| C1 | "The panel runs in AE's embedded CEF/Chromium process" | research 02 §CSInterface | **Confirmed** |
| C2 | "`PlayerDebugMode=1` is set per CSXS version" | research 02 §Signing model | **Confirmed** |
| C3 | "For distribution, the panel ships signed as a `.zxp`" | research 02 §Signing model | **Confirmed** (but note: distribution is not in the user's five judgment points; this is a design commitment dressed as a context fact) |
| C4 | "It is the only layer that holds an `app.project` handle" | implied, not cited | **Unverified** — see Judgment 1 above |
| C5 | "It is the only place where ExtendScript is executed" | implied, not cited | **Unverified** — research 04 §3.5 案A' contradicts this as a categorical statement |
| C6 | "All ExtendScript execution happens inside the CEP panel; nothing outside AE ever holds a live ExtendScript handle" | research 03 §Object identity | **Confirmed** as a *recommended pattern*; **Unverified** as a categorical claim for the entire system |
| C7 | "Every payload crossing the boundary is JSON-serialized at the AE side" | research 01 §Return value passing | **Confirmed** |
| C8 | "Exactly one place in the codebase that calls `CSInterface.evalScript`" | research 05 §T6 #1 | **Scope creep** — research states a *principle*, ADR states an *implementation discipline* |
| C9 | "`evalScript` is always called from the panel's top-level frame" | research 02 §CEP 11 nested-iframe regression (issue #364) | **Confirmed** |
| C10 | Path-based identifier `{projectPath}::{compName}::{layerIndexOrName}::{propertyPath}` | research 03 §Recommended pattern for external tools | **Confirmed** |
| C11 | "`layer.id` is exposed by AE but not documented as persistent across Save → Quit → Reload" | research 03 §Unverified items, item 15 | **Confirmed** (research 03 §Object identity — handle vs snapshot is explicit about this) |
| C12 | "Three independent reasons converge" for daemon | research 02 §Background, research 04 §3.4, vision.md | **Confirmed** |
| C13 | "AE's ExtendScript engine has one connection per `targetengine`" | research 04 §3.4 (評価軸 "VSCode + MCP 共有セッション" row) | **Confirmed** as a known constraint; the *exact* single-connection behavior under concurrent attach is **Unverified** (research 04 Unverified item 4) |
| C14 | "binds `127.0.0.1` only, communicates on an ephemeral port or a randomized Unix domain socket" | research 05 §Mitigations required #1, #2 | **Confirmed** (the "or" between ephemeral port and Unix socket preserves the research's two-option framing) |
| C15 | "per-launch 256-bit shared-secret token" | research 05 §Mitigations required #3 | **Confirmed** |
| C16 | "Premiere Pro MCP precedent `PREMIERE_UXP_TOKEN`" | research 05 §T1; research 04 §2.3 | **Confirmed** as a precedent; the *exact* placement (header vs query vs subprotocol) is **Unverified** (research 05 Unverified item 9) |
| C17 | "evalScript's callback maps 1:1 onto a response" | research 01 §Multiple evalScript calls | **Confirmed** |
| C18 | "Adobe does not document `evalScript` cancellation" | research 01 §Unknowns, item 1 | **Confirmed** |
| C19 | "AE exposes no project-state events for selection, active comp, property changes, expression changes, layer add/remove/reorder, or project modification" | research 03 §Change events, §Per-event-type summary | **Confirmed** |
| C20 | "The only documented push channel is `CSEvent` from ExtendScript to the panel" | research 03 §Custom CEP events | **Confirmed** |
| C21 | "Main-thread polling competes with `evalScript` calls" | research 01 §Multiple evalScript calls ("split into small parts") | **Confirmed** as a Cookbook hint; the *quantitative* claim about main-thread contention under load is **Unverified** (research 01 Unverified item 3) |
| C22 | "`app.scheduleTask` strings evaluate in global scope with documented modal-dialog pause behavior" | research 03 §app.scheduleTask caveats | **Confirmed** |
| C23 | "CEP has no background / invisible mode" | research 02 §Background / invisible mode | **Confirmed** |
| C24 | "Adobe-CEP source archived" | research 01 §B, research 04 §1.1; `gh api` 404 checks | **Confirmed** |
| C25 | "evaluation failure the callback receives the string returned by ExtendScript's `EvalScript_ErrMessage()`" | research 02 §evalScript signature | **Confirmed** |
| C26 | "Adobe's own VSCode ExtendScript Debugger ... ships only for Windows + macOS x64" | research 04 §1.2 | **Confirmed** |
| C27 | "signing ... `.zxp` files must be signed with a certificate that chains to a publicly trusted root" | research 02 §Signing model | **Confirmed** |
| C28 | The `eval` / `inspect_*` verb names are binding for the IPC contract | research 05 §T6 #1, Mitigations #10 | **Scope creep** — see Judgment 2 |

---

## Missing evidence

1. **No live-AE timing evidence.** The ADR cites the Cookbook's
   "split into small parts" hint as justification for serializing
   requests on the daemon side (Decision 4). That hint is a
   qualitative guidance, not a measurement. The ADR would benefit
   from acknowledging that the "split into small parts" principle
   is being used as a *precaution* because the AE main-thread
   behavior under load is **Unverified** (research 01 Unverified
   item 3).

2. **No Adobe legitimacy citation.** The ADR §Open Questions 4
   acknowledges "Adobe's posture on third-party tools invoking
   ExtendScript from outside the host" is undocumented, but the
   decision itself does not flag this as a *project-level risk*
   that the entire architecture inherits. vision.md is silent on
   this; AGENTS.md does not address it. The ADR is the right place
   to note that the project is proceeding on the basis of community
   precedent (Dakkshin, hodor, leancoderkavy) without Adobe's
   blessing, and that this is a *legitimacy* claim that needs to
   be answered before public release — not a documentation gap.

3. **No visibility into what the `inspect_*` verbs actually are.**
   Research 05 §T6 #1 says "single execution primitive" and
   Mitigations #10 says "Read-only `inspect_*` tools". The ADR
   adopts the verb names but does not enumerate what the
   `inspect_*` verbs are. This is *probably* the right level of
   abstraction for an ADR (implementation detail), but the ADR's
   Neutral section says the verb shape is what gets exposed — so
   the verb *names* are part of the contract, and the contract
   needs at least a notional list. **Recommend adding a "verbs
   placeholder" note that lists `inspect_project`,
   `inspect_active_comp`, `inspect_selection`, `inspect_property`
   as illustrative, with the explicit caveat that the actual list
   is a v1 design decision.**

4. **No citation for the "precedent: Premiere Pro MCP
   `PREMIERE_UXP_TOKEN`" placement.** The ADR cites it as a
   precedent, but the exact placement (header vs query vs
   subprotocol) is Unverified per research 05 Unverified item 9.
   The ADR should flag this when relying on it.

5. **Linux coverage gap not in evidence section.** The ADR
   §Negative consequences and §Open questions 3 both note Apple
   Silicon / Linux coverage concerns, but the Evidence section
   does not list any source confirming CEP 12 itself runs
   natively on Linux. Research 02 mentions Linux
   `~/.config/...plist` paths under §Signing model, implying Linux
   support, but the evidence link to a Linux CEP integration is
   thin. The ADR's claim that "the primary path is M1+M3 and runs
   everywhere CEP runs (Windows + macOS)" needs a citation for
   "everywhere CEP runs" if it implicitly includes Linux.

6. **Adobe-internal wire protocol.** Both the synthesis and the
   research mark PlugPlug OOP and `ESCoreLib` wire protocols as
   Unverified (research 01 §Unverified 1; research 04 §Unverified
   2; research 05 Unverified 5). The ADR does not mention these
   at all. The ADR's claim that `evalScript` is "the documented
   choke point" is correct as far as Adobe's public docs go, but
   the *internal* choke point may not be `evalScript` — it may be
   PlugPlug OOP, and the ADR is silent on the difference between
   "public surface" and "internal transport".

7. **Pre-2022 source flagging.** research 01 §Notes explicitly
   warns: "pre-2022 の CEP 記事は古い前提を含む可能性がある".
   The synthesis's §Source-quality rules inherits this. The ADR's
   Evidence section does not echo the warning. The ADR does not
   cite any pre-2022 sources that I can see, so this is mostly
   fine — but if any are added later, the warning should travel
   with them.

---

## Scope discipline check

### Did the ADR decide things it shouldn't have?

1. **Yes — `eval` / `inspect_*` verb naming.** The ADR
   "**single execution primitive (`eval`) plus a closed set of
   typed snapshot verbs (`inspect_*`)**" is a contract shape
   decision. The research supports the *principle* (one exec
   primitive, closed read surface) but does not name the verbs.
   Naming the verbs in the ADR commits the implementation before
   the design phase has explored whether `inspect_*` is the right
   family of operations. **Recommend: change to a placeholder
   notation and note the verb names as illustrative.**

2. **Yes — "exactly one place in the codebase that calls
   `CSInterface.evalScript`."** This is an implementation
   discipline, not a contract decision. The ADR should describe
   the *intent* (single chokepoint for security auditability)
   without binding the implementation to a single call site, which
   is brittle as the codebase grows.

3. **Borderline — IPC specifics (`127.0.0.1`, ephemeral port or
   Unix socket, 256-bit token).** These come directly from research
   05 §Mitigations required, but the user did not ask for them in
   the five judgment points. They are inside the "daemon needed"
   judgment-point territory (you can't say "daemon needed"
   without specifying the trust boundary), so this is acceptable —
   but worth flagging as going a step further than the user
   asked. The synthesis treats them as part of Decision 3, so the
   scope is consistent.

4. **Yes (mildly) — `.zxp` distribution decision.** The ADR
   Decision 1 says "for distribution, the panel ships signed as a
   `.zxp`". Research 02 documents `.zxp` signing but does not
   *decide* that distribution is the chosen channel; vision.md
   §将来的に検討する技術領域 lists "配布形態（VS Marketplace 単独
   / npm パッケージ / スタンドアロン等）" as **未確定**. The ADR
   is making a distribution decision before vision.md resolves it.
   **Recommend: soften to "if/when the panel is distributed as
   `.zxp`, signing is the documented flow."**

5. **No — LSP, type generation, expression editor, frame capture,
   branding, marketplace distribution, Rust-vs-TypeScript, MCP
   tool enumeration.** All explicitly out of scope. Verified by
   reading the §Consequences → Neutral section and §Open questions.

6. **No — "AI が AE を勝手にいじる" surface.** AGENTS.md §9 and
   vision.md §MCP Server の方向性 both constrain this. The ADR
   does not enumerate MCP tools and explicitly defers that. ✓

### Items the synthesis and ADR *do* defer correctly

- UXP Scripting → deferred, not rejected. ✓
- Native addon → kept as escape hatch. ✓
- Event sync → contract reservation only. ✓
- Daemon language → Rust-vs-TypeScript out of scope. ✓
- Multi-AE-instance strategy → acknowledged as community pattern,
  Adobe's blessed strategy undocumented. ✓
- Adobe's third-party-tool posture → open question, not deferred
  to "someday". ✓

---

## Recommended fixes

### To the ADR

1. **Decision 1, change categorical to contingent.** Replace
   "It is the only layer that holds an `app.project` handle, and
   it is the only place where ExtendScript is executed" with
   "For v1, this is the only layer that holds an `app.project`
   handle. Native-addon-based execution (research 04 §3.5 案A')
   is reserved as a future escape hatch, not adopted now."

2. **Decision 2, replace verb names with placeholders.** Replace
   "single execution primitive (`eval`) plus a closed set of
   typed snapshot verbs (`inspect_*`)" with "a single execution
   primitive (working name `eval`) plus a closed set of typed
   read-only verbs (working family `inspect_*`). Verb names and
   payloads are illustrative; the contract-level commitment is
   that `eval` is privileged and the read surface is closed."

3. **Decision 2, soften "exactly one place" claim.** Replace
   "Exactly one place in the codebase that calls
   `CSInterface.evalScript`" with "All `CSInterface.evalScript`
   calls funnel through one chokepoint module (rationale:
   research 05 §T6 #1). The exact call-site count is an
   implementation detail."

4. **Decision 3, drop or qualify the `.zxp` commitment.** The
   `.zxp` mention is in Decision 1's panel-lifecycle paragraph,
   not in Decision 3. Replace "for distribution, the panel ships
   signed as a `.zxp`" with "if/when the panel is distributed as
   a `.zxp` (vision.md §未確定 currently lists 配布形態 as
   undecided), the documented signing flow applies." Or remove
   entirely — the user did not ask about distribution.

5. **Decision 4, mark client-side cancellation as inference.**
   Add a parenthetical: "(this is an inference from research 01
   §Unknowns item 1, not a directly cited decision)."

6. **Add a §Risks section that includes the legitimacy
   question.** The §Open questions 4 is the right place; lift it
   to a higher-visibility section if the ADR moves to Accepted.

7. **Evidence section — add the "Adobe has not blessed third-
   party external-ExtendScript invocation" caveat.** This is
   central to the project and currently only appears in §Open
   questions 4.

8. **Evidence section — flag pre-2022 source policy.** Add a
   sentence: "Pre-2022 third-party CEP guides are not relied on
   (research 01 §Notes — CEP 9 and earlier did not have
   `--enable-nodejs`)."

### To the synthesis (`ae-bridge-research.md`)

1. **§Decision points → §Judgment point 5**: The synthesis says
   "polling at 100–500 ms from the AI agent is acceptable latency
   for the development loop the vision describes". The ADR does
   not adopt this cadence (good — the ADR correctly defers). The
   synthesis should not pre-decide polling cadence either.

2. **§Candidate mechanisms table — M6 verdict.** "Rejected (for
   v1)" but "Re-introduce as a degraded fallback when WebSocket
   cannot bind". The synthesis lists M6 as a v1 fallback. The
   ADR does not mention this. **Recommend the ADR add a sentence
   to §Open questions noting M6 as a reserved fallback** for
   port-collision / firewall scenarios.

3. **§Evidence index — Adobe-CEP org archived date.** The
   synthesis says "org archived 2026-09". The ADR cites this as
   "Adobe-CEP source archived". The synthesis could be more
   specific about *what* is archived (the org, the
   `extendscript-debugger-vscode` repo, the `extendscript-debug`
   repo) and which check confirmed it (`gh api` 404).

### To the research files

1. **research 02 §Unverified items** — add an item noting that
   the AE 25.x enforcement level for `Access-Control-Allow-
   Private-Network` is undocumented. Currently research 05
   carries this; it should appear in research 02's CEP-CEF
   constraint list too.

2. **research 04 §1.6** — note that Adobe Marketplace still lists
   `Adobe.extendscript-debug` (the published extension) even
   though the source repo is 404. This affects how "Adobe still
   ships this" should be characterized.

3. **research 05 §Mitigations required #2** — split into two
   items ("ephemeral port" vs "Unix domain socket") so that the
   ADR doesn't have to write "ephemeral port *or* Unix socket" as
   a single commitment.

---

## Verdict on ADR status

**Status: Proposed is correct. Do not promote to Accepted yet.**

The ADR is honest about its evidence base (Status section lists
three concrete gating requirements for Accepted). The five
judgment points are all addressed at the right level of detail,
and the deferrals (UXP, event sync, Rust-vs-TypeScript, MCP
verbs, distribution) respect vision.md's "未確定" boundaries.

The ADR is **not yet fit for Accepted** because:

1. Three of the most-load-bearing claims — `eval` / `inspect_*`
   verb naming, the "exactly one call site" discipline, and the
   `.zxp` distribution decision — go beyond what the research
   supports. With the recommended fixes above, they all become
   defensible as in-scope decisions; without them, they are
   quiet scope creep.

2. The "single execution primitive" mitigation principle from
   research 05 §T6 #1 is being read as if it prescribed the
   codebase shape. The research lists mitigations; the ADR is
   doing implementation engineering on top of them without
   acknowledging that.

3. The Adobe legitimacy question (research 05 Unverified item
   7) is mentioned in §Open questions but is not surfaced as a
   *risk to the architecture's validity*, not just an open
   question. If Adobe formally objects, the entire M1+M3 stack
   needs revisiting. This belongs in §Risks, not §Open questions.

4. Real-AE testing is genuinely required for the three Status
   gating items. The Status section is correct, and should not
   be relaxed.

**Bottom line:** with the recommended fixes (8 specific changes
to the ADR, 3 to the synthesis, 3 to the research files), the
ADR can move to Accepted once the three Status-gating
conditions are satisfied. As written, the ADR is a sound
Proposed document whose minor over-specifications should be
corrected before it is treated as the binding shape of the
project.

---

## Self-audit: did this verification report extend scope?

1. I did not enumerate MCP tools. ✓
2. I did not pre-decide Rust-vs-TypeScript. ✓
3. I did not specify what `inspect_*` verbs should be (only
   noted the lack of a placeholder list). ✓
4. I did not characterize AE 25.x behavior beyond what the
   research marks as Unverified. ✓
5. I did flag the Adobe legitimacy question as a risk, which
   is *strengthening* scope discipline (it surfaces a constraint
   vision.md and AGENTS.md both omit) — not extending it.
6. I did not decide on distribution channels. ✓
7. I did recommend softening the `.zxp` commitment. ✓

The one place where this verification report *might* be accused
of scope creep is the suggestion to add an `inspect_*`
placeholder list. That suggestion is constrained to "illustrative
verbs the ADR can cite as a placeholder, with an explicit
caveat that the actual list is a v1 design decision" — i.e.,
*less* commitment than the current ADR's bare-named
`inspect_*`. If the maintainer disagrees, the fix can be
ignored without affecting the verdict.