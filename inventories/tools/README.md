# inventories/tools — 既存AE操作ツールの実装機能inventory（CAP001–CAP004）

After Effects を操作する既存ツールを **README の宣伝ではなく実装コード** から棚卸しし、
実装済み operation を出典（file + line）つきで記録する。Issue: [ido-bata/ae-devtools#8](https://github.com/ido-bata/ae-devtools/issues/8)。

> **証拠レベル: source-reviewed（ソース読解のみ）。** 本inventoryのいずれの行も実機AEでの動作確認
> ではない。実機検証は #13–#19 の担当。網羅性・完了率の百分率は主張しない（母集団は開いている）。

## 範囲

- **対象 (CAP001)**: `snapshot/tools.json` に列挙されたツール。GitHub の
  `gh search repos "after effects mcp"`（2026-11-12 実行、検索条件は `generated/discovery.json`）
  で見つかった主要実装、既存研究で参照済みのリポジトリ（BenZed/after-effects、ido-bata/Ae_LayerNote）、
  および ae-a8n / ae-devtools 自身。
- **記録内容 (CAP002)**: `generated/operations.json` — 各 operation の
  `name` / `args` / `access` / `accessBasis`（分類根拠） / `route`（実行経路） /
  `definitionFile`+`definitionLine`（宣言位置） / `implementationFile`+`implementationLine`（実装位置） /
  `status`。**file と line は必ず同一ファイル内で解決する**（`bun run verify` が全行を機械検証）。
- **正規化 (CAP003)**: `generated/semantics.json` — semantic operation ID（**暫定**。確定文法は #11）
  と、ae-a8n / ae-devtools に対する gap matrix。1つの Adobe API を複数ラッパーが経由する場合は
  semantic ID で1件に集計し、二重計上しない。
- **更新手順 (CAP004)**: 下記「更新手順」と `generated/discovery.json` の `refreshProcedure`。

## 非範囲

- 他リポジトリのソースコードの複製・コミット（`.reference/` は gitignore。出典は URL + commit SHA のみ）
- 実機AEでの動作確認・性能・セキュリティ検証（#13–#19）
- unique capability ID 文法・最終 catalog schema の確定（#11）
- 宣伝上の機能数を「実装済み」として数えること。README の記述は証拠ではない
- 「全ツール網羅」の主張・完了率の百分率

## access の分類ルール（D1 対策）

`access` は各 operation の実装コードから導出し、根拠を `accessBasis` に行として記録する。
既定値 `write` は存在しない。分類できなければ `unknown` として計上する（`write` に丸めない）。

| class | 意味 | 例 |
| --- | --- | --- |
| `read` | ホスト/プロジェクト状態の参照のみ | `app.info`、`project.comps`、`effect.parameters` |
| `write` | プロジェクト内容の変更（永続化を含む） | `comp.addText`、`effect.setParameter` |
| `execute` | プロジェクト内容を変えないホスト/UI操作 | `ui.alert`、`app.quit`、UI選択変更、レンダリング出力 |
| `host-callback` | ホスト側コールバック面の呼び出し | （該当行があれば） |
| `build-test` | ビルド/テスト専用の面 | runtime-bridge の例外プローブ |
| `unknown` | source から判定不能 | 分類不能件数として明示 |

特例も実挙動どおりに記録する: 一時オブジェクトを作って直後に削除する処理は、
「net content is unchanged（成功パスで削除済み）」を basis に付けて `write` とする。

## citation の完全性（D3 対策）

- `definitionFile` + `definitionLine` は **同じファイル内** で解決しなければならない。
- `implementationFile` + `implementationLine` も同様。ファイル欠落・行数超過は検証失敗。
- `bun run verify` が全 row について機械検証する（不整合0 が受入条件）。

## 構成

```
inventories/tools/
├── README.md               # 本ファイル
├── package.json / tsconfig.json / bun.lock
├── scripts/
│   ├── registry.ts         # CAP001: ツール定義（commit pin / license / 出典）
│   ├── extract.ts          # CAP001-003 抽出エントリ（deterministic）
│   ├── refresh.ts          # CAP004: 差分検出・再pin手順
│   ├── verify.ts           # byte-identical + citation 検証
│   ├── classify.ts         # access 分類（根拠付き）
│   ├── semantics.ts        # CAP003: semantic ID 正規化表 + gap matrix
│   ├── text.ts             # file/line ヘルパ
│   └── adapters/           # ツールごとの抽出器
├── generated/              # 機械生成（手編集禁止）
│   ├── discovery.json      # CAP001 探索条件 + CAP004 手順
│   ├── operations.json     # CAP002 operation 行
│   └── semantics.json      # CAP003 semantic + gap matrix
├── snapshot/
│   └── tools.json          # ツール記録（commit/license/observedAt/status）
└── tests/                  # bun test
```

## 更新手順（CAP004・再実行可能）

1. **探索差分**: `gh search repos "after effects mcp" --limit 30 --json fullName,license,updatedAt,stargazersCount`
   を再実行し、`snapshot/tools.json`（調査済み）と `discovery.json` の未調査リストと突合する。
   新規リポジトリは「未調査」として reason 付きで残すか、下記 4 で追加する。
2. **upstream 差分**: `bun run refresh` — 各 pinned clone を fetch し、pin より新しい commit を報告する。
3. **再抽出**: `bun run extract` — pinned checkout から決定的に再生成。
4. **受入**: upstream 更新を確認のうえ `bun run refresh -- --update <tool>` で pin を更新（or registry.ts を直接編集）、
   新ツールは `.reference/` に clone → `scripts/registry.ts` に ToolDef 追加 → adapter 追加 →
   `scripts/semantics.ts` に semantic ID 追加。
5. **検証**: `bun run verify`（byte-identical + 全 citation 解決）と `bunx tsc --noEmit` / `bun test`。
6. 差分をレビューのうえ commit。

## 件数（正直な記録）

最終件数は `generated/operations.json` の `counts` を正とする（本 README の記述より機械生成が優先）。
未調査・未検証の候補は `snapshot/tools.json` の `notExamined` に理由つきで残す。
