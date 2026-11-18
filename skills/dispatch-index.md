---
name: dispatch-index
description: Skill progressive disclosure entrypoint. AGENTS.md §17 pointer index、 standard skill taxonomy、vendored skills の sync / freshness 確認方法を 1 ファイルに集約。
---

# Skills — dispatch index

`AGENTS.md` §17 に列挙された Skill は、 **progressive disclosure** 原則に基づき、 各 SKILL.md を
必要時にだけ activate する。本ファイルは entry point であり、 Skill source の sync / freshness
確認方法と taxonomy を 1 ファイルに固定する。

## 標準 Skill taxonomy

リポジトリで vendor する Skill は 25 個 + 1 個の dispatcher（本ファイル）。
ファイル名は `<skill>/SKILL.md` で、 `name` frontmatter は <skill> と一致する。

| Skill | 主な責務 |
|-------|---------|
| `agent-delivery-estimation` | release / roadmap / milestone の evidence-based throughput / cost / wait 評価 |
| `agent-recovery` | structured checkpoint / soft-hard / recovery algorithm / external side effect journal |
| `code-naming` | symbol / file / directory の命名・レビュー・rename 判断 |
| `correctness-assurance` | 不変条件・事前/事後条件と最小十分な保証手段の設計 |
| `design-refinement` | 実装前の evidence-first design / unknown 分解 / decision frontier |
| `engineering-decisions` | decision precedence / user escalation / 質問の整え方 |
| `github-delivery` | Issue / PR / Draft PR / stacked PR / release PR / branch protection |
| `herdr-runtime` | Herdr を使う場合の Supervisor/session Practice（未採用なら参照不要） |
| `idea-discovery` | 既存の延長ではない新規アイデア・設計原理の探索 |
| `interaction-discipline` | agent ownership / blocker presentation / one-question escalation |
| `linear-release-control` | Linear を採用する場合の release planning control plane（ADR-0014、未採用） |
| `onboarding` | fresh contributor / agent onboarding 経路 |
| `orca-frontend` | Orca を使う場合の worktree / agent terminal frontend（未採用） |
| `parallel-orchestration` | 親子 / immutable snapshot / sandbox lifecycle / generation-lease |
| `policy-evaluation` | cold review / deterministic vs latent eval / context-budget model |
| `quality-gate` | adaptive quality profile / verification taxonomy / false-green 禁止 |
| `sandbox-runtime` | sandbox / execution isolation / mutable 共有禁止 / 環境複製 |
| `secrets-management` | secret value の Infisical 中心ライフサイクル（profile default） |
| `security-audit` | 未知の security invariant failure の能動探索 |
| `security-maintenance` | security advisory intake / priority / release 割り |
| `skill-selection` | project の必要能力判定と Skill 導入・採否の記録 |
| `supervisor-boundary` | Supervisor / Worker の権限分離が必要な場合の境界 contract |
| `system-quality` | 要求保存・全体再構成・既知アンチケース排除・改善関係の検証と旧構造撤去 |
| `worktree-workflow` | Worktrunk を WSL/Linux の worktree 操作 layer として使う契約 |
| `writing-discipline` | reader-oriented writing / Select-Compose-Reread pipeline |

条件付き Skill（`herdr-runtime` / `linear-release-control` / `orca-frontend` /
`supervisor-boundary`）は、対応する Practice を project が採用した時だけ activate する。

各 SKILL.md は本文を **必要時にだけ** activate する。 README / AGENTS.md / ADR / docs は canonical source であり、 Skill はそれらへの参照 + 手順 handbook として機能する。

## Upstream reference の読み方

Skill file 内に path 修飾なしで現れる `ADR-NNNN`、`organization/`、`docs/`、`templates/` への
参照は、 **配布元 `rebuildup/project-init` の canonical source** を指す。このリポジトリ固有の
ADR は [`docs/architecture/decisions/`](../docs/architecture/decisions/) にあり、番号体系が
異なるため混同しない。対応関係が必要な場合は各 Skill 本文の記述と本リポジトリの ADR を照合する
（例: skill 内の release merge authorization は本リポジトリでは
`ADR-0012-release-merge-authorization.md` が対応する）。

## Sync / freshness

- source: `rebuildup/project-init`（floating。freeze が必要なら ADR で明示する）
- install layout は本リポジトリでは `skills/` への vendor 方式を維持する
  （`.agents/skills/` + `.claude/skills/` の canonical layout からの意図的な deviation。
  `AGENTS.md` §17 と [`docs/development.md`](../docs/development.md) の field ownership が
  `skills/` を canonical として参照しているため）
- `skills-lock.json` は source / commit / skill path / folder content hash の durable metadata。
  hash は skills CLI (`bunx skills`, v2 format) の `computeSkillFolderHash` と同一手順
  （version 2 format）で、vendor した directory 全体を対象に計算する。
  `scripts/verify-skills-lock.mjs` が lock 記載 hash と `skills/<name>/` の実内容を照合する
- 更新手順: `bunx skills add rebuildup/project-init --skill '*' --agent claude-code --agent codex -y`
  を scratch directory で実行して `.agents/skills/` と `skills-lock.json` を得た後、
  `skills/` へ反映する。`writing-discipline` は配布元が `rebuildup/writing-skills` のため
  別途 `bunx skills add rebuildup/writing-skills --skill writing-discipline` で取得し、
  lock entry を merge する（upstream project-init が pin している release 系の内容に合わせる）。
  `mise run skills-update` / `skills-bootstrap` task は `.agents/skills/` layout 向けのため、
  この vendor 方式にはそのまま使えない

## 関連 canonical

- `AGENTS.md` §17 pointer index
- `docs/architecture/decisions/README.md`
- `docs/development.md` §Quality profile
- `docs/security.md` §Security advisory intake
