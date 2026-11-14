---
name: policy-evaluation
description: cold review / deterministic vs latent eval / context-budget model / regression guard。
---

# policy-evaluation

## 対象

「 policy が守られているか / 設計どおりに動作するか」を **実行 profile** で評価する。 実装変更の前後 /
sprint boundary / dependency upgrade / governance 改訂時に policy evaluation を実施する。

## Canonical pointer

- `AGENTS.md` §11, §12
- `docs/development.md` §Verification
- `docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md` §Recovery algorithm

## 主要 profile

- **cold review** — fresh agent が durable state から reconstruct できるかの drill
- **deterministic eval** — script / assertion / snapshot diff で再現可能に確認
- **latent eval** — concurrent execution / long-running validation / external side effect 周辺の挙動
- **context-budget model** — context limit に対する suppress / checkpoint 戦略
- **regression guard** — 既知 bug / 過去 incident に対する fixture / sentinel を残す

## 推奨 evidence 形

- command / SHA / output / link
- latency / hit rate / false-positive rate
- failure mode catalog（ recovery で再利用 ）
