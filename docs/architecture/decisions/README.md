# Decisions（ADR）目次

> project の長期的な意思決定は canonical source として **ADR (Architecture Decision Record)** を `docs/architecture/decisions/` および `docs/architecture/` に置く。

関連 canonical: [AGENTS.md §17](../AGENTS.md#17-pointer-indexadr--skill--docs)

## 既存 / Accepted

（現時点で Accepted の ADR はない。下記 Proposed を参照）

## Proposed / Recent

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-0001-runtime-bridge.md](../ADR-0001-runtime-bridge.md) | Runtime Bridge Architecture | **Proposed** | 2026-09-18 |
| [ADR-0002-governance-reconciliation.md](ADR-0002-governance-reconciliation.md) | governance reconciliation init policy（複数 AI エージェント並行駆動向け project-local 開発環境の骨格適用） | **Proposed** | 2026-09-18 |
| [ADR-0003-weekly-release-sprint.md](ADR-0003-weekly-release-sprint.md) | weekly release sprint / branch naming / Draft PR / stacked PR / release PR | **Proposed** | 2026-09-18 |
| [ADR-0004-recovery-checkpoint-model.md](ADR-0004-recovery-checkpoint-model.md) | durable recovery checkpoint / soft-hard / recovery algorithm | **Proposed** | 2026-09-18 |
| [ADR-0012-release-merge-authorization.md](ADR-0012-release-merge-authorization.md) | explicit user authorization for release PR merge | **Proposed** | 2026-09-18 |
| [ADR-0014-linear-profile.md](ADR-0014-linear-profile.md) | Linear profile を optional release planning control plane として使う場合の契約 | **Proposed** | 2026-09-18 |

## ADR 作成ガイド

### いつ書くか

[AGENTS.md](../AGENTS.md) §11 および vision.md の「現時点で未確定な事項」を尊重しつつ、**永続的に参照されることになる意思決定**を残す。

- agent architecture / Supervisor / sandbox / recovery checkpoint model
- release / sprint branching model / weekly sprint cadence
- dependency-aware stacked PR model
- durable branch / remote publication / Draft PR / PR metadata lifecycle
- public repository main protection / release-only main integration
- environment reproducibility
- architecture migration / package / toolchain migration
- CI / CD / quality model
- security priority model
- onboarding strategy

vision.md の「現時点で未確定な事項」（core 実装言語 / MCP トランスポート / VSCode Ext 内部構造 / AE 通信方式 / API metadata 生成 / TypeScript 型生成 / frame capture / branding / 配布形態 / 対応 AE バージョン / IDE 範囲 / 商用利用モデル / リアクティブ状態同期 / フォールバック 等）を **ADR で先に固定しない**。これらは各領域の設計を進めながら個別 ADR を起こし決定する。

### ステータス lifecycle

- **Proposed**: draft。承認待ち。実装を進めながら fitness-for-purpose を検証する
- **Accepted**: プロダクションで参照される意思決定になった状態
- **Superseded by NNNN**: 新しい ADR が旧 ADR を置き換えた
- **Deprecated**: 撤回されたが参照のため残す

Promote to Accepted の条件は ADR 内に明記する（多くの場合 `PROPOSED を満たす条件` + 検証 evidence）。

### フォーマット

各 ADR は最低次を含む:

- **Status**（Proposed / Accepted / Superseded by / Deprecated）
- **Date**
- **Context**（なぜ意思決定が必要か / 関連する先行 ADR や vision.md / AGENTS.md の条項）
- **Decision**（採用する決定）
- **Why**（evidence / 採用しなかった代替案）
- **Consequences**（Positive / Negative / Neutral）
- **Open questions**（あれば）
- **Evidence**（URL — date 形式で、 access date を必ず残す）
- **References**（internal / external / unverified 区分）

ADR の言語はコミット / source code と整合させ **英語** 推奨。ただし **理由説明**・**Pros/Cons 議論**・**reference 内での用語** は **日本語** を許容する。decision 文そのものは英語が望ましい。
