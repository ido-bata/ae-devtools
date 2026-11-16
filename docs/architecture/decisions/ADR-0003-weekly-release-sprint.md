# ADR-0003 — Weekly Release Sprint / Branch Naming / Draft PR / Stacked PR / Release PR

> Status: **Proposed** (2026-09-18). Promotion to Accepted when (a) ADR-0002 §Self-verify passes and (b) a release-x-y-z branch has been cut and used for at least one ticket cycle with the rules described here observed end-to-end.

---

## Status

**Proposed.** This ADR declares the binding shape for the weekly release sprint cadence, ticket branch naming, Draft PR lifecycle, independent / stacked PR topology, and the `release-x-y-z → main` release PR contract. It is the canonical source for the rules summarized in `AGENTS.md` §10 and `docs/development.md` §Weekly release sprint / §Ticket / branch / Draft PR lifecycle. Where `docs/release.md` describes the **integration process** (gate, merge authorization, validation evidence), this ADR describes the **shape** of branches, PRs, and stacked topology.

---

## Context

The multi-AI-agent concurrent-development policy in `AGENTS.md` §10 commits to a 1-week cadence, independent mutable runtime per worker, immutable transfer between workers, GitHub-Issues as canonical dependency SoT, and explicit Draft PR + remote publish for every durable ticket branch. Without a binding ADR these rules remain policy narrative; this ADR makes them auditable.

`docs/vision.md` §"現時点で未確定な事項" lists vision-only uncertainties (core language, MCP transport, VSCode Ext internals, AE communication, distribution channel, IDE scope, etc.). None of those are pre-decided by this ADR. The weekly sprint is project-local governance, not a vision decision.

The repository is currently in design / research / experiment state — most commits are ADRs / research / ExtendScript probes. The weekly sprint therefore includes "research notes, ADR amendments, experiment artifact additions, scripted verification" as legitimate deliverables, alongside any implementation that may start in a future sprint.

---

## Decision

The binding rules are stated concretely below. Each rule is one of: branch naming, branch lifecycle, Draft PR lifecycle, independent / stacked PR topology, stack-ready execution, release branch / release PR semantics.

### 1. Weekly cadence

- The default sprint is **1 calendar week**.
- 1 sprint = 1 target semantic version = 1 release integration branch.
- 1 week is a **planning cadence**, not a工期 guarantee. Medium / long horizon release / roadmap / capacity forecasts use the `agent-delivery-estimation` Skill, not subjective calendar estimates.
- A sprint may run longer only by explicit decision (emergency patch release, scope expansion with project-level sign-off). Patch releases still do not modify `main` directly; they go through a patch release branch and a release PR.

### 2. Release branch

- Sprint start creates `release-<major>-<minor>-<patch>` from `main`.
- The release branch lives until its target version is merged into `main` or the sprint is aborted.
- One active release branch per target version. If scope splits, a follow-up target version uses a new release branch.

### 3. Ticket branch naming

- A durable ticket branch is named after the GitHub Issue number: `<issue-number>`.
- **No** `issue/`, `feature/`, `fix/`, `chore/`, `refactor/`, `wip/` prefix; **no** slug; **no** work-type tag in the branch name. Descriptive responsibility lives in the Issue and the PR, not the branch.
- A `rebuild/` prefix is reserved for the canonical remote / fork's namespace only and is not used in normal contribution flow.
- ADR docs follow `ADR-NNNN-<slug>.md` and live under `docs/architecture/decisions/`.

### 4. Independent ticket (no hard predecessor)

- Base: `release-x-y-z`.
- One durable branch per Issue.

### 5. Same-release linear hard dependency (stacked PR)

- The dependent ticket PR bases on the immediate predecessor's ticket branch, not on `release-x-y-z`.
- Stack members share `release-x-y-z` as their **stack trunk**, which is recorded in each PR's metadata.
- Stacked PR is allowed only when:
  - same repository,
  - same target release,
  - the dependency is a **real hard dependency** (e.g., the dependent cannot write its tests until the predecessor's contract is committed),
  - the dependency chain is ordered (no diamond, no fan-out).
- `stacked` is **not** a tool to slice a single Issue into multiple smaller PRs; that is forbidden (use Issue ↔ branch 1:1).
- A branching DAG is not forced into a single stack.

### 6. Branch start contract (mandatory)

For every durable ticket branch:

1. Create the branch from the agreed base (`release-x-y-z` for independent, or the immediate predecessor ticket branch for stacked).
2. Make a **first meaningful commit** immediately. Empty commits are not allowed.
3. Publish to the canonical remote: `git push origin <branch>`.
4. Verify the remote branch head SHA matches the local commit SHA: `gh api repos/<owner>/<repo>/git/ref/heads/<branch>` (or equivalent).
5. Open an **immediate Draft PR** with: linked Issue, accountable assignee, requested reviewer / CODEOWNERS path, repository-established labels, target release, stack context (trunk, immediate predecessor, successor where applicable), and an initial implementation summary that is honest about being a skeleton.
6. Begin further implementation.

Steps 1–6 are one unit. Skipping any of them is a violation, regardless of who runs the steps (human / Coordinator / implementation worker / subagent).

Workers without remote publish or PR mutation permission **immediately hand off** to the Coordinator / Supervisor after step 3 and do not proceed with further implementation until the Coordinator / Supervisor confirms steps 4–6.

### 7. Independent / stacked PR topology rules

| Aspect | Independent | Stacked |
|--------|-------------|---------|
| Base | `release-x-y-z` | immediate predecessor ticket branch |
| Stack trunk | `release-x-y-z` | `release-x-y-z` (shared) |
| Daily rebase against | `release-x-y-z` | immediate predecessor |
| Merge target | `release-x-y-z` | `release-x-y-z` (via predecessor's PR merge → `release-x-y-z` → next PR becomes mergeable against `release-x-y-z`) |
| stack-ready execution | n/a | allowed when predecessor has a **reviewable immutable commit/snapshot** even before predecessor merges |

Stack members are **not** merged into `release-x-y-z` one-by-one as if they were independent; the canonical shape is: PR-N merge → rebase PR-(N+1) → PR-(N+1) merge → … → final PR merges into `release-x-y-z`. The order is the stack order.

### 8. PR metadata (mandatory at creation)

At Draft PR creation the following is set when applicable; not setting a field is itself a recordable decision when it is genuinely N/A:

- linked Issue (`#<n>` via PR body or GitHub linking UI)
- accountable assignee
- requested reviewer / CODEOWNERS-derived reviewer
- repository-established labels (label taxonomy is owned by the repository's established-label set; ad-hoc labels are discouraged)
- acceptance criteria (lifted from the Issue)
- implementation summary
- validation results / status
- known blockers / limitations
- target release
- stack trunk + immediate predecessor + successor context when applicable

Meaningful reviewer absence is itself a fact; if the configured review automation / CI / explicit final review path substitutes for a human reviewer in a way that affects merge semantics, that fact is recorded in the PR body. Routine self-approval serialization is forbidden.

### 9. Ready / Done boundary

**Ready to merge**:

- acceptance criteria implemented
- current-SHA-required checks (worker / integration / stack reconciliation) green on the landing candidate
- blocking reviews resolved
- PR metadata matches reality
- target release / immediate predecessor relationship reconciled with no stale base
- predecessor-mutation-driven revalidation done on the new SHA if applicable

**Done** (ticket closed):

- ticket changes landed in target release trunk
- Issue is **explicitly closed** after the landing
- If GitHub Projects is the planning control plane: Project ticket status updated to `Done`
- If Linear profile is adopted: **ticket status is not updated** (Linear mirrors do not include ticket-level status; release-level reconciliation handles the linear-side equivalent separately per ADR-0014)

Stack boundary enforcement: a ticket is **not** closed at an intermediate predecessor-branch merge. Closing happens only when the ticket's changes have landed in the **target release trunk**.

### 10. Release branch → release PR

- Release branch with `main` zero-diff needs no Draft release PR (GitHub does not allow a no-diff PR).
- Once the release branch receives any meaningful integrated difference versus `main`, a Draft release PR must exist.
- Release PR body includes: release goal, included Issues / PRs, breaking changes, migration notes, validation evidence, known limitations, version / release metadata.
- Validation evidence policy is recorded in `docs/release.md`; this ADR only records that release evidence is project-specific (CI configured vs not).
- The release PR merge is an explicit human-authorized action per ADR-0012.

### 11. Forbidden patterns

- Direct push / merge into `main` except via a release PR approved by a CODEOWNERS / reviewer AND authorized by a human (ADR-0012). On a public repository the branch protection ruleset enforces this mechanically.
- Draft PR deferred to "end of implementation" — first meaningful commit is the moment Draft PR must exist.
- First commit kept local-only — publish to canonical remote is part of step 4 above.
- A single Issue split across multiple durable PRs purely to use stacked-PR mechanics — one Issue ↔ one durable branch.
- Closing a ticket via closing keyword on a merge that lands in an intermediate stack predecessor — only `release-x-y-z` landings or higher-trunk landings close the ticket.
- Reusing a green check from a stale SHA — every rebase / predecessor merge that moves the head re-runs affected validations.

---

## Why

- **Issue numbers as branch names** keep the link from branch to Issue to Draft PR unambiguous. A grep for `<n>` is a recovery primitive.
- **No slug / no `issue/` prefix** avoids the temptation to encode description in a flat label, which then drifts from the Issue.
- **Draft PR at branch start** rather than at feature complete means reviewers see intent early, recovery drill can reconstruct intent from the PR body, and the issue / branch / PR triangle is always visible from day one.
- **Stacked PR with stack-ready execution** is the only safe way to express same-release linear hard dependencies without serialization that negates parallelism. The alternative (`release-x-y-z` direct merge per ticket + retry cascade) produces more conflicts and longer integration tails.
- **Stack-aware reconciliation gate** is needed because rebase / predecessor merge moves the head SHA. Reusing old greens is exactly the false-green pattern banned by the multi-AI-agent policy.

---

## Consequences

### Positive

- All active durable work is observable in `gh api` / `gh issue list` even when implementation is partial.
- The branch / Issue / PR triangle is a recovery primitive for the algorithm in `docs/recovery.md`.
- Stacked PR enables parallel work on linear hard dependencies without deadlock.
- Forbidden-pattern list makes PR review objective: a PR is non-conformant by reading, not by opinion.

### Negative

- The Draft-at-start rule costs one extra PR creation per ticket. The cost is offset by the recovery / review / observability gain.
- Stack-aware reconciliation requires re-running affected validations on new SHA, which adds CI minutes. It also blocks the temptation to use stale greens.
- Stacked PR complicates per-ticket "ready" judgment because the ticket does not become ready in isolation; it becomes ready in its stack position.

### Neutral

- Stacked PR makes the project's bottleneck the stack merge order, not the worker. This is intended.
- ADRs are not "tickets" in this scheme; an ADR amendment is itself an Issue + branch + PR.

---

## Open questions

1. **Stack depth cap.** Stack depth 5 is comfortable in the multi-AI-agent policy; > 5 starts to be rebase-prone. Hard cap is not set in this ADR; tracked in a future ADR if evidence accumulates.
2. **Re-running required validations on every SHA move** may be over-strict for documentation-only changes. A future ADR may define a "docs-fast-path" exemption.
3. **Integration cadence** — when a ticket lands in `release-x-y-z` is the team's choice within the sprint window; this ADR does not impose intra-sprint merge cadence.

---

## Evidence

- `docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests` — Draft PR semantics (2026-09-18).
- `docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request` — PR creation (2026-09-18).
- `docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews` — review semantics (2026-09-18).
- `docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets` — rulesets (2026-09-18).

---

## References

### Internal

- `AGENTS.md` §10.
- `docs/development.md` §Weekly release sprint / §Ticket / branch / Draft PR lifecycle.
- `docs/release.md` §Release PR.
- `docs/architecture/decisions/README.md`.
- `skills/github-delivery` (planned) — GitHub Issue / PR / Draft PR / stacked PR / release PR / branch protection operational skill.

### External

- `docs.github.com/en/issues/tracking-your-work-with-issues/about-issues` — Issue model (2026-09-18).
- `docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks` — required status checks (2026-09-18).

### Unverified items

1. **Whether GitHub's ruleset head-branch-pattern constraint is available on the current repo's plan.** We treat the `release-source-check` workflow as a defensive path regardless (`docs/release.md` §Release PR). To verify before the first release PR.
