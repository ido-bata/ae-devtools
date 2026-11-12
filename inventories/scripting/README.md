# After Effects Scripting API 記号 inventory (CAP005–CAP008)

After Effects の公開 Scripting API（ExtendScript）を **記号単位** で列挙し、各記号に
出典・バージョン範囲・状態を付けた inventory。

- 対象 Issue: [ido-bata/ae-devtools#9](https://github.com/ido-bata/ae-devtools/issues/9)
- 親 Epic: [#6](https://github.com/ido-bata/ae-devtools/issues/6)
- 状態: **source-reviewed inventory**。**実機検証は未実施**。
- 記録日: 2026-11-12

> **この inventory が主張しないこと**
>
> - After Effects を起動して記号を実行した事実は **ない**。`verified-real-host` ではない。
> - 「全対応」「N% 対応」という主張はしない。ここにあるのは **分母** であって達成度ではない。
> - community 文書を Adobe 公式の代替として扱っていない。両者は常に別 tier として記録する。
> - capability ID 文法と最終 schema は **未確定**（[#11](https://github.com/ido-bata/ae-devtools/issues/11) の担当）。
>   本 inventory の ID はすべて `provisional.` prefix 付きの暫定値。

---

## 1. 最初に読むべき結論

**Adobe は scripting の記号レベル参照を公開していない。**

Adobe の公式ページは「スクリプトの読み込み場所」「ファイル書き込み・ネットワーク権限」
「起動方法」は記述するが、クラス・メソッド・属性・enum の一覧は持たず、
記号レベルの説明を community 文書 (`ae-scripting.docsforadobe.dev`) へ **リンクで委譲** している。
この事実は `generated/official-claims.json` の
`provisional.ae.official.symbol-reference-deferred-to-community` に検出器付きで記録している。

そのため:

- **本 inventory の 656 記号はすべて community tier 由来**である。
- ここでの `documented` は「community guide に記述がある」の意味であり、
  「Adobe が文書化した」の意味では **ない**。
- Adobe tier と community tier の「一致」を検証として数えることはできない。
  一致を確認できる対象が Adobe tier 側に存在しないため。

この非対称性が CAP008 の中核成果物であり、`generated/cap008-requirements.json` の
`tierDivergences` に 9 行で記録している。

---

## 2. Scope / Non-scope

### Scope（本 Issue が行ったこと）

| 項目 | 内容 |
| --- | --- |
| CAP005 | 公開クラス / メソッド / 属性 / enum / enum 値 / global 関数を記号単位で抽出し、各記号に source URL + anchor を付与 |
| CAP006 | AE バージョン差を changelog から抽出し、OS 差を公式・community 両 tier から分類 |
| CAP007 | ES3 制約 / ホストオブジェクト参照寿命 / undo / AE UI / ファイル・ネットワーク権限を分類 |
| CAP008 | Adobe 公式と community 文書の差異、および実機でしか確認できない挙動を列挙 |

### Non-scope（意図的に扱っていない）

- **実機実行**。AE 26.5.3 / 27.0.0 はローカルに存在するが、本 Issue では起動も script 実行もしていない。
  （`summary.json` の `referenceHosts` に「存在するが未使用」として記録）
- **AE SDK / AEGP / effect plug-in**。[#10](https://github.com/ido-bata/ae-devtools/issues/10) の担当。
- **capability ID 文法・catalog schema の確定**。[#11](https://github.com/ido-bata/ae-devtools/issues/11) の担当。
- **match name 一覧**（effect / layer の内部識別子）。別軸の inventory であり、
  本 Issue の記号分母には混ぜず、CAP008 の gap として記録している。
- **式言語 (expressions)** の API。scripting API とは別系統。
- **他リポジトリの編集**、`specs/` 配下の編集。

---

## 3. 分母（実数）

`generated/summary.json` の `denominators` と一致する。**達成率ではない。**

### 3.1 記号総数

| 区分 | 件数 |
| --- | ---: |
| scripting member（属性 + メソッド + global 関数） | **656** |
| うち attribute | 406 |
| うち method | 242 |
| うち global-function | 8 |
| class | 48 |
| enum | 49 |
| enum 値 | 322 |

分母は**合算しない**。member 656 と enum 値 322 は別の数え方であり、
足し合わせた「978 記号」のような数字は本 inventory では出さない。

### 3.2 domain 別 member 数

`unknown` は 0。全 656 記号が既知の domain に分類されている
（分類はクラス単位。クラス→domain の対応表は `scripts/build.ts` の `CLASS_DOMAIN`）。

| domain | 件数 | | domain | 件数 |
| --- | ---: | --- | --- | ---: |
| text | 127 | | collection | 17 |
| property | 97 | | preferences | 15 |
| layer | 78 | | shape | 14 |
| project | 59 | | keyframe | 13 |
| item | 52 | | system | 13 |
| application | 41 | | output | 12 |
| comp | 36 | | mask | 7 |
| render-queue | 34 | | ui | 23 |
| source | 18 | | | |

`expression` / `effect` / `undo` / `file` の domain は **0 件** である。
これは「該当記号が無い」ではなく、**本 inventory がクラス単位で分類しているため**
（undo は `app.beginUndoGroup` 等として `application` に入る）であり、
その対応は CAP007 の `constraints.json` 側で扱っている。この 0 は
「未調査」ではなく「分類軸が違う」ことを意味する。

### 3.3 unknown / 未確定の件数

| 項目 | 件数 | 意味 |
| --- | ---: | --- |
| バージョン追加時期が明記された member | 172 | source が "added in After Effects X" と明記 |
| **バージョン未記載の member** | **484** | **unknown**。原著が何も述べていない |
| community が「Adobe 未文書」と明記した member | 6 | `undocumented-community-research` |
| 分類を断定できず `unresolved` にした member | 0 | 推測で埋めていない |
| access（read/write）が不明な member | 258 | 属性のうち Type 節に read-only/read-write が無いもの。推測しない |
| 引数リスト（signature）を取得できた member | 71 | usage 行から復元できたもの |
| version delta のうち記号に解決できなかった行 | 5 | クラス/enum 名として書かれた行。捏造せず未解決のまま |
| `instanceof` の挙動が文書化されたクラス | 6 | `always-false` 2 件 / `throws-undefined` 4 件 |

**484 件の「バージョン未記載」は本 inventory 最大の unknown** である。
「AE 26.5 で使える」とは主張できない。原著が沈黙しているという事実だけを記録している。

---

## 4. 入力ソース（tier を分離して記録）

`sources.lock.json` に URL・revision・SHA-256・byte 数を固定している。

### 4.1 Adobe 公式 (tier: `adobe-official`, authority: `primary`)

| key | 内容 | revision |
| --- | --- | --- |
| `adobe-scripts` | Scripts in After Effects（読み込み・権限・起動） | `http-2026-11-12` |
| `adobe-automation` | Automation in After Effects（自動化経路の分離） | `http-2026-11-12` |
| `adobe-legacy-extendscript-engine` | Legacy / ExtendScript engine（ES3 と ES2018 の区別） | `http-2026-11-12` |
| `adobe-variable-font-axes` | Variable Font Axes の scripting 例 | `http-2026-11-12` |

取得できたもの: 上記 4 ページの HTML（記号レベルの一覧は **含まれない**）。
取得できなかったもの: **Adobe 公式の scripting 記号リファレンス**。
公式 PDF 版 (`after-effects-scripting-guide.pdf` 等) は複数の URL を試したが
**404 で取得できなかった**。この欠落は推測で埋めていない。

### 4.2 community 文書 (tier: `community-reference`, authority: `community-maintained`)

| key | 内容 | revision |
| --- | --- | --- |
| `dfad` | After Effects Scripting Guide | commit `7137a990db4bd8dc9f5869b8ca431c7dfed52bdc` (2026-09-10) |

- サイト: https://ae-scripting.docsforadobe.dev/
- repo: https://github.com/docsforadobe/after-effects-scripting-guide
- **Adobe 公式ではない。** ガイド自身が "community docs" と明記し、
  著作権表示は Adobe だが発行主体は community である。
- 1 commit の tarball を丸ごと取得している。ページ単位で逐次取得すると
  取得途中の upstream 変更で revision が混ざるため。

---

## 5. 生成物

`generated/` は **commit する**。`scripts/verify.ts` が「clean 再生成と一致するか」を
git に対して検査するため、手で編集してはいけない。

| ファイル | 内容 | CAP |
| --- | --- | --- |
| `symbols.json` | member / class / enum と出典・バージョン・状態 | CAP005 |
| `official-claims.json` | Adobe 公式の運用制約 15 件（検出器付き） | CAP006/007 |
| `version-deltas.json` | AE リリース別の追加/更新 226 行 | CAP006 |
| `constraints.json` | 分類済み制約 22 件（tier 別） | CAP007 |
| `cap008-requirements.json` | tier 差異 9 行 + 実機必須項目 12 行 | CAP008 |
| `summary.json` | 分母・unknown 件数・evidence level | 全体 |

### 5.1 記号レコードの形（暫定）

```jsonc
{
  "id": "provisional.ae.scripting.app.beginUndoGroup",
  "kind": "method",                    // attribute | method | global-function
  "owner": "app",
  "member": "beginUndoGroup",
  "sourceKey": "dfad",
  "sourceTier": "community-reference",
  "publisher": "docsforadobe (community)",
  "authority": "community-maintained",
  "url": "https://ae-scripting.docsforadobe.dev/general/application/",
  "anchor": "appbeginundogroup",
  "versionAdded": null,                // 原著が述べない場合は null（推測しない）
  "versionRangeStated": false,
  "access": null,                      // read | write | read-write | null
  "signature": ["undoString"],
  "status": "documented",              // documented | undocumented-community-research | unresolved
  "markedUndocumented": false
}
```

`schemaNote` のとおり **schema は未確定**。#11 が確定させる。
`null` は「不明」を意味し、`false` や「対応」に丸めていない。

---

## 6. CAP006: バージョン差・OS 差

### 6.1 バージョン差

出典は community guide の changelog（community tier）。
**Adobe はバージョン別の scripting 記号一覧を公開していない。**

- 抽出した delta: 226 行（AE 9.0 → 26.5 の 30 リリース）
- 記号に解決できた行: 221
- 解決できなかった行: 5（`ParametricMeshLayer.ParametricMeshType` 等。
  class/enum 名として書かれており member ではないため。**未解決のまま残している**）- breaking change として明示された行: 2（26.5 の guide enum 整数値変更）

各行は `generated/version-deltas.json` に `aeVersion` / `resolvedId` / `notes` 付きで入る。
`resolvedId` が `null` の行は「解決できなかった」ことを表す。

### 6.2 OS 差

| 内容 | tier | 出典 |
| --- | --- | --- |
| 権限設定のメニュー経路が Windows と macOS で異なる | adobe-official | `adobe-scripts` |
| `app.exitAfterLaunchAndEval` は Windows 専用、macOS では無効 | community | `general/application` |
| exit code の返却経路が Windows=コマンドライン / macOS=AppleScript で異なる | community | `general/application` |
| `system.osName` は Windows 7 以降で空文字を返す | community | `general/system` |
| Scripts フォルダのパス形状が OS で異なる | adobe-official | `adobe-scripts` |

**OS 差について断定していないこと**: 上記は「文書がそう述べている」以上の意味を持たない。
AE 26.5.3 / 27.0.0 の macOS 実機で同じ挙動になるかは検証していない。

---

## 7. CAP007: 制約の分類

`generated/constraints.json` に 22 件。tier 別内訳は
**Adobe 公式 8 件 / community 14 件**。tier は絶対に混ぜていない。

| category | 件数 | 代表例 |
| --- | ---: | --- |
| platform-difference | 4 | OS 別メニュー経路、exit code 経路 |
| es3-language | 3 | ECMA-262 3rd Edition、式エンジン ES2018 との混同禁止 |
| host-lifecycle | 3 | Esc による中断、既存インスタンス実行、再起動要否 |
| host-object-lifetime | 3 | session 持続 global、1-based index、base-only class |
| undo | 3 | undo group の入れ子、script 終端での自動 close、UNDO_CACHES |
| ae-ui | 2 | dialog 抑制の範囲、ScriptUI panel の dock 挙動 |
| file-permission | 1 | 既定でファイル書き込み不可 |
| network-permission | 1 | 同じ 1 つの設定で network も不可 |
| value-representation | 1 | PropertyValueType による型分岐 |
| version-difference | 1 | guide enum の整数値がバージョン間で変わる |

各レコードは `tier` / `publisher` / `authority` / `url` / `anchor` /
`aeVersionScope` / `osScope` / `versionStated` / `implication` を持つ。
`versionStated: false` は「原著がバージョンを述べていない」を意味する。

### 7.1 ES3 についての重要な注意

ES3 という主張は **tier で意味が違う**:

- Adobe 公式が述べるのは「**legacy ExtendScript 式エンジン** が ECMAScript 3」および
  「AE 16.0 以降の **JavaScript 式エンジン** が ECMAScript 2018」である。
- 「**scripting エンジン** が ES3」という記述は community tier のものである。

したがって「Adobe が scripting の ES3 を公式に確認している」とは言えない。
この区別は `constraints.json` と `tierDivergences` の両方に明示している。

### 7.2 参照寿命について

「ホストオブジェクトの参照が別 script 呼び出しをまたいで有効か」は
**どの tier も契約として述べていない**。文書化されているのは
「collection の index は 1 始まりで、内容は自動更新される」ところまでである。
そのため参照寿命は CAP008 の `requires real host` 側に置いた（推測で埋めていない）。

---

## 8. CAP008: 差異と実機必須項目

### 8.1 tier 差異（9 行）

`generated/cap008-requirements.json` の `tierDivergences`。分類は 3 種:

| class | 件数 | 意味 |
| --- | ---: | --- |
| coverage-asymmetry | 4 | 片方の tier がその面を全く持たない |
| statement-level | 3 | 両 tier が同じ話題に言及し、内容/バージョン範囲が異なる |
| single-tier-only | 2 | 片方しか述べていない |

代表例:

1. **記号参照が Adobe tier に存在しない**（coverage-asymmetry）。
   これが最大の差異であり、他の差異の前提になっている。
2. **ES3 の主語が違う**（statement-level）。Adobe は式エンジンについて述べ、
   community は scripting エンジンについて述べている。両者は一致していない。
3. **バージョン別 member 一覧がどちらの tier にも無い**（coverage-asymmetry）。
4. **match name が community のみ**（coverage-asymmetry）。本 Issue の分母外。

### 8.2 実機でしか確認できない項目（12 行）

`generated/cap008-requirements.json` の `realHostRequirements`。
全行が `evidenceRequired: "requires real host"` を持つ。**1 つも実行していない。**

- 特定 build 上に member が実在するか（26.5.3 / 27.0.0 各々）
- script 呼び出しをまたいだオブジェクト同一性、undo / 並べ替え / 削除後の失効
- stale handle 使用時のエラー型・メッセージ・回復可能性
- 1 操作あたりの undo step 数、Esc 中断時の部分適用状態
- `beginSuppressDialogs` が抑止しない modal の集合と、その blocking 性
- 権限設定の実 default 状態と、script から読めるか
- 非英語 UI での値の文字列化、match name 照合の locale 依存性
- render 完了・キャンセルの通知契約
- `project.expressionEngine` 変更後の保存済み式の解釈
- 複数 script の global 名衝突と、自前でない global の観測可能性
- 文書化された引数範囲がホストで強制されるか、clamp されるか

---

## 9. 再生成手順

前提: `bun` 1.4.x。Python は使わない（AGENTS.md §16）。

```bash
cd inventories/scripting
bun install

# 通常 build: キャッシュから再現し、sources.lock.json のハッシュと照合する
bun run build

# upstream の変更を意図的に取り込む場合のみ
bun run refresh
```

### 9.1 ネットワークとキャッシュ

- 初回 build は 5 つの source を取得し、`.cache/`（git 対象外）に保存する。
- 2 回目以降は `.cache/` から読み、`sources.lock.json` の SHA-256 と照合する。
- **ハッシュが一致しない場合は build が失敗する**。 upstream の変化は
  `bun run refresh` という明示的な操作でしか取り込めない。
- 生 payload は **commit しない**。commit するのは hash と短い参照のみ
  （ドキュメント本文の複製を避けるため）。

### 9.2 deterministic であることの確認

```bash
bun run verify
```

これは次を行う:

1. build を 2 回実行し、生成物の SHA-256 が一致することを確認
2. `generated/` が git の index と一致することを確認（stale commit を検出）

`generated/` を手で編集すると `verify` が落ちる。

### 9.3 品質ゲート

```bash
bun test          # parser / slug / enum 抽出の unit test（AE 不要・network 不要）
bun run typecheck # tsc --noEmit
```

### 9.4 出典の drift 検出

`claims.ts` と `constraints.ts` の各主張は **検出器（正規表現）** を持ち、
build 時に取得済みページと照合する。文言が変わって検出器が一致しなくなると
**build が失敗する**。主張が根拠より長生きできない仕組みである。

実際にこの機構は作業中に 3 件の誤引用（見出しの取り違え）を検出しており、
そのうち 1 件は実際の記述位置の誤りだった。

---

## 10. Evidence level

| 項目 | 水準 |
| --- | --- |
| 記号の存在 | **source-reviewed**（pinned revision から抽出） |
| 抽出の再現性 | **automated test**（`bun test` + `bun run verify`） |
| 記号の実行 | **未実施** |
| 実機挙動 | **未検証**（`requires real host` として 12 項目を列挙） |

`fake-only` でも `verified-real-host` でもない。
**本 Issue は real host 検証を一切含まない。**

---

## 11. 既知の限界

1. **記号の出所が単一 tier**。Adobe 公式の記号一覧が存在しないため、
   全 656 記号が community tier 単独依存である。community 文書の誤りは
   そのまま本 inventory の誤りになる。実機照合は #13–#16 の範囲。
2. **バージョン不明が 484 件**。原著が追加バージョンを述べていない記号について、
   「いつから使えるか」は unknown である。
3. **access 不明が 258 件**。属性の read/write 区分は Type 節の記述に依存しており、
   記述が無いものは `null` のままにしている。
4. **signature は 71 件のみ**。usage 行から復元できたものだけ。
   引数の型・必須/任意・範囲は本 inventory では構造化していない。
5. **enum の数値は 49 件中 1 件のみ**。大半の enum は名前しか文書化されていない。
6. **match name を含まない**。scripting の安定識別子だが別軸のため分母外。
7. **domain 分類はクラス単位の手写像**。`expression` / `effect` / `undo` / `file`
   が 0 なのは分類軸の都合であり、記号の不在ではない。
8. **公式 PDF を取得できていない**。存在する可能性は排除できない。
9. **本 inventory は「対応状況」を持たない**。`coverage.implementation` に
   相当する情報は #11 以降で catalog に統合される。

---

## 12. ファイル構成

```
inventories/scripting/
├── README.md                    # 本ファイル（日本語）
├── package.json
├── tsconfig.json
├── sources.lock.json            # URL / revision / SHA-256 / bytes
├── .gitignore                   # .cache/ を除外
├── scripts/
│   ├── sources.ts               # source registry（tier を分離）
│   ├── fetch.ts                 # content-addressed cache と lock
│   ├── archive.ts               # pinned tarball reader
│   ├── markdown.ts              # 見出し抽出と anchor slug
│   ├── adobe-page.ts            # Adobe HTML → 正規化テキスト
│   ├── extract-symbols.ts       # CAP005: class / member
│   ├── extract-enums.ts         # CAP005: enum / enum value
│   ├── extract-changelog.ts     # CAP006: version delta
│   ├── claims.ts                # Adobe 公式の主張（検出器付き）
│   ├── constraints.ts           # CAP007/008: 制約と実機必須項目
│   ├── resolve-constraints.ts   # 制約の出典解決
│   ├── divergence.ts            # CAP008: tier 差異
│   ├── build.ts                 # 生成
│   └── verify.ts                # 決定性 + commit 一致の検査
├── tests/
│   └── extract.test.ts          # 24 tests
└── generated/                   # commit 対象。手編集禁止
    ├── symbols.json
    ├── official-claims.json
    ├── version-deltas.json
    ├── constraints.json
    ├── cap008-requirements.json
    └── summary.json
```
