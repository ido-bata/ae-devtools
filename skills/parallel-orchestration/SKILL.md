---
name: parallel-orchestration
description: 親子 / immutable snapshot / sandbox lifecycle / generation / lease による複数 AI コーディングエージェント並行駆動。
---

# parallel-orchestration

## 対象

複数 AI コーディングエージェントが **独立 mutable runtime** を持ち、 **immutable snapshot / result** で
接続しながら並行に作業する orchestration。 AGENTS.md §13 + ADR-0003 準拠。

## Canonical pointer

- `AGENTS.md` §13
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md`
- `docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md` §5

## 主要 capability

- `spawn_agent`
- `wait_agent`
- `get_agent_status`
- `get_agent_result`
- `send_agent_message`
- `cancel_agent`
- `resume_or_replace_agent`
- `integrate_agent_result`
- `checkpoint_agent`
- `recover_task`

## Subagent mode

- **Research** — read-only. explore / architecture 調査 / official guidance 調査
- **Worker** — implementation / refactor / test / migration. 必ず独立 mutable environment
- **Reviewer** — clean snapshot から開始。 implementer の dirty workspace を共有しない

## Parent → child

未統合変更を持つ親から child を spawn する場合は immutable snapshot を作成する。

- ephemeral Git commit / immutable Git ref / filesystem / container snapshot / content-addressed workspace snapshot
- snapshot identity を追跡可能
- spawn 後の parent 変更で child input が変化しない
- clean environment へ再現可能
- result との base relationship を判定可能

## Child → parent

child は parent workspace を直接編集せず、 結果は少なくとも次を含む immutable result として返却する:

```
agent_id
issue_or_task_id
target_release
base_snapshot
predecessor_snapshot
execution_generation
result_commit_or_ref
draft_pr_identity
summary
validation_results
artifacts
known_issues
```

## Forbidden

- 同一 ticket branch への複数 generation 同時 push
- generation / lease / fencing token のない reproduction
- WIP / recursion / cost budget を host 側で所有しないこと
