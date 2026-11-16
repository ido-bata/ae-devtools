# @ae-devtools/cli — ae-devtools developer CLI

After Effects スクリプト・拡張開発のための開発者向け CLI。
TypeScript/モダン JS → ExtendScript ES3 JSX のビルド・型検査・lint・
ソースマップに加え、capability registry 経由の `discover / inspect /
execute / verify` を提供する。

**Evidence level の正直な表示**: fake/mock セッションでの結果は
fake-level evidence として記録され、real-host 検証済みとは表示しない。

## Install

```sh
npm install @ae-devtools/cli        # npm publish 後
# または tarball / git から:
npm install ./ae-devtools-cli-0.2.0.tgz
```

Provides three bins:

- `ae-devtools` — developer CLI (`doctor`, `discover`, `inspect`,
  `execute`, `verify`, `runs`, `reap`)
- `jsx-toolchain` — TS→ES3 JSX build / `check` / `lint` / `resolve`
- `ae-devtools-mcp` — stdio MCP server exposing the dev-loop tools
  (`ae_discover` / `ae_inspect` / `ae_execute` / `ae_verify`)

## MCP server

`ae-devtools-mcp` speaks newline-delimited JSON-RPC 2.0 on stdio (no
extra dependencies). Point any MCP client at it:

```json
{ "mcpServers": {
    "ae-devtools": { "command": "ae-devtools-mcp", "args": [] } } }
```

Claude Desktop: add the same entry under `mcpServers` in
`claude_desktop_config.json`. For a real After Effects session pass
`"args": ["--session", "a8n", "--ae-a8n-root", "/path/to/ae-a8n"]`;
the default `--session fake` is fake/mock evidence only.

`ae_execute` / `ae_verify` keep the CLI consent contract:
`consent:"grant"` is required (default deny, checked before any
session opens), destructive ops need `confirmDestructive:true`, render
ops `confirmRender:true`. See `mcp-server/README.md` for details.

## Quick start (fake session — no AE required)

```sh
ae-devtools doctor
ae-devtools discover
ae-devtools inspect read.projectSummary
ae-devtools execute read.projectSummary --session fake --consent grant
ae-devtools verify --session fake --consent grant
```

## Real After Effects (owned session)

```sh
ae-devtools execute <opId> --session a8n --consent grant
# unreleased ae-a8n 検証時のみ:
ae-devtools execute <opId> --session a8n --ae-a8n-root <local-a8n-checkout> --consent grant
```

`--session a8n` は `@ido-bata/ae-a8n` (pinned `0.1.0-alpha.2`) の
owned-session launch を使う。`attached`/`unknown` ownership は拒否される。
consent の default は deny。destructive/render op は追加の confirm flag が必要。

## JSX toolchain

```sh
jsx-toolchain check src/main.ts          # tsc --noEmit + AE API typings
jsx-toolchain lint src/main.ts           # ES3-compat lint
jsx-toolchain build-project src/main.ts -o dist --name panel
jsx-toolchain resolve dist/panel.jsx.map 12 4   # JSX位置→TS位置
```

`check` は同梱の生成済み `ae-api.d.ts`（scripting inventory 由来）を使う。

## Layout

| dir | role |
| --- | --- |
| `devtools-cli/` | developer CLI (`cli.mjs`, session guard, evidence records) |
| `dev-loop/` | discover/inspect/execute/verify core |
| `trusted-execution/` | codec, consent/permissions, outcomes, mutation guard, runner |
| `scripting-adapters/` | operation registry + fake host + coverage claims |
| `a8n-transport/` | owned-session transport over `@ido-bata/ae-a8n` |
| `mcp-server/` | stdio MCP server (JSON-RPC) over the dev-loop core |
| `jsx-toolchain/` | TS→ES3 JSX build / typecheck / lint / sourcemap |

## Verification

- `npm test` — 全 fake-level suite（AE 不要）
- `npm run smoke:consumer` — tarball を外部ディレクトリへ install し、
  fake session での CLI 実行を検証
- real-host: `--session a8n` 経路は opt-in。AE 実機・Windows は
  別途 evidence 記録（未検証は未検証と表示）

## Docs

- Module READMEs: `devtools-cli/README.md`, `jsx-toolchain/README.md`,
  `a8n-transport/README.md`, `trusted-execution/README.md`,
  `mcp-server/README.md`
- Canonical governance: repo ルートの `AGENTS.md`, `docs/`
