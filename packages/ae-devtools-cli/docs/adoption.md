# Adopting @ido-bata/ae-devtools-cli in an existing AE project

対象読者: After Effects のスクリプト/拡張を TypeScript で開発している
プロジェクト（例: Aulymo_v04, vidc-wAI）。

## Install

`@ido-bata/ae-devtools-cli` は npm に公開済み（latest `0.2.0`）。
ローカルのソース checkout や開発者固有の設定は不要。

```sh
npm install --save-dev @ido-bata/ae-devtools-cli
# または bun / pnpm 等、プロジェクトの package manager で同等に
```

提供される bin: `ae-devtools`, `jsx-toolchain`, `ae-devtools-mcp`,
`ae-devtools-recover`, `ae-devtools-cep`, `ae-devtools-cep-lifecycle`。

### real-host session (`--session a8n`) の ae-a8n 要件

`--session a8n` は owned AE session を `@ido-bata/ae-a8n` 経由で使う。
この経路が要求する ae-a8n contract（capability handshake export =
ae-a8n#102。#103 extension prelude / #105 LaunchServices 修正を祖先に持つ）を
満たすのは ae-a8n `release-0-2-0` 以降。npm pin は `@ido-bata/ae-a8n@0.2.0`
（`next` dist-tag で公開済み）で、これを満たす。`<=0.1.0-alpha.2` を
解決した場合のみ contract gate が launch 前に refuse する。

- `ae-devtools doctor` が解決した ae-a8n の `contractOk` を報告する
  （AE は起動しない）。
- contract 未満の ae-a8n で `--session a8n` を実行すると、launch 前に
  `AE_A8N_CONTRACT_UNSUPPORTED` で refuse される（fail-closed。
  分かりにくい host error で途中失敗しない）。
- 次回の `@ido-bata/ae-a8n` publish までは、ae-a8n の checkout
  （`release-0-2-0` 以降、`dist/` build 済み）を `--ae-a8n-root <dir>`
  で指定する。fake session（`--session fake`、既定）はこの要件に
  関係なく動作し、evidence level は fake/mock のまま。

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
| `ae-devtools-recover evidence --since <ISO> --out <dir>` | crash evidence（`.ips` / Sentry envelope）収集 + 相関付け | 不要（read-only） |
| `ae-devtools-recover observe/recover/verify-exit` | GUI 観測・timeout recovery・exit 検証 | 必要 + ae-a8n #109/#111 build |
| `ae-devtools-cep scaffold <args>` | CEP extension プロジェクト scaffold 生成 | 不要 |
| `ae-devtools-cep validate <dir>` | CEP extension dir の静的 validate（JSON report） | 不要（`loadProof` は常に `NOT RUN`） |
| `ae-devtools-cep-lifecycle install/uninstall/status/cleanup/logs/playerdebugmode` | OS CEP ディレクトリへの panel 配置・除去・状態・ログ・`PlayerDebugMode` 読み取り | 不要（AE は起動しない。実機 load は別途 LOAD-PROOF 手順） |

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
`--ae-a8n-root` の ae-a8n は前述の contract を満たす build が必要で、
満たさない場合は session open 前に refuse される。`ae_execute` /
`ae_verify` は CLI と同じ consent 契約で、`consent:"grant"` が無い
呼び出しは session を開く前に refuse される。default の fake session
の結果は fake/mock evidence であり real-host 検証ではない。

## Coding agent からの dev loop 利用（agent-loop library）

`agent-loop/` は bin を持たない library module。`fixer`（診断を受けて
修正 source を返す関数）と `consentProvider` / `stateReset` は呼び出し側の
agent / deployment が注入する設計であり、package 側に既定の修正ロジックは
存在しない。install 済み package から:

```js
import { runDevLoop, regressionCheck, toDiagnostic, FAKE_SESSION }
  from "@ido-bata/ae-devtools-cli/agent-loop";
import { createFakeHost, createFakeApp }
  from "@ido-bata/ae-devtools-cli/agent-loop/fake-host";
import { loadTrustedCodec } from "@ido-bata/ae-devtools-cli/trusted-execution/runner.mjs";
import { consentScopeFor } from "@ido-bata/ae-devtools-cli/trusted-execution/permissions.mjs";
```

最小の fake-level 利用例（`fixtures/clean.jsx` は package 同梱）:

```js
const codec = loadTrustedCodec();
const host = createFakeHost({ app: createFakeApp() });
const transport = { send: async (text) => host.send(text, codec) };
const consentProvider = async (source) => ({
  consent: { scope: consentScopeFor({
    pin: FAKE_SESSION.pin, operationId: FAKE_SESSION.operationId,
    args: { source, dispatchArgs: null },
    projectIdentity: FAKE_SESSION.projectIdentity }) },
  trustedScriptOptIn: true,
  scriptProvenance: "my-agent",
});
const report = await runDevLoop({ source, transport, fixer, consentProvider });
// report.outcome: COMPLETED | FAILED | BLOCKED | REFUSED | UNKNOWN
```

loop の契約（詳細は `agent-loop/README.md`）:

- dispatch は attempt ごとに 1 回。silent retry なし、fix budget は
  `maxFixes`（default 3）で bounded。
- consent は loop が発行しない。`consentProvider` 未注入なら send 前に
  `BLOCKED`。
- FAILED で `mayHaveMutated` または state fingerprint 変化があれば、
  rerun 前に `stateReset` の fingerprint 検証、または明示
  `allowDirtyRerun: true` が必須。検証不能なら `resetIncomplete` で停止。
- `regressionCheck` は `assumeIdempotent: true` の場合のみ再 dispatch。
  `stateFingerprint` を渡せば mutation を実測できる。
- `UNKNOWN`（reply-identity 不一致等）は quarantine され loop は停止。

**Evidence: fake/mock only。** fake host は Node `vm` sandbox であり
real AE / ExtendScript semantics / real-host regression は未検証。
consumer smoke（`npm run smoke:consumer`）が install 済み tarball からの
import と clean fixture の 1 dispatch 完了を検証する。

## Verified adoption smoke (2026-11-16)

`rebuildup/Aulymo_v04` に対して tarball install 後に read-only で実行:

- `doctor`: AE 2026/2027 検出、`@ido-bata/ae-a8n` 解決 OK
- `discover`: 26 ops、evidence level は fake/mock only と正直に表示
- `jsx-toolchain check src/api.ts` / `lint src/main.ts`: diagnostics 0
- `jsx-toolchain check src`（全体）: ScriptUI/host ambient 型の未整備で
  412 diagnostics → Issue #97 で対応中

`rebuildup/vidc-wAI`（release-0-1-0 head、clone は read-only、tracked
source への変更なし）に対して、repo 内 scratch dir `ae-smoke/` へ
tarball install して実行:

- `doctor`: AE 2026/2027 検出、`@ido-bata/ae-a8n` 解決 OK
- `discover`: 26 ops、evidence level は fake/mock only と正直に表示
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
- `ae-devtools-recover` の `observe` / `recover` / `verify-exit` が
  必要とする ae-a8n surface（`readGuiSession` / `listAppInstances` /
  `censusRunnerInSession` / `windowServerCensus` / `MacGuiRecovery` /
  `MacHostRecovery` / GUI lease 関連 export）は、公開版
  `@ido-bata/ae-a8n@0.2.0` が全て ship しているため、pinned
  dependency のまま動作する。`--ae-a8n-root` は別 build / 開発版の
  ae-a8n を指したい場合の override であり必須ではない。コマンド別に
  必要 export が検証され、欠落時は `AE_A8N_SURFACE_MISSING` で
  明示的に失敗する（silent degradation しない）。実機 GUI 経路は
  未検証（fake-level の `tests/fixtures/fake-a8n` のみ）。
  `evidence` サブコマンドは AE / GUI 不要で動作する。
- `ae-devtools-cep` の scaffold / validate は static / fake-level の
  証拠のみ。実機 CEP panel load → `evalScript` round trip → reload →
  unload（CAP059）は **UNVERIFIED** で、owned AE session での
  `cep-extension/LOAD-PROOF.md` 手順が前提。UXP（CAP060）は
  **BLOCKED/UNVERIFIED**。`ae-devtools-cep-lifecycle` は OS の CEP
  ディレクトリを既定対象とする machine-level 操作であり、AE 本体は
  起動・設定しない。`--target` / `--log-dir` で退避先を変えられる。
