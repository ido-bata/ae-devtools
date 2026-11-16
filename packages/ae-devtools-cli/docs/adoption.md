# Adopting @ae-devtools/cli in an existing AE project

対象読者: After Effects のスクリプト/拡張を TypeScript で開発している
プロジェクト（例: Aulymo_v04, vidc-wAI）。

## Install

npm publish 前の現時点では tarball または git 依存で導入する。

```sh
# tarball（ae-devtools repo で `npm pack packages/ae-devtools-cli`）
npm install ./ae-devtools-cli-<version>.tgz

# または git: npm / bun は git repo 内の subdirectory を直接
# install できない（repo root に package.json がなく、git URL に
# path を含める記法も未サポート）。clone して package dir を
# file: 依存として install する
#   `npm install github:ido-bata/ae-devtools#release-0-2-0` は
#   repo root を解決しに行き package.json 不在で失敗する
git clone --depth 1 --branch release-0-2-0 \
  https://github.com/ido-bata/ae-devtools.git
npm install ./ae-devtools/packages/ae-devtools-cli
```

提供される bin: `ae-devtools`, `jsx-toolchain`, `ae-devtools-mcp`。

## What you get

| Command | 用途 | AE 実機 |
| --- | --- | --- |
| `ae-devtools doctor` | 環境 probe（node/AE install/transport） | 不要 |
| `ae-devtools discover` | 実行可能 op 一覧 + evidence level | 不要 |
| `ae-devtools inspect <op>` | op schema（実行しない） | 不要 |
| `ae-devtools execute <op> --session fake --consent grant` | fake session で dispatch | 不要（fake evidence） |
| `ae-devtools execute <op> --session a8n --consent grant` | owned AE session で dispatch | 必要 |
| `ae-devtools verify` | 実行後 read-back | session に依存 |
| `jsx-toolchain check <file\|dir>` | tsc --noEmit + AE ambient 型 | 不要 |
| `jsx-toolchain lint <file>` | ES3 非互換構文 lint | 不要 |
| `jsx-toolchain build-project <entry> -o dist` | TS→ES3 JSX + sourcemap | 不要 |
| `jsx-toolchain resolve <outdir> <line> <col>` | JSX位置→TS位置 | 不要 |
| `ae-devtools-mcp`（MCP stdio server） | `ae_discover` / `ae_inspect` / `ae_execute` / `ae_verify` を MCP tool として公開 | fake session は不要 |

## MCP client からの利用

`ae-devtools-mcp` は依存なしの NDJSON JSON-RPC stdio server。MCP
client（Claude Desktop 等）の設定例:

```json
{
  "mcpServers": {
    "ae-devtools": {
      "command": "ae-devtools-mcp",
      "args": []
    }
  }
}
```

実機 AE に繋ぐ場合は `"args": ["--session", "a8n", "--ae-a8n-root",
"/path/to/ae-a8n"]` を渡す（owned session のみ。attached/unknown は拒否）。
`ae_execute` / `ae_verify` は CLI と同じ consent 契約で、`consent:"grant"`
が無い呼び出しは session を開く前に refuse される。default の fake session
の結果は fake/mock evidence であり real-host 検証ではない。

## Verified adoption smoke (2026-11-16)

`rebuildup/Aulymo_v04` に対して tarball install 後に read-only で実行:

- `doctor`: AE 2026/2027 検出、`@ido-bata/ae-a8n` 解決 OK
- `discover`: 20 ops、evidence level は fake/mock only と正直に表示
- `jsx-toolchain check src/api.ts` / `lint src/main.ts`: diagnostics 0
- `jsx-toolchain check src`（全体）: ScriptUI/host ambient 型の未整備で
  412 diagnostics → Issue #97 で対応中

`rebuildup/vidc-wAI`（release-0-1-0 head、clone は read-only、tracked
source への変更なし）に対して、repo 内 scratch dir `ae-smoke/` へ
tarball install して実行:

- `doctor`: AE 2026/2027 検出、`@ido-bata/ae-a8n` 解決 OK
- `discover`: 20 ops、evidence level は fake/mock only と正直に表示
- `execute read.projectSummary --session fake --consent grant`:
  COMPLETED（fake/mock evidence）
- `jsx-toolchain check scripts/node`（唯一の TS source、Node 側
  script 3 file）: 9 diagnostics。すべて top-level await と
  `Promise.withResolvers` が ES5 lib 前提の check options で error。
  vidc-wAI の現行 TS は ExtendScript ではなく Node ツール用であり、
  AE 側の置き場（`scripts/ae/`、`plugins/after-effects/`）は現時点で
  README のみで check 対象の AE source が存在しない
- `jsx-toolchain lint`: ae-smoke.ts 5 / mcp-probe.ts 18 /
  frame-time.ts 2 diagnostics。bare module import・`JSON`/`Promise`/
  ES5 prototype method 等、Node script を ES3 host 前提で検査した
  ことによる想定内の指摘であり、adoption blocker ではない

## Boundaries

- consent default は deny。destructive/render op は追加 confirm が必要。
- `--session a8n` は `@ido-bata/ae-a8n` の owned session のみ。
  attached/unknown ownership は拒否される。
- evidence level は常に記録される。fake-level を real-host verified と
  見做さない。
- 実行・認可・transport の正本は ae-a8n。この CLI はその consumer。
