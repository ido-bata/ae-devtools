# ADR-0015 — Deliverable-Unit Release Cadence and Continuous Release-Branch Integration

> Status: **Proposed** (2026-11-16). Refines the cadence clause of
> [ADR-0003-weekly-release-sprint.md](ADR-0003-weekly-release-sprint.md);
> does not replace its branch model, Draft PR lifecycle, or stacked-PR rules.
> ADR-0012 (explicit human authorization for release → main) is unchanged.

---

## Status

**Proposed.** This ADR records the release cadence decided for the 0.2.0
practicalization sprint: releases are cut per **independently usable
deliverable unit**, not on a fixed calendar, and accepted ticket PRs
integrate into the active release branch continuously without per-merge
human approval.

Promotion to Accepted requires one deliverable-unit release executed
end-to-end under this cadence with the freeze → batch-verification →
ready-to-merge → explicit-authorization sequence honored.

---

## Context

ADR-0003 fixed "1 sprint = 1 week = 1 target semantic version = 1 release
integration branch" as a planning cadence. For the practicalization phase
of ae-devtools — where the deliverable is a set of independently usable
tooling capabilities (JSX toolchain, developer CLI, diagnostics,
extension/native devkits) rather than a monolithic product — a fixed
weekly boundary forces either (a) shipping half-finished lanes or
(b) accumulating finished work past the boundary. Both violate the
project's own "deliverable unit" framing in `AGENTS.md` §10 calibration.

The 0.1.0 release (`release-0-1-0`, freeze SHA `bdead71`, PR #1) is a
frozen release candidate awaiting explicit merge authorization
(ADR-0012). Next-cycle development must not mutate that freeze, yet
`main` does not yet contain the 0.1.0 work, so a new sprint cannot
honestly branch from `main`.

---

## Decision

### 1. Deliverable-unit release cadence

- A release is cut when **one or more independently usable deliverable
  units** have landed on the release branch and passed their acceptance
  criteria — not because a calendar boundary was reached.
- "Usable" means a developer outside this repository can adopt the
  artifact (install / invoke / integrate) per its documented path, with
  its evidence level honestly recorded.
- Between deliverable units, ticket PRs keep integrating into the active
  release branch. There is no requirement to empty the branch weekly.
- A release branch may carry multiple deliverable units; the release PR
  body enumerates them.

### 2. Continuous ticket-PR integration

- A ticket PR whose acceptance criteria are met and whose required
  checks are green integrates into the active release branch
  **without additional per-merge human approval**. This is the standing
  authorization for ticket → release integration only.
- This does **not** extend to `release-x-y-z → main`, tag creation,
  GitHub Release publication, or npm/marketplace publish — those remain
  under ADR-0012 explicit human authorization.
- Draft PRs and unintegrated branches must not be left to rot: a ticket
  PR either lands on the release trunk, is explicitly re-scoped, or is
  closed with a reason recorded on its Issue.

### 3. Freeze → batch verification

- When the release owner declares a candidate frozen (freeze SHA
  recorded on the release PR), further feature integration stops.
- Release-wide verification (full applicable integration, critical
  E2E/smoke, package/distribution build, real-host acceptance where the
  deliverable claims it) runs **once against the frozen SHA**, in a
  batch — not per ticket PR.
- Ticket/worker PRs are **not** required to run AE real-host, GUI, full
  E2E, full CI, or distribution builds per change; they run the
  verification level appropriate to their surface (AGENTS.md §12).
  Unverified scope is reported honestly at the release gate.

### 4. Branching while a release PR is pending

- When `release-<prev>` is frozen and its release PR awaits authorization,
  the next release branch (`release-<next>`) is created from the frozen
  head of `release-<prev>` — not from `main` — so development continues
  on the integrated state without mutating the freeze.
- When the pending release PR merges, `main` fast-forwards to the same
  content and the next release branch's diff against `main` collapses
  to only post-freeze work. Until then, the next release PR's diff
  includes the pending release's content; this is expected and recorded
  in the release PR body.

### 5. Sprint naming

- "Sprint" remains a planning/review cadence for reporting and issue
  grooming; it no longer bounds a release. `release-<major>-<minor>-<patch>`
  naming is unchanged.

---

## Why

- Matches the actual unit of value: each lane (toolchain, CLI,
  inspector, devkits) becomes usable independently; coupling their
  release to a calendar or to each other would delay all of them.
- Removes a standing authorization bottleneck (per-merge approval) while
  keeping the irreversible boundary (release → main) human-gated.
- The freeze/batch model matches ADR-0004's snapshot discipline: verify
  the frozen candidate once, honestly, rather than re-verifying moving
  SHAs.

## Alternatives considered

- **Keep strict weekly releases**: rejected — forces shipping
  half-lanes or blocking finished work; mismatched to research-phase
  deliverables.
- **Per-feature patch releases off `main`**: rejected — `main` is the
  released-state SoT and is protected; feature work must integrate on a
  release branch first (ADR-0003).
- **Merge ticket PRs only after human review each time**: rejected for
  the practicalization sprint by explicit user instruction; reviewer
  quality is enforced via required checks + independent review recorded
  on the PR, not per-merge approval.

## Consequences

- **Positive**: fastest path from finished work to usable artifact;
  release branch accumulates verified increments; freeze gives a single
  honest verification point.
- **Negative**: release PR diffs can grow large between freezes;
  mitigated by per-ticket evidence levels and the batch gate's honest
  unverified-scope reporting.
- **Neutral**: ADR-0003's branch/PR/stack rules are unchanged; only the
  cadence clause is refined.

## Open questions

- Whether `release-0-2-0` becomes 0.2.0 or splits into several
  deliverable-unit releases (`0.2.0`, `0.3.0`, …) is decided at each
  freeze, per §1.

## Evidence

- Internal: PR #1 (0.1.0 release candidate, freeze `bdead71`),
  PR #87 (`release-0-2-0` draft), Issue #88.
- Access date: 2026-11-16.

## References

- Internal: [ADR-0003-weekly-release-sprint.md](ADR-0003-weekly-release-sprint.md),
  [ADR-0012-release-merge-authorization.md](ADR-0012-release-merge-authorization.md),
  [docs/release.md](../../release.md), [docs/development.md](../../development.md),
  [AGENTS.md](../../../AGENTS.md) §10–§12.
