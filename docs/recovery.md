# Recovery Model

> AI agent / sandbox / provider / context のいずれを失っても fresh agent が unfinished work を再開できるようにするための recovery model の canonical 入口。

関連 canonical:

- [AGENTS.md §10, §14, §17](../AGENTS.md)
- [`docs/architecture/decisions/ADR-0004-recovery-checkpoint-model.md`](./architecture/decisions/ADR-0004-recovery-checkpoint-model.md)
- [`docs/development.md`](./development.md) — ticket branch / Draft PR lifecycle
- [`docs/release.md`](./release.md) — release branch / release PR の復旧

## Failure model（最低限）

- model / session context loss
- agent process crash / cancellation
- IDE / terminal restart
- parent agent crash while child continues
- child / subagent crash
- sandbox / container / VM recreation
- Supervisor restart
- transient network / provider failure
- host reboot
- context-window exhaustion

project / provider 要件に応じて machine / provider loss までの RPO / RTO も定義する。ae-devtools 単体では lightweight に:

- **RPO**: durable ticket 単位（GitHub Issue / PR）。active durable branch に意味のある実装があるならそれが RPO の最小単位。
- **RTO**: fresh agent が durable state から reconstruct 完了するまでの時間。GitHub 接続 + branch fetch + checkpoint read が一巡できる時間が下限。

## Durable recovery sources（優先順）

1. **GitHub Issue / dependency state**（canonical SoT）。planning control plane（GitHub Projects / Linear）は補助。
2. **target release branch** + **ticket branch / remote commit graph**
3. **Draft / Ready PR**（assignee / reviewer / labels / review / CI state）
4. **stack predecessor / pinned predecessor SHA** when applicable
5. **committed design / ADR / Skills / docs**（会話履歴ではなく version 付き canonical text）
6. **immutable worker / subagent results**
7. **structured recovery checkpoint**（明示的に checkpoint 化された external state）

native conversation ID / agent ID / Supervisor local DB / shell history / IDE state は **transient optimization** であり、canonical 復旧点にしない。

## active durable ticket branch の正常 state

`active durable ticket branch` は次の状態を正常 state として扱う:

- canonical remote に branch が push されている
- canonical remote の branch head SHA が追跡可能（GitHub API で解決できる）
- immediate Draft PR が存在
- PR metadata（assignee / reviewer / labels / linked Issue / target release / stack context）が現状と一致

これらが一つでも欠ける場合は正常 state として扱わず、 **delivery surface を修復** する。

## release branch の正常 state

`release-x-y-z`:

- `main` と zero-diff の間: Draft release PR **不要**（GitHub の制約による明示的例外）
- first meaningful integrated difference が入ったら: **Draft release PR を必須**
- release gate 通過 + ready-to-merge まで進んだら Draft release PR を Ready に

これらの正常 state を満たさない release branch は修復する。

## Soft / Hard checkpoint

### Soft checkpoint

same host / sandbox recovery 向け。

- local immutable Git ref
- filesystem snapshot
- Supervisor journal
- native session state

短時間（数十分〜数時間）の中断では soft checkpoint で十分。external side effect を伴わないこと。

### Hard checkpoint

sandbox / provider を失っても復旧する境界。

- durable ticket: recorded commit が canonical remote で到達可能で remote head identity と Draft PR を追跡できること
- release branch: zero-diff 例外または first-difference 後の Draft release PR が存在すること
- durable checkpoint journal（structured checkpoint）が Supervisor 外部 storage に書かれていること

すべての小 edit を remote commit して history を汚す必要はない。project の RPO / task length / provider TTL から checkpoint 頻度を決める。

### Structured checkpoint schema（最低限）

checkpoint を file / artifact に残す場合は次の schema を最低限満たす:

```yaml
schema_version
issue_id
target_release
ticket_branch
pr_number
immediate_pr_base
predecessor_issue_or_pr
predecessor_sha
base_sha
checkpoint_sha_or_snapshot
execution_generation
status
completed_steps
next_steps
pending_validation
active_children
integrated_child_results
external_side_effects
blockers
decision_refs
artifact_refs
updated_at
```

秘密 / machine-specific absolute path / private reasoning を含めない。

## Recovery trigger（少なくとも次の前後）

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

## Recovery algorithm（fresh agent）

会話履歴を推測せず次を実行する:

1. **Issue / PR / target release / dependency を GitHub から fetch**
   `gh issue list`, `gh pr list`, `gh api repos/<owner>/<repo>/branches` 等で canonical 状態を最新から取得
2. **ticket / release branch / remote commit graph / stack relation を照合**
   `git fetch --all` で remote branch を全て取得し、active durable branch / release branch の状態を確認
3. **durable ticket の delivery surface 修復**
   published remote head 確認 → first meaningful commit を publish → remote branch head SHA 確認 → immediate Draft PR 作成（必要なら）。release branch は zero-diff 例外または first-difference 後 Draft release PR を確認
4. **latest valid checkpoint を読む**
   local Supervisor journal → file system → 過去 checkpoint 候補へ順に降下して最新 valid を読む
5. **canonical policy / design / decision refs を確認**
   [`AGENTS.md`](../AGENTS.md), [`docs/vision.md`](./vision.md), [`docs/architecture/decisions/`](./architecture/), [`skills/`](../../skills/) を読む
6. **active children を Supervisor から再発見**
   `gh api` / Supervisor API / journal から running / completed / failed / orphaned を分類
7. **checkpoint から workspace を recreate**
   - soft: filesystem snapshot apply
   - hard: durable state から git checkout + branch sync + remote confirm
8. **completed / pending validation を再評価**
   stack update があったなら affected required validation を新しい SHA で再実行（[AGENTS.md §12](../AGENTS.md)）
9. **external side effect の actual remote state を確認**
   release tag / deploy / notification / billing を remote actual で照合
10. **stale base / predecessor / conflicting integration を確認**
    target release の land 状況と predecessor の同期状態を確認
11. **remaining plan を再構成**
    remaining work / open question / blocked items を Issue / Project 状態と整合させる
12. **safe な最小 verification で reconstructed state を確認**
    smoke / unit / focused integration のみ実行（full gate はしない）
13. **execution generation / lease を更新して続行**
    Supervisor 側で `execution_generation` を上げ、stale result の自動統合を防止

native resume に成功しても branch / PR / checkpoint との整合を確認してから続行する。

## Parent / child recovery と split-brain 防止

child lifecycle は parent model process ではなく **Supervisor / control plane** が所有する。

parent が死亡しても safe な間は child を即 cancel しない。recovered parent / coordinator は次を行う:

- child 一覧を再発見
- input snapshot / predecessor snapshot / execution generation を確認
- running / completed / failed / orphaned に分類
- completed result を immutable result として回収
- durable branch child では published remote head / Draft PR identity / metadata を reconcile
- stale child result は自動統合しない
- 必要なら retry / resume / re-spawn

network partition / timeout 後に旧 agent と新 agent が同時実行する可能性を前提にする。Supervisor は task ごとに lease / generation / fencing token を持つ:

- recovery 時に `execution_generation` を進める
- worker result へ generation を付与
- stale generation からの branch integration / external write を拒否
- heartbeat 消失だけで即同一 side effect を再実行しない

同じ ticket branch へ複数 generation が同時 push する運用を禁止する。

## Context handoff

context window 接近を failure ではなく **planned handoff event** として扱う。次の trigger で structured checkpoint へ externalize する:

- meaningful implementation milestone 完了
- risky refactor / migration 前後
- child spawn 直前
- child result integration 直前
- long validation 開始直後
- external side effect 直前
- provider TTL / shutdown 接近

長い conversation summary や private reasoning を保存するのではなく、fresh agent が再実行可能な **operational state** に圧縮する。

## Recovery drill（定期確認）

定期的に次を dry-run する:

1. ticket work を checkpoint
2. agent / sandbox を意図的に停止
3. fresh agent / sandbox から recovery algorithm を 1〜13 まで実行
4. branch / remote head / PR / stack / children / validation / side-effect journal を再構成
5. release branch の zero-diff 例外 / first-difference 後 Draft release PR を確認
6. duplicate mutation なしで続行できることを確認

dry-run で発見した欠落は Issue 化し次の sprint で修復する。
