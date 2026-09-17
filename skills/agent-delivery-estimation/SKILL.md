---
name: agent-delivery-estimation
description: release / roadmap / milestone の evidence-based throughput / cost / wait 評価。 主観的 calendar 見積もりに依存しない。
---

# agent-delivery-estimation

## 対象

release / roadmap / milestone の中長期 estimate を、 **evidence-based** に行う。 主観的 calendar 見積もり
（「私なら 1 週間で終わる」「来週リリース」 等）を evidence なしに採用しない。

## Canonical pointer

- `AGENTS.md` §10, §11, §15
- `docs/development.md` §Weekly release sprint
- `docs/release.md`

## 主要 approach

1. 過去 sprint の throughput / cost / wait 計測を evidence として収集
2. checkpoint frequency / generation 切替頻度から overhead を見積もる
3. validation cost（verification level）/ dependency cost を加味
4. stacked PR の stack depth / bottleneck を分離評価
5. release gate の典型所要時間 / 失敗率を見積もる

## output schema

```
task_scope
throughput_basis
cost_basis
wait_basis
verification_assumed
dependency_assumed
stack_assumed
estimate_range_low_estimate_high
confidence_basis
risks
```

## Forbidden

- 主観 calendar estimate のみ採用
- 「過去に経験がある」「普通は このくらい」 という独立 evidence なし statement
- risk を disabling する説得に estimate を寄せる
