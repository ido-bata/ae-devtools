# Development Workflow

> プロジェクトの通常の開発ワークフローをまとめる。
> 仕様の固定ではなく、weekly release sprint / durable ticket / Draft PR lifecycle / quality profile の canonical entrypoint。

関連 canonical:

- [AGENTS.md §10〜§17](../AGENTS.md) — governance の枠組み
- [`docs/release.md`](./release.md) — release integration / target release PR
- [`docs/security.md`](./security.md) — security profile / advisory intake
- [`docs/recovery.md`](./recovery.md) — durable checkpoint / recovery algorithm
- [`docs/architecture/decisions/ADR-0003-weekly-release-sprint.md`](./architecture/decisions/ADR-0003-weekly-release-sprint.md) — weekly sprint の詳細決定

## Source / Work State of Truth（SoT の明示）

| 対象 | canonical | 補助 |
|------|-----------|------|
| released code / config / design | `main` | — |
| active sprint integration | `release-<major>-<minor>-<patch>` | — |
| durable ticket / priority / dependency | GitHub Issues | GitHub Projects（planning control plane; aid のみ / SoT ではない） |
| release planning（GitHub Projects 採用時）| GitHub Projects（durable SoT ではない / planning control plane）| optional Linear profile（採用時のみ、ADR-0014）|
| review / integration surface | GitHub Pull Requests | — |
| PR 配下 / reviewer / classification | assignee / requested reviewer / CODEOWNERS / labels / PR metadata | — |
| public `main` 保護 | branch protection / ruleset + required release-source check when applicable | — |
| transient execution | Supervisor | — |
| project-wide policy / design | [`docs/vision.md`](./vision.md), [`AGENTS.md`](../AGENTS.md), [`docs/architecture/decisions/`](./architecture/) | — |
| repository-controlled operational docs | `docs/*.md`, `docs/architecture/decisions/`, `docs/architecture/research/`, `skills/` | — |
| durable recovery checkpoint | documented in [`docs/recovery.md`](./recovery.md) + remote commit/PR/ref identity | — |

GitHub Projects と Linear で同じ field を二重 canonical にしない。**Linear の Project status / Done 境界は release-level reconciliation** で個別チケットの Done 境界に含めない（[ADR-0014](./architecture/decisions/ADR-0014-linear-profile.md)）。

## Weekly release sprint

- 通常 sprint は **1 週間**。これは planning cadence であり、工期保証ではない。
- 1 sprint = 1 target semantic version = 1 release integration branch。
- release branch: `release-<major>-<minor>-<patch>`（例: `release-0-1-0`）。
- sprint 開始時に `main` から release branch を作成する。緊急 patch 等、release scope / date を明示的に decision する場合は 1 週間から外れてよい。patch release でも `main` を直接変更せず patch release branch からの release PR を使う。
- 中長期 release / roadmap / milestone / capacity / agent 数による短縮見積もりは `agent-delivery-estimation` Skill を使う。主観的 calendar / linear agent scaling に依存しない。

詳細: [`docs/release.md`](./release.md) + [`docs/architecture/ADR-0003-weekly-release-sprint.md`](./architecture/decisions/ADR-0003-weekly-release-sprint.md)。

## Ticket / branch / Draft PR lifecycle

### 独立 ticket（hard predecessor なし）

- branch 名: `<issue-number>`
- base: `release-<x-y-z>` 直接
- first meaningful commit を canonical remote へ publish して remote head SHA を確認した直後に Draft PR を作成
- 1 top-level Issue = 1 durable ticket branch = 1 ticket PR を基本

### 同 release 内の linear hard dependency（stacked PR）

- dependent ticket PR は immediate predecessor ticket branch を base にしてよい
- stack members は共通 target release branch を stack trunk として持つ
- 条件: same repository / same target release / real hard dependency / ordered chain として表現可能 / predecessor に reviewable immutable commit/snapshot が存在
- 1 Issue を複数 durable PR へ細切れにする目的で stack を使わない
- branching dependency DAG を無理に 1 本の stack へ変換しない

`stack-ready execution`: predecessor が release へ未 merge でも reviewable immutable predecessor snapshot があれば dependent worker を開始できる。predecessor 変更に伴う rebase / update で downstream SHA が変わったら affected required validation を **新しい SHA に再 pin** する。古い green result を流用しない。

### durable branch start contract（canonical）

```
1. issue と target release を確認
2. branch 作成: git switch -c <issue-number>
3. first meaningful commit を作成（空 commit は不可）
4. canonical remote へ publish: git push origin <issue-number>
5. canonical remote の branch head SHA が commit SHA と一致することを確認
   gh api repos/<owner>/<repo>/git/ref/heads/<issue-number>
6. immediate Draft PR を作成（linked Issue / assignee / reviewer or CODEOWNERS / established labels / target release / stack context を設定）
7. implementation を継続
```

Draft PR を「実装完了時に作る」運用や、first commit を local だけに残したまま追加実装する運用を禁止。human / Coordinator / implementation worker / subagent すべてに適用。

remote publication 権限または PR mutation 権限が無い worker は first meaningful commit 後ただちに Coordinator / Supervisor へ handoff し、Coordinator / Supervisor が publish + remote head SHA 確認 + Draft PR 作成を完了するまで追加実装を進めない。

### PR metadata（作成時に評価・設定する）

- linked Issue
- accountable assignee
- requested reviewer / CODEOWNERS-derived reviewer
- repository-established labels
- acceptance criteria
- implementation summary
- validation results / status
- known blockers / limitations
- target release
- stack trunk / immediate predecessor / successor context when applicable

`が存在しない label を形式的に作る`、`無関係な reviewer を指定する`、`author 自身を自己 reviewer として欄だけ埋める`運用はしない。meaningful reviewer が存在しない場合、その事実と configured review automation / CI / explicit final review 等の代替 path を **review / merge semantics へ影響する場合に限り** PR body に明記する（`github-delivery` / `writing-discipline` の operations 上の必要性がある範囲に限定）。

### Ticket Done

- required CI / checks が current landing candidate で green
- blocking review が resolved
- ticket changes が **target release trunk へ land 済み**
- Issue を明示 close（target release-trunk 着地成功後）
- **GitHub Projects を planning control plane に使う場合**: Project の ticket status を Done に更新
- **optional Linear profile を採用した場合**: ticket status 更新は行わない。release-level Project status の Completed / Done 更新は release 完了時の reconciliation で別途実施し、個々の ticket Done 境界に含めない

native stacked PR では contiguous stack landing で target release trunk に到達した ticket だけを Done にする。`124 -> 123` のような intermediate predecessor branch merge だけで Issue #124 を close / Done にしない。

non-default branch への merge では closing keyword だけに依存しない。

## Quality profile（adaptive）

ガバナンスの固定 bundle を盲信しない。framework / runtime / SDK の **current official guidance** から project 固有 profile を compile する。

### Calibration for ae-devtools

ae-devtools は vision.md で多数を「未確定」と記録する design / research 段階である。language / framework / SDK の selection が固まっていない以上、generic な固定 Linter / test bundle を入れると未確定領域を前提の上で固定化してしまう。

当面:

- **Node.js syntax check**: `experiments/runtime-bridge/node-server/server.js` を `node --check` で syntax check する（researcher 環境でも回せる)
- **ADR link / status 一貫性**: `docs/architecture/*.md` 内の `Status:` 行とリンクが壊れていないかを simple grep / 派生 check で担保する
- **citation access date**: research / ADR / docs 内の URL 引用に access date が付与されているか spot check
- **manifest / XML well-formed**: `experiments/runtime-bridge/cep-panel/CSXS/manifest.xml` を `xmllint --noout` で検証（optional）

domain 実装（CEP panel ExtendScript / VSCode Extension / MCP Server いずれか）が始まった時点で、framework / runtime / SDK 別の公式 guidance から **language-specific quality gate** を別途起票し ADR で固定する。

### False green 禁止（再掲）

`.only` / `|| true` / blanket suppression / CI disabling 等の偽装 green 禁止。coverage threshold を盲目的に target にしない。partial / stale validation を full pass として再利用しない。stack rebase / update で SHA が変わったら affected required validation を **新しい SHA** に再実行する。

### Verification level 決定

変更 surface / risk に応じて次の組合せで判断する。詳細は [AGENTS.md §12](../AGENTS.md#12-quality--verification--security-profile) を参照。

- pure logic → unit
- API / service → unit + integration
- DB / schema / migration → integration + schema/migration + smoke
- runtime / env / network / DI → smoke + relevant integration
- user journey / auth / navigation → integration/contract + E2E
- build / package / container → build/package + smoke
- release → full applicable integration + critical E2E/smoke + release checks

unit だけで smoke / integration correctness を証明した扱いにしない。

## GitHub Project / Kanban（planning control plane）

Project を使う場合の最小カラム:

`Backlog → Ready → In Progress → In Review → Done`

WIP を実 capacity に合わせる。dependency execution 上は次の metadata を使い、Project Status 列自体を増やす必要はない。

- `blocked`: prerequisite snapshot が未到達
- `stack-ready`: reviewable immutable predecessor snapshot があり dependent work を開始可能
- `integrated`: ticket changes が target release trunk へ land 済み

Stack 運用の canonical description は [`docs/architecture/ADR-0003-weekly-release-sprint.md`](./architecture/decisions/ADR-0003-weekly-release-sprint.md) を参照。

## Engineering decision precedence

判断は次の順:

1. project-wide policy / canonical architecture / invariant
2. design / specification / explicit task instruction
3. coherent existing implementation majority
4. current official framework / runtime / SDK guidance
5. established ecosystem convention
6. local best judgment

詳細: [`AGENTS.md §11`](../AGENTS.md#11-engineering-decision-precedence--user-escalation) + `engineering-decisions` Skill。
