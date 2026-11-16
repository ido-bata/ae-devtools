# Release 0.1.0 — real-host acceptance procedure

> 対象: `release-0-1-0 → main` release PR (#1)、freeze SHA は PR head。
> 本書は **実機 After Effects を要する受入確認だけ** をまとめる。fake/mock
> level の検証は CI (`ci.yml`) と release gate の記録が担い、ここには
> 含めない。
>
> **実機確認は merge の追加ゲートではない。** 下記シナリオの未実施を
> 理由に merge を止めない — 未検証状態はすべて known limitation として
> PR #1 本文に記録済みであり、0.1.0 の出荷範囲に含まれるのは
> fake/mock・build・contract レベルの成果物である。ユーザーが余裕のある
> 時に実機確認を行い、重大欠陥が見つかった場合のみ対応する。

## 分離原則（既存 AE への非干渉）

- **owned session のみ**: After Effects の起動・終了は ae-a8n の owned
  session 経路（`packages/ae-devtools-cli/a8n-transport`、`--session a8n`）か、明示的に
  指定した専用 AE インストールで行う。オペレータの interactive session
  には attach しない・quit しない。
- **disposable project のみ**: 証明用プロジェクトは受入のために新規作成し、
  終了後に破棄する。実プロジェクトは開かない。
- **attached は拒否されることを確認済み**: 既に AE が起動している場合、
  ae-a8n は `attached` を返し dispatch 前に拒否する
  （`packages/ae-devtools-cli/a8n-transport/EVIDENCE.md` failure-path 記録）。
  受入中にユーザーが普段の AE を使っていても干渉しない。
- **native plug-in の install 先**: `~/Library/Application Support/Adobe/
  After Effects/<ver>/Plug-ins/` への配置は専用セッション中のみ行い、
  受入後に除去する。ad-hoc 署名の受理可否自体が検証項目
  （`experiments/native-sdk/LOAD-PROOF.md` §2）。

## 受入シナリオ（最小代表）

### A-1. owned-session JSX dispatch（実機検証済み経路の再確認・任意）

この縦切りは **既に verified on real host**（macOS、AE 2026/2027、
`packages/ae-devtools-cli/a8n-transport/EVIDENCE.md` runs 3–4、ae-a8n ローカル
ビルド `be78ca6` 経由）。受入マシンでの再実行は任意の spot check で
あり、release 条件ではない:

```sh
cd packages/ae-devtools-cli/a8n-transport
node real-run.mjs --ae-a8n-root <ae-a8n checkout>
```

- 期待: owned AE が起動し、consent gate 付き ExtendScript dispatch →
  outcome 分類 → close まで完走。close 後に main `After Effects`
  executable が残らないこと（helper process は別記録）。
- 未カバー: npm 公開版 ae-a8n での確認は別ゲート（0.1.0 出荷対象外）。
- 失敗時: `run-*.json` evidence と session trace が workdir に残る。
  原因切り分けは `packages/ae-devtools-cli/a8n-transport/README.md`。

### A-2. NativeProbe plug-in load proof（UNVERIFIED・既知の制限）

`experiments/native-sdk/LOAD-PROOF.md` の手順を専用セッションで実行
する場合の手順。**現状 UNVERIFIED** であり、0.1.0 では既知の制限
として記録済み — 実施しなくても merge を妨げない:

1. `AE_SDK_ROOT=~/Documents/projects/adobe/AeSDK experiments/native-sdk/build-macos.sh`
   で `NativeProbe.plugin` をビルド（SDK は operator-supplied、未 vendored）。
2. 専用 AE セッションで Plug-ins へ配置 → disposable project を開く。
3. 成功信号: AE が生存し、debug log に `probe.start` … `probe.end`
   シーケンス（`app.numProjects`、`project[0].*`、`project.items.*` 等）。
4. 受入後: plug-in を除去し、専用セッションを終了。

検証済みの範囲: build 成功（macOS arm64）+ mock-host 612 checks。
plugin load/実行は未確認。失敗は `FAIL`/`BLOCKED` finding として記録し、
ad-hoc 署名を黙って回避しない。

### A-3.（任意）CEP panel load proof

`packages/ae-devtools-cli/cep-extension/LOAD-PROOF.md` — scaffold 生成パネルの
load → `evalScript` round trip → unload。`PlayerDebugMode` は前後記録・
復元。**UNVERIFIED** のまま 0.1.0 の既知の制限として記録済み。

## 0.1.0 の出荷対象外 / 既知の制限（実機確認の対象外）

以下は 0.1.0 に含まれるが、実機・外部環境での成立を一切主張しない
機能・領域。受入シナリオの対象外であり、後続リリースの課題:

- **Windows 全般**: UNVERIFIED（Windows host 不在、Issue #21 の owner
  decision）。
- **GPU / SmartFX / MFR 経路**: `SDK_Invert_ProcAmp` は `metal_common` +
  Boost 不足で BUILD FAILED。Issue #68 で BLOCKED として追跡。
- **UXP plugin lifecycle**: BLOCKED/UNVERIFIED（Adobe released builds
  の surface 待ち、CAP060）。
- **runtime-bridge spike（ADR-0001）**: 実機未実行、ADR は Proposed の
  まま。CEP panel / ExtendScript / node server の spike artifact のみ。
- **npm 公開版 ae-a8n との組合せ**: ローカルビルドのみ検証済み。
- **native-adapter の実 dispatch**: registry 933 ops のうち
  dispatchable は 0（34 implemented-unverified / 876 inventory-only /
  23 unsupported-or-unknown）。実機 dispatch は一切未実装。
- **全 scripting operation の実機 dispatch**: registry op は
  fake/mock level。実機確認は代表シナリオ A-1 の範囲に留める。
- **diagnostics の real-host collectors / recovery-orchestrator の実機
  経路**: pending-real-host / fake-level。

## 記録

受入結果は PR #1 のコメントまたは Issue #21 に、実行したシナリオ・
AE version・結果・証拠ファイルパスを記録する。実機で新たな重大欠陥が
見つかった場合のみ修正 PR を `release-0-1-0` に対して起こし、影響を受ける
検証を新 SHA に再 pin する。
