# Vision

このドキュメントは ae-devtools プロジェクトの背景・目的・方向性をまとめる。
仕様を確定するものではなく、現時点で **意図として共有されている内容** を整理する。
各項目は今後の設計フェーズで個別に決定される。

## 背景

After Effects のスクリプト／エクステンション開発は、長年にわたって独自のエコシステムに閉じてきた。ExtendScript / JSX は独自の方言を持つ JavaScript で、VSCode などのモダン IDE はそれを After Effects 固有の文脈で扱うための型情報を持っていない。CEP / UXP パネル、デバッガ統合、ビルドツール — After Effects 開発者にとっては断片的で、毎回手作業で組み上げる必要がある。

さらに近年は Claude Code、Cursor、OpenCode のような AI コーディングエージェントが一般の開発ワークフローに浸透してきている。しかし、エージェントが After Effects 開発で生産的に動くには、ドキュメント上の API 知識だけでは足りない。「今ユーザーが After Effects 上で開いているプロジェクト」「アクティブなコンポジション」「選択中のレイヤーとプロパティ」「最後に実行したスクリプトのエラースタック」 — この種の runtime 状態を、エージェントは認識できない。

## 問題意識

現状の After Effects 開発にはおおよそ以下の摩擦がある。

1. **IDE の理解不足** — After Effects API の型情報が弱く、補完・diagnostics が AE バージョン差を反映しない。
2. **フィードバックループの遅さ** — コードを書く → After Effects に貼り付けて実行 → 結果を確認 → 修正、の流れが分断されている。
3. **runtime と IDE の断絶** — アクティブな comp、選択レイヤー、選択プロパティ、プロジェクト状態が IDE から見えない。
4. **AI コーディングエージェントの制約** — エージェントはドキュメント上の API は参照できても、After Effects のランタイム状態をほぼ把握できない。結果として AI が生成したコードを AE 上で自律的に検証・修正するループを回しにくい。
5. **既存「AE 自動化ツール」との混同** — 「After Effects を AI から操作する」ことと「After Effects 開発を AI から扱う」ことは別の問題であり、後者にはまだ十分な基盤がない。

## プロジェクトの目的

このプロジェクトは、After Effects の **スクリプト／エクステンション開発そのものを** VSCode と AI コーディングエージェントから扱える開発基盤を作ることを目的とする。

目指している方向:

- After Effects API の型・補完・diagnostics を、IDE と AI コーディングエージェントの両方から利用できるようにする。
- 開発ループを高速化する — コード編集 → 実行 → 結果確認 → エラー→ソースマッピング → 修正を IDE 内で完結に近づける。
- ランタイムの After Effects 状態（プロジェクト、active comp、選択レイヤー、選択プロパティ、expression エラーなど）を IDE と AI の双方から観測・操作可能にする。
- AI コーディングエージェントが After Effects 開発を自律的に進められるよう、状態取得 → コード生成 → 検証 → 実行 → エラー回収 → 修正のループを支えるインターフェースを提供する。

## 想定利用者

- After Effects のスクリプト／エクステンションを日常的に書く開発者。
- コンポジション、レイヤー、エフェクト、expression をプログラムで操作するワークフローを、AE の中だけに閉じず IDE と連携させたい開発者。
- AI コーディングエージェントを After Effects 開発に持ち込みたい開発者。
- After Effects の自動化やパイプライン構築を行っているスタジオや個人。

## VSCode Extension の方向性（意図）

人間の開発者向けに、以下のような機能を持つ VSCode Extension を構想している。**詳細仕様は未確定**。

- JSX / ExtendScript の実行
- After Effects 向け diagnostics
- AE バージョン差を考慮した API 補完
- runtime inspector（active comp / 選択レイヤー / 選択プロパティ）
- expression 編集
- runtime エラーのソースコードへのマッピング
- 開発中コードの高速な実行・検証

実装方式 — Language Server を独立させるか VSCode 拡張に内蔵するか、CEP / UXP とどう連携するか、デバッガ統合をどう扱うか — は **まだ決めていない**。

## MCP Server の方向性（意図）

AI コーディングエージェント向けに MCP Server を提供することを構想している。

ただし、本プロジェクトの MCP は **`createLayer`、`moveLayer`、`setPosition` のようなプリミティブを大量に MCP Tool として定義することを目的としない**。

MCP が提供するのは、エージェントが以下の After Effects 開発ループを自律的に回すためのインターフェースである。

1. 現在の After Effects 状態を取得する。
2. コードを生成する。
3. 検証する。
4. After Effects 上で実行する。
5. runtime 結果やエラーを取得する。
6. 必要なら画面・プロジェクト状態を確認する。
7. 修正する。

つまり MCP も「After Effects 操作ツール」ではなく、「**After Effects Developer Tools を AI から利用するためのインターフェース**」として位置づける。

## shared core を持つ理由

VSCode Extension と MCP Server を直接強く結合させず、背後に共有可能な機能を持たせる構成を想定している。

具体的には、After Effects との通信、runtime inspection、script 実行、API metadata、validation などの本質的な機能は、両方のフロントエンドから再利用される。

この分離により、

- フロントエンド（VSCode Extension / MCP / その他クライアント）の追加・差し替えがしやすくなる。
- After Effects との通信仕様が変わっても、コア側で吸収できる。
- 人間向けと AI 向けの表面を独立に進化させられる。
- 片方のフロントエンドの実装言語を後から変更する場合でも、コアとの契約面を保てれば全体は維持しやすい。

ただし、コア層の **実装言語（TypeScript / Rust / Node.js 等）、プロセスモデル、ローカル IPC 方式、デーモン構成** などは **まだ決めていない**。これは今後の設計フェーズで、コアに持たせる責務と不可分なので一緒に決める。

## アーキテクチャの方向性

想定しているおおまかな構造:

```
After Effects
     ↕
AE Bridge / Runtime
     ↕
Shared Core / Daemon
   ↙          ↘
VSCode        MCP
```

これは現時点での **方向性** であり、ボックス名・責務分割・プロセス境界を確定したものではない。コアと Bridge の境界、MCP と VSCode Ext が共有する範囲、AE Bridge の置き場所（AE 内に常駐する CEP/UXP パネルか、外部プロセスか等）は今後の設計で詰める。

## 将来的に検討する技術領域（未確定）

今後のフェーズで検討対象になり得る領域を挙げる。**いずれも方針未確定**。

- コア層・daemon の実装言語（TypeScript / Rust / Node.js 等）
- MCP Server の実装言語・トランスポート
- VSCode Extension の内部構造（Language Server の独立／内蔵、CEP / UXP / native bridge の扱い）
- After Effects との通信方式（CEP 経由、ExtendScript 経由、Scripting API、UXP、その他）
- AE API metadata の生成パイプライン
- TypeScript 型定義の生成
- frame capture、visual verification
- 製品名／ブランド名
- 配布形態（VS Marketplace 単独 / npm パッケージ / スタンドアロン等）
- 対応する After Effects バージョン範囲

## 現時点で未確定な事項

上に挙げた技術領域に加え、以下の事項も **未確定**:

- VSCode 以外の IDE を想定するか（現時点では VSCode のみ言及）。
- AI コーディングエージェント以外（CLI、ローカル動作の reviewer 等）を一次の対象にするか。
- 商用利用・スタジオ向けか、個人開発者中心か（ライセンス方針と不可分）。
- リアクティブに状態同期を行うか、リクエスト時のみ取得するかの運用モデル。
- エラー時のフォールバック、AE バージョンが古い場合の挙動。

## このドキュメントの位置づけ

`docs/vision.md` は **意図の保存** を目的とする。

「現時点で未確定な事項」に挙げた内容は現時点では決めていない、ということであり、
今後の設計フェーズで決定される可能性がある。決定された際は、ドキュメントへの反映と同時に実装に反映する。

実装と矛盾するビジョン項目を見つけた場合は、ビジョンを先に更新する。