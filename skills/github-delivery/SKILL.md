---
name: github-delivery
description: GitHub Issue / PR / Draft PR / stacked PR / release PR / branch protection の運用。
---

# github-delivery

## 対象

GitHub を canonical delivery surface として使う操作群。 AGENTS.md §10 + ADR-0003 準拠。

## Canonical pointer

- `AGENTS.md` §10
- `docs/development.md`
- `docs/release.md`
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md`
- `docs/architecture/decisions/ADR-0012-release-merge-authorization.md`

## 主要操作

- Branch start contract (ADR-0003 §6):
  1. base から branch 作成
  2. first meaningful commit
  3. publish to canonical remote (`git push origin <branch>`)
  4. remote head SHA が commit SHA と一致することを確認 (`gh api .../git/ref/heads/<branch>`)
  5. immediate Draft PR（linked Issue / assignee / reviewer / target release / stack context）
  6. implementation を継続
- Stacked PR topology（ ADR-0003 §5 / §7 ）
- Release PR merge 経路（ ADR-0012 ）
- Branch protection / ruleset 適用（ `gh api repos/<owner>/<repo>/branches/main/protection` ）

## PR metadata（mandatory at creation）

- linked Issue (`#<n>`)
- accountable assignee
- requested reviewer / CODEOWNERS-derived reviewer
- repository-established labels
- acceptance criteria
- implementation summary
- validation results / status
- known blockers / limitations
- target release
- stack trunk + immediate predecessor + successor context when applicable

## Forbidden

- Draft PR なし active 実装
- 「merge は approval 取れたから agent が実行する」
- `.ae-bridge-token` 等の secret を PR body / comment に貼る
- dependabot alert 由来でない advisory を **advisory** として labelling しない（ intakepath 経由 ）
