---
name: onboarding
description: fresh contributor / agent onboarding 30 分経路。
---

# onboarding

## 対象

新規 contributor / 新規 agent が 30 分で project 構造を把握し、 first commit できる状態に到達する経路。

## Canonical pointer

- `README.md`
- `AGENTS.md`
- `docs/vision.md`
- `docs/onboarding.md`
- `docs/architecture/decisions/README.md`

## 30 分経路

1. **5 分**: README / vision を読む。 「現時点で未確定な事項」の list を確認
2. **10 分**: AGENTS.md §1〜§9（project-wide design guardrail）と §10〜§17（project-local governance） を読む
3. **5 分**: `docs/architecture/decisions/` の ADR-0001 / 0002 / 0003 / 0004 / 0012 / 0014 を読む
4. **5 分**: `docs/development.md` §Weekly release sprint / §Ticket branch start contract を読む
5. **5 分**: `docs/security.md` §Secret handling と `docs/troubleshooting.md` §Draft PR なし実装 を skim

## First-commit 最短経路

1. Issue / branch 作成は `skills/github-delivery` に委ねる
2. first meaningful commit を即時に作成
3. `git push origin <issue-number>` で remote publish
4. remote head SHA を確認
5. immediate Draft PR を作成し、 `docs/development.md` §PR metadata に従い metadata を整える
6. 実装を継続
