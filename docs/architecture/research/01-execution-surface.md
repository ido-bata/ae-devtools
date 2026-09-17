# Execution Surface

外部の開発ツールから After Effects の ExtendScript を起動し、結果を観測する経路を整理する。
Adobe 公式ドキュメント（CEP-Resources, CSInterface API, ExtendScript Toolkit 由来の説明）を一次情報として優先し、2026-09-18 時点で確認できる範囲でまとめる。古い pre-2022 の CEP 記事は古い前提を含む可能性があるため、その旨を明示する。
本文中の `official` は Adobe 公式リポジトリ／Developer ドキュメントを示す。

---

## Candidates considered

| # | Method | Brief | Source |
|---|---|---|---|
| A | **CEP panel + `CSInterface.evalScript`** | ホスト AE 内に常駐する CEP HTML/JS パネルから `evalScript()` で ExtendScript を実行する。CEP 12 が AE 25.0 に同梱されている。 | `CEP-Resources/CEP_12.x/.../CEP 12 HTML Extension Cookbook.md` (official) |
| B | **VSCode ExtendScript Debugger (`Adobe.extendscript-debug`)** | Adobe 公式の VSCode デバッガ拡張。Adobe 公式 Marketplace ID は `Adobe.extendscript-debug`。元リポジトリは `Adobe-CEP/extendscript-debugger-vscode` だったが 2026-09 時点で Web 上では取得困難（旧 GitHub URL は 404）。 | https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug (official), https://extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/ |
| C | **CEP panel with Node.js (`--enable-nodejs`)** | CEP 6.1 以降、CEP HTML 拡張内で Node.js API を有効化できる。CEP 12 は Node.js 17.7.1 を同梱。Node.js は **拡張の Chromium プロセス内**で動き、ファイル / TCP / 子プロセスなどを扱える。 | `CEP_12.x/.../CEP 12 HTML Extension Cookbook.md` "Using Node.js APIs", "Browser Features" (official) |
| D | **Standalone ExtendScript (ESTK 由来)** | `#target` ディレクティブ付きで起動されたスクリプトが AE の ExtendScript engine 上で走る。`$.evalFile`, `$.eval`, `#include` で他ファイルを読み込む。ESTK は deprecated だが engine 側の挙動は有効。 | https://extendscript.docsforadobe.dev/extendscript-toolkit/debugging-in-the-toolkit/, https://mapsoft.com/posts/extendscript.html |
| E | **UXP Scripting (AE 25.0+, 2024-10)** | AE 25.0（October 2024）で UXP スクリプティングが導入された。ES6+ 対応。ExtendScript を UXP から呼び出せるかは別途要確認。 | https://helpx.adobe.com/after-effects/faq/uxp-for-after-effects-early-access.html, https://www.adobe.com/content/dam/cc/en/think-tank/uxp-in-after-effects/uxp-in-after-effects.pdf |
| F | **AEX / native plugin (out of scope)** | C++ プラグイン。SDK は `ae-plugins.docsforadobe.dev`。本プロジェクトの対象外。 | https://ae-plugins.docsforadobe.dev/ |

---

## Mechanism details

### A. CEP panel + `CSInterface.evalScript` (official)

- Adobe CEP 12 Cookbook（公式）によると、`CSInterface.evalScript(script: string, callback?: function): void` が Application DOM にアクセスするための公式 API。 Cookbook の "Access Application DOM" セクションで `csInterface.evalScript('app.documents.add();', function(result){ alert(result); })` の形が例示されている。
  - 出典: `https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md` （公式 GitHub）— 2026-09-18 アクセス。
- **プロセスモデル**: CEP 拡張はホスト AE の PlugPlug Library 経由で読み込まれ、Chromium Embedded Framework ベースの CEPHtmlEngine プロセスで動く。**ExtendScript 自体はホストアプリのメインハンドラ内（AE プロセス上）で動作する**。Cookbook はこれを明示している:

  > "Please be aware that the script in evalScript and the jsx file which is configured in `<ScriptPath>` in the extension's manifest are executed in host application's ExtendScript engine, which runs in host application's main thread."

- **Wire protocol**: Adobe 公式には `evalScript` の RPC プロトコル仕様は公開されていない。実装的には PlugPlug OOP メッセージング層で `EvalScript` イベントが AE の ExtendScript engine 側に届き、結果を文字列化して返す、とコミュニティ解説で説明されている（Stack Overflow / Adobe Forum 多数）。Adobe 公式ドキュメントには内部実装は記載がないため、**プロトコルの詳細仕様は unverified**。
- **Signature**: `evalScript(script: string, callback?: (result: string) => void): void`。戻り値は `string`（JSON.stringify 等で明示シリアライズするのが標準パターン）。
- **Return value passing**: Cookbook 例は `app.documents.add();` の戻り値 undefined を `alert(result)` に渡している。複雑なオブジェクトは ExtendScript 側で `JSON.stringify()` し、CEP 側で `JSON.parse()` する慣習。Stack Overflow の "evalScript() returns undefined when ExtendScript function has no return" もこのシリアライズ前提と一致（出典: https://stackoverflow.com/questions/58070522/csinterface-evalscript-returns-undefined-when-extendscript-function-has-no-return）。
- **Multiple evalScript calls**: Cookbook に明示的に書かれている:

  > "If the interaction between the script and CEP event is needed, please split the script into small parts and call them separately so that CEP event has a chance to be scheduled."

  → つまり `evalScript` は **同期的でない可能性が高い** ことが Adobe 自身の記述で示唆されている（後述の Synchronization セクション参照）。

### B. VSCode ExtendScript Debugger

- Marketplace での正式名称は `ExtendScript Debugger`、Publisher は `Adobe`、ID は `Adobe.extendscript-debug`。バージョン 2.x が安定版、`develop` ブランチで 3.x 系を開発中。
  - 出典: https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug (official) — 2026-09-18 アクセス。
- 元リポジトリ `Adobe-CEP/extendscript-debugger-vscode` は現時点で Web 上から到達不能（404）。Adobe-CEP org 自体が archived/redirect 状態。**実装ソースを直接確認できないため、内部プロトコルの詳細記述は unverified**。
- Adobe Developer ドキュメント / `extendscript.docsforadobe.dev` の Getting Started によれば、launch/attach は debug type `extendscript-debug`、attach 時は既に起動中のホスト AE にアタッチする。`Evaluate Script in Host...` コマンドと "Eval in Adobe..." ステータスバーボタンでワンショット eval が可能（出典: https://extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/ — 2026-09-18 アクセス）。
- `docsforadobe.dev` の "Debugging in the Toolkit"（ESTK 由来の説明）には、Toolkit がターゲットの ExtendScript engine を **targetengine 名** で選択するモデルが記載されている。AE の targetengine は `"main"` と `"aftereffects"`（Adobe 公式記述は確認できず、community 既知）。
  - 出典: https://extendscript.docsforadobe.dev/extendscript-toolkit/debugging-in-the-toolkit/ — 2026-09-18 アクセス。
- VSCode デバッガは DAP (Debug Adapter Protocol) で VSCode と話す層と、Adobe 側 ExtendScript engine に BridgeTalk / `$debug` 系 API で命令を送る層の 2 段構成と推測されるが、**公式の wire protocol 仕様は公開されていない**（unverified）。

### C. CEP with Node.js (official)

- Cookbook "Chromium Embedded Framework" 表（公式）:

  | Component | CEP 9.0 | CEP 10.0 | CEP 11.1 | CEP 12.0 |
  |---|---|---|---|---|
  | Node.js | 8.6.0 | 12.3.1 | 15.9.0 | 17.7.1 |
  | Node-WebKit | 0.25 | 0.38 | 0.50.1 | 0.62.1 |

  - 出典: CEP 12 Cookbook CEF table (official) — 2026-09-18 アクセス。
- 起動は `--enable-nodejs` フラグ（CEP 6.1 以降サポート）。`--mixed-context` で iframe からの Node シンボル共有を制御。
- **Node.js は CEPHtmlEngine プロセス（Chromium 拡張プロセス）内で動き、AE プロセスではない**。`cep_node` シンボル経由で `Buffer`, `global`, `process`, `require` 等にアクセス。Cluster API は非サポート。Windows では Console API も非サポート（Cookbook "Using Node.js APIs" セクション）。
- CEP Node から **ExtendScript を直接呼べる API は Cookbook に記載がない**。CEP Node から ExtendScript を呼ぶには一旦 `CSInterface.evalScript` を経由する必要がある（または `$.evalFile` を ExtendScript 側で起動）。
- AE は CEP 12 が 25.0 で同梱（Cookbook の Applications Integrated with CEP 表より）だが、After Effects に Node 有効の CEP panel が広く配布されている例は少なく、**実運用上の AE 側の安定性は unverified**。

### D. Standalone ExtendScript / ESTK (deprecated engine だがスクリプト起動経路は有効)

- `#target` ディレクティブで対象アプリを指定。例: `#target aftereffects`。`#targetengine "main"` で engine を切替可能。Toolkit は `#target` を読み取り、そのアプリを起動してスクリプトを渡す（`docsforadobe.dev` "Debugging in the Toolkit" より、official-mirror）。
- `$.evalFile(filePath)` / `$.eval(evalString)` で外部ファイルを評価。`#include` はプリプロセッサディレクティブ（実行時読み込み）。`$include` はグローバルに現在のパスを返す特殊変数。
  - 出典: https://extendscript.docsforadobe.dev/extendscript-toolkit/debugging-in-the-toolkit/ (community-maintained mirror of Adobe docs)。
- **ESTK 自体は deprecated**（Adobe は VSCode + ExtendScript Debugger 拡張への移行を案内、mapsoft.com 2026-09 確認）。ESTK のデバッガ API（`evalFile`, `connectToTarget` 等）は **ESTK 内部用であり、AE 単体では呼べない**。
- `file://.jsx` を AE に「ドラッグして実行」「File > Scripts > Run Script File...」するのは最も古典的な動かし方で、現在の AE でも有効（AE の標準メニュー）。

### E. UXP Scripting (AE 25.0+, 2024-10)

- AE 25.0（October 2024）で UXP for After Effects が導入された。FAQ:
  - "Available since After Effects 25.0 (October 2024 release)."
  - "Modern JavaScript support, access to modern..." 
  - 出典: https://helpx.adobe.com/after-effects/faq/uxp-for-after-effects-early-access.html (official) — 2026-09-18 アクセス。
- AE 25.5（2025）で UXP scripting の API 拡張。ExtendScript が AE 25.5 以降の新規インストールでデフォルト無効化に向かっている。
- UXP の ExtendScript 互換や、`app.project` / `app.activeItem` 等の **Scripting オブジェクトモデルが UXP からどこまで呼べるかは Adobe 公式ドキュメント上で明確に一覧化されていない**。Photoshop UXP scripting のドキュメント (https://adobedocs.github.io/uxp-photoshop/ps_reference/media/uxpscripting/) は成熟しているが、AE は後発。
  - **API サーフェスの正確な対応表は unverified**。
- UXP から ExtendScript を呼ぶ経路は Adobe 公式に見当たらず、**現時点では AE 側の Scripting は ExtendScript が事実上の標準**（AE 25.0 で UXP スクリプティングが併存する移行期）。

---

## Synchronization semantics

CEP `evalScript` の同期性について、Adobe 公式 Cookbook は次のとおり:

> "the script in evalScript and the jsx file ... are executed in host application's ExtendScript engine, which runs in host application's main thread. On the other hand, CEP event is also dispatched from host application's main thread. If the interaction between the script and CEP event is needed, please split the script into small parts and call them separately so that CEP event has a chance to be scheduled."

要点:

- **JS 側 (`CSInterface.evalScript`) から見ると非同期**: 戻りは `void`、第 2 引数の callback に結果が来る。
- **ExtendScript 側は AE メインスレッドで実行**: つまり AE UI 描画、レンダー、ワッチドッグ、その他 ExtendScript ジョブと直列化する必要がある。
- **callback が AE メインスレッド外で発火するかは Cookbook 上で明示されていない**が、Cookbook が「split into small parts」と書いている以上、「長時間スクリプトで callback が遅延する／来ない」ことを前提に設計する必要がある。
- **AE state の観測可能タイミング**: ExtendScript が終了して callback が呼ばれた時点で AE state は更新済み（少なくとも同一スレッドで起きた変更は観測可能）。`project.activeItem` のような変更も callback 受信後は確実に観測可能 — ただし、これは **callback が呼ばれた後**の話であり、`evalScript` 呼び出し直後ではない。

VSCode ExtendScript Debugger はデバッガプロトコル (DAP) で `Evaluate` を送るが、**実行は AE 側の ExtendScript engine 上で起きるため AE UI スレッドをブロックする長時間スクリプトは同じ問題を抱える**（Adobe 公式に明記なし、unverified）。

`$.evalFile` は同期的に評価する（ExtendScript engine 内）。`#include` はプリプロセス時に取り込まれる。**`$.evalFile` の評価が完了するまで、呼ばれた側のスクリプトの実行は止まる**。

---

## AE busy states

ExtendScript 評価が AE 本体の状態とどう絡むかを整理する。Adobe 公式の明確な記述は少ないため、Cookbook の "main thread" 記述と、ExtendScript engine の一般挙動から推測される事項を明示する。

| AE 状態 | ExtendScript の挙動 | 出典 |
|---|---|---|
| **Render 実行中** | レンダーキューが走っている間、ExtendScript は同じメインスレッドで動くため **競合／ブロック／応答停止** が起きうる。AE Scripting Guide には明示記載はないが、Adobe コミュニティで頻出の既知挙動。 | unverified (要 real-AE テスト) |
| **Modal dialog 開いている** | ExtendScript 内で `Window.prompt` 等を呼ぶと modal が AE をブロック。CEP 側は callback 待ちで止まる。 | Cookbook の main thread 記述 + 一般挙動 |
| **他のスクリプト実行中** | Engine は 1 度に 1 ジョブ（同一 engine scope）。後続 `evalScript` は前の完了を待つか、エラーで返る（仕様未公開）。 | unverified |
| **Expression 評価中** | expression engine は ExtendScript engine と分離された evaluator。`$.evalFile` で expression を再評価させる等のパターンはあるが、評価タイミングは frame 描画タイミング依存。 | unverified |
| **Project loading** | `app.project` 編集中は ExtendScript からアクセス不可／部分的アクセスになる場合あり。AE 起動直後のスクリプトは `app.project` が null。 | unverified |
| **Saving** | `app.project.save()` は同期 API。ExtendScript 内で呼ぶと完了までスクリプトは待機。CEP callback は保存完了後に発火。 | Adobe Scripting Guide 既知 |

Commands は **キューイングされない**（evalScript 呼び出しを重ねても、engine は前の完了を待つが、明確な queue 仕様は Cookbook に無い）。**Timeout / Cancellation は Adobe 公式に存在しない**。スクリプト側で `try / finally` と watchdog を作る必要がある。

---

## Evidence

URL とアクセス日と、何を確認したか。

1. `https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md` — 2026-09-18 アクセス — 公式 GitHub（Adobe-CEP org）Cookbook。`evalScript` の signature、main thread 実行、`--enable-nodejs` 起動、CEP 12 / Node.js 17.7.1 / After Effects 25.0 への同梱を確認。
2. `https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug` — 2026-09-18 アクセス — 公式 Marketplace。Publisher `Adobe`、ID `Adobe.extendscript-debug`、バージョン 2.x 安定、3.x develop。
3. `https://extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/` — 2026-09-18 アクセス — Adobe ExtendScript docsforadobe.dev コミュニティ mirror（公式情報の集約）。launch/attach、targetengine `main`、CEP callback 内では `$.level = 1` を立てる必要。
4. `https://extendscript.docsforadobe.dev/extendscript-toolkit/debugging-in-the-toolkit/` — 2026-09-18 アクセス — 旧 ESTK 公式ドキュメント mirror。target engine 選択、`#target` ディレクティブ、Data Browser。
5. `https://helpx.adobe.com/after-effects/faq/uxp-for-after-effects-early-access.html` — 2026-09-18 アクセス — 公式 Adobe Help。UXP for AE は 25.0 (Oct 2024) で導入。
6. `https://www.adobe.com/content/dam/cc/en/think-tank/uxp-in-after-effects/uxp-in-after-effects.pdf` — Adobe 公式 PDF。URL は存在するが WebFetch 時に 404 が返る（パス再確認要）。**Adobe が公開している UXP in AE ホワイトペーパーの存在自体は確認**。
7. `https://stackexchange.com` 経由の Stack Overflow 解説 — `evalScript()` の callback / 同期性 / 引数シリアライズ挙動 — community 既知。
8. `https://mapsoft.com/posts/extendscript.html` — 2026-09 確認 — community サマリ。ExtendScript = ES3、ESTK deprecated、UXP 移行。公的仕様ではないが参考。
9. `https://adobedocs.github.io/uxp-photoshop/ps_reference/media/uxpscripting/` — 2026-09-18 アクセス — Photoshop UXP scripting 公式 docs（**AE ではないが UXP scripting のパラダイム比較用**）。

注: `Adobe-CEP/extendscript-debugger-vscode` リポジトリ（旧 GitHub URL）は 2026-09-18 時点で 404。実装ソースを直接参照できず、wire protocol の詳細は未検証。

---

## Per-candidate Advantages / Constraints / Unknowns

### A. CEP + `CSInterface.evalScript`
- **Advantages**: Adobe 公式・現役。CEP 12 が AE 25.0 に同梱。`app.*` 等の Scripting オブジェクトモデル全アクセス。callback で結果取得可。
- **Constraints**: パネルを AE 内にロードする必要（インストール・署名・PlayerDebugMode）。ExtendScript メインスレッド占有。長時間スクリプトで callback 遅延。内部 RPC プロトコルは非公開。
- **Unknowns**: evalScript の timeout/cancel 機構は無い（unverified）。複数 evalScript のキュー順は仕様で定義されていない。

### B. VSCode ExtendScript Debugger
- **Advantages**: Adobe 公式の IDE 統合、`Evaluate Script in Host...` でワンショット実行可、ブレークポイント可。VSCode 上から人間が使う分には最も低摩擦。
- **Constraints**: 内部 wire protocol は非公開。デバッガとして作られているため「無音で実行 → 結果取得」の API は薄そう。Apple Silicon で追加手順が必要（hyperbrew 2024）。2026-09 時点でリポジトリが 404 になるなど、保守体制に不確実性。
- **Unknowns**: AI エージェントから「ライブラリ」として呼べる API surface。launch/attach のスクリプト経路。

### C. CEP + Node.js
- **Advantages**: Node 17.7.1 で TCP/UDP/fs/child_process 等フルアクセス。CEP panel 内に daemon を組み込める。`cep_node` 経由で既存 CEP から Node を呼べる。
- **Constraints**: Node は **CEP プロセス内**で動き、AE プロセスではない。ExtendScript を直接呼ぶ API は CEP には無い → `evalScript` 経由となり、結局 A と同じ制約を被る。Cluster/Console 制限あり。AE 上で Node CEP panel が本番運用されている事例は少ない印象。
- **Unknowns**: AE 25.0 における Node CEP panel の安定性（実機検証要）。

### D. Standalone ExtendScript (File > Scripts > Run Script File...)
- **Advantages**: インストール最小。AE 単体で完結。CEP 不要。`#target`, `$.evalFile`, `$.eval`, `#include` がエンジンで直接解釈される。
- **Constraints**: ユーザ操作（メニュー / ショートカット）が必要。AI から叩くには OS レベルの「メニューを叩く」操作 or AppleScript `do javascript file`（macOS）が必要。`do javascript` は CC 2020 世代で報告された壊れがある（Adobe Forum、unverified）。リアルタイム性は低い。
- **Unknowns**: `do javascript file` の現行 AE 25.x での挙動。

### E. UXP Scripting (AE 25.0+)
- **Advantages**: モダン ES6+、Adobe が将来推す方向。Photoshop UXP scripting と整合するメンタルモデル。
- **Constraints**: AE UXP scripting の API surface ドキュメントは 2026-09 時点で薄い。ExtendScript の `app.project` 等の **Scripting オブジェクトモデルとの対応は公式一覧がない**。AE 25.5 以降 ExtendScript デフォルト無効化方向。
- **Unknowns**: ExtendScript → UXP の呼び出し経路（逆もしかり）。MCP / AI 統合の実例。

### F. AEX / Native plugin
- **Constraints**: C++ ビルド。本プロジェクトのスコープ外（vision.md の MCP / VSCode 経路とは別物）。

---

## Unverified items (要 real-AE 検証 or 公式情報待ち)

1. **CEP `evalScript` の wire protocol 詳細**（PlugPlug メッセージング仕様、timeout、cancel API の有無）。
2. **`evalScript` の callback が AE メインスレッドで発火するか、別スレッドで発火するか**。Cookbook は「split into small parts」と書くのみで callback スレッドは未明記。
3. **AE メインスレッド競合時の挙動**: 既存 render 中 / save 中 / expression 評価中の evalScript が reject されるか、ブロックされるか。
4. **VSCode ExtendScript Debugger のライブラリ的 API**。人間がボタン押す分には動くが、AI から `Evaluate` リクエストを投げ続ける安定経路があるかは要検証（旧 GitHub リポジトリは 2026-09 時点で 404 のため、ソース確認も要代替経路）。
5. **CEP 12 + Node 17.7.1 を AE 25.0 で動かした安定性事例**。Photoshop では一般的、AE では事例が薄い。
6. **UXP Scripting in After Effects の API surface 一覧**。Photoshop UXP scripting docs はあるが、AE 用は同等物が未公開（2026-09 時点）。`app.project`, `composition`, `layer`, `property` 等の ExtendScript オブジェクトモデルがどこまで UXP から呼べるかは要 Adobe 公式待ち。
7. **`$.evalFile` が他プロセスの ExtendScript から呼べるか**（Engine 跨ぎのスクリプトロード）。Cookbook には CEP から呼ぶ `$.evalFile` の例はあるが、AE プロセス外から直接呼ぶ経路は無いはず（要実機確認）。
8. **Apple Silicon + macOS 環境での `osascript -e 'tell application "Adobe After Effects 25" to do javascript file "..."'` の現行動作**。コミュニティ報告では 25.x で `do javascript` が壊れる事例あり。
9. **`#targetengine` の AE における正式名**（`"main"`, `"aftereffects"` 等）。Adobe 公式の正式名称一覧は Cookbook に無く、community 既知。
10. **CEP panel を AE に動的にロード／アンロードする公式 API**。開発中のスクリプトを「毎回ロードし直す」運用を考える場合、ロード API の有無は要検証。

---

## Notes

- 本ドキュメントは **2026-09-18 時点**の調査であり、pre-2022 の CEP 記事は古い前提を含む可能性がある（CEP 9 以前は `--enable-nodejs` が無いため Node が使えない等）。特に CEP 5/6/7 を前提とした古いブログは鵜呑みにしない。
- Adobe-CEP 公式 GitHub organization 自体、2026-09 時点で Web 上の旧 URL が 404 を返す場合がある。常に Cookbook の GitHub Raw URL を直接参照する。
- 実装判断は vision.md / AGENTS.md のガードレールに従い、**未確定事項を前提として固定しない**。本ドキュメントに書かれた "unknown" は実装フェーズで再検証する。
