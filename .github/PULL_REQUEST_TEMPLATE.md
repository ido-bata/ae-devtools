# Pull Request

> canonical PR metadata set. AGENTS.md §10, ADR-0003, ADR-0012 を前提に組み立てる。
> 詳細は `docs/development.md` および `docs/architecture/decisions/` を参照。

---

## 0. リンク / メタ

- **Linked Issue**: #
- **Target release branch**: `release-x-y-z`
- **Branch name**: `<issue-number>`
- **Branch base**:
  - [ ] `release-x-y-z`（independent）
  - [ ] 直前 predecessor ticket branch（stacked; 以下に SHA）
    - predecessor SHA:
- **Stack trunk / 順序**: (stacked の場合)
- **Assignee**:

---

## 1. 対応 Issue / Acceptance criteria

> Issue 本文の acceptance criteria をそのまま貼り、満たすものを ✔ する。

- [ ] acceptance criteria 1
- [ ] acceptance criteria 2
- [ ] acceptance criteria N

---

## 2. 実装概要

- 何を変えたか（reason-driven 1〜3 行で）
- なぜこの方式か（採用案・不採用案）
- 境界面（VSCode Ext / MCP / AE bridge / shared core）へのインパクト

---

## 3. Verification

`AGENTS.md` §12 + `docs/development.md` §Verification を前提に、 該当 level を ✔ して evidence を貼る。

- [ ] Unit
- [ ] Smoke / connectivity
- [ ] Integration
- [ ] Contract / schema
- [ ] E2E / system
- [ ] Manual / visual (AE 本体 / パネル UI / native addon 等)

### evidence

- command / output / link / SHA などを具体的に貼る

---

## 4. False-green / suppression 監査

- [ ] `.only` / `|| true` / blanket suppression / CI disabling / ignored exit code 等は使用していない
- [ ] `.skip` / `.todo` を無条件 commit していない
- [ ] coverage threshold を盲目的に target にしていない
- [ ] stack rebase / update で SHA が動いた箇所は affected required validation を新しい SHA に再 pin した

---

## 5. Security / privacy チェック

- [ ] secret / token / 個人識別子 / machine-specific absolute path を diff / log / commit message / agent result に含めていない
- [ ] loopback bind / per-launch token / body cap / Origin allowlist 等の docs/security.md 境界を逸脱していない
- [ ] advisory を導入 / 更新した場合は SECURITY.md / docs/security.md に整合

---

## 6. Stack / predecessor / merge 関係

- 直前 predecessor SHA が最新（再 pin 済み）
- predecessor mutation がある場合、 affected validation を新 SHA に再 pin
- merge target は `release-x-y-z`（stacked の場合は predecessor 経由）

---

## 7. ADR / docs 整合

- AGENTS.md / docs/ / docs/architecture/decisions/ のうち、 本 PR が更新する file 一覧
- AGENTS.md の dispatcher section から 新規 / 修正 file へ pointer が張ってある

---

## 8. レビュー観点

- 重点的に見てほしいところ
- 不安なところ / 質問したいところ

---

## 9. Ready to merge 状態

> ADR-0003 §9 を満たす状態。**ADR-0012 により merge 実行は explicit user authorization を待つ。**

- [ ] acceptance criteria implemented
- [ ] current-SHA-required checks（worker / integration / stack reconciliation）green
- [ ] blocking reviews resolved
- [ ] PR metadata matches reality
- [ ] target release / immediate predecessor 関係が reconcile 済み
- [ ] predecessor-mutation-driven revalidation 完了（stacked の場合）

> agent は ready-to-merge で **停止** し、 head SHA / required checks / outstanding reviews を report する。

---

## 10. 関連 ADR / docs

- ADR / docs link 一覧
