# Process Architecture Research

外部ツール（VSCode Extension、MCP Server、CLI など）から After Effects にアクセスするための **プロセスモデル** の選択肢を整理する。
Adobe 公式デバッガ拡張（`Adobe.extendscript-debug`）の実装パターンと、コミュニティで運用されている AE ↔ AI ブリッジの実装を一次情報として参照し、`ae-devtools` が取り得る 3 つのアーキテクチャ案を評価軸に沿って比較する。
2026-09-18 時点の調査。本ドキュメントは **仕様の固定ではなく、設計フェーズで参考にする材料** の提供を目的とする。

---

## 1. Official pattern — Adobe VSCode ExtendScript Debugger

### 1.1 リポジトリの出自と現状

Adobe 公式の Marketplace ID は `Adobe.extendscript-debug`、Publisher は `Adobe`。従来のリポジトリ `Adobe-CEP/extendscript-debugger-vscode` と `Adobe/extendscript-debug` は 2026-09 時点でいずれも **404**（GitHub API からも確認済み）。Adobe-CEP org 自体が archived 状態で、ソースを直接参照できない。

- 出典: https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug — 2026-09-18 アクセス。
- 出典: `gh api repos/Adobe-CEP/extendscript-debugger-vscode` → 404 — 2026-09-18 確認。

ただし、コミュニティが部分的に抽出した実装（`psyirius/extendscript-debugger-core`）と、Adobe 公式ドキュメントの断片から、**内部構造は高い確度で推定できる**。

### 1.2 プロセスモデル — ネイティブ addon による単一 Node プロセス

Adobe デバッガは、Node.js の **ネイティブ addon** `esdcorelibinterface.node` をプロセス内にロードする。これは Adobe 旧 ExtendScript Toolkit（ESTK）が内部で使用していた **`ESCoreLib`**（`ESCoreLib.framework` on macOS, `ESCoreLib.dll` on Windows）へのバインディングである。

`psyirius/extendscript-debugger-core` のソース（`src/index.ts`）は次の構造を持つ:

- プラットフォーム別バイナリを遅延ロード（`lib/darwin/x64/esdcorelibinterface.node`, `lib/win32/x64/...`, `lib/win32/ia32/...`）
- シングルトン `_coreLib` を介して native 関数を公開
- 型定義（`types/esdcorelibinterface.d.ts`）には次の API が並ぶ:
  - `esdInitialize(spec, processId)` — engine 接続を初期化
  - `esdCompileToJSXBin(source, scriptId, includePath)` — ExtendScript コンパイル
  - `esdCheckSyntax(source, scriptId, includePath)` — シンタックスチェック
  - `esdCleanup()` — 終了処理
- 戻り値は `ESDCoreStatus` enum（`INIT_FAILED`, `NOT_INITIALIZED`, `ALREADY_INITIALIZED`, `JSX_COMPILATION_FAILED`, `SCRIPT_EXECUTION_NO_RESULT` 等）
- プラットフォーム制限は **明示的**: macOS x64, Windows ia32/x64 のみ。**Linux / ARM (Apple Silicon) は未対応**。

  - 出典: https://github.com/psyirius/extendscript-debugger-core — 2026-09-18 確認。
  - 出典: `https://raw.githubusercontent.com/psyirius/extendscript-debugger-core/main/types/esdcorelibinterface.d.ts` — 2026-09-18 確認。
  - 出典: `https://raw.githubusercontent.com/psyirius/extendscript-debugger-core/main/src/index.ts` — 2026-09-18 確認。

つまり Adobe デバッガのプロセスは:

```
[VSCode]  ── Extension Host (Node.js, DAP 実装)
              └─ esdcorelibinterface.node (native addon)
                   └─ ESCoreLib (Adobe ネイティブ)
                        └─ AE ExtendScript engine (targetengine "main" 等)
```

**プロセス数は 1 つ**。VSCode Extension Host の中で完結する。CEP パネルは介在しない。これは Adobe が旧 ESTK の資産（`ESCoreLib`）を流用した実装になっているため。

### 1.3 接続のイニシエータ

**Adobe デバッガ側（Node）から** AE プロセスへ接続に行く。`launch` 設定で対象 AE を起動する経路と、`attach` 設定で既に起動中の AE にアタッチする経路の 2 種類がある。

- 出典: https://extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/ — 2026-09-18 アクセス。

アタッチ時は `processId` を `esdInitialize` に渡すことで AE プロセスに紐付ける（`docsforadobe.dev` のドキュメントに明確記載はないが、native 関数のシグネチャから推測、**unverified**）。

### 1.4 Wire protocol

Adobe 公式の **内部 wire protocol は公開されていない**。ただし、次は公式 / 半公式情報から確実視できる:

- VSCode ⇔ Extension Host 間は標準の **Debug Adapter Protocol (DAP)** over stdio。
- Extension Host ⇔ AE 間は **`ESCoreLib`** 経由の Adobe プロプライエタリ IPC。`esdcorelibinterface.node` がこの層を隠蔽する。**具体的なメッセージ形式（BridgeTalk? 独自 TCP?）は Adobe の旧 ESTK 内部仕様であり、現時点で Web 上に公開情報なし**（unverified）。
- 一般に Adobe 製 ExtendScript engine は ESTK と TCP ポート 2018 でやり取りした歴史があり（community 既知）、ESTK の TCP プロトコルが VSCode デバッガに流用されている可能性があるが、**wire 詳細の確証は Adobe 公式には無い**。

### 1.5 ライフサイクル

| 段階 | 挙動 |
|---|---|
| Extension activate | DAP server 起動、native addon ロード |
| Debug session start | `esdInitialize(spec, processId)` で engine 接続 |
| Evaluate / Step / Breakpoint | `esdcorelibinterface` の対応関数呼び出し |
| Debug session stop | `esdCleanup()` で切断 |
| Extension deactivate | native addon は process exit で自動解放 |

`esdCleanup` を呼ばないと `ALREADY_INITIALIZED` 状態が残る可能性がある（status enum からの推測、unverified）。

### 1.6 このパターンの得失

- **利点**: プロセス境界が 1 つしかなく、シンプル。CEP 不要（パネル署名・`PlayerDebugMode` 不要）。VSCode の DAP エコシステムに直接乗れる。
- **制約**: **Linux 非対応**、**Apple Silicon 非対応**。ESTK の保守終了と共に将来の保守性に懸念。AI エージェントから「ライブラリ」として呼べる API surface がデバッガ中心（breakpoint、step）で、「無音で実行 → 結果取得」のエンドポイントは薄い。
- **コミュニティ評価**: `extendscript.docsforadobe.dev` 自身が「semi-buggy, generally unreliable」と評している。`app.scheduleTask` との併用で安定性が低下する報告あり（Adobe Community thread 2022-、出典: https://community.adobe.com/questions-529/extendscript-debugger-for-vscode-is-not-maintained-42460 — 2026-09-18 アクセス）。

---

## 2. Community patterns — 既存ツールのプロセスモデル

### 2.1 ファイルポーリング型ブリッジ（最も一般的）

**代表例**: `Dakkshin/after-effects-mcp`, `a-y-ibrahim/after-effects-mcp`

```
[AI/MCP client]
      ↓ MCP (stdio)
[MCP server (Node.js)]
      ↓ write JSON command file
[~/Documents/ae-mcp-bridge/ae_command.json]
      ↓ poll every 2000ms via app.scheduleTask
[ScriptUI panel (mcp-bridge-auto.jsx, in AE)]
      ↓ ExtendScript evalScript / app.*
[AE ExtendScript engine]
      ↓ write result file
[~/Documents/ae-mcp-bridge/ae_mcp_result.json]
      ↓ poll every 250ms
[MCP server] → MCP response
```

- 出典: https://github.com/Dakkshin/after-effects-mcp — 2026-09-18 確認。
- 出典: https://raw.githubusercontent.com/Dakkshin/after-effects-mcp/main/src/index.ts — 2026-09-18 確認。
- 出典: https://raw.githubusercontent.com/Dakkshin/after-effects-mcp/main/src/scripts/mcp-bridge-auto.jsx — 2026-09-18 確認。

特徴:
- **IPC = ファイル書き込み + `app.scheduleTask` ポーリング**（Socket 不要、CEP 不要）。
- ポーリング間隔はブリッジ側が 2000ms、サーバ側が 250ms（`waitForBridgeResult` ループ）。
- コマンド単位のユニーク ID を使い、結果ファイルの「stale 化」を避ける（`a-y-ibrahim` 版）。
- ScriptUI panel をユーザーが **手動で開いたまま** にしておく運用。閉じるとブリッジ停止。
- **AE 側クラッシュの影響**: サーバ側はコマンドを書き込んでも読まれない。タイムアウト（5000ms）でエラーを返す。サーバ自体は生き残る。
- **サーバ側クラッシュ**: AE 側の panel は結果を書き込めないが、次のコマンド試行時にサーバ不在で失敗するだけ。AE 側は無停止。

### 2.2 WebSocket 型ブリッジ（CEP パネル経由）

**代表例**: `hodor/ae-mcp`

```
[AI/MCP client]
      ↓ MCP (stdio)
[MCP server (Node.js)]
      ↓ WebSocket (port 3000)
[CEP panel (in AE, with Node.js enabled)]
      ↓ CSInterface.evalScript
[AE ExtendScript engine]
```

- 出典: https://github.com/hodor/ae-mcp — 2026-09-18 確認。

特徴:
- CEP panel が `Window > Extensions > AEMCP` から **手動起動**。
- `cep_node.require('ws')` 等で Node.js の WebSocket サーバを panel 内に立てるか、サーバへ接続。
- ファイルポーリングより **低レイテンシ**（リアルタイム push 可能）。
- ただし CEP 12 で `cep_node` の Node.js は 17.7.1 に固定（CEP Cookbook より）。npm パッケージの多くが load 失敗する報告あり（Adobe Community 2024 確認）。
- パネルを閉じると WebSocket 切断。再起動必要。

### 2.3 Premiere Pro MCP の二段構え

**代表例**: `leancoderkavy/premiere-pro-mcp`

```
[AI/MCP client]
      ↓ MCP (stdio or HTTP/SSE remote)
[MCP server (Node.js)]
      ↓ file polling (.jsx command / .json response)
[CEP plugin (in Premiere Pro)]
      ↓ CSInterface.evalScript
[Premiere ExtendScript engine]
```

ただし **Premiere 25.6+ の UXP バックエンド** では、WebSocket `127.0.0.1:7777` + shared secret token 認証に切り替わる。

- 出典: https://github.com/leancoderkavy/premiere-pro-mcp — 2026-09-18 確認。

これは **同一 MCP サーバが CEP 経由と UXP 経由の両方を抽象化する** 設計例であり、本プロジェクトの MCP/VSCode が共通コアを持つビジョンと整合する。

### 2.4 比較まとめ

| パターン | 採用例 | IPC | パネル常時起動 | レイテンシ | 複雑度 |
|---|---|---|---|---|---|
| ファイルポーリング | Dakkshin, a-y-ibrahim | ファイル | ScriptUI 必要 | 高（秒単位） | 低 |
| WebSocket (CEP) | hodor/ae-mcp | WebSocket | CEP パネル必要 | 低 | 中 |
| ファイル + WebSocket 2段 | premiere-pro-mcp | 両方 | 環境依存 | 中 | 高 |
| ネイティブ addon | Adobe VSCode Debugger | ESCoreLib | 不要 | 低 | 高（プラットフォーム依存） |

---

## 3. Architecture options for ae-devtools

vision.md の構成（VSCode Ext ─ core/daemon ─ MCP）と、既存の AE 通信経路（CEP panel / native addon / file bridge）を組み合わせる。3 つの案を提示し、共通の 9 評価軸で比較する。

### 3.1 案A: VSCode Ext / MCP が直接 native addon を host（Adobe デバッガ型）

```
[VSCode Extension Host (Node.js)]
   ├─ esdcorelibinterface.node → ESCoreLib → AE engine
   └─ (MCP は同じプロセスを使うか、別プロセスで bridge 経由)

[MCP Server (Node.js, stdio)]
   └─ esdcorelibinterface.node → ESCoreLib → AE engine
```

- **共有セッション**: VSCode と MCP が同時に同じ AE engine に attach する場合、`ALREADY_INITIALIZED` 衝突の可能性。ExtendScript engine は単一 targetengine を共有するため、**実質 1 プロセスしか attach できない**。
- **ライフサイクル**: VSCode を閉じると VSCode 側の接続が死ぬ。MCP は独立して attach 可能。両方を同時に使うならプロセス毎に 1 個。
- **クラッシュ分離**: native addon クラッシュは Node プロセスごと巻き込む。VSCode 拡張が落ちると VSCode 全体が影響を受ける。
- **認証**: プロセスローカル。localhost 不要。
- **再接続**: AE 再起動時は VSCode / MCP それぞれが `esdInitialize` を再実行。
- **複数 AE インスタンス**: 1 プロセス 1 インスタンスが基本。複数 attach は `processId` を使い分ける必要（API は対応しているが、運用は未検証）。
- **テスト**: native addon のモックが極めて困難。実 AE 必須。
- **CLI**: 同一 addon を CLI から呼べる（MCP サーバと等価）。
- **LSP 統合**: VSCode Extension 内で完結するため統合は容易。MCP 側は別プロセス。
- **実装複雑度**: Adobe の遺産に依存。Linux / Apple Silicon で動かない。

**証拠**: Adobe デバッガの実装（psyirius/extendscript-debugger-core）、Adobe Marketplace ページ。

### 3.2 案B: 外部 daemon + VSCode Ext / MCP が client + AE 内に CEP panel bridge

```
[VSCode Extension (Node.js)] ─┐
                              ├─→ [Shared daemon (Node.js, 常駐)]
[MCP Server (Node.js)] ───────┘         │
                                         │ TCP / WebSocket / Unix socket
                                         ↓
                              [CEP panel (AE 内)] ── evalScript ──→ ExtendScript engine
                              [ExtendScript Socket listener] ──────→ daemon へ通知
```

- **共有セッション**: daemon が AE との接続を 1 本に集約。VSCode と MCP は daemon に対する client として並列アクセス可能。daemon がリクエストを **直列化** することで `evalScript` の重複実行を避けられる（コミュニティ既知の懸念、「split into small parts」原則）。
- **ライフサイクル**: daemon は VSCode 起動とは独立。launchd / Task Scheduler / ユーザー手動起動のいずれでも可。VSCode を閉じても daemon と CEP panel は生存。
- **クラッシュ分離**: 4 プロセスに分かれるため、各層が独立に再起動可能。CEP panel が落ちても daemon が再接続待ち、daemon が落ちても VSCode / MCP は次回起動時に reconnect。
- **認証**: localhost / Unix socket / 共有 secret token 等の選択が必要（TCP なら最低限）。
- **再接続**: AE 再起動時、CEP panel は死ぬ。daemon は CEP panel の不在を検出し、ユーザーが再起動するまで "AE 未接続" 状態を返す。VSCode / MCP 側は daemon への接続を維持したまま状態を受信。
- **複数 AE インスタンス**: 1 daemon で複数 AE インスタンスの socket を持てる（CEP-Resources の "Sidecar addressing" の通り、各インスタンスの panel が別 socket を開く）。**ポート管理**: daemon は固定 port（例: 7000）、各 AE panel はエフェメラル port で daemon に接続。
- **テスト**: daemon 自体は CEP / AE と独立にテスト可能。CEP panel と AE engine はモック必要（ScriptUI 部分のモックは困難だが、ロジックは分離できる）。
- **CLI**: 同一 daemon に CLI から HTTP / gRPC で接続する選択肢が自然。
- **LSP 統合**: daemon の API として LSP 用のエンドポイントを露出できる（Language Server を daemon 内に同梱するか別プロセスにするかは選択）。
- **実装複雑度**: プロセス境界 3 つ。**vision.md の「shared core / daemon」像と最も整合する**。一方、CEP panel 配布・署名の運用負荷が残る。

**証拠**: Premiere Pro MCP、hodor/ae-mcp の構造、Adobe CEP-Resources 内の "Sidecar" 解説（02-cep-deep-dive.md セクション 4 参照）。

### 3.3 案C: CEP panel が server、VSCode Ext と MCP が client

```
[VSCode Extension (Node.js)] ─┐
                              ├─→ [CEP panel (AE 内, サーバ)]
[MCP Server (Node.js)] ───────┘         │
                                         │ CEP 内 Node 17.7.1 で listen
                                         ↓
                                    ExtendScript engine
```

- **共有セッション**: CEP panel が単一窓口。VSCode と MCP は panel の client として並列接続可。サーバ側の多重化は panel 内で実装。
- **ライフサイクル**: **panel が落ちるとサーバも消える**。panel を閉じるとブリッジ停止。File > Extensions から手動起動し続ける運用。
- **クラッシュ分離**: panel クラッシュ = サーバ消滅 = クライアント全滅。ただし panel を再起動すれば復帰。
- **認証**: localhost 上でも panel が listen するなら共有 secret が望ましい。
- **再接続**: AE 再起動 = panel 消滅 = クライアントは再起動待ち。
- **複数 AE**: 各 AE インスタンスが独自の panel を持ち、client 側は AE インスタンスごとに接続先を切り替える必要。
- **テスト**: panel ロジック（Node 17.7.1 環境）は単体テスト困難。
- **CLI**: panel が生きている間に CLI から接続可能だが、AE 終了と同時に CLI も切断される。
- **LSP 統合**: サーバを panel 内に置く場合、Node 17.7.1 固定の制約を LSP も受ける。
- **実装複雑度**: プロセス数は 2 つだが、**CEP Node.js の制限（17.7.1, モジュール制限）** に巻き込まれる。

**証拠**: hodor/ae-mcp（部分的にこの形）、Adobe CEP 12 Cookbook の Node.js 制限。

### 3.4 比較表

| 評価軸 | 案A (native) | 案B (daemon + CEP) | 案C (CEP as server) |
|---|---|---|---|
| VSCode + MCP 共有セッション | 不可（engine 単一 attach） | 可（daemon が直列化） | 可（panel が直列化） |
| Lifecycle 主導 | 各 client | daemon | CEP panel |
| Crash isolation | 弱（process 巻き込み） | 強（4 プロセス分離） | 中（panel = SPOF） |
| 認証 | 不要 | 必要（daemon ↔ client） | 必要（panel ↔ client） |
| AE 再接続 | client 毎 | daemon が retry | panel 再起動待ち |
| 複数 AE インスタンス | 1 プロセス 1 attach | 1 daemon が複数接続 | client 側で切替 |
| Mock でのテスト | 困難 | 可能（daemon 単独テスト可） | 困難（CEP 依存） |
| CLI 利用 | 可能 | 自然 | 限定的 |
| LSP 統合 | VSCode 内では容易 | daemon API として | panel 内の制約受ける |
| 実装複雑度 | 中（依存が深い） | 高（プロセス境界 3） | 中（panel 依存） |
| プラットフォーム対応 | Win/macOS のみ | 全プラットフォーム | 全プラットフォーム |
| CEP 署名 / 配布 | 不要 | 必要（panel 配布時） | 必要 |
| Adobe 保守依存 | 強（ESCoreLib） | 弱 | 中 |

### 3.5 派生案・補足

- **案A': 案B の中で native addon も選択肢にする**: daemon が `esdcorelibinterface.node` を使い、CEP panel を介さず ExtendScript engine に直接 attach。AE 再起動時の自動再接続と Linux/ARM 非対応は残るが、CEP 署名・配布が不要になり panel のクラッシュ点を消せる。Adobe デバッガを daemon 化した形。
- **案B': ExtendScript Socket listener 型**: CEP panel の代わりに、AE startup scripts フォルダに置いた ExtendScript が `$.socket.listen(port)` で直接 listen。daemon がそこへ接続。panel 不要。AE の起動毎に listener を貼り直す必要。
- **案C の UXP 版**: AE 25.0+ の UXP scripting で同等のサーバを立てる。ExtendScript 互換と UXP scripting API の対応を要確認（02-cep-deep-dive.md の Unverified 参照）。

### 3.6 暫定的な推奨

vision.md の「shared core / daemon」像、AGENTS.md の責務分離方針、2026-09 時点で実 AE を持てない開発初期のテスト容易性を総合すると、**案B（外部 daemon + 薄い CEP panel bridge）が当面もっとも整合的** である。実装方針の確定は別フェーズで判断する（本ドキュメントは評価のみ）。

---

## 4. Evidence (URL — アクセス日)

1. `https://marketplace.visualstudio.com/items?itemName=Adobe.extendscript-debug` — 2026-09-18 — Adobe 公式 Marketplace。Publisher=Adobe, ID=`Adobe.extendscript-debug`。
2. `https://github.com/psyirius/extendscript-debugger-core` — 2026-09-18 — Adobe 元デバッガの native addon を単体抽出した community ポート。`esdcorelibinterface` の構造、API、プラットフォーム制限を確認。
3. `https://raw.githubusercontent.com/psyirius/extendscript-debugger-core/main/src/index.ts` — 2026-09-18 — プラットフォーム別バイナリの遅延ロード・シングルトン実装。
4. `https://raw.githubusercontent.com/psyirius/extendscript-debugger-core/main/types/esdcorelibinterface.d.ts` — 2026-09-18 — `esdInitialize`, `esdCompileToJSXBin`, `esdCheckSyntax`, `esdCleanup`, `ESDCoreStatus` のシグネチャ。
5. `https://extendscript.docsforadobe.dev/vscode-debugger/getting-started-with-vscode-debugger/` — 2026-09-18 — launch/attach 設定、`Evaluate Script in Host...` の存在。
6. `https://extendscript.docsforadobe.dev/external-communication/socket-object/` — 2026-09-18 — ExtendScript `Socket.open/listen/poll` の TCP API。
7. `https://community.adobe.com/questions-529/extendscript-debugger-for-vscode-is-not-maintained-42460` — 2026-09-18 — Adobe Community。Adobe VSCode デバッガの保守状態・安定性に関する community 評価。
8. `https://github.com/Dakkshin/after-effects-mcp` — 2026-09-18 — ファイルポーリング型ブリッジ実装の代表例。
9. `https://raw.githubusercontent.com/Dakkshin/after-effects-mcp/main/src/index.ts` — 2026-09-18 — サーバ側の 250ms ポーリング、`ae_command.json`/`ae_mcp_result.json` の IPC パターン。
10. `https://raw.githubusercontent.com/Dakkshin/after-effects-mcp/main/src/scripts/mcp-bridge-auto.jsx` — 2026-09-18 — ブリッジパネル側。`app.scheduleTask` で 2000ms ポーリング。
11. `https://github.com/a-y-ibrahim/after-effects-mcp` — 2026-09-18 — ファイルポーリングの改良版（per-command ユニーク ID で stale 回避）。
12. `https://github.com/hodor/ae-mcp` — 2026-09-18 — CEP panel + WebSocket 型ブリッジ。port 3000。
13. `https://github.com/leancoderkavy/premiere-pro-mcp` — 2026-09-18 — Premiere 用 MCP。CEP ファイルポーリング + UXP WebSocket(127.0.0.1:7777 + secret) の二段実装。
14. `https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md` — 2026-09-18 — CEP 12 の `evalScript` シグネチャ、main thread 実行、`--enable-nodejs`、Node 17.7.1。
15. `gh api repos/Adobe-CEP/extendscript-debugger-vscode` — 2026-09-18 — リポジトリ 404 確認（GitHub API 直接）。
16. `gh api repos/Adobe/extendscript-debug` — 2026-09-18 — リポジトリ 404 確認。
17. `docs/architecture/research/01-execution-surface.md` — 2026-09-18 — 既存 research。`evalScript` 同期性、main thread 挙動の整理。
18. `docs/architecture/research/02-cep-deep-dive.md` — 2026-09-18 — 既存 research。CEP lifecycle、Node 17.7.1、debug port、署名、background mode 不可。

---

## 5. Unverified items

1. **`Adobe-CEP/extendscript-debugger-vscode` の正確な内部実装**。リポジトリ 404 のため、`esdInitialize` の引数 `spec` の意味、`processId` の取得元、`esdCleanup` を呼ばない場合の挙動、ESTK と AE engine 間の wire format は **コードから確認できない**。`psyirius/extendscript-debugger-core` のラッパーと `docsforadobe.dev` の記述から推定した部分が多い。
2. **Adobe VSCode デバッガが ESTK の TCP ポート 2018 を使うか、別経路か**。コミュニティで「ESTK の TCP プロトコルを流用」と言及されることはあるが、Adobe 公式の明文はない。
3. **`esdcorelibinterface.node` が AE engine の targetengine をどう選択するか**（`"main"` vs `"aftereffects"`）。type 定義には露出していない。
4. **複数 AE インスタンスに対する `esdInitialize` の挙動**。複数 processId 同時 attach の可否。
5. **CEF 上の CEP Node.js (`cep_node`) で動く WebSocket サーバの安定性**。`ws` モジュールが Node 17.7.1 で load できるか、Adobe Community 2024 の「`cep_node` の制限」報告との整合。
6. **ExtendScript `Socket.listen` を商用パネルで使う是非**。ドキュメントには記載あるが、Adobe 公式の推奨ではなく、実例が薄い。
7. **AE 25.5+ で ExtendScript がデフォルト無効化に向かう方向性と、daemon 経由アクセスへのインパクト**。現状 AE 25.0 で UXP scripting が入ったが、ExtendScript の長期ロードマップは Adobe 公式に明確な日程が無い。
8. **Premiere Pro MCP の UXP バックエンドが AE に移植可能か**。Premiere 25.6+ 固有機能の可能性がある。
9. **Apple Silicon 上で `esdcorelibinterface.node` が Rosetta 以外で動く可能性**。`psyirius` フォークは macOS x64 のみバンドル。
10. **`ALREADY_INITIALIZED` 状態のリカバリ手順**。Adobe 公式の記述なし。
11. **CEP panel を経由しない `evalScript` の代替手段**（例: 直接 ESCoreLib を叩くライブラリ）。Adobe 公式に独立使用例は無い。

---

## 6. Notes

- 本ドキュメントは 2026-09-18 時点の調査であり、Adobe-CEP org のリポジトリが archived 状態であることを前提にしている。将来リポジトリが復活・移動した場合は再検証する。
- Adobe VSCode デバッガの内部構造は **直接のソース確認が取れていない** ため、案A を採用する場合は real-AE での検証が必須。
- 案B を採用する場合、CEP panel の配布・署名・`PlayerDebugMode` の UX は 02-cep-deep-dive.md の Working assumptions を引き継ぐ。
- vision.md の「実装言語 / プロセスモデル / IPC 方式はまだ決めていない」と整合させ、本ドキュメントは **設計の固定ではなく材料提供** に留める。AGENTS.md 第 1 項「ユーザーが決めていない仕様を勝手に固定しない」に従う。
