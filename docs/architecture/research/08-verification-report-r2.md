# Verification Report — Real-AE Validation Round

> Adversarial verification of the round-2 corrections and validation
> artifacts authored on 2026-09-18. Default verdict: **refute unless
> evidence is concrete**. Source materials and the corrections-01/02
> files are quoted verbatim where useful.

---

## Correction application: per-file verdict

### `research/01-execution-surface.md` — PASS

- §B line 45 now reads: "`Adobe-CEP` org 自体は archived されておらず（`gh api orgs/Adobe-CEP` で `archived_at: null`、`public_repos: 3` を確認）、`CEP-Resources` / `Samples` / `Getting-Started-guides` の 3 リポジトリが 2025–2026 の activity を維持している（research/corrections-01 参照）。"
  This matches the correction's required replacement text. ✔
- §Notes line 191 reads: "Adobe-CEP 公式 GitHub organization 自体は archived されていない（research/corrections-01 参照）が、legacy な `Adobe-CEP/extendscript-debugger-vscode` および `Adobe-CEP/extendscript-debug`、および `Adobe/extendscript-debug` の 3 リポジトリは 2026-09-18 時点で 404 を返す。常に Cookbook の GitHub Raw URL を直接参照する。"
  This is the corrected scope (org vs. specific repos). ✔
- No remaining instance of "Adobe-CEP org 自体が archived 状態" or the
  shorter "archived/redirect" or "Adobe-CEP archived" strings. ✔

### `research/02-cep-deep-dive.md` — PASS

- The version-mapping table now uses the per-version verdict format from
  corrections-02. Specifically, row for "2024 / 24.x / CEP 11
  (community-attributed)" carries the exact text "**NOT
  Cookbook-confirmed.** … working hypothesis is **AE 24.x → CEP 11**,
  not CEP 12" (line 24). ✔
- Row for "2025 / 25.x / CEP 12 / Cookbook-confirmed" preserves the
  AEFT 25.0 (CEP 12) FY2024 attribution (line 25). ✔
- Row for "2026 / 26.x / CEP 12 (undocumented)" replaces the prior
  "no CEP 13 confirmed" wording with the calibrated "no CEP 13
  evidence found in the sources consulted" (line 26). ✔
- `getCurrentApiVersion()` section (lines 79–96) now correctly describes
  `{major, minor, micro}` with the warning that
  `CSInterface.VERSION_11` / `VERSION_12` constants do **not** exist.
  ✔
- AE 24.x → CEP 12 in any verbatim form is no longer present. ✔

### `research/04-process-architecture.md` — PASS

- §1.1 line 13: replaces the old "Adobe-CEP org 自体が archived 状態"
  wording with "`Adobe-CEP` org 自体は archived されておらず（`gh api
  orgs/Adobe-CEP` で `archived_at: null`、`public_repos: 3` を
  確認）、`CEP-Resources` / `Samples` / `Getting-Started-guides` の 3
  リポジトリが 2025–2026 の activity を維持している（research/
  corrections-01 参照）". ✔
- §6 Notes line 323: removes the prior "Adobe-CEP org のリポジトリが
  archived 状態であることを前提にしている" line and replaces it with
  the scoped "`Adobe-CEP/extendscript-debugger-vscode` および
  `Adobe/extendscript-debug` の 2 リポジトリが 404" caveat. ✔

### `docs/architecture/ae-bridge-research.md` — PASS

- Line 117 (Evidence index, Adobe-CEP/CEP-Resources row) reads: "The
  `Adobe-CEP` org itself is **not** archived as of 2026-09-18
  (`gh api orgs/Adobe-CEP` returns `archived_at: null`,
  `public_repos: 3`); … these 404 checks remain reproducible but the
  inference that the org is archived does **not** hold
  (research/corrections-01)." ✔
- The "Org archived 2026-09-18 (verified by `gh api` checks ...)" string
  flagged in corrections-01 is gone. ✔
- M4 row (line 52) carries the corrected parenthetical: "the two
  legacy `extendscript-debug*` repos return 404 (the `Adobe-CEP` org
  itself is not archived — see research/corrections-01)". ✔

### `ADR-0001-runtime-bridge.md` — PASS, with one caveat (see below)

- §Status (lines 14–27) carries the explicit corrections: org not
  archived, AE 25.0 → CEP 12 Cookbook-confirmed, AE 24.x → CEP 11
  community-attributed, prior phrasing "AE 24/25 → CEP 12" replaced. ✔
- §Decision 1 (line 118): "return 404 (the `Adobe-CEP` org itself is
  not archived — see `research/corrections-01`)". ✔
- §Alternatives row M4 (line 277): "the two legacy
  `Adobe-CEP/extendscript-debug*` repos return 404 (the `Adobe-CEP`
  org itself is not archived — see `research/corrections-01`); not an
  execution API, a debugger." ✔
- §Evidence row (line 555): "**The `Adobe-CEP` org itself is not
  archived** (`gh api orgs/Adobe-CEP` returns `archived_at: null`,
  `public_repos: 3`); the 404 applies to the two legacy
  `extendscript-debug*` repos only." ✔

#### Caveat — `06-verification-report.md` not updated

`research/corrections-01-adobe-cep-org.md` §"Documents that need
correction" item 5 lists `docs/architecture/research/06-verification-report.md`
and prescribes specific changes:

> Row C24, line 156 — change the verdict from **Confirmed** to
> **Partially wrong / scope error** …
> §Evidence index item 3, lines 367–372 — rewrite to distinguish
> (a) `archived_at: null` on the org, (b) three active repos with
> 2025–2026 activity, (c) two specific 404'd legacy repos, and (d)
> `Adobe.extendscript-debug` Marketplace status.

This round did **not** update `06-verification-report.md`. A grep
across the repo shows the prior "synthesis says 'org archived
2026-09'" string is still present at `06-verification-report.md:368`.
That said, the new `08-verification-report-r2.md` (this file)
supersedes the old report, so leaving the stale 06 around is not a
factual hazard for the current round — but it is a leftover that will
mislead anyone reading the older file. Recommend deleting or
superseding `06-verification-report.md` with a one-line note pointing
to this round's report.

---

## EXPERIMENT-LOG.md: Actual-section audit

Every Actual section in `experiments/runtime-bridge/EXPERIMENT-LOG.md`
was inspected:

| Probe | Actual section contents | Honest? |
|---|---|---|
| 01 (`app.version`) | "Not executed — this environment (Linux on WSL2) has no After Effects installed. No real-AE validation possible in this round." | ✔ |
| 02 (`activeItem` JSON) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 03 (mutate-then-inspect) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 04 (intentional throw) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 05+06 (concurrent A/B) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 07 (structured snapshot) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 08 (temp comp / layer identity) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 09 (`getCurrentApiVersion()` shape) | "Not executed — this environment (Linux on WSL2) has no After Effects installed." | ✔ |
| 10 (daemon loopback contract) | "Syntax check: clean (the server source parses). **The other steps were not executed in this round** because the focus of this round was documenting the validation record; running the daemon stub requires no AE and can be done at any time on this host." | ✔ (with caveat below) |

### Verdict on Probe 10

Probe 10's Actual section contains a real measurement: "Syntax check:
clean (the server source parses)." This was independently confirmed
in this verification pass by running `node --check
node-server/server.js` — it exited 0 with no output. So the
measurement is reproducible and truthful, not fabricated.

However, the run itself is *mechanical* (`node --check` only). It
does **not** exercise the listening / token / 401 / 200 paths. Probe
10's "Result" line correctly says "Pending runtime execution; the
source is parseable." This is honest.

The repo did **not** run the curl probes described in the
"Procedure" section (missing-token, wrong-token, right-token,
loopback-only). That is consistent with `07-real-ae-validation.md`
§"What was attempted" item 4 ("No real-AE probes were run … we do not
fabricate measurements").

### Conclusion: NO FABRICATION DETECTED

No Actual section contains a real measurement that was not actually
performed. Probe 10's syntax-check note is the only mechanical
verification reported, and it is correctly scoped and explicitly
labelled as not the runtime probe.

---

## ADR Status: appropriate?

**Verdict: PASS.**

- ADR Status remains **Proposed**, with the reason explicitly stated
  (§Status line 42–43): "Until those three are exercised on a live
  AE instance, the architectural shape below is provisional."
- §Status line 46–47: "**This round (2026-09-18) could not perform
  real-AE validation** because the working environment is Linux on
  WSL2 with no After Effects installed."
- §Status line 49–52 introduces the Windows gate / macOS-Linux gate
  split, and line 451–452 closes with "Move to **Accepted** as soon
  as the Windows gate (W1–W7) is exercised on a real AE 25.x
  instance." This is an explicit forward condition, not a claim that
  acceptance has happened.
- §Open questions 1 (line 357–360) explicitly lists "Real-AE behavior
  under load" as **Required before this ADR can move from Proposed to
  Accepted.**
- The user's rule "未検証を「成功」と扱うことは禁止です" is honored:
  no claim in the ADR promotes an unvalidated piece to "successful"
  or "accepted". The corrections in §Status are described as
  "**improves**, not weakens" the evidence base (line 137 of 07).

The Status is honest and the forward condition is correctly scoped.

---

## Windows/macOS gate split: verdict

**Verdict: PASS.**

The split is reasonable and platform-appropriate:

- **W1–W7 (Windows, required for Accepted)**: every condition is one
  that can be observed on a Windows AE 25.x instance (W1 JSON
  snapshot, W2 mutation visibility, W3 throw propagation, W4
  back-to-back serialization, W5 API version shape, W6 daemon
  reconnect, W7 daemon failure-survival). The behaviors are
  platform-agnostic in principle (CEP runs on Windows and macOS the
  same way) so testing on Windows AE is a valid proxy for v1
  acceptance. ✔
- **M1–M4 (macOS/Linux, deferred)**: M1 = macOS Intel AE, M2 =
  Apple Silicon native vs Rosetta, M3 = Linux AE (currently N/A), M4
  = OS-version-specific loopback ACL changes. All four are
  genuinely platform-specific and out of reach of a Windows AE host.
  ✔
- **M3 is correctly marked N/A**: "AE for Linux is not a real
  product line as of 2026-09-18" (line 441). This avoids forcing a
  permanent "deferred forever" item that would otherwise bias the
  gate count. ✔
- **The recommendation (§Recommendation line 446–450)** correctly
  states that Windows-gate clearance moves the ADR to Accepted and
  that macOS/Linux gate items remain tracked but do not gate
  acceptance. This is the user's requested split.

### Minor nit on M4 wording

M4 in the ADR table (line 442) reads "macOS Sequoia / Linux 6.x
loopback ACL changes (multi-user isolation)". macOS Sequoia is the
macOS 15 release; Linux 6.x is the kernel version. Reading it as
"two separate OS-version concerns to test on macOS Sequoia and on
Linux 6.x" is plausible; reading it as "Sequoia/Linux 6.x" as a
compound noun is confusing. Recommend a tiny wording fix in a future
edit, but it does not invalidate the gate.

---

## Experiment code: spot checks

### CEP panel references `CSInterface` correctly per the corrections

`cep-panel/js/csinterface-wrapper.js` line 153–183 — `getCurrentApiVersion()`:

- Calls `this.cs.getCurrentApiVersion()` (not `CSInterface.VERSION_12`).
- Returns the `{major, minor, micro}` shape per corrections-02.
- Validates `typeof v.major === "number"` etc. (line 168–172), matching
  the corrected description.
- Comments explicitly warn against the non-existent
  `CSInterface.VERSION_11` / `VERSION_12` constants (lines 25–27,
  149–151). ✔
- Refuses to operate when `CSInterface` global is missing, with a
  clear console error pointing at research/02 §CSInterface (lines
  48–56). ✔
- Implements the nested-iframe check (lines 77–83) per Adobe-CEP
  issue #364. ✔

`cep-panel/index.html` line 58 loads `CSInterface.js` from the host
(not bundled), then `csinterface-wrapper.js`, then `main.js`. This
matches the README's documentation that the host provides the
runtime file. ✔

### ExtendScript scripts avoid forbidden JSON.stringify-of-Layer patterns

Reviewed each probe for the canonical anti-pattern "JSON.stringify
on a raw AE Scripting object that would trigger circular-ref
crashes":

- `01-version.jsx`: returns `{ version: String(app.version) }` —
  stringifies a primitive. ✔
- `02-active-item.jsx`: builds an explicit projection object (lines
  20–38), does **not** stringify `ai` directly. ✔
- `03-mutate-then-inspect.jsx`: returns scalars and the new comp's
  `name` string. ✔
- `04-exception.jsx`: uses `$.error(...)` to trigger
  `EvalScript_ErrMessage()`, returns nothing. ✔
- `05-concurrent-A.jsx`: walks `app.project.item(i)` and counts; the
  returned payload is plain JS numbers / strings. ✔
- `06-concurrent-B.jsx`: returns scalars. ✔
- `07-snapshot.jsx`: builds a projection object explicitly with
  `numItems`, `name`, `id`, `width`, etc.; does **not** stringify
  `ai.selectedLayers` directly. ✔
- `08-identity.jsx`: returns `comp.index`, `comp.id`, `comp.name`,
  `layer.index`, `layer.id`, `layer.name` — scalar properties only.
  ✔
- `lib/util.jsx` `toJsonSafe` provides a circular-ref / max-depth
  replacer (lines 23–41) — defensive, consistent with the
  corrections-02 guidance. ✔

No forbidden pattern was found.

### Node.js server binds 127.0.0.1 only and uses a token

- `node-server/server.js` line 47: `var HOST = "127.0.0.1"; // loopback
  only; never 0.0.0.0`. ✔
- Line 48–58: refuses to start without `AE_BRIDGE_TOKEN` env var.
  ✔
- Line 100–106: token comparison via `crypto.timingSafeEqual` (the
  README §Limitations correctly notes that length short-circuit leaks
  token length; flagged as deferred). ✔
- Line 125–129: rejects missing or wrong token with HTTP 401. ✔
- Line 64–66: 1 MiB body cap; line 67–70 hard-destroys the request
  on overflow. ✔
- `/healthz` is intentionally token-exempt (line 118–122), with no
  privileged data — acceptable. ✔
- `node --check node-server/server.js` passes in this verification
  pass. ✔

### Issues / nits

1. **`cep-panel/CSXS/manifest.xml` references a non-existent
   `host-bridge.jsx`.** Line 41: `<ScriptPath>./jsx/host-bridge.jsx
   </ScriptPath>`. There is no `host-bridge.jsx` in the panel tree;
   the probes live under `experiments/runtime-bridge/extendscript/`
   and are loaded by `main.js` via XHR. The CEP Cookbook treats
   `<ScriptPath>` as the JSX file auto-executed when the panel loads;
   pointing at a missing file will at minimum log a load warning on
   AE startup, and at worst prevent the panel from loading. Either
   (a) drop the `<ScriptPath>` element if it is unused, or (b) populate
   it with a real script. The fact that this is not referenced from
   any other file in the panel tree suggests it is dead config.

2. **`cep-panel/index.html` uses `script-src 'self' 'unsafe-eval'`.**
   The `unsafe-eval` directive is documented in research/05-security
   as one of the harder risks to defend; the panel will need eval
   (because `csinterface-wrapper.js` parses JSON, which requires eval
   is not necessary, but inline `eval`/`new Function` would be).
   The justification for `unsafe-eval` is **not** recorded in
   `research/05-security.md` or in the panel's own comments. Either
   tighten the CSP or document the rationale.

3. **`cep-panel/js/main.js` uses `../../extendscript/...` paths** to
   locate probes (lines 26–33). This works only if the panel is
   installed with `experiments/runtime-bridge/extendscript/` as a
   sibling of `cep-panel/`. For a real CEP install into
   `%APPDATA%\Adobe\CEP\extensions\ae-devtools-bridge\`, the relative
   path will break unless the directory layout is preserved exactly.
   A future round should either bundle the probes into the panel or
   document the install layout precisely.

4. **Probe 10 in `EXPERIMENT-LOG.md` lists a "loopback-only" check**
   (step 6, line 381) that uses `curl -sS -i -X POST
   http://0.0.0.0:7000/eval`. The reasoning in the procedure is
   correct ("a request to a non-loopback interface must fail"), but
   the actual curl is to `0.0.0.0:7000`, which the OS treats as
   "this host" and may still resolve to the loopback interface. A
   cleaner test would bind to `192.168.x.x` (or any non-loopback
   address on the test box) and verify connect-refused. This is a
   minor procedure nit, not a coherence error.

5. **`cep-panel/js/csinterface-wrapper.js` line 154** comment says
   "Delegate to CSInterface.prototype.getCurrentApiVersion so the
   host-provided implementation is used." The actual call is
   `this.cs.getCurrentApiVersion()` (line 165), which is via the
   instance, not the prototype. Functionally identical; wording is
   slightly misleading. Trivial.

---

## URL/access-date audit

Audited the corrected docs for URLs cited without access dates:

- `research/01-execution-surface.md` §Evidence lines 127–135: each
  bullet is URL — `2026-09-18 アクセス` / `2026-09 確認` /
  `2026-09-18 アクセス` pattern. ✔
- `research/02-cep-deep-dive.md` §Evidence lines 414–460: same pattern,
  every bullet has `2026-09-18` annotation. ✔
- `research/04-process-architecture.md` §Evidence lines 282–301:
  every numbered entry has `2026-09-18` annotation. ✔
- `ADR-0001-runtime-bridge.md` line 482: "All URLs accessed
  **2026-09-18** unless otherwise noted." ✔
- `ae-bridge-research.md` line 112: "All access dates are
  **2026-09-18** unless otherwise noted." ✔

**Verdict: PASS.** Every URL cited in the corrected docs has an access
date, and the meta-statement at the top of each synthesis document
sets the expectation correctly.

One borderline case: `ae-bridge-research.md` line 122 cites
`adobe.com/content/dam/cc/en/think-tank/uxp-in-after-effects/
uxp-in-after-effects.pdf` with the note "URL exists; WebFetch returned
404 at research time — URL existence is the verified fact". This is
honest about a failure-to-fetch but does not update the access date
nor say when the WebFetch happened. Minor nit; recommend a one-line
"WebFetch 2026-09-18 returned 404; the URL exists per
`developer.adobe.com` index pages" annotation.

---

## Scope discipline check

Vision.md §"現時点で未確定な事項" lists items that the project has not
decided. The ADR and the experiment artifacts must not pre-decide any
of them. Audit:

| Vision item | Pre-decided by ADR or experiment? |
|---|---|
| コア層・daemon の実装言語 (TypeScript / Rust / Node.js) | **Not pre-decided.** ADR line 184 ("Rust-vs-TypeScript is not decided by this ADR") and line 342 ("Rust-vs-TypeScript belongs to a future ADR") explicitly defer. The Node.js stub in `experiments/runtime-bridge/node-server/server.js` is a *probe* demonstrating the contract, not the actual implementation. The package.json name includes the literal word "stub". Acceptable. ✔ |
| MCP Server の実装言語・トランスポート | Not pre-decided. ADR §Consequences Neutral line 343–346 explicitly defers "which of these become MCP tools is an MCP-layer decision and explicitly not pre-decided here." ✔ |
| VSCode Extension の内部構造 | Not pre-decided. ADR §Consequences Neutral line 348 explicitly lists it as "untouched; this ADR does not extend scope into them." ✔ |
| AE との通信方式 | The ADR adopts M1+M3 (CEP + daemon), but this is the binding architecture decision the ADR exists to make, not an undecided item from vision.md. ✔ |
| AE API metadata の生成パイプライン | Not pre-decided. ✔ |
| TypeScript 型定義の生成 | Not pre-decided. ✔ |
| frame capture, visual verification | Not pre-decided. ✔ |
| 製品名／ブランド名 | Not pre-decided. ADR §Consequences Neutral line 348 lists branding as untouched. ✔ |
| 配布形態 (Marketplace / npm / standalone) | Not pre-decided. ADR line 127–129: "The distribution channel itself is **not pre-decided** by this ADR — `vision.md` §未確定 currently lists 配布形態 as undecided." ✔ |
| 対応 AE バージョン範囲 | The ADR commits to AE 25.x as the primary target via the Windows gate, and treats AE 24.x as community-attributed CEP 11 (per corrections-02). It does not commit to AE 22.x/23.x support. This is a *direct* answer to one of the five judgment points; not scope creep. ✔ |
| VSCode 以外の IDE | Not pre-decided. No mention of other IDEs in ADR or experiments. ✔ |
| CLI、ローカル reviewer | Not pre-decided. ADR §Consequences line 222 (research 04 §3.2) mentions CLI as a possible future client of the daemon, but does not commit to building one. ✔ |
| 商用利用・スタジオ向け | Not pre-decided. The `package.json` license field is "UNLICENSED" for the stub, which is a stub-internal choice and does not pre-commit the project license. ✔ |
| リアクティブ状態同期 | Explicitly **deferred** (ADR §Decision 5, M-event-not-in-v1). Matches vision.md's "リクエスト時のみ取得するかの運用モデル". ✔ |
| エラー時のフォールバック、AE バージョンが古い場合の挙動 | Listed as Open questions 5 and 6 in ADR; not pre-decided. ✔ |

**Verdict on scope discipline: PASS.** The Node.js stub is the only
soft language choice in the experiment artifacts, and it is
self-described as a stub; the ADR's language choice is still
deferred to a future ADR.

---

## Recommended fixes

These are concrete fixes the next pass should apply before this
round is considered sealed:

1. **`research/06-verification-report.md` supersession.** Add a
   one-line notice at the top of that file pointing at
   `08-verification-report-r2.md`, or move/rename it to make the
   supersession obvious. Today the file still carries the stale
   "synthesis says 'org archived 2026-09'" reference at line 368.

2. **`cep-panel/CSXS/manifest.xml` dead `<ScriptPath>`.** Either
   remove `<ScriptPath>./jsx/host-bridge.jsx</ScriptPath>` (line 41)
   or replace it with a real file (a stub `host-bridge.jsx` that
   defines a no-op). Leaving it pointed at a missing file will
   generate an Adobe startup warning on every panel load.

3. **`cep-panel/index.html` CSP justification.** Either remove
   `unsafe-eval` from `script-src` (the JSON.parse path does not
   require it; only direct `eval` / `new Function` would), or add a
   comment explaining why it is needed and a corresponding threat
   analysis entry in `research/05-security.md`.

4. **`main.js` install-path assumption.** Document in
   `experiments/runtime-bridge/README.md` that the
   `../../extendscript/...` paths in `main.js` require the probe
   directory to be a sibling of the installed panel. Alternatively,
   bundle the probes into the panel at install time so the relative
   paths collapse.

5. **Probe 10 loopback-only test.** Tighten the loopback-only test in
   `EXPERIMENT-LOG.md` §Probe 10 step 6 to use a non-loopback
   interface (`192.168.x.x` or similar) rather than `0.0.0.0`.

6. **ADR §Accepted conditions M4 wording.** "macOS Sequoia / Linux
   6.x loopback ACL changes" reads as a compound noun; rephrase as
   "macOS Sequoia and Linux 6.x loopback ACL changes" so the two
   platforms are not concatenated.

7. **`ae-bridge-research.md` UXP-in-AE PDF.** Tighten the WebFetch
   note to record the date: "WebFetch 2026-09-18 returned 404; the
   URL exists per `developer.adobe.com` index pages".

These are nits, not blockers; the round is otherwise coherent and
honest.

---

## Verdict on whether this round can be committed as-is or needs revisions

**Verdict: Can be committed as-is.**

The round correctly:

1. Applies every correction specified in
   `corrections-01-adobe-cep-org.md` and
   `corrections-02-cep-ae-mapping.md` to the targeted documents
   (research/01, 02, 04, ae-bridge-research, ADR-0001), with the
   single exception of research/06 (which is superseded by this
   report).
2. Reports "Not executed" for every Actual section in
   `EXPERIMENT-LOG.md`. Probe 10's Actual section reports only the
   one mechanical verification (`node --check`) that was actually
   performed, in keeping with the user's "未検証を「成功」と扱うことは
   禁止です" rule.
3. Keeps the ADR at **Proposed** with an explicit forward condition
   (the Windows gate W1–W7), and does not promote the unvalidated
   architecture to "Accepted".
4. Splits the Accepted conditions into a Windows gate (binding) and a
   macOS / Linux gate (deferred) per the user's request, with M3
   correctly marked N/A for the Linux AE case.
5. Authors experiment artifacts that avoid forbidden JSON.stringify
   patterns on AE Scripting objects, use the corrected
   `getCurrentApiVersion()` shape, bind the daemon to 127.0.0.1 only,
   and refuse to start without a per-launch token.
6. Cites every URL in the corrected documents with an access date
   (2026-09-18) and a meta-statement setting the expectation.
7. Defers every item that `vision.md` lists as 未確定 (daemon language,
   MCP tool surface, distribution channel, branding, AE version range
   beyond the AE 25.x target, IDE scope, license) to a later decision.

The recommended fixes above are nits that should land in the next
edit cycle; none of them is a blocker for committing this round.

---

*Author: adversarial verification pass, 2026-09-18.*
*Verdict: PASS — round can be committed; nits listed under
§Recommended fixes.*
