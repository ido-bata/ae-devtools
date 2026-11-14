# ADR-0012 — Explicit Human Authorization for Release PR Merge

> Status: **Proposed** (2026-09-18). Promotion to Accepted requires (a) at least one successful release PR end-to-end with the described authorization boundary honored, (b) branch protection / ruleset on `main` enforces the reviewer / CODEOWNERS branch of the contract.

---

## Status

**Proposed.** This ADR declares that the `release-x-y-z → main` PR merge (and any other irreversible / destructive side effect on the canonical source of truth) requires **explicit human authorization** in addition to the reviewer / CODEOWNERS approval. Reviewer approval is a **necessary condition**, but it is **not sufficient** to trigger the merge. Only an explicit human "merge" instruction by the repository owner / designated human gate causes the merge to execute.

The ADR is the canonical source for `AGENTS.md` §15 and `docs/release.md` §Release PR merge authorization. ADR numbers are explicit (`0012`); lower numbers are reserved for governance / architecture ADRs whose ADR numbers were already taken in the existing ADR list (`ADR-0001`), and this ADR intentionally lives at `0012` to align with the multi-AI-agent policy's reference to "ADR-0012" in §1.

---

## Context

The multi-AI-agent policy in `AGENTS.md` §1 explicitly designates release PR merge and release-side side effects as an **explicit human authorization boundary**. The rationale is twofold:

1. **Irreversibility** — once `main` is moved by a release PR merge, the canonical released state has changed; rolling back requires another PR + release gate or a revert PR + another release PR. The cost of an unauthorized merge is high.
2. **Permission separation** — the project may give agents release-gate / ready-to-merge capability without giving them release-merge capability. Splitting these in the policy keeps the trust boundary sharp.

In addition, the policy forbids the agent from asking for permission actively. The user supplies authorization on their own initiative; the agent's job is to stop at ready-to-merge and report state.

Without an ADR this separation is informal and decays as contributors take convenient shortcuts ("the merge looked obvious", "the user already said yes earlier in chat").

---

## Decision

### 1. Side effects in scope

This ADR applies to any irreversible / destructive operation on the canonical source of truth or the public canonical release surface. Specifically:

- **`release-x-y-z → main` PR merge.** The canonical case.
- **Push / creation of release tags** that point at merged release commits (e.g., `v0.1.0`).
- **GitHub Release publication** that exposes the new version publicly.
- **Operations that move canonical state outside the PR/branch model** (e.g., publishing an npm / VS Marketplace artifact derived from a release commit, signing a `.zxp`, dispatching a deployment job).
- **Destructive operations on protected branches** outside the release PR model (force-push, history rewrite, branch deletion on `main`).

It does **not** apply to:

- Draft / Ready PR creation or update on a non-protected branch.
- Comment / review / label / assignee / project-board update.
- Push to a durable ticket branch (the durable branch contract is in ADR-0003; that contract has its own auth).
- Recovery operations (recorded in `docs/recovery.md` §External side effect journal) when the user explicitly invoked the recovery.

### 2. The two-part authorization

Each in-scope side effect requires **both**:

- **(a) reviewer / CODEOWNERS approval** — the standard GitHub-required reviewer (typically one or more; configured in branch protection / ruleset). This is a **necessary** condition and is enforceable mechanically by `required_pull_request_reviews` in the protection ruleset.
- **(b) explicit human "merge" authorization** — a human (the repository owner or a designated human gate) issues a direct instruction to perform the merge. This is enforced by **process, not by the ruleset alone**: the agent must stop at ready-to-merge and not proceed without an explicit instruction.

The two are not interchangeable. Reviewer approval alone does not authorize the merge.

### 3. The agent's stop condition

When the agent reaches a state where:

- (a) reviewer / CODEOWNERS approval is recorded,
- (b) required status checks are green on the current landing candidate,
- (c) outstanding blocking review conversation is empty,
- (d) included Issues and release PR body agree,

the agent reports the state (head SHA / required checks / outstanding reviews / included Issues) and **stops**. It does not issue `gh pr merge`. It does not push a tag. It does not publish a release. It does not ask the user "shall I merge?" for the purpose of getting authorization — that question is the user's own initiative.

The agent then waits for the human to say "merge" / "ship it" / "release now" / equivalent. The phrase used is not enforced; the **act** of authorization is.

### 4. Forbidden patterns under this ADR

- An agent answering a question with "yes I'll merge it once CI passes" (the agent is making authorization on the user's behalf).
- An agent running `gh pr merge` after seeing approval, even when CI is green.
- An agent publishing a GitHub Release automatically after detecting a merge.
- An agent tagging or pushing artifacts from a release commit without explicit instruction.
- A bypass via a side-channel tool (e.g., direct push to `main` even when branch protection would refuse; or `gh pr merge --auto` when the ruleset does not require human review).
- A narration like "I am about to merge, this is your last chance to object" as a substitute for explicit instruction.

### 5. Allowed patterns under this ADR

- An agent reporting ready-to-merge state and waiting for instruction.
- An agent explaining in the release PR body what would happen on merge (release notes, breaking changes, migration notes).
- An agent preparing a `gh release create` invocation and asking the user to confirm parameters, **without** executing it.
- An agent validating that the merge is authorized to proceed (reviewer approval recorded, CI green) without merging.

### 6. Recovery from accidental merge

If an unauthorized merge is detected:

1. Halt further automated actions immediately.
2. Audit which path executed the merge (audit log of Supervisor / shell history / `git log`).
3. Revert the merge via `git revert -m 1 <merge_sha>` or by opening a follow-up "undo-merge" PR; whichever matches the situation.
4. Confirm `main` and the merged-in branch state.
5. Identify downstream impact (tag / release / downstream branch / package publish) and remediate.
6. Open a remediation Issue; record root cause in an ADR amendment or in `docs/troubleshooting.md`.

This is also a recovery operation external side effect and must be journaled per `docs/recovery.md` §External side effect journal.

### 7. Branch protection / ruleset linkage

Even with this policy in place, the ruleset on `main` must enforce:

- require PR (no direct push),
- require 1+ reviewer or CODEOWNERS approval,
- disallow force push / branch deletion,
- require linear history (per project preference; recorded in `docs/development.md`),
- require status check pass before merge (when CI is configured).

This is the mechanical side. The "human authorization" side is process-only and not enforceable by the ruleset alone.

### 8. Documentation in `docs/release.md` and `AGENTS.md`

The authorization boundary is restated in:

- `AGENTS.md` §10 (most-priority principles), §15 (external side effect / idempotency / user authorization).
- `docs/release.md` §Release PR merge authorization.

The restatement is summary, not replacement; this ADR is canonical.

---

## Why

- **Irreversibility is real.** A bad release PR merge can take `main` to a state that needs its own release PR to fix. The cost of an unauthorized merge is disproportionately large relative to the cost of waiting for a human "go" signal.
- **Permission separation is a force-multiplier.** Agents that can run a release gate but cannot run a release merge are useful tools; agents that can run both become a single point of failure.
- **The "agent should not ask" rule** is important. If the agent asks "may I merge?" to obtain authorization, the agent is implicitly authorized by silence. Letting the user initiate authorization (or not) gives the user real control.
- **Branch protection is necessary but not sufficient.** A ruleset can enforce reviewer / CODEOWNERS, but it cannot tell whether the human owner has acknowledged this particular merge. The agent's restraint at ready-to-merge is the additional layer.

---

## Consequences

### Positive

- A human is always in the loop at the canonical release boundary.
- The agent can be empowered to run release gates without giving up release control.
- The split is auditable: a recorded sequence (reviewer approval → CI green → agent stop → human authorization → merge) is the clean form; deviations are recoverable and journaled.

### Negative

- The merge cannot be merged continuously; it requires the human's attention. This is intentional, but it can become a bottleneck under high-cadence sprints.
- The "no asking for permission" rule can create friction when the human is unsure whether they have authorized yet. The rule is "don't ask; report and stop"; the rule is not "be quiet".

### Neutral

- The ADR is project-internal contract, not a GitHub feature. GitHub does not have a "must ask human before merging" flag; the policy lives in this ADR and in the agent's discipline.

---

## Open questions

1. **Designated human gate** — who, in a multi-human team, is the gate for a given release PR? This ADR says "the repository owner / designated human gate" but does not name one; that is recorded in `CODEOWNERS` / repo settings, not here.
2. **Auto-merge for low-risk releases** — some releases (docs-only, internal-only) might be safe enough to allow `--auto` after green CI. This ADR says no until a future ADR says yes, and any such future ADR must satisfy the policy's "explicit human authorization" framing (it can still require an explicit `gh pr merge --auto` invocation by the human).
3. **CI-configured vs CI-not-configured** — when CI is configured, required checks are part of the stop condition. When CI is not configured (e.g., the current ae-devtools state), the stop condition is `pending_validation` clear + reviewer / CODEOWNERS approval + release evidence consistent with `docs/release.md` §Release PR.

---

## Evidence

- `docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-protected-branches` — branch protection (2026-09-18).
- `docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets` — rulesets (2026-09-18).
- `docs.github.com/en/rest/pulls/pulls#merge-a-pull-request` — `gh pr merge` semantics (2026-09-18).

---

## References

### Internal

- `AGENTS.md` §10 / §15.
- `docs/release.md` §Release PR merge authorization.
- `docs/recovery.md` §External side effect journal.
- `docs/architecture/decisions/ADR-0002-governance-reconciliation.md`.
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md` §Release branch → release PR.
- `docs/security.md`.
- `skills/writing-discipline` (planned).

### External

- `docs.github.com` pages above (2026-09-18).

### Unverified items

1. ~~Whether the GitHub ruleset on this repository supports a `required reviewers = CODEOWNERS` rule at the time of acceptance.~~ **Partially resolved (2026-09-18):** `.github/CODEOWNERS` is committed with `@rebuildup` as the project-wide owner; `require_code_owner_reviews` is **not** enabled on the protection (single-human project, would cause a self-approval deadlock). When the project adopts a second owner, this should be revisited and `require_code_owner_reviews: true` should be considered alongside `enforce_admins`.
