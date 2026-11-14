---
name: agent-recovery
description: structured checkpoint / soft-hard / recovery algorithm / external side effect journal。 AGENTS.md §14 + ADR-0004 準拠。
---

# agent-recovery

## 対象

AI agent recovery を **同一 conversation を resume できること** に依存させない。 native session /
thread / subagent resume は高速経路、 canonical path は fresh agent が durable project state から
reconstruct する。

## Canonical pointer

- `AGENTS.md` §14, §15
- `docs/recovery.md`
- `docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md`
- `docs/architecture/decisions/ADR-0012-release-merge-authorization.md`

## Durable sources（優先順）

1. GitHub Issue / dependency state
2. target release branch
3. ticket branch / remote commit graph
4. Draft / Ready PR / reviewer / labels / review / CI state
5. stack predecessor / pinned predecessor SHA
6. committed design / ADR / Skills / docs
7. immutable worker / subagent results
8. structured recovery checkpoint

## Soft / Hard

- **soft**: same host / sandbox recovery. local immutable ref / filesystem snapshot / Supervisor journal / native session state. acceptable for short interruptions
- **hard**: sandbox / provider loss 耐性. durable ticket は recorded commit が canonical remote で到達可能、 remote head identity + Draft PR を追跡可能

## Structured checkpoint schema (minimum)

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

## External side effect journal

```
intent
side_effect_kind
target
identifier
result_or_status
remote_actual_at_recovery
retry_policy
```

`command returned no response` ≠ `operation did not happen`.

## Forbidden

- secret / machine-specific absolute path / private reasoning を checkpoint / commit / log に含める
- structured checkpoint schema を緩く書く（ loose interpretation ）
- external side effect を journal せず retry する
