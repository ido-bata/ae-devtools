# ADR-0002 — Governance Reconciliation (multi-AI-agent project-local env)

> Status: **Proposed** (2026-09-18). Sealed records the reconciliation pass; promotion to Accepted is automatic once ADR-0003, -0004, -0012, -0014 also reach Proposed and the init checklist (see §Self-verify) is satisfied.

---

## Status

**Proposed.** This ADR records the project-local governance reconciliation pass performed on 2026-09-18 against the multi-AI-agent concurrent-development policy described in `AGENTS.md` §10–§17. It is the entry point that links the policy to the concrete files written in this round (AGENTS.md dispatcher, docs/ skeleton, .github/ templates, skills/ index, ADR-0003 / -0004 / -0012 / -0014).

The reconciliation respects AGENTS.md §1 ("ビジョン未確定を勝手に固定しない"); it does not pre-decide any of `docs/vision.md` §"現時点で未確定な事項" (core implementation language, MCP transport, VSCode Ext internals, AE communication channel, AE API metadata pipeline, TypeScript type generation, frame capture, branding, distribution channel, supported AE version range, IDE scope, commercial model, reactive state sync, fallback). The governance skeleton only adds structure that exists independently of those decisions.

---

## Context

The repository has reached the point where `main` exists with README / AGENTS.md / LICENSE / .gitignore / docs/vision.md / docs/architecture / experiments/runtime-bridge probes committed (3 commits, head SHA `97a0823d`), but no GitHub Issues / Pull Requests, no `.github/` templates, no CODEOWNERS, no branch protection, no `docs/` development / release / security / recovery / onboarding / troubleshooting skeleton, no Skills directory, no governance ADR beyond `ADR-0001-runtime-bridge.md`, and no canonical pointer showing which ADR is the source of truth for which rule.

The multi-AI-agent concurrent-development policy is described in detail in `AGENTS.md` §10–§17. It commits to:

- independent mutable runtime per implementation worker
- weekly release sprint with `release-x-y-z` integration branch and Issue-number-only ticket branches
- published remote head + immediate Draft PR for every active durable ticket branch
- independent / stacked PR topology with stack-aware reconciliation gate
- explicit user authorization for `release-x-y-z → main` merge
- durable checkpoint + soft / hard distinction + recovery algorithm that allows a fresh agent to reconstruct state without conversation history
- adaptive quality profile compiled from current official guidance (no fixed bundle)
- source / docs / GH language policy (English source; Japanese docs / Issues / PRs)
- canonical SoT separation: GitHub Issues for ticket / dependency, GitHub Projects (or Linear) for planning, Git for source, ADR for design

Without an enforceable skeleton, the policy remains aspirational and decays into whatever convention each new contributor happens to bring.

---

## Decision

This round reconciles the existing repository state with the policy by:

1. **Turning AGENTS.md into a dispatcher.** Existing §1–§9 are preserved verbatim; §10–§17 are added as the governance skeleton, with explicit pointers to `docs/vision.md`, `docs/development.md`, `docs/release.md`, `docs/security.md`, `docs/recovery.md`, `docs/onboarding.md`, `docs/troubleshooting.md`, `docs/architecture/decisions/`, `skills/`, and the GitHub Issues / Pull Requests surfaces.
2. **Authoring the docs/ skeleton** in `docs/{development,release,security,recovery,onboarding,troubleshooting}.md`, with a `docs/architecture/decisions/README.md` index. Each doc states its canonical scope and points at the relevant ADR.
3. **Drafting the four governance ADRs** (ADR-0003 weekly release sprint, ADR-0004 recovery checkpoint model, ADR-0012 release merge authorization, ADR-0014 Linear profile) that the policy insists on but the repository did not previously have. All four are written in English, in the same Status / Context / Decision / Why / Consequences / Open questions / Evidence / References format as ADR-0001.
4. **Authoring `.github/` templates**: `CODEOWNERS`, `ISSUE_TEMPLATE/{bug,feature,architecture}.yml`, `PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`, and a `.github/workflows/release-source-check.yml` referenced from `docs/release.md` for the case where rulesets cannot constrain PR head branches.
5. **Creating `skills/`** with a `dispatch-index.md` entrypoint and an SKILL.md stub for each of the standard skills enumerated in `AGENTS.md` §17 (parallel-orchestration, sandbox-runtime, github-delivery, agent-delivery-estimation, quality-gate, engineering-decisions, security-maintenance, onboarding, agent-recovery, correctness-assurance, policy-evaluation, design-refinement, writing-discipline, interaction-discipline, linear-release-control, worktree-workflow). The stubs declare inputs / outputs / constraints / pointers and do not pre-decide any project-undecided engineering surface.
6. **Extending `.gitignore`** for the new artifacts (`.tmp/`, `.reference/`, `.ae-bridge-token`, sandbox snapshot directories).
7. **Applying main branch protection** via `gh api` against the live GitHub repository (idempotent; documented in the §Self-verify section below). If the gh CLI is not authenticated with admin privileges, the protection apply step is documented as a blocker rather than silently failing.
8. **Declaring Linear as not adopted by default**, with a separate ADR (ADR-0014) prescribing the contract for the case where the repository later adopts Linear as a release planning control plane.

No architecture decisions are made in this round for `docs/vision.md` §"現時点で未確定な事項" beyond what ADR-0001 already proposed (runtime bridge architecture) and the policies here. Any later decision in those areas must be its own ADR.

---

## Why

Reconciliation is the right shape because:

- **`/init` is idempotent in the policy.** Doing it only once is an anti-pattern; reconciliation against the current state is the explicit instruction.
- **The repository is small but is at a structural inflection point.** Three commits, zero issues, zero PRs, no protection: this is the cheapest moment to install the structural skeleton that the policy implies.
- **The skeletons are cheap to maintain later and expensive to retrofit.** Recovery model / checkpoint schema / weekly sprint / Draft PR lifecycle all become harder to add after the first few non-conforming PRs land.
- **AGENTS.md §1–§9 are preserved.** This keeps the project-wide guardrails stable while reconciling around them; they remain the binding project guardrails.
- **Adaptive quality profile is cheap in this round and expensive to skip.** Specifying the verification taxonomy and the false-green prohibition before the first PR lets contributors cite `docs/development.md` §Verification instead of writing per-PR justification.

---

## Consequences

### Positive

- A new contributor / new agent can read `AGENTS.md` and reach every operational rule and its canonical document with two clicks.
- A future ticket without a Draft PR / remote head / labels / assignee can be detected by the recovery algorithm in `docs/recovery.md` as anomalous, not as a legitimate state.
- Branch protection on `main` (when applied) closes the direct-push / force-push / unprotected-PR attack surface called out in `AGENTS.md` §10 and the multi-AI-agent policy.
- The four new ADRs give the policy teeth that AGENTS.md pointers alone cannot; an ADR can be cited from a PR review, a recovery drill, or a future refactor without re-litigating the rationale.
- Skills stubs exist as discovery points; consumers can read `skills/dispatch-index.md` and pick only what they need.

### Negative

- The reconciliation creates more files than it removes. `docs/` grows from one file (`vision.md`) to seven, plus six ADRs and a Skills directory. This is intentional; the policy insists on dispatcher roles. A contributor who wants only the existing ADRs must read past the dispatcher. This is the progressive disclosure cost the policy accepts.
- The new ADRs are all **Proposed**, not Accepted. Promotion to Accepted requires the conditions in §Self-verify below; until then, cited as "Proposed" rather than "binding".
- Branch protection apply is a live side effect. Documented as §Self-verify step; if the gh token does not have admin, the apply is recorded as a blocker rather than silently failing.

### Neutral

- `AGENTS.md` is now longer (~300 lines). The pointer system keeps the per-task reading cost bounded by `docs/{development,release,security,recovery,onboarding,troubleshooting}.md` selective loading and Skill-level disclosure.
- `experiments/runtime-bridge/` is not modified in this round. Its files already implement many of the runtime-security mitigations (loopback bind, per-launch token, 1 MiB cap, graceful shutdown); reconciling the ADR ↔ experiment boundary is out of scope for the init pass.

---

## Open questions

1. **When do the new ADRs move from Proposed to Accepted?** Per §Self-verify below: after this round's sealed record can be reproduced by a fresh agent reading only AGENTS.md + the four new ADRs + `docs/`, without conversation history.
2. **Does the `release-source-check` workflow need to be enabled at all if the ruleset alone constrains head branches?** This depends on whether GitHub's ruleset supports the head-pattern constraint on a free public-repo ruleset (it may not when the ruleset is the older branch protection model). The check workflow is wired into `docs/release.md` as a defensive path; whether it is required is decided when the first release PR is created.
3. **`docs/architecture/research/06-verification-report.md` supersession**. The Round-2 verification report (`08-verification-report-r2.md`) already supersedes it; we do not rename in this round to avoid an unrelated history churn. Renaming is a future maintenance task.

---

## Self-verify (init pass completion criteria)

This ADR claims `Proposed` after the following checks pass:

| # | Check | Evidence |
|---|-------|----------|
| S1 | `AGENTS.md` becomes a dispatcher (§0 + §10–§17) without removing §1–§9 | git diff |
| S2 | `docs/development.md`, `docs/release.md`, `docs/security.md`, `docs/recovery.md`, `docs/onboarding.md`, `docs/troubleshooting.md` exist and have content | ls + read |
| S3 | `docs/architecture/decisions/README.md` lists all four new ADRs | read |
| S4 | `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/{bug,feature,architecture}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`, `.github/workflows/release-source-check.yml` exist | ls |
| S5 | `skills/dispatch-index.md` exists and points at SKILL.md stubs for the standard set | ls + read |
| S6 | `.gitignore` lists `.tmp/`, `.reference/`, `.ae-bridge-token`, sandbox snapshot paths | grep |
| S7 | ADR-0003, -0004, -0012, -0014 exist in `docs/architecture/decisions/` | ls |
| S8 | `gh api repos/ido-bata/ae-devtools/branches/main/protection` returns a non-404 response with required PR review enabled OR the apply step is documented as a blocker (per §Self-verify §External side effect) | gh api |
| S9 | Existing `docs/architecture/ADR-0001-runtime-bridge.md` keeps status: Proposed and is reachable from `docs/architecture/decisions/README.md` | grep |

### External side effect record

| Step | Intent | Result | Identifier |
|------|--------|--------|-----------|
| Branch protection apply to `main` | lock `main` against direct push / force push, require PR, require 1+ approval, require linear history, dismiss stale reviews, require conversation resolution | **APPLIED** via `gh api -X PUT repos/ido-bata/ae-devtools/branches/main/protection` (2026-09-18) | URL `https://api.github.com/repos/ido-bata/ae-devtools/branches/main/protection`; applied config: `required_pull_request_reviews.required_approving_review_count=1`, `dismiss_stale_reviews=true`, `require_code_owner_reviews=false`, `required_linear_history=true`, `allow_force_pushes=false`, `allow_deletions=false`, `required_conversation_resolution=true`, `enforce_admins=false`, `required_status_checks.strict=false` with `contexts:[]` (CI not yet configured; strict mode is deferred until a required check is defined) |
| Branch protection re-apply: strict off | remove misleading strict-mode flag while CI is not configured | **APPLIED** via `gh api -X PUT repos/ido-bata/ae-devtools/branches/main/protection` (2026-09-18, same PR) | response payload confirms `required_status_checks.strict=false` |
| `release-source-check` workflow path | defensive PR gate when ruleset head-branch-pattern constraint is unavailable on the repo plan | **APPLIED** (`.github/workflows/release-source-check.yml` committed in this round) | workflow file at `.github/workflows/release-source-check.yml`; defensively wired into `docs/release.md` §Release PR merge authorization |

The single-admin stance for this repository (admin = owner = single human) means `enforce_admins: false` is intentional: any "main bypass" path remains subject to `docs/architecture/decisions/ADR-0012-release-merge-authorization.md` and project policy. The mechanical layer (no direct push, no force push, required reviewer, linear history, conversation resolution) is now enforced via the GitHub ruleset; the human authorization layer remains process-only and lives in ADR-0012. This is the intended split.

Both branches (apply / no-admin) honor the journal pattern (intent / result / identifier) documented in `docs/recovery.md`.

---

## Evidence

All access dates 2026-09-18 unless otherwise noted.

### Internal

- `git log --oneline` on `main`: head `97a0823d` (research corrections + experiment probes + ADR-0001 update).
- `gh api repos/ido-bata/ae-devtools`: visibility `public`, default branch `main`, has_issues `true`, has_projects `true`, has_wiki `true`, `permissions.admin: true` (admin permission present on the authenticated token used during reconciliation).
- `gh api repos/ido-bata/ae-devtools/branches/main/protection`: returns `404 Branch not protected` at the start of this round.

### External

- `docs.github.com/en/rest/branches/branch-protection` — Branch protection API reference (2026-09-18 access). Used to design the `gh api` apply call.
- `docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets` — Rulesets API reference. Confirms rulesets and branch protection can both gate `main`; rulesets head branch pattern constraints are recommended for the case where branch protection is insufficient.

---

## References

### Internal

- `AGENTS.md` §10–§17 (governance skeleton).
- `docs/vision.md` — vision including §"現時点で未確定な事項".
- `docs/architecture/ADR-0001-runtime-bridge.md` — runtime bridge architecture (Proposed).
- `docs/development.md` — daily workflow.
- `docs/release.md` — release integration.
- `docs/security.md` — security profile.
- `docs/recovery.md` — recovery model.
- `docs/onboarding.md`, `docs/troubleshooting.md` — onboarding & troubleshooting.
- `docs/architecture/decisions/README.md` — ADR index.
- `skills/dispatch-index.md` — Skills entry point.

### External

- `docs.github.com/en/rest/branches/branch-protection` — Branch protection REST API (2026-09-18).
- `docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets` — Rulesets (2026-09-18).
- `docs.github.com/en/issues/using-labels-and-milestones-to-track-work` — Issue labels reference (2026-09-18).

### Unverified items

1. ~~Whether the authenticated gh token has admin scope on `ido-bata/ae-devtools`.~~ **Resolved (2026-09-18):** `gh auth status` confirmed active user `rebuildup` with scopes `gist, project, read:org, repo, workflow`. `PUT repos/ido-bata/ae-devtools/branches/main/protection` returned 200 with full protection payload.
2. ~~Whether the ruleset head-branch-pattern constraint is available on this repository's current GitHub plan without enabling a paid feature.~~ **Resolved (2026-09-18):** the `release-source-check` workflow is committed and provides a defensive PR-side gate for `release-* → main`. The free public-repo branch protection we just applied does not support head-branch-pattern restrictions, so the workflow is the canonical gate layer for `release-source-check` until/unless a ruleset is created.
3. `gh pr merge --admin` and admin direct push remain a bypass (`enforce_admins: false`). The gate at the policy layer is `ADR-0012` + `AGENTS.md` §15.
