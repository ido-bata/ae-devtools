# ADR-0004 — Durable Recovery Checkpoint / Soft-Hard Distinction / Recovery Algorithm

> Status: **Proposed** (2026-09-18). Promotion to Accepted when the recovery algorithm has been dry-run successfully from cold start at least once against this repository (see §Self-verify in `docs/recovery.md` and ADR-0002 §Self-verify).

---

## Status

**Proposed.** This ADR declares the binding shape for the durable recovery checkpoint model, the soft / hard checkpoint distinction, and the recovery algorithm. It is the canonical source for `AGENTS.md` §14 and `docs/recovery.md`. Parent-child recovery and split-brain prevention covered in §5 are part of this ADR.

---

## Context

The multi-AI-agent policy in `AGENTS.md` §14 insists that recovery must not depend on the ability to resume the same conversation. Native session / thread / subagent resume can be a fast path, but the canonical path is a fresh agent reconstructing durable state from external sources.

Without an ADR this requirement remains aspirational. With three ADRs (ADR-0001, -0003, -0004) and a `docs/recovery.md`, the durable state surface is explicit:

1. GitHub Issues / dependency / labels / assignees.
2. The release branch + every durable ticket branch + their remote commit graph.
3. Draft / Ready PR (assignee / reviewer / labels / review state / CI state).
4. Stack predecessor / pinned predecessor SHA where applicable.
5. Committed design / ADR / Skill / docs (versioned in git).
6. Immutable worker / subagent results (committed in the durable branch's history).
7. Structured recovery checkpoint written by Supervisor / Coordinator before risky boundaries.

Native conversation IDs, agent IDs, Supervisor local DBs that are not also remote-reachable, shell history, IDE state are excluded from canonical sources. They are transient optimization only.

---

## Decision

### 1. Canonical durable sources (priority order)

When a fresh agent needs to recover the state of a worker / Coordinator / Supervisor, it consults the following sources in order. It does not invent state from earlier turns, scratchpads, summaries, or self-reported memory.

1. **GitHub Issue / dependency / dependency-graph state** (canonical dependency SoT).
2. **Target release branch** + **ticket branch / remote commit graph** (canonical durable source tree).
3. **GitHub Draft / Ready PR** state (canonical review / integration surface).
4. **Stack predecessor / pinned predecessor SHA** (canonical stack truth where stacked PR is in use).
5. **Committed design / ADR / Skills / docs** (canonical policy / decision / procedure).
6. **Immutable worker / subagent results** (committed in the durable branch's history).
7. **Structured recovery checkpoint** explicitly externalized by Supervisor / Coordinator.

Anything else is a transient optimization.

### 2. Soft vs Hard checkpoint

- **Soft checkpoint**: same host / sandbox recovery. Cheaper (filesystem snapshot, local immutable ref, Supervisor journal, native session state). Acceptable for short interruptions (tens of minutes to a few hours). Does not survive sandbox loss.
- **Hard checkpoint**: sandbox / provider loss must not break recovery. Requires:
  - durable ticket: recorded commit is reachable in the canonical remote, and remote head SHA + Draft PR identity are tracked;
  - release branch: zero-diff with `main` (no Draft release PR required) or first-difference Draft release PR (mandatory);
  - structured checkpoint journal written to durable storage outside the sandbox.

The frequency of soft vs hard is decided by the project's RPO / R-task length / provider TTL. ae-devtools's default: every meaningful implementation milestone gets a hard checkpoint; intermediate work gets soft checkpoints only.

### 3. Structured checkpoint schema (minimum)

A checkpoint is a YAML / JSON document with at least the following fields. None of these may include secret, machine-specific absolute path, or private chain-of-thought:

```
schema_version
issue_id
target_release
ticket_branch
pr_number
immediate_pr_base
predecessor_issue_or_pr
predecessor_sha
base_sha
checkpoint_sha_or_snapshot
execution_generation
status
completed_steps
next_steps
pending_validation
active_children
integrated_child_results
external_side_effects
blockers
decision_refs
artifact_refs
updated_at
```

### 4. Recovery trigger (at least these events trigger a checkpoint consideration)

- meaningful implementation milestone complete
- before / after risky refactor or migration
- before child spawn
- before integrating child result
- during / before long validation
- before external side effect
- when waiting on user / external input
- when provider TTL or graceful shutdown is approaching
- when context window is approaching limit

Per-trigger checkpoint depth is project-specific (RPO + task length + provider TTL).

### 5. Parent-child recovery and split-brain prevention

- **Child lifecycle is owned by Supervisor / control plane**, not by the parent model process.
- **Parent death does not automatically cancel children.** Safe children are allowed to complete. Unsafe children are explicitly killed.
- Each task carries a **lease / generation / fencing token**. The token is incremented on recovery; older generations' results are not auto-integrated.
- **Stale generation cannot be auto-merged** into a durable branch or executed as an external side effect.
- **Heartbeat loss alone is not sufficient re-execution criteria** for an external side effect; remote actual state is consulted before retry (per `AGENTS.md` §15).
- **Concurrent generations on the same ticket branch** are forbidden by convention and rejected by branch protection / pre-push checks where feasible.

When a recovered Coordinator resumes:

1. Re-discover children via Supervisor (running / completed / failed / orphaned).
2. Reconcile each child's `input_snapshot`, `predecessor_snapshot`, `execution_generation`.
3. Collect `completed` results as immutable `result` artifacts.
4. For durable branch children: reconcile published remote head / Draft PR identity / PR metadata. If the durable surface is incomplete, repair (push, open Draft PR, set metadata).
5. Do not auto-merge stale results into the durable surface.
6. Decide per-child: retry, resume, replace, or close.

### 6. Recovery algorithm (fresh agent)

Canonical steps, matching `docs/recovery.md`:

1. Fetch Issue / PR / target release / dependency from GitHub.
2. Reconcile `git fetch --all` of all branches, ticket / release branch state, remote commit graph, stack relations.
3. Repair durable ticket delivery surface (publish head / Draft PR / metadata) and release branch Draft release PR if applicable.
4. Read latest valid checkpoint from local Supervisor journal → file system → oldest durable archive.
5. Reconcile canonical policy / design / decision refs (`AGENTS.md` / `docs/vision.md` / `docs/architecture/decisions/` / `skills/`).
6. Re-discover active children from Supervisor; classify running / completed / failed / orphaned.
7. Recreate workspace from checkpoint (soft: filesystem-snapshot apply; hard: git checkout + branch sync + remote confirm).
8. Re-evaluate completed / pending validation against current SHA; rerun affected validations on new SHA if stack rebase happened.
9. Reconcile external side effects against remote actual state.
10. Reconcile stale base / predecessor / conflicting integration.
11. Reconstruct remaining plan.
12. Confirm reconstructed state with a safe minimum verification (smoke / focused unit). Do **not** run a full gate here.
13. Update `execution_generation` / lease; continue.

Even if native resume succeeds, the worker reconciles branch / PR / checkpoint with canonical sources before continuing.

### 7. Context handoff

Context-window approach is a **planned handoff event**, not a failure. The handoff externalizes the structured checkpoint above. Long conversation summary and private reasoning are not saved; only operational state that a fresh agent can use to resume is saved.

### 8. External side effect journal

Any external side effect (release PR merge / tag push / deploy / publish / notification) is recorded as a journal entry:

```
intent
side_effect_kind
target
identifier
result_or_status
remote_actual_at_recovery
retry_policy
```

On recovery, the actual remote state is consulted before retry. `command returned no response` is not equivalent to `operation did not happen`.

---

## Why

- **Priority order matters**: GitHub has the most authoritative state for ticket / branch / PR. Putting conversation history above GitHub would let stale summaries override truth.
- **Soft / Hard split** keeps the per-checkpoint cost low while letting a provider loss be recovered from external state.
- **Structured schema** lets multiple agents / sessions write checkpoints in the same format; recovery is grep + parse + verify, not "interpret human prose".
- **Parent-child recovery** prevents the common stale-child bug where a recovered parent unknowingly re-integrates a child's results from a previous generation.
- **Generation / fencing token** is a defensive mechanism against split-brain. Even with state corruption, the token gates auto-merge.

---

## Consequences

### Positive

- A fresh agent can reconstruct the state of an active ticket within one fetch + read cycle.
- A worker can be killed mid-task; the next worker picks up from durable state without re-running completed work.
- A parent crash does not orphan successful child results.
- False-green / stale-SHA reuse is detected by the structured checkpoint's `pending_validation` field.

### Negative

- Writing structured checkpoints adds latency to risky boundaries. The cost is bounded (one YAML write per trigger).
- Generation / fencing token requires Supervisor support; lightweight local-only projects may not have one and must fall back to lease-free coordination.
- External side effect journal grows over time and must be pruned; the rule is project-specific.

### Neutral

- Soft checkpoint is intentionally weaker than hard; not every transient interruption justifies a hard checkpoint.

---

## Open questions

1. **Where the structured checkpoint storage lives.** Per-project choice (workspace-relative `.checkpoint/` + Supervisor journal vs durable database). This ADR does not pre-decide.
2. **How checkpoints interact with `execution_generation` in `agent-delivery-estimation` Skill.** The estimation Skill's throughput modeling is informed by checkpoint frequency; specifics belong to the Skill, not this ADR.
3. **Whether to ship a CLI / library for checkpoint schema validation** as part of `skills/`. Deferred; a domain Skill can vendor the schema when needed.

---

## Evidence

- Internal: `git log --oneline` on `main` head `97a0823d` (2026-09-18) shows the repository is at a structural inflection point — small enough that the recovery model can be installed before any non-trivial issue stack has accumulated.
- External: `docs.github.com/en/rest` — GitHub REST API surface used by `gh api` for recovery (2026-09-18).

---

## References

### Internal

- `AGENTS.md` §14 §15.
- `docs/recovery.md` (canonical recovery model).
- `docs/development.md` §PR metadata / ticket branch start contract.
- `docs/architecture/decisions/ADR-0002-governance-reconciliation.md` §Self-verify.
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md` §Stack reconciliation gate.
- `skills/agent-recovery` (planned).

### External

- `docs.github.com/en/rest` (2026-09-18).
- `docs.github.com/en/issues/tracking-your-work-with-issues/about-issues` (2026-09-18).

### Unverified items

1. Whether the project's Supervisor (yet to be selected) supports generation / lease / fencing natively or requires a project-local adapter. This ADR does not pre-decide the Supervisor.
