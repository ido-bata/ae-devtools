# AE SDK 公開ヘッダー inventory（CAP009–CAP012）

- Issue: [#10](https://github.com/ido-bata/ae-devtools/issues/10) / CAP009–CAP012
- 親 Epic: [#6](https://github.com/ido-bata/ae-devtools/issues/6)
- 対象: After Effects SDK **26.5**（macOS 配布）
- 証拠レベル: **source-reviewed**（ヘッダー読解のみ。実機 AE では未実行）
- Status: **Provisional**。capability ID 文法と catalog schema は [#11](https://github.com/ido-bata/ae-devtools/issues/11) の担当で、ここでは確定しない。

## これは何か

AE SDK の公開ヘッダー（`Examples/Headers`）に現れるシンボルを**宣言コンテキストから**分類し、
その**集計**を記録する。目的は「SDK のどこにどんな種類の入口があるか」を、
後から監査できる形で固定すること。

分類は 5 クラス。各シンボルは必ず 1 つに属する。

| class | 意味 | 判定に使う構造 |
| --- | --- | --- |
| `external-command` | クライアントが AE 側の操作を呼ぶ | suite 構造体 + 登録マクロ `#define k...Suite "..."` |
| `in-host-plugin-command` | ホストがプラグインへコマンドを送る | selector enum、entry-point block |
| `host-callback` | ホストが任意のタイミングで呼ぶ | host procedure table、suite へ登録するフック型 |
| `build-test-lifecycle` | 版・PiPL・ビルド交渉 | version マクロ |
| `unsupported-or-unknown` | 上記に帰属できない／呼び出し方向を持たない | — |

**識別子の綴りや記憶からは分類しない。** 判定は「その型を誰が保持しているか」
「その構造体に登録マクロがあるか」という宣言上の事実による。rule 別の件数を
`aggregate.json` の `byRuleFamily` に出しているので、どの規則が何件を生んだか監査できる。

## これは何ではないか

- **実機検証ではない。** AE は一切起動していない。`verified-real-host` ではない。
- **完全性の主張ではない。** 下記の件数は「構造的に帰属できた行数」であって、
  SDK 公開面の全列挙ではない。
- **能力カタログではない。** ここにあるのは SDK シンボルの棚卸しであって、
  ae-devtools が実装する操作の一覧でも、利用可能であることの表明でもない。
- **Windows の証拠ではない。** 手元にあるのは macOS 配布のみ。Windows 固有の記述は
  macOS 版ヘッダーに現れる分岐以上のことは言えず、すべて **UNVERIFIED**。
- **AE 2026 と 2027 の差の証拠ではない。** 検証していないので記録しない。

## 再配布制約 — 最重要

SDK zip には**ライセンス / EULA / readme が同梱されていない**。
598 エントリのうち文書は PDF 2 点のみで、しかもその 2 点は
「公開ドキュメントサイトへ移転した」という告知だけのスタブである。

ヘッダーには次の通知がある（`ADOBE CONFIDENTIAL` かつ `strictly forbidden` は 70 ファイル中 **29**）:

> 本資料の頒布および複製は、Adobe の事前の書面による許諾がない限り固く禁止される。

したがって **ライセンス許諾の無い派生物を公開することはできない**。本リポジトリの扱い:

| 対象 | 扱い |
| --- | --- |
| ヘッダー本文、コメント、struct レイアウト、プロトタイプ、enum 値 | **commit しない** |
| シンボル名の一覧（完全な機械生成テーブルを含む） | **commit しない**（`.local/` に出力し git ignore） |
| 集計件数、クラス別合計、ハッシュ、取得経緯、抽出方法 | **commit する** |

**判定基準**: 「読者がその一覧を得るのに、自分自身のライセンス済み SDK を必要とするか」。
必要なら公開してよい（＝集計）。不要になるなら公開してはいけない（＝シンボル一覧）。

`.local/symbols.json`（シンボル単位の行）は**ローカル作業物**であり、公開物ではない。
`inventories/sdk/.gitignore` が `.local/` を除外している。

> **#11 / #12 への申し送り**: この制約があるため、公開 capability catalog は既定で
> **集計と出典のみ**を持ち、シンボル単位のデータは build 時に**ライセンス済み SDK から**
> 供給する形にする必要がある。これは本 Issue で決めず、#11 / #12 の決定事項として提起する。

## 件数（分母）

ヘッダー **70 ファイル**（`.h` 68 / `.hpp` 2）。うち `Examples/Headers` 直下が 40、
サブディレクトリ（`SP/`、`adobesdk/` など）が 30。

シンボル総数（分母）: **4677**

| class | 件数 |
| --- | --- |
| `external-command` | 3766 |
| `unsupported-or-unknown` | 552 |
| `host-callback` | 154 |
| `in-host-plugin-command` | 131 |
| `build-test-lifecycle` | 74 |
| **合計** | **4677** |

unknown **552** の内訳:

| 理由 | 件数 | 意味 |
| --- | --- | --- |
| `pure-data-type` | 534 | 呼び出し方向を持たない単純データ型。**未対応コールバックの数ではない** |
| `unattributed-callable` | 13 | 呼び出し可能だが、ヘッダーから方向を決められなかった |
| `reserved-selector` | 5 | `PF_Cmd_RESERVED*` / `..._UNUSED_*` |

kind 別:

| kind | 件数 |
| --- | --- |
| `suite-slot` | 3539 |
| `type` | 534 |
| `suite` | 227 |
| `callback-slot` | 98 |
| `version-or-pipl` | 74 |
| `callback-type` | 69 |
| `entry-point-slot` | 58 |
| `selector` | 49 |
| `entry-point` | 29 |

### 読むときの注意

- **`external-command` が 3766 と大きいのは suite slot の積み上げ**である。
  suite は版ごとに累積する（例: ある suite の v1〜v13 がすべて宣言されている）ため、
  「3766 個の独立した操作」ではない。**版違いの重複を含む。**
- deprecated ヘッダー（`*Old.h`）の **2318** シンボルは分母から除外していない。
  機能クラスに計上したうえで `deprecatedHeaderSymbols` として別掲している。
- 未登録 suite は 2 件のみ（いずれも `SPXPlat*`。この配布に対応する `k...` マクロが無い）。

### 独立検証

関数ポインタ宣言子を **Python で独立に**数えた（コメント除去・複数行対応）。結果 **3792**。
抽出側は callable 行 3793 − 非 star 形式 1 件（`typedef Ret (Name)(args)`）= **3792** で**完全一致**。
件数はこの方法で裏取りしてある。

## 生成物

| パス | 内容 | commit |
| --- | --- | --- |
| `generated/aggregate.json` | クラス別・kind 別・rule 別の集計、ヘッダー別の件数と sha256 | する |
| `generated/provenance.json` | release、取得経緯、zip sha256、ライセンス調査、通知の分類 | する |
| `constraints.md` | CAP012。ABI / OS / CPU/GPU / threading / MFR / 署名をヘッダー出典付きで | する |
| `.local/symbols.json` | シンボル単位の行 | **しない** |

## 再生成

`bun`（1.4.x）が必要。SDK は各自が用意する（リポジトリは同梱しない）。

```sh
bun inventories/sdk/scripts/extract-sdk-inventory.ts \
  --headers /path/to/AeSDK/Examples/Headers \
  --zip     /path/to/AfterEffectsSDK_26.5_MacOS.zip \
  --release 26.5 \
  --out-aggregate inventories/sdk/generated/aggregate.json \
  --out-detail    inventories/sdk/.local/symbols.json
```

`--out-detail` を省略した場合の既定値も `.local/symbols.json`（git ignore 済み）。

### 冪等性の確認

commit 済みの集計が、いまのヘッダーからの再実行と一致するかを確認する。
書き込みは行わない。

```sh
bun inventories/sdk/scripts/extract-sdk-inventory.ts \
  --headers /path/to/AeSDK/Examples/Headers \
  --zip     /path/to/AfterEffectsSDK_26.5_MacOS.zip \
  --out-aggregate inventories/sdk/generated/aggregate.json \
  --check
```

一致すれば `idempotent: ...` を stderr に出して終了コード 0、
一致しなければ `NOT IDEMPOTENT` で終了コード 1。

### テスト

パーサの単体テストは **SDK を必要としない**（合成ヘッダーをその場で組み立てる）。
ライセンス済み素材を一切読まないので、誰でも実行できる。

```sh
bun test inventories/sdk/scripts
```

型検査（`bun-types` が必要）:

```sh
tsc --noEmit --strict --target esnext --module esnext \
    --moduleResolution bundler --skipLibCheck \
    --allowImportingTsExtensions \
    inventories/sdk/scripts/extract-sdk-inventory.ts \
    inventories/sdk/scripts/extract-sdk-inventory.test.ts
```

### SDK の場所

このマシンでの一例（**リポジトリ外**）:

- zip: `/Users/rebui/Documents/projects/adobe/AfterEffectsSDK_26.5_MacOS.zip`
- 展開済みヘッダー: `/Users/rebui/Documents/projects/adobe/AeSDK/Examples/Headers`

展開済みツリーには `Examples/` とガイド PDF しか無く、ヘッダーは
`Examples/Headers/` の下にある（トップレベルに `Headers/` は無い）。

## 出典と版

- SDK release: **26.5**、macOS 配布
- zip sha256: `7b837d594696ca0ece1ddba5e15b0fd3bf1ee908a1c7be04d4627180aa7ece7e`
- ヘッダー 70 件の個別 sha256: `aggregate.json` の `perHeader[].sha256`
- 参照インストール: AE 2026 = 26.5.3、AE 2027 = 27.0.0（`Info.plist` より）
- **注意**: ヘッダーが名指しする最新 AE 版は **26.3**（`AE_GeneralPlug.h:890`）。
  26.4 / 26.5 で suite が増えた形跡はコメントからは読めない。実害の有無は未検証。

## ヘッダーの通知分類

再配布判断の根拠として、70 ファイルの通知を分類した（`provenance.json` にも記録）。

| 分類 | 件数 |
| --- | --- |
| `adobe-confidential-no-reproduction` | 29 |
| `other-restrictive`（PICA 期の proprietary 文言） | 21 |
| `no-notice` | 13 |
| `adobe-permissive`（`permits you to use, modify, and distribute`） | 4 |
| `other-copyright-only` | 3 |

**permissive な 4 件があっても、29 件が再配布を禁じている以上、全体として公開はできない。**
最も制約の強い通知に合わせる。

## 既知の限界

1. **分類は rule-based で暫定**。rule 別件数を出してあるので、規則の妥当性は監査できる。
2. **`external-command` は版違いの重複を含む**（suite は累積する）。
3. **MFR はこのヘッダー群から記述できない**（`Examples/Headers` に `MFR` の語が 0 件）。
   `constraints.md` §6 に「記述が無い」ことを記録し、#18 へ送った。
4. **署名・公証の要件はヘッダーに無い**（`sign` / `notariz` / `codesign` / `entitle` で 0 件）。
5. **Windows は UNVERIFIED**、**AE 2026/2027 の差も未検証**。
6. unknown 13 件（`unattributed-callable`）は、ヘッダーだけでは方向が決まらないもの。
   推測で埋めずに unknown のまま残した。

## 参照

- [`spec.md` FR-03/04/05/13](https://github.com/ido-bata/ae-devtools/blob/6/specs/ae-capability-coverage/spec.md)
- [`tasks.md` #10 節](https://github.com/ido-bata/ae-devtools/blob/6/specs/ae-capability-coverage/tasks.md)
- [`contracts/capability-catalog.md`](https://github.com/ido-bata/ae-devtools/blob/6/specs/ae-capability-coverage/contracts/capability-catalog.md)（schema は未確定）
