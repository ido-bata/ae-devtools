---
name: design-refinement
description: 実装前 evidence-first design / unknown 分解 / scope-risk 調整 / trade-off documentation。
---

# design-refinement

## 対象

実装前に **evidence-first** で design を精錬する。 未確定事項を hidden assumption にせず、 分解 /
scope-risk 調整 / trade-off documentation を行う。

## Canonical pointer

- `AGENTS.md` §1, §2, §6
- `docs/vision.md` §「現時点で未確定な事項」
- `docs/architecture/decisions/`

## 精錬ステップ

1. unknown 分解（ hidden assumption / contract / irreversible boundary / 計測不能 値 / 倫理的判断 を識別）
2. evidence-first で不確実性を narrow する
3. scope-risk バランス（ 過剰設計回避 vs 拡張性保持 ）
4. trade-off documentation（ 採用案 / 不採用案 / positive / negative / neutral ）
5. ADR の Status / Context / Decision / Why / Consequences / Open questions / Evidence / References を満たす原案

## 推奨 evidence 形

- 公式 documentation / community 検証済みの情報 / version 依存の挙動差
- 関連 ADR / spec pointer
- 「未確定」を **明示的に残す**（ AGENTS.md §1 ）
