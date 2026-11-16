# Onboarding

> fresh contributor / fresh agent が chat history / private memory なしで開発開始・復旧できるようにするための最低限の経路。

関連 canonical:

- [AGENTS.md](../AGENTS.md) — project-wide guardrails + governance dispatcher
- [`docs/vision.md`](./vision.md) — プロジェクト背景
- [`docs/development.md`](./development.md) — daily workflow
- [`docs/release.md`](./release.md) — release integration
- [`docs/recovery.md`](./recovery.md) — recovery model
- [`docs/security.md`](./security.md) — security profile
- [`docs/troubleshooting.md`](./troubleshooting.md) — 失敗ケース

## Fresh contributor / agent の最初の 30 分

このリポジトリへ来た直後、次を順に踏む。会話履歴 / プロジェクト固有 memory は **存在しない前提** で動く。

### 1. リポジトリ構造とプロジェクト目的

- [`README.md`](../README.md): プロジェクトが「After Effects のスクリプト / エクステンション開発を VSCode と AI コーディングエージェントから扱える開発基盤」であることを確認
- [`docs/vision.md`](./vision.md): 背景 / 想定利用者 / 未確定な事項を整理
- 「現時点で未確定な事項」（日本語「未確定」）に触れない領域は実装しない方針を認識

### 2. project 固有ガードレール

- [`AGENTS.md`](../AGENTS.md) §1〜§9: ビジョン未確定の固定禁止、依存導入根拠、責務境界分離、docs 規律、AE API / Adobe 公式仕様の検証、過剰設計回避、コミット粒度、スコープ最終確認、AI=AE自動化 vs AE開発支援の峻別
- §10 以降: weekly sprint / Draft PR / stacked PR / recovery / external side effect / language policy

### 3. Architecture / decision の現状

- [`docs/architecture/ae-bridge-research.md`](./architecture/ae-bridge-research.md): research 統合
- [`docs/architecture/research/`](./architecture/research/): research 一次資料 + corrections-01 / 02
- [`docs/architecture/ADR-0001-runtime-bridge.md`](./architecture/ADR-0001-runtime-bridge.md): Runtime Bridge Architecture（status: **Proposed**。Promote to Accepted は Windows gate 通過後）
- [`docs/architecture/decisions/`](./architecture/): governance ADRs

### 4. Workflow

- [`docs/development.md`](./development.md) §Weekly release sprint / §Ticket / branch / Draft PR lifecycle
- [`docs/release.md`](./release.md) §Release PR / §Release gate / §Release PR merge authorization

### 5. Experiment / probe の現状

- [`experiments/runtime-bridge/`](../../experiments/runtime-bridge/) §READ ME: experiments / probes は **未検証**。各 Probe の Actual は `Not executed` のまま
- [`docs/architecture/research/07-real-ae-validation.md`](./architecture/research/07-real-ae-validation.md): 本 environment (Linux on WSL2, AE 不在) で検証できない理由

### 6. Recovery / security

- [`docs/recovery.md`](./recovery.md): durable state からの再構築
- [`docs/security.md`](./security.md): secret handling / advisory intake

## 最初の commit までの最短経路

fresh state から最初の contribution までの最短経路:

1. **GitHub Issues を開く** / 既存の近い Issue に pickup コメントする
   - 既存の近い Issue がない場合、AGENTS.md §1〜§9 を尊重した観察ベースの Issue を作成
2. **branch 作成**: `git switch -c <issue-number>`（`issue/` prefix / slug / work type をつけない。Issue 番号のみ）
3. **first meaningful commit を draft** する
4. **canonical remote へ publish**: `git push origin <issue-number>`
5. **remote head SHA を確認**: `gh api repos/<owner>/<repo>/git/ref/heads/<issue-number>`
6. **immediate Draft PR を作成**（linked Issue / target release / established labels / assignee / reviewer or CODEOWNERS / stack context を設定）
7. **以降の実装を続ける**

Draft PR なしで実装を進めない。

## Fresh agent が会話履歴なしで reconstruct できるか

[`docs/recovery.md`](./recovery.md) §Recovery algorithm 1〜13 を **会話履歴なしで** 実行できるか、 dry-run で定期的に確認する。具体的には:

1. 任意の active 状態の Issue / PR を選び、 fresh shell から上の最短経路が実行できることを確認
2. active な branch / remote head / PR / children が再発見できることを確認
3. release branch の Draft release PR 状態（zero-diff 例外 / first-difference 後の有無）を確認
4. duplicate mutation が発生しないことを確認

dry-run で欠落が見つかった場合は Issue 化し次の sprint で修復する。
