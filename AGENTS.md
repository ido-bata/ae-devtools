# AGENTS.md

AI コーディングエージェント、およびこのリポジトリで作業する人間の開発者に向けた作業原則をまとめる。
仕様の固定ではなく、**意図を保護しつつ拡張可能な開発基盤を維持するためのガードレール** として位置づける。

## このファイルの読み方

このファイルはプロジェクト固有の **dispatcher + work principles** の役割を持つ。

- **§1〜§9** は **project-wide design guardrails**（ビジョン未確定の固定禁止 / 依存導入根拠 / 責務境界分離 / ドキュメント規律 / AE API & Adobe 公式仕様の検証 / 過剰設計回避 / コミット粒度 / スコープ最終確認 / AI=AE自動化 vs AE開発支援の峻別）。これらは project の永続的なガードレールであり、 governance structure の意思決定を上書きしない。
- **§10 以降** は **project-local governance structure**（weekly release sprint / durable ticket / Draft PR / stacked PR / recovery model / quality & security profile / external side effect 等）。durable な変更は関連 ADR / docs / Skill を更新する。
- 通常 task では **必要な Skill と ADR だけ** を読み、このファイル全章を読み直さない（progressive disclosure）。

## 関連 canonical 入口

- **プロジェクトビジョン（意図、現時点で未確定な項目を含む）**: [`docs/vision.md`](docs/vision.md)
- **project 構造の更新ログ・weekly release workflow の入口**: [`docs/development.md`](docs/development.md)
- **release integration・target release PR の運用**: [`docs/release.md`](docs/release.md)
- **secret handling / security advisory intake**: [`docs/security.md`](docs/security.md)
- **durable checkpoint / recovery algorithm**: [`docs/recovery.md`](docs/recovery.md)
- **discovery & first-runner 起点**: [`docs/onboarding.md`](docs/onboarding.md)
- **ADR（長期的意思決定の canonical source）**: [`docs/architecture/decisions/`](docs/architecture/decisions/)
- **Agent Skill（progressive disclosure）**: [`skills/`](skills/)
- **GitHub Issue（durable ticket / dependency SoT）**: https://github.com/ido-bata/ae-devtools/issues
- **GitHub Pull Requests（review / integration surface）**: https://github.com/ido-bata/ae-devtools/pulls

ガバナンス構造の主要決定は関連 ADR を canonical source とし、本 AGENTS.md はその dispatcher / pointer に徹する。

## 1. ユーザーが決めていない仕様を勝手に固定しない

- `docs/vision.md` の「現時点で未確定な事項」あるいは本文の「未確定」マークが付いた領域について、独断で前提を埋め込まない。
- 実装・コンパイル時定数・設定・命名に、未確定事項を前提とした選択を紛れ込ませない。
- 曖昧さを排除して先に進む必要がある場面では、進めるための **仮定** を明示し、ドキュメントには残さない。

## 2. 新しい大きな依存・アーキテクチャの導入は根拠を示す

- 大型の依存関係、アーキテクチャ変更、プロセスモデル、IPC / トランスポートの変更などを導入する前に、**なぜそれをこのリポジトリにもたらすのか** を PR 説明かコメントで示す。
- 「動けばよい」だけの採用をしない。代わりに、**今後の開発基盤として拡張可能な構造を維持する** 側か、**過剰設計を避けるため最小にとどめる** 側かのどちらの選択かを意識する。
- 既存依存を増やす前に、本当にその依存が必要か（標準 API やコア層の機能で代替できないか）を確認する。

## 3. VSCode / MCP / AE Bridge / shared core の責務を不用意に混ぜない

- 各層の責務境界を意識する。
- ある層のために書かれた変更が、別の層に意図せず影響しないことを確認する。
- 通信・契約が絡む変更は、境界面に対するインパクトを明示する。
- 「とりあえずコア層に置いた」「とりあえず VSCode Extension 内に置いた」という理由で、責務をまたぐ位置にコードを置かない。

## 4. ドキュメントは、後から第三者が読んでも意味がある情報だけを残す

- 一時的な会話、エージェントの作業ログ、作業コンテキストを **恒久ドキュメントに残さない**。
- README、`docs/` 以下、コメントは、未来の第三者がプロジェクトの意図と現状を理解するために書かれているべきである。
- コミットメッセージに書くべき内容を README や docs に持ち込まない。
- ビジョンと仕様が固まっていない段階で、それを **「決定済み仕様」** として書かない。

## 5. After Effects API / Adobe 公式仕様についての検証

- 既存の After Effects API、Adobe 公式仕様について断定する場合は **根拠を確認する**。
- バージョン依存の挙動、CEP / UXP / ExtendScript の境界、Scripting API の挙動などは、記憶や推測ではなく公式ドキュメント・コミュニティの検証済みの情報を参照する。
- バージョン差が影響する箇所では、対象バージョン範囲を明示する。
- 不確かな場合は、コメントまたはドキュメントに「要確認」等を明記する。

## 6. 設計のバランス — 拡張可能性と過剰設計の回避

- 将来を予測しすぎた過剰設計はしない。`docs/vision.md` の「未確定」領域を、相手が決める前に先回りして固定しない。
- 同時に、後から拡張不可能な構造にもしない。**モジュール境界と責務分離は初期から意識する** が、具体的な中身は決定後に書く。
- 短期的な動作確認のために、長期的な構造を壊す変更を避ける。
- 「このプロジェクトはこうなるはずだ」という前提の上にコードを書き、その前提を前提としないコードベースに引き継ぐ人を困らせない。

## 7. コミット・変更の粒度

- 1 つの意味のある単位でコミットする。WIP 状態のままコミットしない。
- コミットメッセージには **その変更の意図** を書く。実装詳細の羅列や、AI との作業ログは書かない。
- 途中で止める必要がある場合は、止める判断自体をコミットメッセージか PR 説明に記録する。

## 8. スコープの最終確認

- 自分のタスクが、ビジョン・直近の指示で示されたスコープを超えていないか確認する。
- スコープを広げそうな変更は、独断で進めない。立ち止まる。
- スコープが本当に足りないと感じた場合は、不足を明示して依頼者に確認する。

## 9. 「このプロジェクトは何ではないか」の確認

このプロジェクトは **After Effects を AI から自動操作する MCP ツール** ではない。

AI コーディングエージェントから After Effects 開発を扱うためのインターフェースであっても、
「AI が AE を勝手にいじる」ことを主目的にしない。
エージェントはあくまで **人間の AE 開発を支援する** 側に立つ。この原則は、実装と意思決定において維持する。

---

## 10. project-local governance の枠組み（durable な骨格）

複数 AI コーディングエージェントが **独立 runtime + immutable snapshot / result の境界を保ったまま** 並行作業し、**中断・context 消失・sandbox 消失** からも復旧しながら version-oriented weekly release sprint に統合できる開発基盤を維持する。

最優先原則:

- 実装 worker ごとに独立した mutable runtime を与える。Git working tree を execution isolation boundary として扱わない。
- mutable DB / cache / queue / process / generated state を worker 間で共有しない。
- parent → child は immutable snapshot、child → parent は immutable result で接続する。
- sandbox lifecycle は Supervisor が所有し、agent が host Docker socket 等を直接扱わない。
- `main` は released/integrated source state、`release-x-y-z` は weekly sprint integration、ticket branch は Issue 番号だけを表す。
- public repository では `main` を branch protection / ruleset で保護し、release PR のみを正規 integration 経路とする。
- durable ticket branch は **first meaningful commit を canonical remote へ publish して remote head SHA を確認した直後に Draft PR を作成** する。Draft PR なしの active 実装を継続しない。
- 一週間は planning cadence であり、工期保証ではない。release / roadmap / milestone の中長期見積もりは `agent-delivery-estimation` Skill の evidence-based framework を使い、主観的 calendar 見積もりに依存しない。

Canonical source / pointer:

- canonical source/work SoT / dependency: [`docs/development.md`](docs/development.md) §Source / work State of Truth
- weekly release workflow: [`docs/development.md`](docs/development.md) §Weekly release sprint + [`docs/release.md`](docs/release.md)
- recovery model / parent-child recovery: [`docs/recovery.md`](docs/recovery.md) + [`docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md`](docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md)
- quality / verification / security profile: [`docs/security.md`](docs/security.md) + [`docs/development.md`](docs/development.md) §Quality profile
- external side effect / idempotency / explicit user authorization: [`docs/release.md`](docs/release.md) §Release PR merge authorization + [`docs/architecture/decisions/ADR-0012-release-merge-authorization.md`](docs/architecture/decisions/ADR-0012-release-merge-authorization.md)
- Linear profile を release planning control plane として併用するかどうか: [`docs/architecture/decisions/ADR-0014-linear-profile.md`](docs/architecture/decisions/ADR-0014-linear-profile.md)（既定は GitHub Projects のみ。採用時のみ併用）

### このリポジトリへの calibration

ae-devtools は vision.md で「現時点で未確定な事項」を多数記録している **design / research 段階** のリポジトリであり、現時点の source の大半は ADR / research / experiment probe である。ガバナンス構造は以下に calibrate する。

- weekly sprint の "deliverable" は、release-x-y-z branch に **durably 研究成果・ADR・experiment 結果・雛形実装・検証ログを取り込む単位**として表現する。
- 通常 sprint の最終 PR merge は `release-x-y-z → main` の **release PR** を唯一の正規経路とする (ADR-0012)。
- 「first meaningful commit を canonical remote へ publish して Draft PR を即時作成」「stacked PR による same-release linear hard dependency の安全な投影」「stack-reconciliation gate は現在の SHA に再 pin」等のルールは runtime bridge と vision document の両方を保護する基盤として維持する。runtime bridge 実装が薄い段階でも rule は事前適用する。
- target 言語 / フレームワーク / MCP トランスポート / 配布形態等の **vision.md の未確定項目** はガバナンス側で固定しない。具体的な実装言語の選択は当該領域の ADR を起こして決定する。

## 11. engineering decision precedence / user escalation

判断は次の順で確認する。

1. **project-wide policy / canonical architecture / invariant**（[`AGENTS.md`](AGENTS.md) §1〜§9 と、現状 Accepted の ADR）
2. **design / specification / explicit task instruction**（Issue / PR 本文、ユーザーのタスク指示）
3. **coherent existing implementation majority**（coherent な既存実装）
4. **current official framework / runtime / SDK guidance**
5. established ecosystem convention
6. local best judgment

同一 level で矛盾する場合は、**より specific かつ新しい canonical source** を優先する。old implementation や migration 途中の多数派が新しい canonical design / policy を上書きしてはいけない。

### 自明な判断を user に返さない

次を **すべて** 満たす場合は agent 自身で判断して進める。project evidence で解ける事柄を user へ逐次 escalate しない。

- precedence から答えが一意または実質一意
- reversible かつ局所的
- acceptance criteria を変更しない
- public / external contract を新規確定しない
- security / privacy / cost / release scope を重大に変えない

### User escalation が必要な境界

- canonical source 同士が矛盾し product semantics が変わる
- acceptance criteria が複数解釈でき user-visible behavior が変わる
- irreversible / destructive な操作
- public / external API contract の確定
- security / privacy / compliance risk の受容
- meaningful cost increase
- release scope / date の変更
- explicit design-first approval gate

質問する場合は、調査可能な fact を先に確認し、選択肢・影響・推奨案を整理してから聞く。

## 12. quality / verification / security profile

ガバナンスの固定 bundle を盲信しない。framework / runtime / SDK の **current official guidance** から project 固有 profile を compile する。

### Verification taxonomy（最低限）

ae-devtools は design / research / experiment 段階を含むため、verification level は変更 surface / risk に応じて次の組合せで判断する。

- **Unit** — 局所 logic / component behavior の単体検証
- **Smoke / connectivity** — startup / wiring / 起動経路の最小限の成立確認
- **Integration** — 複数 component 間の data flow / persistence / 連携確認
- **Contract / schema** — API / event / DB / 生成 interface の互換性確認
- **E2E / system** — release-like boundary で user / system critical flow を確認
- **Manual / visual** — automation が困難な AE 本体 / パネル UI / native addon 経路に限定

各 verification level の責務境界は [`docs/development.md`](docs/development.md) §Verification と [`docs/development.md`](docs/development.md) §Quality profile に詳しく書く。

### False green 禁止

- `.only` / ignored exit code / `|| true` / blanket suppression / CI disabling 等の偽装 green は禁止
- `.skip` / `.todo` を無条件 commit しない
- coverage threshold を盲目的に target にしない
- partial / stale validation を full pass として再利用しない（stack rebase / update で SHA が変わったら affected required validation を新しい SHA に再 pin する）

### Security advisory intake

framework / runtime / SDK / dependency の security advisory は project で実際に使用中の version に紐付けて継続的に扱う。`docs/security.md` の priority model（severity だけでなく exploitability / reachability / external exposure / required privilege / impact / fix availability / workaround quality / regression risk / release timing）に従う。

有意な advisory は GitHub Issue へ変換し、target release を割り当てる。critical な exposed vulnerability では current sprint を中断して patch release を優先してよいが、public repository の `main` を直接変更せず **patch release branch からの release PR** を使う。

## 13. execution isolation / sandbox / supervisor / subagent mode

### Sandbox / execution isolation

- 実装 worker はそれぞれ独立 mutable runtime を持つ
- mutable application DB / concurrently-mutated dependency / build directory / generated runtime files / Git index / working tree を worker 間で共有しない
- cacheable な read-only base image / immutable Nix store / package download cache / OCI layer cache は共有する
- Git working tree を execution isolation boundary として扱わない
- 同じ内部 port を sandbox ごとに再利用してよい

### Subagent spawn を第一級 capability にする

Coordinator / 許可された parent agent には次の logical capability を公開する。

- `spawn_agent`
- `wait_agent`
- `get_agent_status`
- `get_agent_result`
- `send_agent_message`
- `cancel_agent`
- `resume_or_replace_agent`
- `integrate_agent_result`
- `checkpoint_agent`
- `recover_task`

transport は native agent API / MCP / ACP / CLI wrapper / project-local Supervisor client 等から選べる。Subagent / worker に durable branch 作成権限を与える場合は remote publication + Draft PR 作成・metadata 設定とセット。

### Subagent mode

最低限次を区別する。

- **Research** — read-only。探索 / architecture 調査 / official guidance 調査
- **Worker** — implementation / refactor / test / migration / generation / runtime verification。必ず独立 mutable environment
- **Reviewer** — clean snapshot から開始。implementer の dirty workspace を共有しない

### Parent → child

未統合変更を持つ親から child を spawn する場合は immutable snapshot を作成する。

- ephemeral Git commit / immutable Git ref / filesystem / container snapshot / content-addressed workspace snapshot
- snapshot identity を追跡可能
- spawn 後の parent 変更で child input が変化しない
- clean environment へ再現可能
- result との base relationship を判定可能

### Child → parent

child は parent workspace を直接編集せず、結果は次を少なくとも含む immutable result として返却する。

```
agent_id
issue_or_task_id
target_release
base_snapshot
predecessor_snapshot
execution_generation
result_commit_or_ref
draft_pr_identity
summary
validation_results
artifacts
known_issues
```

### Fork bomb / recursion 対策

- generation / lease / fencing token を持たせ、recovery 時には generation を進める
- WIP / recursion / cost budget を Supervisor が所有
- 同一 ticket branch へ複数 generation が同時 push する運用を禁止

## 14. recovery model

AI agent recovery は「同じ conversation を resume できること」に依存させない。native session / thread / subagent resume は **高速経路** として利用してよいが、**canonical path は fresh agent が durable project state から reconstruct すること**。

### Durable recovery sources（優先順）

1. GitHub Issue / dependency state（canonical SoT）。release planning control plane（GitHub Projects / Linear）は補助 board
2. target release branch
3. ticket branch / remote commit graph
4. Draft / Ready PR / assignee / reviewer / labels / review / CI state
5. stack predecessor / pinned predecessor SHA when applicable
6. committed design / ADR / Skills / docs
7. immutable worker / subagent results
8. structured recovery checkpoint

`active durable ticket branch` は **published remote head + Draft PR を必ず持つ**。未整備の ticket branch は正常 state として扱わず、修復する。release branch は `main` と zero-diff の間だけ Draft release PR 不要だが、first meaningful integrated difference が出たら Draft release PR を必須とする。

### Soft / Hard checkpoint

- **soft checkpoint**: same host / sandbox recovery 向け。local immutable ref / filesystem snapshot / Supervisor journal / native session state 等
- **hard checkpoint**: sandbox / provider を失っても復旧する境界。durable ticket では recorded commit が canonical remote で到達可能で remote head identity と Draft PR を追跡できること

### Recovery trigger（少なくとも次の前後）

- meaningful implementation milestone
- risky refactor / migration
- child spawn
- child result integration
- long validation
- external side effect
- user / external input 待ち
- provider TTL / shutdown 接近
- graceful cancellation / shutdown signal
- context limit 接近

### Recovery algorithm（fresh agent の手順）

会話履歴を推測せず次を実行する。詳細は [`docs/recovery.md`](docs/recovery.md) を参照。

1. Issue / PR / target release / dependency を GitHub から fetch
2. ticket / release branch / remote commit graph / stack relation を照合
3. durable ticket では published remote head + Draft PR / metadata を確認・修復。release branch は zero-diff 例外 / first-difference 後の Draft release PR を確認
4. latest valid checkpoint を読む
5. canonical policy / design / decision refs を確認
6. active children を Supervisor から再発見
7. checkpoint から workspace を recreate
8. completed / pending validation を再評価
9. external side effect の actual remote state を確認
10. stale base / predecessor / conflicting integration を確認
11. remaining plan を再構成
12. safe な最小 verification で reconstructed state を確認
13. execution generation / lease を更新して続行

native resume に成功しても branch / PR / checkpoint との整合を確認してから続行する。

## 15. external side effect / idempotency / user authorization

Git 外の操作（release PR merge / tag / deploy / publish / notification 等）は中断復旧で特に危険。

- 可能なら idempotency key を使う
- side effect 前に intent、後に result / remote identifier を durable journal へ記録する
- recovery 時は remote actual state を確認してから retry する
- `command returned no response = operation did not happen` と推測しない

### Release PR merge を含む side effect の explicit user authorization 境界（ADR-0012）

`release-x-y-z → main` release PR を含む side effect は **explicit user authorization 境界** に従う。

- reviewer / CODEOWNERS approval は merge の前提条件
- **merge そのものを実行する権限は user が保持**する
- Agent は release-wide verification 完了 + release gate green + ready-to-merge 状態まで進めた時点で **ready-to-merge で停止** し、現在の head SHA / required checks / outstanding review conversations を report する
- authorization 取得のための追加質問を行わない（permission 確認は user 側の発火に委ねる）

これは破壊的・不可逆な操作を user の明示的手続に委ねるための境界である。詳細と例外は [`docs/architecture/decisions/ADR-0012-release-merge-authorization.md`](docs/architecture/decisions/ADR-0012-release-merge-authorization.md) と [`docs/release.md`](docs/release.md) §Release PR merge authorization を参照。

## 16. source / docs / GitHub language policy

### Source code

英語のみ。filename / identifier / comment / dev-facing log / config identifier を含む。localization resource は例外。

### Commit

英語。

`<work-prefix>: <extremely concise title>`

### Internal documentation

日本語。

### GitHub Issue / Pull Request

Issue title / body、PR title / body、review discussion は日本語。

branch 名は Issue 番号または release version だけを表し、説明責務を持たせない。

### Branch name conventions（本リポジトリ）

- ticket branch: `<issue-number>` （`issue/` prefix / slug / work type を入れない。説明責務は Issue / PR へ）
- weekly release integration branch: `release-<major>-<minor>-<patch>`（例: `release-0-1-0`）
- ADR doc: `ADR-NNNN-<slug>.md`

### Container / env / temp

- 新規 container definition は原則 `Containerfile` を使う
- 一時 artifact は `.tmp/`、external reference repository は `.reference/` 配下に置き Git ignore する
- actual dotenv（`.env`, `.env.development`, `.env.production`）は Git ignore。committed examples（`.env.example*`）は許容
- secret を snapshot / checkpoint / commit / log / agent result に含めない

### toolchain rule

- text search は `rg` / `rg --files` を標準
- package manager は project で実 use する場合に限り、`bun` を標準、Node.js / npm 環境では `npm` / `npx` を許容
- 新規 `.py` script を automation / generation / migration / validation / build & test support / temporary analysis 目的で追加しない

## 17. pointer index（ADR / Skill / docs）

### Architecture & governance ADRs

- [`ADR-0001-runtime-bridge.md`](docs/architecture/ADR-0001-runtime-bridge.md) — Runtime Bridge Architecture（status: Proposed）
- [`ADR-0002-governance-reconciliation.md`](docs/architecture/decisions/ADR-0002-governance-reconciliation.md) — 2026-09-18 init policy の適用記録
- [`ADR-0003-weekly-release-sprint.md`](docs/architecture/decisions/ADR-0003-weekly-release-sprint.md) — weekly release sprint / branch naming / Draft PR / stack / release PR
- [`ADR-0004-recovery-checkpoint-model.md`](docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md) — durable checkpoint / soft-hard / recovery algorithm
- [`ADR-0012-release-merge-authorization.md`](docs/architecture/decisions/ADR-0012-release-merge-authorization.md) — explicit user authorization for release PR merge
- [`ADR-0014-linear-profile.md`](docs/architecture/decisions/ADR-0014-linear-profile.md) — Linear profile（任意採用時）の併用契約

### docs / onboarding

- [`docs/vision.md`](docs/vision.md) — プロジェクトビジョン（意図、現時点で未確定な事項を含む）
- [`docs/architecture/ae-bridge-research.md`](docs/architecture/ae-bridge-research.md) — research 統合
- [`docs/architecture/research/`](docs/architecture/research/) — research 一次資料
- [`docs/development.md`](docs/development.md) — daily workflow / weekly sprint / quality profile
- [`docs/release.md`](docs/release.md) — release integration process
- [`docs/security.md`](docs/security.md) — security profile / advisory intake
- [`docs/recovery.md`](docs/recovery.md) — recovery model
- [`docs/onboarding.md`](docs/onboarding.md) — fresh contributor / agent onboarding
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — 失敗ケースと復旧

### Skills（progressive disclosure）

- [`skills/`](skills/) — Skills CLI で source を pin / refresh する。各 Skill は本文を読み直さず必要時のみ activate する
- [`skills/dispatch-index.md`](skills/dispatch-index.md) — entrypoint

### 標準 Skill（標準的な役割分担。`skills/` 配下の SKILL 名称の mapping）

- `parallel-orchestration` — 並列 orchestration / 親子 / immutable snapshot
- `sandbox-runtime` — sandbox / execution isolation / 環境複製
- `github-delivery` — GitHub Issue / PR / Draft PR / stacked PR / release PR / branch protection
- `agent-delivery-estimation` — release / roadmap / milestone の中長期 throughput / cost / wait 評価
- `quality-gate` — adaptive quality profile / required verification level
- `engineering-decisions` — decision precedence / user escalation
- `security-maintenance` — security advisory intake / priority / release 割り
- `onboarding` — fresh 開発者 / agent onboarding 経路
- `agent-recovery` — recovery algorithm / structured checkpoint
- `correctness-assurance` — 正しい答えを作る前提 / 不変条件・事前/事後条件 / 型・静的解析・runtime assertion / プロパティ・差分・review
- `policy-evaluation` — execution profile / cold review / deterministic vs latent eval / context-budget model / regression guard
- `design-refinement` — 実装前 evidence-first design / unknown 分解 / scope-risk 調整 / trade-off documentation
- `writing-discipline` — reader-oriented writing / 作業 context から独立した artifact への再構成 / Select-Compose-Reread pipeline
- `interaction-discipline` — agent ownership / blocker presentation / one-question escalation / tangent defer / persistent prose routing
- `linear-release-control` — Linear を optional release planning / health / portfolio control plane として使う契約（採用時のみ）
- `worktree-workflow` — Worktrunk を WSL/Linux の worktree 操作 layer として使う契約 / branch base / port allocation

## Constitution / operating profile

- 最上位 contract: [`constitution/CONSTITUTION.md`](constitution/CONSTITUTION.md)
- current Operating Model: [`organization/profiles/release-driven-solo.md`](organization/profiles/release-driven-solo.md)
- 既存の project-specific spec / architecture / ADR は、Constitution と両立する限り generic upstream Practice より具体的な authority として維持する。
