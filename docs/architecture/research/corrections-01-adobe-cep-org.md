# Adobe-CEP Organization: Factual Correction

**Author:** ae-devtools research correction
**Date:** 2026-09-18
**Scope:** Corrects a conflated claim made in commit `fe933c8` about the status of the `Adobe-CEP` GitHub organization. The conflation is **factually wrong** and downgrades the confidence with which downstream documents (ADR-0001, ae-bridge-research synthesis, verification report) treat Adobe's official CEP sources.

---

## What the prior research claimed (quote the offending passages)

The prior research made three classes of claim that need correction. All quotations are taken verbatim from `docs/architecture/research/` and `docs/architecture/`:

1. **Org-level claim** — `research/04-process-architecture.md` §1.1, line 13:

   > "従来のリポジトリ `Adobe-CEP/extendscript-debugger-vscode` と `Adobe/extendscript-debug` は 2026-09 時点でいずれも **404**（GitHub API からも確認済み）。**Adobe-CEP org 自体が archived 状態で、ソースを直接参照できない。**"

2. **Re-statement of the org-level claim** — `research/01-execution-surface.md` §B, line 45:

   > "元リポジトリ `Adobe-CEP/extendscript-debugger-vscode` は現時点で Web 上から到達不能（404）。**Adobe-CEP org 自体が archived/redirect 状態。** 実装ソースを直接確認できないため、内部プロトコルの詳細記述は unverified"

3. **Cross-corroboration in the synthesis** — `docs/architecture/ae-bridge-research.md`, line 117:

   > "`github.com/Adobe-CEP/CEP-Resources` — Authoritative CEP source repo. **Org archived 2026-09-18** (verified by `gh api` checks against `Adobe-CEP/extendscript-debugger-vscode` and `Adobe/extendscript-debug`, both returning 404). The repo remains readable but is no longer maintained."

4. **Treating the verification as confirmed** — `research/06-verification-report.md` C24 (line 156):

   > "**C24** | 'Adobe-CEP source archived' | research 01 §B, research 04 §1.1; `gh api` 404 checks | **Confirmed**"

5. **Down-stream ADR consequence** — `ADR-0001-runtime-bridge.md` line 245 (Alternatives considered):

   > "**Native addon (Adobe VSCode Debugger pattern) as primary AE-side component** | Platform coverage limited to Win + macOS x64; **Adobe-CEP source archived**; not an execution API, a debugger."

6. **Forward-looking assumption** — `research/04-process-architecture.md` §6 Notes, line 323:

   > "本ドキュメントは 2026-09-18 時点の調査であり、**Adobe-CEP org のリポジトリが archived 状態であることを前提にしている**。将来リポジトリが復活・移動した場合は再検証する。"

The 404 observations about the two specific repos are **correct and reproduced below**. The inferential leap from "two legacy repos return 404" to "the entire Adobe-CEP org is archived" is **not correct**.

---

## What is actually true (verified today, 2026-09-18)

1. **The `Adobe-CEP` GitHub organization is not archived.** `gh api orgs/Adobe-CEP` returns `"archived_at": null` and `"public_repos": 3`. GitHub's organization-level archived banner is not shown on `https://github.com/Adobe-CEP`.
2. The organization contains **exactly three public repositories**, all with `archived: false`:
   - `Adobe-CEP/CEP-Resources` (1,842 stars, description: "Tools and documentation for building Creative Cloud app extensions with CEP")
   - `Adobe-CEP/Samples` (1,087 stars, description: "Code samples for CEP extensions")
   - `Adobe-CEP/Getting-Started-guides` (662 stars, description: "Getting Started guides and samples for CEP extensions")
3. **All three repos have activity in 2025 or 2026.** The `updated_at` metadata and the latest commit on the default branch both fall within the 18 months preceding the access date.
4. The legacy `Adobe-CEP/extendscript-debugger-vscode` and `Adobe-CEP/extendscript-debug` repos **do return 404** from the GitHub REST API. The `Adobe/extendscript-debug` repo (different org) also returns 404. These three 404 observations are reproduced and remain accurate.
5. The **Marketplace extension `Adobe.extendscript-debug` is still published by Adobe** at version 2.1.0 (page accessed 2026-09-18). The Marketplace page does not link to a public source repo; the VSCode extension is distributed as a `.vsix`.
6. **The release cadence inside `Adobe-CEP` is repo-specific**, not org-wide. `CEP-Resources` ships via tagged releases (last: CEP11, 2021-05-31) and posts updates as commits to `master` without re-tagging. `Samples` ships no GitHub releases at all. `Getting-Started-guides` ships tagged pre-release VSCode Debugger Plugin builds (last tag `extendscript-debugger` 2.1.0-rc2, 2025-06-18). The mixed cadence was misread as "the org is archived".

---

## Repo-by-repo evidence table

All rows verified 2026-09-18 via `gh api` against `api.github.com`. Branch = default branch (`master` in all three cases).

| Repo | Archived? | Latest commit on default branch | Other recent commit | `updated_at` | Tagged releases (most recent) | Source URL |
|---|---|---|---|---|---|---|
| `Adobe-CEP/CEP-Resources` | **No** | `ab5e4e3` 2026-02-20 — "Update link for CEP 12 HTML Extension Cookbook" | `2ee4783` 2025-06-18 — merge #547 (Illustrator version bump) | 2026-09-17 | CEP11 (2021-05-31) — last tagged release; recent Cookbook updates live on `master` without new tags | https://github.com/Adobe-CEP/CEP-Resources |
| `Adobe-CEP/Samples` | **No** | `e4946b7` 2026-03-24 — merge #136 (ErinFinnegan-patch-1) | `fbc2f2f` 2025-11-11 — "Update readme" | 2026-09-15 | None (no GitHub releases) | https://github.com/Adobe-CEP/Samples |
| `Adobe-CEP/Getting-Started-guides` | **No** | `54cd2d0` 2024-09-06 — "sample id.mxi" | `82d5756` 2023-01-25 | 2026-08-22 (metadata refresh; latest release artifact below) | `extendscript-debugger` **2.1.0-rc2** (2025-06-18) — VSCode Debugger Plugin build; `vscode` 2.1.0-rc1 (2025-04-30) | https://github.com/Adobe-CEP/Getting-Started-guides |
| `Adobe-CEP/extendscript-debugger-vscode` (legacy) | n/a | n/a | n/a | n/a | n/a | **404 (gh api verified)** |
| `Adobe-CEP/extendscript-debug` (legacy) | n/a | n/a | n/a | n/a | n/a | **404 (gh api verified)** |
| `Adobe/extendscript-debug` (different org) | n/a | n/a | n/a | n/a | n/a | **404 (gh api verified)** |

### Reading guide (do not over-claim)

- "Last commit 2026-XX" means the latest commit on the default branch `master`, fetched via `gh api repos/.../commits?per_page=5` on 2026-09-18. This is the most defensible "last activity" metric.
- "`updated_at` 2026-XX" is GitHub's metadata timestamp; it can advance on non-commit events (settings changes, label edits, releases) and is therefore a *weak* signal on its own. It is listed for transparency, not as a maintenance proxy.
- "Latest release" is the most recent **GitHub Release** (`/repos/.../releases`). It does not necessarily track code activity, because (a) `CEP-Resources` ships Cookbook updates as commits only, and (b) `Getting-Started-guides` ships VSCode pre-releases as tags with `published_at` close to the commit date.
- For `Getting-Started-guides`, do **not** state "actively maintained in 2026". The honest statement is "last default-branch commit 2024-09; last GitHub release 2025-06 (VSCode Debugger Plugin 2.1.0-rc2); repo metadata refreshed 2026-08". The `updated_at: 2026-08-22` is consistent with metadata-only churn (e.g., default-branch rename or topic edits), not with new content.

---

## Documents that need correction (list specific files + line/section references)

1. **`docs/architecture/research/04-process-architecture.md`**
   - §1.1, line 13 — replace "Adobe-CEP org 自体が archived 状態" with "The two legacy `extendscript-debug*` repos return 404; the `Adobe-CEP` org itself is **not** archived and still maintains three public repos with 2025–2026 activity".
   - §6 Notes, line 323 — delete "Adobe-CEP org のリポジトリが archived 状態であることを前提にしている". Forward-looking assumption should be scoped to the two specific 404'd repos.

2. **`docs/architecture/research/01-execution-surface.md`**
   - §B, line 45 — replace "Adobe-CEP org 自体が archived/redirect 状態" with "The two legacy `extendscript-debug*` repos return 404; the `Adobe-CEP` org itself is **not** archived".
   - §References, item 8 (line 134 area) and §Unknowns / closing caveats — same correction.

3. **`docs/architecture/ae-bridge-research.md`**
   - Line 117 — replace "**Org archived 2026-09-18** (verified by `gh api` checks ...)" with "Org is **not** archived as of 2026-09-18 (`archived_at: null`); the two probed `extendscript-debug*` repos return 404 but `CEP-Resources` (last commit 2026-02-20), `Samples` (2026-03-24), and `Getting-Started-guides` (release 2025-06-18) remain active".

4. **`docs/architecture/ADR-0001-runtime-bridge.md`**
   - Line 245 (Alternatives considered, M4 row) — replace "Adobe-CEP source archived" with "Adobe-CEP source for the legacy `extendscript-debug*` repos returns 404; the `Adobe-CEP` org remains active and `CEP-Resources` is the authoritative source for CEP specs".
   - Line 468 (References) — keep the `gh api` 404 evidence but note in the same bullet that the org itself is not archived.

5. **`docs/architecture/research/06-verification-report.md`**
   - Row C24, line 156 — change the verdict from **Confirmed** to **Partially wrong / scope error**: "the 404 checks are real and reproducible for the two named repos; the *inferred* claim that the org is archived does **not** hold as of 2026-09-18".
   - §Evidence index item 3, lines 367–372 — rewrite to distinguish (a) `archived_at: null` on the org, (b) three active repos with 2025–2026 activity, (c) two specific 404'd legacy repos, and (d) `Adobe.extendscript-debug` Marketplace status.

6. **`docs/architecture/research/02-cep-deep-dive.md`, `03-state-events.md`, `05-security.md`**
   - All three quote CEP 12 Cookbook content with attribution to `github.com/Adobe-CEP/CEP-Resources/...`. The attribution chain is **unaffected** by this correction — the Cookbook URL is still authoritative. No edits required unless those files also re-state the org-archived claim (spot-check showed they do not, but a second pass is warranted during apply).

7. **`docs/architecture/research/01-execution-surface.md` §References items 1, 8** — access-date annotation already says 2026-09-18 and the URLs resolve. No edit required.

---

## Evidence (URL — date)

- `https://api.github.com/orgs/Adobe-CEP` — 2026-09-18 — `"archived_at": null`, `"public_repos": 3`, `"login": "Adobe-CEP"`.
- `https://api.github.com/orgs/Adobe-CEP/repos?per_page=100` — 2026-09-18 — list of the 3 public repos, all with `archived: false`.
- `https://api.github.com/repos/Adobe-CEP/CEP-Resources` — 2026-09-18 — `archived: false`, `pushed_at: 2026-02-20`, `updated_at: 2026-09-17`, 1,842 stars.
- `https://api.github.com/repos/Adobe-CEP/CEP-Resources/commits?per_page=5` — 2026-09-18 — top commit `ab5e4e3` 2026-02-20 "Update link for CEP 12 HTML Extension Cookbook".
- `https://api.github.com/repos/Adobe-CEP/CEP-Resources/releases` — 2026-09-18 — 5 releases; most recent `CEP11` 2021-05-31.
- `https://api.github.com/repos/Adobe-CEP/Samples` — 2026-09-18 — `archived: false`, `pushed_at: 2026-03-24`, `updated_at: 2026-09-15`, 1,087 stars.
- `https://api.github.com/repos/Adobe-CEP/Samples/commits?per_page=5` — 2026-09-18 — top commit `e4946b7` 2026-03-24 merge of ErinFinnegan-patch-1.
- `https://api.github.com/repos/Adobe-CEP/Samples/releases` — 2026-09-18 — empty list (no GitHub releases).
- `https://api.github.com/repos/Adobe-CEP/Getting-Started-guides` — 2026-09-18 — `archived: false`, `pushed_at: 2025-06-18`, `updated_at: 2026-08-22`, 662 stars.
- `https://api.github.com/repos/Adobe-CEP/Getting-Started-guides/commits?per_page=5` — 2026-09-18 — top default-branch commit `54cd2d0` 2024-09-06 "sample id.mxi".
- `https://api.github.com/repos/Adobe-CEP/Getting-Started-guides/releases` — 2026-09-18 — most recent release `extendscript-debugger` 2.1.0-rc2 published 2025-06-18; previous `vscode` 2.1.0-rc1 2025-04-30.
- `https://api.github.com/repos/Adobe-CEP/extendscript-debugger-vscode` — 2026-09-18 — **HTTP 404** (response: `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}`).
- `https://api.github.com/repos/Adobe-CEP/extendscript-debug` — 2026-09-18 — **HTTP 404** (same response shape).
- `https://api.github.com/repos/Adobe/extendscript-debug` — 2026-09-18 — **HTTP 404**.
- `https://api.github.com/search/repositories?q=org:Adobe-CEP` — 2026-09-18 — `total_count: 3`; the org has exactly three public repos (no private results visible to the search API).
- `https://github.com/Adobe-CEP` — 2026-09-18 (WebFetch) — page renders 3 repos, none shown as archived; no org-level archived banner.
- `https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug` — 2026-09-18 (WebFetch) — extension `Adobe.extendscript-debug` 2.1.0 still published by Adobe; page does not link to a public source repo.

---

## Unverified items

- **Whether `Adobe-CEP` org members include Adobe employees today.** `gh api orgs/Adobe-CEP` does not return a `members_url` listing for non-admins; we did not enumerate members. Inferred from commit authorship on `ErinFinnegan-patch-*` PRs (Erin Finnegan) that at least one Adobe employee maintains `Samples` and `Getting-Started-guides`; this is **inferred**, not verified against a member list.
- **Whether the 404'd repos (`extendscript-debugger-vscode`, `extendscript-debug`) were renamed, moved to a different org, or deleted.** No redirect target was followed; the `gh api` 404 carries no `moved_to` field. Plausible explanations include a private mirror under `Adobe-CEP/Getting-Started-guides` (which does ship `extendscript-debugger` 2.1.0-rc2 as a release), but this is **inferred** from the release artifact, not confirmed.
- **The exact publication mechanism for `Adobe.extendscript-debug` 2.1.0 on the Marketplace** (auto-build from a private repo, manual upload, or vendor pipeline). Not visible from public sources.
- **The date of the most recent `CEP-Resources` Cookbook content change inside the repo tree.** We have the `master`-tip commit date (2026-02-20). Sub-tree edits via the GitHub web UI (which can bypass commits) were not enumerated.
- **Whether `Adobe-CEP` had additional private repos that are no longer visible** to a non-member `gh api` token. We can only assert about `public_repos: 3`.

---

## Impact assessment

- **No impact on the CEDP-bridge architecture decision.** ADR-0001 already rejected the Adobe VSCode Debugger pattern as the primary AE-side component (Decision 4) on the grounds of *platform coverage*, *debugger-vs-execution-API mismatch*, and *unverifiable source* — not on the grounds of org archival. Replacing "org archived" with "two legacy repos 404'd" preserves the rejection logic.
- **No impact on `CEP-Resources` Cookbook citations.** The Cookbook URLs (`raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/...`) resolve and the content is current as of 2026-02-20. Citations remain authoritative.
- **Modest impact on confidence language.** Phrases like "the org is no longer maintained" should be replaced with "two specific legacy `extendscript-debug*` repos are unreachable; the org itself remains active with three repos showing 2025–2026 activity". This is a net **upward** correction in source quality, not a downward one.
- **No code, no contract, no API surface is affected** by this correction. The change is entirely in the *narrative* about the org, not in the technical evidence.
