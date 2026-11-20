# ae-devtools

After Effects のスクリプト／エクステンション開発を、VSCode と AI コーディングエージェントから扱える開発基盤を目指すプロジェクト。

## なぜやるか

After Effects の ExtendScript / JSX やエクステンション開発は、通常の Web 開発と比較して多くの摩擦がある。

- VSCode 上で得られる型情報・補完・診断が弱い。
- After Effects 固有 API の仕様やバージョン差を IDE が十分理解できない。
- コードを書く → After Effects 上で実行 → 結果を確認する、というフィードバックループが遅い。
- 実行中のプロジェクト／アクティブコンポジション／選択レイヤー／選択プロパティなどの runtime 状態を IDE 側から利用しにくい。
- AI コーディングエージェントはドキュメント上の After Effects API は参照できても、「今ユーザーが開いている After Effects の状態」をほぼ認識できない。
- 結果として、AI がコードを生成しても、After Effects 上で実行 → 結果確認 → エラー修正、というループを自律的に回しにくい。

## 目指すもの

このプロジェクトが最終的に提供するのは、After Effects を AI から操作する MCP ツール群ではない。

After Effects の **スクリプト／エクステンション開発そのもの** を、VSCode と AI コーディングエージェントからリアルタイムに扱える開発基盤を目指す。

最終的には大きく 2 つの利用面を持つ。

- **VSCode Extension** — 人間の開発者向け。実行、補完、diagnostics、runtime inspector、expression 編集、runtime エラーのソースコードへのマッピング、開発中コードの高速実行など。
- **MCP Server** — Claude Code、Codex、Cursor、OpenCode などの AI コーディングエージェント向け。`createLayer` や `moveLayer` のようなプリミティブを大量に MCP Tool として並べることはしない。エージェントが After Effects 開発ループを自律的に回すためのインターフェースとして設計する。

両者は直接結合せず、背後に AE との通信・runtime inspection・script 実行・API metadata・validation などの機能を共有するコア層を置く構成を想定している。

## 現在の状態

`packages/ae-devtools-cli`（`@ido-bata/ae-devtools-cli@0.5.0`）として CLI + JSX toolchain +
capability catalog + conformance gate が shipped 済み（fake-level 検証 +
macOS arm64 / AE 26.5 の verified-real-host 証跡あり。Windows・配布・
実 editor 受入は未検証）。shipped 済みの範囲を超えて **未確定 / 未検証** のままの領域:

- MCP Tool の詳細仕様の拡張（最小 inspect/execute/verify は実装済み）
- VSCode Extension の実 editor 受入（scaffold + fake-level は shipped）
- Language Server 実装
- CEP / UXP 対応の実機 load proof（scaffold/devkit は shipped、loadProof は NOT RUN）
- Windows 実機検証（macOS arm64 のみ verified-real-host 証跡あり）
- npm 公開・配布パイプラインの完了
- frame capture、visual verification
- AI による After Effects 自動操作機能
- 製品名／ブランド名

なお ExtendScript 実行 bridge（trusted-execution + a8n-transport）、
After Effects との通信方式（ae-a8n file-envelope transport、ADR-0005）、
Scripting API metadata / TypeScript 型定義（`inventories/scripting` +
jsx-toolchain 同梱 `ae-api.d.ts`）は初期形が実装済みであり、詳細は
[docs/vision.md](./docs/vision.md) と各 package README を参照。

詳細は [docs/vision.md](./docs/vision.md) を参照。

## 現在利用可能なもの

`packages/ae-devtools-cli`（`@ido-bata/ae-devtools-cli`）— 外部プロジェクトから
`npm install` で利用できる開発者向け CLI + JSX toolchain。

- `ae-devtools` — `doctor` / `discover` / `inspect` / `execute` / `verify`（fake session は AE 不要、real session は `@ido-bata/ae-a8n` 経由）
- `jsx-toolchain` — TypeScript → ExtendScript ES3 JSX の `build` / `build-project` / `check` / `lint` / `resolve`（ソースマップ）

使い方と evidence level の意味は [`packages/ae-devtools-cli/README.md`](./packages/ae-devtools-cli/README.md) を参照。