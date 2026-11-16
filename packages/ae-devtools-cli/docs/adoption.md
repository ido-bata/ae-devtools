# Adopting @ae-devtools/cli in an existing AE project

対象読者: After Effects のスクリプト/拡張を TypeScript で開発している
プロジェクト（例: Aulymo_v04, vidc-wAI）。

## Install

npm publish 前の現時点では tarball または git 依存で導入する。

```sh
# tarball（ae-devtools repo で `npm pack packages/ae-devtools-cli`）
npm install ./ae-devtools-cli-<version>.tgz

# または git（release branch を pin）
npm install github:ido-bata/ae-devtools#release-0-2-0
```

提供される bin: `ae-devtools`, `jsx-toolchain`。

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

## Verified adoption smoke (2026-11-16)

`rebuildup/Aulymo_v04` に対して tarball install 後に read-only で実行:

- `doctor`: AE 2026/2027 検出、`@ido-bata/ae-a8n` 解決 OK
- `discover`: 20 ops、evidence level は fake/mock only と正直に表示
- `jsx-toolchain check src/api.ts` / `lint src/main.ts`: diagnostics 0
- `jsx-toolchain check src`（全体）: ScriptUI/host ambient 型の未整備で
  412 diagnostics → Issue #97 で対応中

## Boundaries

- consent default は deny。destructive/render op は追加 confirm が必要。
- `--session a8n` は `@ido-bata/ae-a8n` の owned session のみ。
  attached/unknown ownership は拒否される。
- evidence level は常に記録される。fake-level を real-host verified と
  見做さない。
- 実行・認可・transport の正本は ae-a8n。この CLI はその consumer。
