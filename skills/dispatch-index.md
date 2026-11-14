---
name: dispatch-index
description: Skill progressive disclosure entrypoint. AGENTS.md §17 pointer index、 standard skill taxonomy、SKILL CLI の activate / refresh 方法を 1 ファイルに集約。
---

# Skills — dispatch index

`AGENTS.md` §17 に列挙された Skill は、 **progressive disclosure** 原則に基づき、 各 SKILL.md を
必要時にだけ activate する。本ファイルは SKILL CLI に対する entry point であり、 Skill source の
pin / refresh / activate 方法と taxonomy を 1 ファイルに固定する。

## 標準 Skill taxonomy

リポジトリで定義する Skill は 16 個 + 1 個の dispatcher（本ファイル）。
ファイル名は `<skill>/SKILL.md` で、 `name` frontmatter は <skill> と一致する。

| Skill | 主な責務 |
|-------|---------|
| `parallel-orchestration` | 親子 / immutable snapshot / sandbox lifecycle / generation-lease |
| `sandbox-runtime` | sandbox / execution isolation / mutable 共有禁止 / 環境複製 |
| `github-delivery` | Issue / PR / Draft PR / stacked PR / release PR / branch protection |
| `agent-delivery-estimation` | release / roadmap / milestone の evidence-based throughput / cost / wait 評価 |
| `quality-gate` | adaptive quality profile / verification taxonomy / false-green 禁止 |
| `engineering-decisions` | decision precedence / user escalation / 質問の整え方 |
| `security-maintenance` | security advisory intake / priority / release 割り / loopback 境界 |
| `onboarding` | fresh contributor / agent onboarding 30 分経路 |
| `agent-recovery` | structured checkpoint / soft-hard / recovery algorithm / external side effect journal |
| `correctness-assurance` | 正しい答えを作る前提 / 不変条件・事前/事後条件 / 型・静的解析・runtime assertion |
| `policy-evaluation` | cold review / deterministic vs latent eval / context-budget model / regression guard |
| `design-refinement` | evidence-first design / unknown 分解 / scope-risk 調整 / trade-off documentation |
| `writing-discipline` | reader-oriented writing / artifact への再構成 / Select-Compose-Reread pipeline |
| `interaction-discipline` | agent ownership / blocker presentation / one-question escalation / tangent defer / persistent prose routing |
| `linear-release-control` | Linear optional release planning / portfolio control plane の併用契約（採用時のみ） |
| `worktree-workflow` | Worktrunk を WSL / Linux の worktree 操作 layer として使う契約 / branch base / port allocation |

各 SKILL.md は本文を **必要時にだけ** activate する。 README / AGENTS.md / ADR / docs は canonical source であり、 Skill はそれらへの参照 + 手順 handbook として機能する。

## Activate / refresh

SKILL CLI 標準的な activate 経路:

```
# SKILL を pin する（ source をこのリポジトリ commit に固定）
skill pin <skill-name>

# activate する（ output / input schema を reveal）
skill activate <skill-name>

# refresh（ source を再取得 / 同期）
skill refresh <skill-name>
```

transport / 具体的な CLI 実装は `SKILL.md` の `name` / `description` frontmatter に従う。

## 関連 canonical

- `AGENTS.md` §17 pointer index
- `docs/architecture/decisions/README.md`
- `docs/development.md` §Quality profile
- `docs/security.md` §Security advisory intake
- `docs/recovery.md` §Recovery algorithm / §External side effect journal
- `docs/release.md` §Release PR merge authorization
