# Troubleshooting

> 失敗ケースと復旧経路の canonical 入口。

関連 canonical:

- [`docs/recovery.md`](./recovery.md)
- [`docs/development.md`](./development.md) — ticket / branch / Draft PR lifecycle
- [`docs/release.md`](./release.md) — release integration
- [`docs/security.md`](./security.md)
- [AGENTS.md](../AGENTS.md) §Self-audit / False green 禁止

## Draft PR なしで実装が進んでしまった

**症状**: active な ticket branch に first commit が local のみ、または commit の remote publish 後に Draft PR がない、または PR が来たが remote head SHA と一致していない。

**対応**:

1. `git log --oneline -n 5` で直近 commit を確認
2. 未 push の commit を `git push origin <branch>` で canonical remote へ送る
3. `gh api repos/<owner>/<repo>/git/ref/heads/<branch>` で remote HEAD が commit SHA と一致することを確認
4. immediate Draft PR を作成し linked Issue / assignee / reviewer / labels / target release / stack context を設定
5. AGENTS.md §10 / [`docs/development.md`](./development.md) §Ticket start contract に基づき修復記録を commit に残す

## `release-x-y-z` branch に first difference が入ったのに Draft release PR がない

**症状**: release branch が `main` と差分を持ち始めているが `gh pr list --base main` に Draft release PR が出てこない。

**対応**:

1. `git log main..release-x-y-z --oneline` で差分を確認
2. zero-diff かどうかを再判定
3. 差分がある場合: `gh pr create --base main --head release-x-y-z --title "..." --body "..." --draft`
4. PR body に release goal / included Issues / breaking changes / migration notes / validation evidence を必ず設定
5. [`docs/release.md`](./release.md) の Release gate 項目を満たしてから Ready にする

## release PR の head SHA が変わったが古い green check が残っている

**症状**: stacked PR の predecessor merge / rebase / push で release PR の head SHA が変わったが、CI の green check が古い SHA に紐づいている。

**対応**:

1. `git log --oneline main..release-x-y-z -n 10` で新 SHA を確認
2. `gh api repos/<owner>/<repo>/pulls/<n>/commits` で PR の最新 head を確認
3. required CI を新 SHA で **明示的に re-run** する。古い green result を流用しない
4. [AGENTS.md §12](../AGENTS.md) False green 禁止 / [`docs/release.md`](./release.md) §stack reconciliation gate と整合

## AGENTS.md §1〜§9 と整合しない変更が PR に混ざった

**症状**: vision.md の「未確定」項目を前提にした命名 / ビルド選択 / 配布形態 / IDE 範囲 / ライセンス方針が PR に混入。

**対応**:

1. PR 作成者が未確定項目を勝手に固定しようとしていないか確認
2. 該当 commit の message を確認し、 intent が AGENTS.md §1〜§9 と整合しない理由を PR body に書かせる
3. 整合しなければ fixup commit か revert で修正、整合すれば AGENTS.md / vision.md / docs を先に更新してから PR を Ready にする
4. ADR を起こして決定する経路を PR body に明記する（決定自体は決定してから実装に進む）

## AE 検証環境で `extendscript/*.jsx` の実際実行結果が想定と一致しない

**症状**: Windows / macOS AE で Probe 01-09 を実行したが `Actual` に書いた内容と食い違う。

**対応**:

1. 該当 Probe の「Limitations」「Unverified」を確認
2. `experiments/runtime-bridge/EXPERIMENT-LOG.md` の Actual / Evidence を正確な値で更新
3. `research/05-security.md` の Unverified リスト / `research/03-state-events.md` の不確実項目との整合を確認し、必要なら `docs/architecture/research/corrections-*` を新規起こして修正案を提示
4. 変更が ADR-0001 §Decision に矛盾する場合は該当 Decision を「Status: Proposed」のまま保ち、 §Status の gating を更新してから promote to Accepted を再評価

## `node-server/server.js` の token 認証が期待通り動かない

**症状**: 正しい token を渡しているのに 401 が返る、または wrong token が 200 になる。

**対応**:

1. `AE_BRIDGE_TOKEN` 環境変数が server 起動 shell に export されているか確認（子プロセスへの伝播忘れが多い）
2. `crypto.timingSafeEqual` の length 短絡が効いていないか（research 05 §Mitigations の length leakage）。両側を SHA-256 等で固定長化してから比較する
3. header name が `X-AE-Bridge-Token` と一致しているか（case-sensitive）。server.js と client の header を揃える
4. curl の `-H` オプションが shell 展開されて token が空になっていないか

## AE panel が `Window > Extensions` に出てこない

**症状**: panel を CEP 拡張フォルダに配置したが AE の `Window > Extensions` に出てこない。

**対応**:

1. `cep-panel/CSXS/manifest.xml` の `<ExtensionBundleId>` と install folder 名が一致しているか
2. `PlayerDebugMode=1` が対応する `CSXS.<ver>`（CEP 12 → CSXS.12; AEFT 25.0 の場合）のレジストリ値に書かれているか（research/02-cep-deep-dive §Signing model）
3. `extensions/` 配下が `%USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions\`（Windows）または `~/Library/Application Support/Adobe/CEP/extensions/`（macOS）に存在するか
4. AE を再起動したか（CEP は AE 再起動まで読み込まれない; research 02 §Load timing）
5. see [`experiments/runtime-bridge/README.md`](../../experiments/runtime-bridge/README.md) §How to reproduce

## parent agent が child の結果を統合したが Draft PR がない

**症状**: child が結果を返したが、ticket branch に immediate Draft PR が作られていない状態。

**対応**:

1. child が returned した immutable result の `draft_pr_identity` を確認する
2. なければ immediate Draft PR を Coordinator / Supervisor 側で作成
3. issue / assignee / reviewer / labels / target release / stack context を metadata として設定
4. child の base_sha / predecessor snapshot と、今作った PR の SHA を一致させる
5. AGENTS.md §10 / [`docs/development.md`](./development.md) §Ticket start contract と整合

## release PR merge を user 承認なく実行しようとした

**症状**: agent が `gh pr merge` を実行しようとした、または ready-to-merge 状態で停止せず merge まで進めた。

**対応**:

1. merge を実行した path を直ちに監査
2. merge を revert（`git revert -m 1 <merge_sha>` または `gh pr` 経由）
3. `main` が壊れていないか `git log main --oneline` で確認
4. 影響範囲（tag / release / downstream branch）を洗い出し
5. [`docs/architecture/decisions/ADR-0012-release-merge-authorization.md`](./architecture/decisions/ADR-0012-release-merge-authorization.md) 該当条項をレビューし、root cause を記録
6. related Issue を起こし再発防止策を ADR / Skill に反映
