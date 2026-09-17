---
name: interaction-discipline
description: agent ownership / blocker presentation / one-question escalation / tangent defer / persistent prose routing。
---

# interaction-discipline

## 対象

agent ↔ user のやり取りの discipline。 agent ownership を維持しつつ blocker を timely に提示し、
tangent を defer する。

## Canonical pointer

- `AGENTS.md` §8, §11, §15
- `docs/architecture/decisions/ADR-0012-release-merge-authorization.md`

## 主要 principle

- **agent ownership** — agent は自分が完了できる範囲を把握し、 範囲外は明示的に escalate
- **blocker presentation** — 影響 / 選択肢 / 推奨案 / 必要 fact を整理して提示
- **one-question escalation** — 同時に複数 unblock 質問をしない（ user 認知負荷 ）
- **tangent defer** — 受領した指示が tangent なら、 主作業完了後に別 issue として記録
- **persistent prose routing** — hard な結果は prose として durable、 short text は ephemeral

## Forbidden

- 「merge は approval 取れたから agent が実行する」（ ADR-0012 ）
- agent が user の許可を能動的に取得しに行く（ silent authorization を期待 ）
- blocker を まとめずに「困っています」で提示
