# Release 0.1.0 — real-host acceptance procedure

> 対象: `release-0-1-0 → main` release PR (#1)、freeze SHA は PR head。
> 本書は **実機 After Effects を要する受入確認だけ** をまとめる。fake/mock
> level の検証は CI (`ci.yml`) と release gate の記録が担い、ここには
> 含めない。全 API の実機確認は release 条件ではない — 下記の最小代表
> シナリオのみを要求する。

## 分離原則（既存 AE への非干渉）

- **owned session のみ**: After Effects の起動・終了は ae-a8n の owned
  session 経路（`experiments/a8n-transport`、`--session a8n`）か、明示的に
  指定した専用 AE インストールで行う。オペレータの interactive session
  には attach しない・quit しない。
- **disposable project のみ**: 証明用プロジェクトは受入のために新規作成し、
  終了後に破棄する。実プロジェクトは開かない。
- **attached は拒否されることを確認済み**: 既に AE が起動している場合、
  ae-a8n は `attached` を返し dispatch 前に拒否する
  （`experiments/a8n-transport/EVIDENCE.md` failure-path 記録）。
  受入中にユーザーが普段の AE を使っていても干渉しない。
- **native plug-in の install 先**: `~/Library/Application Support/Adobe/
  After Effects/<ver>/Plug-ins/` への配置は専用セッション中のみ行い、
  受入後に除去する。ad-hoc 署名の受理可否自体が検証項目
  （`experiments/native-sdk/LOAD-PROOF.md` §2）。

## 受入シナリオ（最小代表）

### A-1. owned-session JSX dispatch（推奨・必須相当）

実機検証済みの縦切りを受入マシンで再現する:

```sh
cd experiments/a8n-transport
node real-run.mjs --ae-a8n-root <ae-a8n checkout>
```

- 期待: owned AE が起動し、consent gate 付き ExtendScript dispatch →
  outcome 分類 → close まで完走。close 後に main `After Effects`
  executable が残らないこと（helper process は別記録）。
- 根拠: `experiments/a8n-transport/EVIDENCE.md` — AE 2026 (26.5.3) /
  AE 2027 (27.0.0) 双方で verified on real host（ae-a8n ローカルビルド
  `be78ca6` 経由）。npm 公開版 ae-a8n での確認は別ゲート。
- 失敗時: `run-*.json` evidence と session trace が workdir に残る。
  原因切り分けは `experiments/a8n-transport/README.md`。

### A-2. NativeProbe plug-in load proof（native adapter の実機ゲート）

`experiments/native-sdk/LOAD-PROOF.md` の手順を専用セッションで実行:

1. `AE_SDK_ROOT=~/Documents/projects/adobe/AeSDK experiments/native-sdk/build-macos.sh`
   で `NativeProbe.plugin` をビルド（SDK は operator-supplied、未 vendored）。
2. 専用 AE セッションで Plug-ins へ配置 → disposable project を開く。
3. 成功信号: AE が生存し、debug log に `probe.start` … `probe.end`
   シーケンス（`app.numProjects`、`project[0].*`、`project.items.*` 等）。
4. 受入後: plug-in を除去し、専用セッションを終了。

現状 **UNVERIFIED**（build 成功・mock-host 563 checks のみ）。ここが
0.1.0 で唯一「実機未確認の中核機能」。失敗は `FAIL`/`BLOCKED` finding
として記録し、ad-hoc 署名を黙って回避しない。

### A-3.（任意）CEP panel load proof

`experiments/cep-extension/LOAD-PROOF.md` — scaffold 生成パネルの
load → `evalScript` round trip → unload。`PlayerDebugMode` は前後記録・
復元。実施しない場合は 0.1.0 の既知の制限として記録済みのまま公開可。

## 受入で確認しないもの（0.1.0 の既知の制限）

- **Windows 全般**: UNVERIFIED（Windows host 不在、Issue #21 の owner
  decision）。
- **GPU / SmartFX / MFR 経路**: `SDK_Invert_ProcAmp` は `metal_common` +
  Boost 不足で BUILD FAILED。Issue #68 で BLOCKED として追跡。
- **全 scripting operation の実機 dispatch**: registry op は
  fake/mock level。実機確認は代表シナリオ A-1 に限定する。
- **npm 公開版 ae-a8n との組合せ**: ローカルビルドのみ検証済み。
- **UXP**: BLOCKED/UNVERIFIED（Adobe released builds の surface 待ち）。

## 記録

受入結果は PR #1 のコメントまたは Issue #21 に、実行したシナリオ・
AE version・結果・証拠ファイルパスを記録する。実機で新たな重大欠陥が
見つかった場合のみ修正 PR を `release-0-1-0` に対して起こし、影響を受ける
検証を新 SHA に再 pin する。
