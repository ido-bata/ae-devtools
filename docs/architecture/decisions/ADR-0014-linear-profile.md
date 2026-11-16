# ADR-0014 — Linear Profile (optional) as Release Planning Control Plane

> Status: **Proposed** (2026-09-18). Default: **Linear is not adopted.** This ADR records the contract for the case where the project later adopts Linear as an optional release planning control plane, and forbids double-canonical use.

---

## Status

**Proposed.** Default position for ae-devtools: **Linear is not adopted as a release planning control plane.** The repository will use GitHub Projects (when configured) for planning visibility, with GitHub Issues as the canonical dependency / ticket SoT (per `docs/development.md` §Source / Work State of Truth).

If and when the repository adopts Linear as a release planning control plane, the contracted behavior is described in §Decision below. This ADR exists to prevent the common failure mode of "we adopted Linear as an alternative to GitHub Issues" — which would violate the canonical SoT separation in `AGENTS.md` §10 and `docs/development.md`.

ADR number `0014` is intentional: lower numbers are reserved for governance ADRs already taken in the existing ADR list, and the multi-AI-agent policy's reference to "ADR-0014" in §1 corresponds to this file.

---

## Context

The multi-AI-agent policy in `AGENTS.md` §10 and §11 mandates that the canonical dependency / ticket SoT is GitHub Issues, and that GitHub Projects and Linear are **planning control planes** only. The dual-canonical anti-pattern — using Linear issues as the canonical ticket store while GitHub Issues is treated as a mirror — is explicitly forbidden because it splits reality across two systems and breaks recovery.

Linear is a popular project planning tool for teams that want richer product / portfolio planning than GitHub Projects offers (initiatives, projects, cycles, sub-issues). Some teams want to use it in addition to GitHub, especially for cross-repo portfolio views. This ADR documents the boundary that allows that, when needed.

The reason this ADR exists at all (and not just "we don't use Linear") is that Linear adoption is a common drift in projects where a contributor already has a Linear workspace. Without an explicit boundary, the drift is unchecked.

---

## Decision

### 1. Default — Linear is not adopted

By default, ae-devtools uses:

- **GitHub Issues** as the canonical dependency / ticket SoT.
- **GitHub Projects** (when configured) as the planning control plane for visibility and WIP tracking.
- **Git branches / PRs** as the canonical durable source tree.

Linear is not used. No Linear API key, no Linear MCP, no Linear mirror scripts are configured. The ADR is the canonical record that this is the default.

### 2. If Linear is later adopted — the contract

Adoption requires an ADR amendment that names:

- which workspace / team owns the Linear side,
- which projects / cycles are in scope,
- which GitHub labels / assignees / projects are mirrored,
- who is responsible for daily reconciliation,
- a documented reconciliation job (manual or script) that runs at least once per sprint.

With those named, the Linear profile is allowed under the following contract:

| Concern | Linear role | GitHub role |
|---------|-------------|-------------|
| Ticket / dependency canonical SoT | **not** canonical | canonical |
| Status / owner / target version (planning visibility) | mirror; lag allowed | canonical |
| Cross-repo portfolio / initiative view | primary surface for this view | n/a |
| Release planning (target version mapping) | mirror; reconciled at release cut | canonical (via release branch + release PR) |
| Issue creation / update | discouraged; trigger a GitHub Issue and link the Linear ticket | canonical creation |
| Closing a ticket | triggered **only** after the GitHub Issue closes (see §3 below) | canonical closure |
| Done status | release-level reconciliation only (see §3) | per-ticket, on close |

### 3. Done boundary — release-level reconciliation, not per-ticket

If Linear is adopted, the **ticket Done boundary is GitHub Issue close only**. Linear's per-ticket status update is not a Done boundary; release-level Project status (Completed / Done) is updated as part of the release-completion reconciliation, separately from per-ticket events.

Rationale: per-ticket status mirroring on every GitHub Issue close is brittle and turns Linear into a duplicate canonical. Release-level reconciliation preserves the "Linear = planning / portfolio control plane, not per-ticket SoT" boundary.

### 4. Forbidden patterns under this ADR

- Creating a Linear ticket for a unit of work with no GitHub Issue.
- "Closing" a Linear ticket when the corresponding GitHub Issue is still open (and vice versa for hard dependencies).
- Driving merge / Ready state from Linear state instead of from PR metadata.
- Letting Linear Projects (Linear's "Project" object) become a canonical at the level of a GitHub milestone or target version.
- Auto-creating / auto-closing Linear tickets from GitHub as a hidden state mutation outside the reconciliation job.

### 5. Reconciliation cadence

If Linear is adopted:

- **Daily** during active sprints: any drift in Linear ↔ GitHub mapping is reviewed and reconciled by the owner named in the ADR amendment.
- **Per release cut**: a release-level reconciliation pass over `release-x-y-z → main` PR merges updates Linear Project status to Completed for included Issues / PRs.
- **Per sprint boundary**: any orphan Linear tickets (no linked GitHub Issue, or the linked GitHub Issue is closed without a Linear ticket) are reviewed.

### 6. Anti-canonical hygiene

The repository must keep "Linear is a planning control plane, not a canonical dependency SoT" visible in the planning-visible surfaces:

- `AGENTS.md` §10 / §11 (already does).
- `docs/development.md` §Source / Work State of Truth (already does).
- `docs/onboarding.md` (already does).
- Any repo-side automation script that bridges Linear ↔ GitHub must declare its canonical direction explicitly and refuse to operate if the canonical direction is violated.

---

## Why

- **SoT separation** is the load-bearing invariant. Once Linear becomes the canonical, recovery, PR review, ADR amendment, and ADR-0009-style ticket hygiene all degrade.
- **Planning visibility ≠ canonical.** Linear's added value (portfolios, initiatives, cycles) is exactly in the planning layer; using it at that level avoids the main risk.
- **Daily reconciliation is cheap, mirror-everything is expensive.** A planned reconciliation cadence enforces the boundary. Auto-mirroring everything blurs it.
- **Closing boundary must be one-sided.** GitHub Issue close is the human-visible "we shipped" event. Linear side mirrors that event in batch at release cut.

---

## Consequences

### Positive

- The default protects the canonical SoT from accidental drift.
- If Linear is later adopted, the contract is already articulated and reviewable.
- The "release-level reconciliation only" rule keeps Linear's value where it belongs (planning / portfolio) instead of duplicating canonical events.

### Negative

- A repo that wants rich product planning without dual-canonical risk has limited exposure to Linear's primitives (no per-ticket status mirroring, no Linear-driven Ready state). This is the trade-off.
- Reconciliation cadence requires a named owner. Without one, the contract is silent drift.

### Neutral

- Linear is a per-repo decision. Not adopting here is not a global policy; other repositories in the same workspace may adopt it under their own ADR.

---

## Open questions

1. **Linear API access policy** — when adoption is requested, will the project use Linear API keys, Linear MCP, or both, and where are the credentials stored? This ADR does not pre-decide; the ADR amendment specifies.
2. **Cross-project portfolio** — if multiple ae-devtools-adjacent projects all adopt Linear under this contract, is there value in a shared Linear workspace? Out of scope here.

---

## Evidence

- `linear.app/docs` (general Linear docs) (2026-09-18).
- `docs.github.com/en/issues/tracking-your-work-with-issues/about-issues` (2026-09-18) — GitHub Issues canonical status.
- `docs.github.com/en/issues/planning-and-tracking-with-projects` (2026-09-18) — GitHub Projects planning surface.

---

## References

### Internal

- `AGENTS.md` §10 / §11.
- `docs/development.md` §Source / Work State of Truth / §Ticket Done.
- `docs/architecture/decisions/ADR-0002-governance-reconciliation.md`.
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md` §Ticket Done.
- `skills/linear-release-control` (planned; surfaces this contract only).

### External

- Linear docs pages above (2026-09-18).

### Unverified items

1. Whether Linear MCP tooling is available in this environment when adoption is requested. To verify before enabling the Skill.
