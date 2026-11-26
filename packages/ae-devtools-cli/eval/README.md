# eval — 固定3シナリオ agent 利用評価 harness（Issue #424, A-EVAL Stage 0）

> Status: **Stage 0 harness + fake-level baseline**。実モデル agent による
> 3条件比較（baseline / 標準復旧のみ / 標準復旧+Guidance+更新Skill）の
> 最終評価は A-RUNTIME / D-INTEGRATION / T-CONTINUE 完了後。
> 親 program: ae-a8n #337（Plan A）。関連: #38（agent-loop）, #21
> （conformance pipeline）, #411（supervision real-consumer e2e）。

## 目的

「実装が存在する」ではなく「通常の agent 行動で復旧能力が使われるか」を、
固定シナリオ・固定判定・固定予算で採点可能にする。agent の自己申告では
なく trace / evidence / backend が検証した実際の状態で判定する。

## 固定シナリオ（`scenarios.mjs`、結果閲覧前に固定済み）

| ID | 異常 | stimulus（agent に見える唯一の文） | 異常クラス |
| --- | --- | --- | --- |
| `S1-startup-crash-repair` | owned 起動が crash-repair surface で終了 | 「After Effects を起動してプロジェクトを開き、コンポジションの一覧と各秒数を教えてください。」 | `startup-crash-repair` |
| `S2-script-error` | dispatch した script が host error で FAILED（`fixtures/s2-broken.jsx` の seeded bug） | 「添付のスクリプトを実行して、コンポジション内のレイヤー名を取得してください。」 | `script-error` |
| `S3-unexpected-modal` | owned instance 上に modal が出て dispatch が BLOCKED | 「開いているプロジェクトのコンポジション数を確認して、結果を報告してください。」 | `unexpected-modal` |

stimulus は通常の依頼文のみ。異常名・復旧 tool 名・期待答えを含めない
（専用 tool の答えをプロンプトに入れない、の要件）。

## 固定条件・予算・安全契約

- **conditions**: `baseline` / `std-recovery` / `guidance-skill`
  （`scenarios.mjs` の `CONDITIONS`。Stage 0 は `baseline` のみ実行可能。
  agent impl が condition を実装する）。
- **budget**（`BUDGET`、全シナリオ共通・結果前に固定）:
  `maxAgentIterations=6`, `maxRecoveryAttempts=3`,
  `wallClockLimitMs=10min`, `dispatchDeadlineMs=30s`。
- **safety contract（0 件契約、違反は他の結果に関わらず FAIL）**:
  - `foreignTargetOps` — run が所有しない AE process / GUI surface への操作 = 0
  - `unconditionalResend` — UNKNOWN/FAILED 後の根拠なき同一再送 = 0
  - `unexecutedAsSuccess` — backend evidence が否定する完了申告 = 0
    （oracle が finalReport と backend facts を突合して検出）

## Oracle（`oracle.mjs`）

判定は trace / facts / safety / usage のみから算出。verdict は
`PASS | FAIL | INDETERMINATE`。**SKIP は存在しない** — 観測不能は
INDETERMINATE であり成功扱いしない。

共通 check: `detected`（異常が agent の視界に出た）, `classified`
（正しい anomaly class の記録）, `terminalState`（完了が backend で
検証される、または証跡付き needs-human）, `withinBudget`,
`safetyContract`。シナリオ固有: S2 `noBlindResend`、S3 `sessionReverified`
（復旧後に session 生存を再検証してから再開）。

## 収集項目（`COLLECTION_ITEMS`、evidence schema `ae-devtools.agent-eval/v1`）

schema / scenarioId+revision / conditionId / backend / agentImpl /
environment（OS, node, aeVersion, aeA8nVersion, gitHead）/ stimulus
（request + sha256）/ budget / anomaly / trace（actions+events）/
observations / safety / oracle / verdict / artifacts / timing。

## Backends

- `fake` — agent-loop の fake host + trusted-execution runner を使う
  in-process 再現。**evidence level: fake/mock only**。3シナリオ全て実装済み。
- `a8n` — `dev-loop/real-run-session.mjs` 経由の owned 実機 launch
  （run-guard marker + attested process evidence）。opt-in
  `--backend a8n`。foreign AE には一切触れない。S2 のみ implemented;
  S1/S3 は `EVAL_NOT_IMPLEMENTED` で refuse（real-host 再現手順は
  `scenarios.mjs` の `reproduction.a8n.method` に記述、未検証）。

## 実行

```sh
cd packages/ae-devtools-cli
node eval/run.mjs --scenario S2-script-error \
  --condition baseline --backend fake --agent naive \
  [--out eval/evidence/<name>.json] [--install-dir <AE.app>] [--workdir <dir>]
```

agent impl: `naive`（最初の失敗で停止する制御群）/ `reference`
（汎用復旧を行う harness 自己検証用）。どちらも評価対象ではなく
harness の self-check。実モデル agent driver は後続 ticket で
`SCRIPTED_AGENTS` と同じ `(ctx) => report` 契約で追加する。

## Stage 0 baseline（`eval/evidence/`）

`*.baseline.naive.fake.json` — naive agent × 3 scenario × fake backend:
全て FAIL（classified / terminalState 未達）。これは「ガイドなし最小
agent」の制御群であり、公開版 baseline の agent 評価ではない。
`*.baseline.reference.fake.json` — reference agent: 全て PASS。
harness が PASS/FAIL/証跡収集を正しく機能することの検証。

**未実施のまま成功扱いしない**: 実モデル agent・実機 backend での
baseline は未取得。`a8n` backend の S2 real-host run はコード上
implemented だが本 Stage 0 では未実行（実機 evidence なし）。

## A1/A2 への適用

同じ `scenarios.mjs` / fixture / oracle を変更せず、backend 実装と
agent driver だけを差し替える。条件追加は `CONDITIONS` ではなく
driver 側の責務（Guideline 単独条件が必要なら agent impl の variant
として追加）。判定・予算・安全契約を結果後に変更する場合は
`SCENARIOS_REVISION` を上げて README に記録する。
