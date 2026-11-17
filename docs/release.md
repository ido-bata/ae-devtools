# Release Integration

> weekly release sprint から target release への integration フローをまとめる。
> 主要 canonical は [`docs/architecture/ADR-0003-weekly-release-sprint.md`](./architecture/decisions/ADR-0003-weekly-release-sprint.md) と [`docs/architecture/ADR-0012-release-merge-authorization.md`](./architecture/decisions/ADR-0012-release-merge-authorization.md)。

関連 canonical:

- [AGENTS.md §10-§17](../AGENTS.md)
- [`docs/development.md`](./development.md) — weekly sprint / ticket lifecycle / quality profile
- [`docs/recovery.md`](./recovery.md) — release branch 復旧時の扱
- [`docs/security.md`](./security.md) — security advisory intake → patch release 分岐

## Release branch

- release cadence は **deliverable-unit**（[`ADR-0015-deliverable-unit-release-cadence.md`](./architecture/decisions/ADR-0015-deliverable-unit-release-cadence.md)）。固定日程ではなく、独立して利用可能な成果物が成立した単位で release を切る
- 前 release PR が pending の間は、次の release branch を **frozen head から** 作成する（`main` からではない。ADR-0015 §4）
- 緊急 patch 等、release scope / date を明示的に decision する場合は cadence から外れてよい
- patch release でも **`main` を直接変更せず** patch release branch からの release PR を使う
- release branch は remote で head を解決できる必要があるため、push / fetch のいずれかが成立するようにする

## Release PR (Draft → Ready)

- release branch は `main` と zero-diff の間だけ Draft release PR 不要（GitHub が差分なし PR を許可しない）
- **first meaningful integrated difference** が入った直後に Draft release PR を作成
- Draft release PR には assignee / reviewer / labels / release goal / included Issues / breaking changes / migration notes / validation evidence を設定
- release branch の意味は target release ごとに 1 つ。first meaningful difference 後に Draft release PR を必須とする

### Release PR 本文

タイトル / 本文は日本語。最低限:

- release goal
- included Issues / PRs
- breaking changes
- migration notes
- validation evidence（後述）
- known limitations
- version / release metadata

validation evidence は CI 形態によって扱いが分かれる（[`writing-discipline` Skill](../skills/) の full snapshot の無条件 serialize 回避方針と整合）:

- **native CI checks（GitHub Actions / workflow run）が available な repository**: native checks を canonical evidence とし、`github-delivery` の ready-to-merge semantic は GitHub UI 上の required check status で判定する。validated SHA pinned reference と workflow run status の PR 本文への pin / 転写は **reader が evidence を再 fetch する必要が生じた場合に限り** 行い、Draft → Ready / merge candidate の必須 rule として固定化しない。
- **CI が configured でない repository（policy / docs only を含む）**: validated SHA pinned reference と `evals/` 配下の canonical control reproduction block を release evidence として本文へ残す（`evals/` controls を fresh agent / reviewer / CI runner から再取得できる形）

いずれの場合も full snapshot の無条件 serialize は避け、reader が必要時に evidence を再 fetch できる pointer を本文に残す方針は共通。

ae-devtools では `.github/workflows/ci.yml`（`pull_request` 対象、package / experiment suite ごとの detect-and-skip job）と `.github/workflows/release-source-check.yml`（`main` 向け PR の defensive gate）が configured であり、release evidence は上記「native CI checks が available」分岐に従う。PR #1（`release-0-1-0 → main`）の checks が validated SHA に対する canonical evidence となる。

## Release gate

`release-<x-y-z> → main` の PR 前に release-wide verification を実行する。必要に応じて:

- full applicable integration
- critical E2E / smoke
- production build / package
- browser / device / OS matrix（CEP 関連は AE 25.x on Windows / macOS 等）
- migration rehearsal（schema / dependency major upgrade 時）
- signing / notarization（`.zxp` / InstallKit 等を採用する場合）
- deployment / IaC plan

release gate 実施途中で中断した場合、途中までの green を full pass とみなさない。check result は code snapshot に bind し、stale success を再利用しない。

### conformance gate（capability evidence、Issue #21 / CAP056）

`release-x-y-z → main` の release-source check は `packages/capability-catalog` の conformance release gate（`bun run conformance-gate`、`.github/workflows/release-source-check.yml`）を必須 check として実行する。判定規則と release 受入との接続は次の通り。

- **claim 集合** = catalog の `coverage.verification: verified-real-host` 行 ∪ `release-scope.json` の `claimedCapabilities`。宣言 claim は catalog row の存在と `compatibility.os` 宣言を cross-check され、catalog が宣言しない platform の claim は `platform-not-declared` で fail する。
- **evidence record** は `evidence/conformance/<runId>/record.json` + cited artifacts として commit され、`artifactHashes` が release candidate と same-bytes で再計算できる場合のみ有効（`design/conformance-evidence.md` §3）。claim を満たせるのは `verified-real-host` の `PASS` record のみ。
- **verdict の意味**:
  - `pass` — 評価対象の全 claim に実機 evidence がある。
  - `violations` — scope / claim 違反あり。check は fail する。
  - `no-claims` — claim 集合が空。**verified conformance の pass ではなく、実用性の証明でもない**。`supportedRelease` 未記録のまま CI が green になる現状を「対応環境が検証済み」と読み替えない。
- **`supportedRelease` の記録は owner decision**（`specs/ae-capability-coverage/plan.md` §6.1）。`not-recorded` は gate の diagnostic であり blocker ではないが、release 受入時には「どの AE build / SDK / OS を supported と主張し、何を範囲外とするか」を release PR 本文で明示する。
- **未検証 platform を claim に追加して gate を阻止することもしない**。Windows が UNVERIFIED のままなら claim しないことが正直な状態であり、release notes / PR 本文に `UNVERIFIED` と明記する。逆に、検証済み evidence のない capability を `claimedCapabilities` に書いて通すこともできない（evidence record がなければ violation）。

Release PR 本文は少なくとも (a) conformance gate verdict、(b) claimed capabilities と各々の evidence level、(c) UNVERIFIED platform・未対応 SDK の一覧、を明示する。`no-claims` を実機検証済みと表現しない。

### stack reconciliation gate（predecessor 変更時の再検証）

stacked PR 構造を採用した場合、predecessor の rebase / update / merge の結果 downstream head SHA が変化するたびに、affected required validation を **新しい SHA に再実行** する（[AGENTS.md §12](../AGENTS.md) の False green 禁止 と整合）。

## Merge 前の最終確認

`release-x-y-z → main` PR merge 直前に **次の状態** を満たすこと:

- review 条件が green: solo-maintainer 構成では GitHub approval count は 0 であり、ADR-0012 §7 の solo adjustment に従い「自動レビュー + agent 側独立レビュー + release evidence」で代替する（CODEOWNERS は approval gate ではなく ownership map）
- required CI / checks current landing candidate で green
- target release のチケットが ready 状態（未 commit の依存なし）
- outstanding blocking review conversation が 0
- included Issues と release PR 本文のずれがない
- breaking changes / migration notes が current の記述と一致
- critical security advisory が current バージョンで対応済みか明示

## Release PR merge authorization（ADR-0012）

[`ADR-0012-release-merge-authorization.md`](./architecture/decisions/ADR-0012-release-merge-authorization.md) の **explicit user authorization 境界** に従う。

- reviewer / CODEOWNERS approval は merge の **前提条件**（solo 構成では ADR-0012 §7 の solo adjustment により代替条件で充足。実質的な binding 条件は次項の explicit user authorization）
- merge そのものを実行する権限は **user** が保持する
- Agent は release-wide verification 完了 + release gate green + ready-to-merge 状態まで進めた時点で **ready-to-merge で停止**
- その時点の head SHA / required checks / outstanding review conversations を report
- authorization 取得のための追加質問は行わない

merge は user が明示的に authorization した時にのみ実行する。merge 後に `main` がその version の released state となる。

merge method は **merge commit** を使う（`required_linear_history` は solo 構成で無効化済み）。merge commit の第2 parent が freeze SHA と一致することを `git rev-parse <merge-sha>^2` で検証し、freeze SHA ↔ 統合後 SHA の対応を機械的に確認できるようにする。squash / rebase は per-issue の追跡性と freeze SHA の保全を損なうため使わない。

## Tags / releases の公開

- 通常 merge 直後に GitHub Release を作成（tag は merge commit を指す）
- prerelease / draft release の運用は別途 ADR で規定する
- external side effect として `git push --tags` / `gh release create` を実行する場合は [`docs/recovery.md`](./recovery.md) §external side effect の journal / idempotency 規則に従う
