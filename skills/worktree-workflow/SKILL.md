---
name: worktree-workflow
description: Worktrunk を WSL / Linux の worktree 操作 layer として使う契約 / branch base / port allocation。
---

# worktree-workflow

## 対象

Git worktree を multi-ticket / parallel-agent work の **補助 layer** として扱う契約。
Git working tree を execution isolation boundary として扱わない（ AGENTS.md §13 ）ことを前提に、
worktree は 同一 immutable snapshot を **異なる checkout で同時 read** するために使う。

## Canonical pointer

- `AGENTS.md` §13
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md`

## Worktrunk 契約

- base 選択: `release-x-y-z`（independent）/ predecessor ticket branch（stacked）
- worktree 作成前に durable branch 作成 + remote publish + remote head 確認が先（ ADR-0003 §6 ）
- port allocation: 各 worktree が使う loopback port は worktree ごとに再利用可能
- worktree 間 state 共有は readonly cache / immutable file のみ

## Forbidden

- mutable state を worktree 間で共有する
- worktree を execution isolation の single source of truth として扱う
- worktree 削除を durable branch 削除と同一視する（ branch 削除は ADR-0003 + branch protection の下でのみ）
