---
name: sandbox-runtime
description: sandbox / execution isolation / mutable 共有禁止 / 環境複製。 AGENTS.md §13 + sandbox lifecycle。
---

# sandbox-runtime

## 対象

実装 worker ごとに独立した **mutable runtime** を提供し、 mutable state を worker 間で共有しないこと。
sandbox lifecycle を Supervisor が所有し、 agent が host Docker socket 等を直接扱わない。

## Canonical pointer

- `AGENTS.md` §13
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md` §Branch start contract
- `docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md`

## 主要 rule

- 実装 worker ごとに独立 mutable runtime
- mutable DB / cache / queue / process / generated state を worker 間で共有しない
- 同じ内部 port を sandbox ごとに再利用してよい
- cacheable な read-only base image / immutable Nix store / package download cache / OCI layer cache は共有してよい
- Git working tree を execution isolation boundary として扱わない

## 禁止

- 同一 sandbox 状態を複数 worker が同時 read-write する前提
- agent から host Docker socket 等への直接操作（lifecycle は Supervisor 経由）
- mutable state を snapshot / result と混同して serialize する

## 推奨経路

- worktree ベースではなく immutable snapshot ベース（content-addressed workspace snapshot 等）
- 復元は snapshot identity のみで OK（ checksum 検証付き）
