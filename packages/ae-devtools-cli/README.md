# @ido-bata/ae-devtools-cli — ae-devtools developer CLI

After Effects スクリプト・拡張開発のための開発者向け CLI。
TypeScript/モダン JS → ExtendScript ES3 JSX のビルド・型検査・lint・
ソースマップに加え、capability registry 経由の `discover / inspect /
execute / verify` を提供する。

**Evidence level の正直な表示**: fake/mock セッションでの結果は
fake-level evidence として記録され、real-host 検証済みとは表示しない。

## Install

```sh
npm install @ido-bata/ae-devtools-cli          # registry latest
npm install @ido-bata/ae-devtools-cli@0.3.0    # this release, once published
# tarball / local checkout からも可:
npm install ./ae-devtools-cli-0.3.0.tgz
```

### Migrating to 0.3.0

- New dev-loop surface: `ae-devtools discover/inspect/execute/verify`,
  `ae-devtools-mcp` (stdio MCP), and the VSCode extension
  (`ae-devtools-vscode-extension`, packaged via `npm run package:vsix`).
- `--session a8n` (real After Effects) now **requires an ae-a8n build
  satisfying the capability contract** (#102 handshake exports +
  #103/#105 fixes). The published `@ido-bata/ae-a8n@0.1.0-alpha.2`
  predates them and is refused up front (`AE_A8N_CONTRACT_UNSUPPORTED`;
  check `ae-devtools doctor` → `aeA8n.contractOk`). Until a conformant
  ae-a8n is published, pass `--ae-a8n-root <ae-a8n release-0-2-0+ build>`.
  The `fake` session is unaffected.

Provides six bins:

- `ae-devtools` — developer CLI (`doctor`, `discover`, `inspect`,
  `execute`, `verify`, `runs`, `reap`, `diagnose`)
- `jsx-toolchain` — TS→ES3 JSX build / `check` / `lint` / `resolve`
- `ae-devtools-mcp` — stdio MCP server exposing the dev-loop tools
  (`ae_discover` / `ae_inspect` / `ae_execute` / `ae_verify`)
- `ae-devtools-recover` — crash/modal recovery orchestration
  (`evidence` / `observe` / `recover` / `verify-exit`)
- `ae-devtools-cep` — CEP extension devkit (`scaffold` / `validate`)
- `ae-devtools-cep-lifecycle` — CEP panel install/uninstall/status/
  cleanup/logs/`playerdebugmode` (machine-level only; never launches AE)

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
# ae-a8n contract を満たす build を明示する場合（現状はこちらが必要）:
ae-devtools execute <opId> --session a8n --ae-a8n-root <local-a8n-checkout> --consent grant
```

`--session a8n` は `@ido-bata/ae-a8n` の owned-session launch を使う。
解決される ae-a8n が必要 contract（#102 handshake export。#103/#105
修正を祖先に持つ）を満たさない場合は launch 前に
`AE_A8N_CONTRACT_UNSUPPORTED` で refuse される — `ae-devtools doctor`
の `aeA8n.contractOk` で事前確認できる。現時点の npm 公開版
`@ido-bata/ae-a8n@0.1.0-alpha.2` は未対応のため、real-host 利用は
`--ae-a8n-root <ae-a8n release-0-2-0 以降の build>` が必要。
`attached`/`unknown` ownership は拒否される。
consent の default は deny。destructive/render op は追加の confirm flag が必要。

## Crash recovery (`ae-devtools-recover`)

```sh
ae-devtools-recover evidence --since <ISO> --out <dir> \
  [--pid N] [--proc-name NAME] [--app-version V] [--proc-path P] \
  [--reports-dir d]... [--sentry-dir d]...
```

`evidence` は macOS の DiagnosticReports（`.ips`）と Sentry envelope を
収集し、sha256 付きで target process へ相関付ける read-only コマンド。
AE / GUI 不要で consumer 環境でも動く。

`observe` / `recover` / `verify-exit` は real-host 前提:

- `--ae-a8n-root <built-ae-a8n>` が必要。ae-a8n repo の #109（GUI 観測）/
  #111（GUI lease + dialog class）の export を含む build が前提で、
  現時点の npm 公開版 (`@ido-bata/ae-a8n@0.1.0-alpha.2`) には未搭載。
- `recover` は devtools-cli の run marker
  (`ae-devtools.cli.run-guard/v1`) による認可が必須。self-declared
  flag では GUI mutation に到達しない。
- 実機 GUI 経路は **UNVERIFIED**（fake-level のみ、`tests/run.mjs`）。

詳細は `recovery-orchestrator/README.md`。

## CEP extension devkit (`ae-devtools-cep`)

```sh
ae-devtools-cep scaffold --id com.example.my-panel --out ./my-panel \
  [--title "My Panel"] [--version 0.1.0] [--host "[25.0,99.0]"] [--csxs 12.0] [--force]
ae-devtools-cep validate ./my-panel   # JSON report; loadProof は常に "NOT RUN"
```

CEP/UXP panel プロジェクトの scaffold 生成と静的 validate
（manifest well-formedness / 必須要素 / panel 参照 / CSInterface.js
同梱 / host `.jsx` の ES3 subset lint）。Node >= 22、追加依存なし、
AE 不要。

`ae-devtools-cep-lifecycle` は scaffold 生成物の OS CEP ディレクトリ
への install/uninstall/status/cleanup/log 収集と `PlayerDebugMode`
読み取りを行う（`--target`/`--log-dir` で退避可能）。**実機での panel
load / reload / unload（CAP059）と UXP（CAP060）は UNVERIFIED /
BLOCKED** — gated 手順は `cep-extension/LOAD-PROOF.md`、詳細と
証拠水準は `cep-extension/README.md` を参照。

## Agent dev loop library (`agent-loop/`)

bin は提供しない。`fixer` / `consentProvider` / `stateReset` は
呼び出し側（coding agent / deployment）が注入するため、正直な既定
CLI が存在しない。install した package から library として import
する:

```js
import { runDevLoop, regressionCheck, toDiagnostic, FAKE_SESSION }
  from "@ido-bata/ae-devtools-cli/agent-loop";
import { createFakeHost, createFakeApp }
  from "@ido-bata/ae-devtools-cli/agent-loop/fake-host";
```

`runDevLoop` は dispatch→diagnose→fix→rerun→regression の dev loop
（Issue #38）。silent retry なし、fix budget は bounded、consent は
attempt ごとに注入 provider が評価、dirty FAILED 後の rerun は
`stateReset` 検証または明示 `allowDirtyRerun` が必須。詳細は
`agent-loop/README.md`。**fake/mock level のみ** — real AE dispatch /
ExtendScript semantics / real-host regression は未検証。

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
| `recovery-orchestrator/` | crash/modal recovery orchestration (`ae-devtools-recover` bin) |
| `diagnostics/` | `ae-devtools.diagnostics/v1` record schema, collector registry, JSX→TS sourcemap resolution (consumed by `ae-devtools diagnose`) |
| `jsx-toolchain/` | TS→ES3 JSX build / typecheck / lint / sourcemap |
| `cep-extension/` | CEP extension scaffold + validate devkit (`ae-devtools-cep`, `ae-devtools-cep-lifecycle` bins) |
| `agent-loop/` | agent dev loop library (`@ido-bata/ae-devtools-cli/agent-loop`; bin なし、fake-level) |

## Verification

- `npm test` — 全 fake-level suite（AE 不要）
- `npm run smoke:consumer` — tarball を外部ディレクトリへ install し、
  fake session での CLI 実行を検証
- real-host: `--session a8n` 経路は opt-in。AE 実機・Windows は
  別途 evidence 記録（未検証は未検証と表示）

## Docs

- Module READMEs: `devtools-cli/README.md`, `dev-loop/README.md`,
  `jsx-toolchain/README.md`, `a8n-transport/README.md`,
  `trusted-execution/README.md`, `mcp-server/README.md`,
  `recovery-orchestrator/README.md`, `cep-extension/README.md`,
  `agent-loop/README.md`
- Canonical governance: repo ルートの `AGENTS.md`, `docs/`
