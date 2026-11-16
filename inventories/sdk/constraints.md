# CAP012 — AE SDK 26.5 制約レコード

- Issue: [#10](https://github.com/ido-bata/ae-devtools/issues/10) / CAP012
- 対象: After Effects SDK 26.5、macOS 配布
- 証拠レベル: **source-reviewed**（ヘッダー読解のみ）
- Status: **Provisional**。ここに書いた内容は実機検証ではない。

この文書は「ヘッダーに何が書かれているか」だけを記録する。実機で何が起きるかは
#17–#19 の担当であり、本 Issue では一切実行していない。

出典は `ファイル:行` で示す。行番号は SDK 26.5 の macOS 配布ヘッダーに対応する。

## 1. 読み方の前提 — 証拠の非対称性

| 対象 | 証拠の種類 | 状態 |
| --- | --- | --- |
| macOS | ヘッダー本文 + 配布物の実在 | source-reviewed |
| Windows | ヘッダー内の `#if defined(_WIN32)` 分岐**のみ** | **UNVERIFIED** |
| 実機挙動（両 OS） | なし | **未検証** |

本 Issue の配布物は **macOS 版のみ**である。Windows 用ヘッダーは手元に無く、
Windows 固有の値・レイアウト・制約は「macOS 版ヘッダーに現れる分岐」以上のことは
言えない。以下の Windows 記述はすべて **UNVERIFIED** として扱うこと。

## 2. ABI

### 2.1 固定幅の基本型

`A.h:40-70` が基本型を定義する。プラットフォームで分岐するが、幅は固定されている。

| 型 | macOS (GCC/Clang) | Windows (MSVC) |
| --- | --- | --- |
| `A_short` / `A_u_short` | `int16_t` / `uint16_t` | `short` / `unsigned short` |
| `A_u_char` / `A_Boolean` | `uint8_t` | `unsigned char` |
| `A_intptr_t` | `intptr_t` | `__int64`（`_WIN64`）/ `int32_t` |
| `A_u_longlong` | `uint64_t` | `unsigned __int64` |

`A_FpLong` は `double`、`A_FpShort` は `float`、`A_Err` は `A_long`（`A.h:40-43`）。
つまり浮動小数点と誤りコードの幅は両 OS で共通。

### 2.2 構造体パッキング

パッキングは**ヘッダーごとに異なる**。一律ではない。

| ヘッダー | 指示 | 出典 |
| --- | --- | --- |
| `adobesdk/config/PreConfig.h` | `#pragma pack(push, AdobeSDKExternalAlign, 8)` — 8 バイト整列 | `adobesdk/config/PreConfig.h:6` |
| `adobesdk/config/PostConfig.h` | `#pragma pack(pop, AdobeSDKExternalAlign)` | `adobesdk/config/PostConfig.h:2` |
| `AE_IO.h` | `#pragma pack(push, CoSAalign, 2)` / `pop` | `AE_IO.h:369`, `AE_IO.h:384` |
| `PR_Public.h` | `#pragma pack(push, 4)` / `pop` | `PR_Public.h:64`, `PR_Public.h:385` |
| `PF_Masks.h` | `#pragma pack(push, 2)` / `pop` | `PF_Masks.h:11`, `PF_Masks.h:44` |

`AE_Effect.h` は `PreConfig.h` を include する（`AE_Effect.h:87`）ため、効果プラグイン側の
公開構造体は既定で 8 バイト整列になる。**独自の `#pragma pack` を挟むと ABI が壊れる**。
これはヘッダーの指示から読める事実であり、実機で確認したものではない。

### 2.3 バージョン交渉

プラグインは自身が期待する API 版を PiPL に書き、ホストは `PF_SpecVersion` で応答する
（`AE_Effect.h:175-180`、`AE_Effect.h:1305-1309` の `PF_SpecVersion` 定義）。
現行値は `AE_EffectVers.h:4-13`:

- `AEFX_API_VERSION` = 8
- `PF_PLUG_IN_VERSION` = 13、`PF_PLUG_IN_SUBVERS` = 29

`AE_EffectVers.h:10-11` のコメントは、このファイルが PiPL 生成側（`AEFX_PiPL.r`）からも
include され、値が**両側で一致している必要がある**と述べている。つまり版番号は
ABI の一部として扱われている。

## 3. macOS と Windows の差

### 3.1 ヘッダーが明示している差

| 項目 | 内容 | 出典 | 状態 |
| --- | --- | --- | --- |
| OS マクロ | `AE_OS_WIN` / `AE_OS_MAC` / `AE_OS_IOS` / `AE_OS_ANDROID` / `AE_OS_APPLE_SIM` | `AEConfig.h:53-78` | source-reviewed |
| 未認識プラットフォーム | `#error "unrecognized AE platform"` で**コンパイルを止める** | `AEConfig.h:77-78` | source-reviewed |
| ピクセル順序 | 「Mac では常に ARGB、Windows では BGRA（現状）」 | `AE_Hook.h:69` | source-reviewed（ヘッダーの主張） |
| エンディアン | 「PowerPC Mac は BIG、x86 は little」／ファイル形式は big endian 固定 | `AEConfig.h:37-48` | source-reviewed |
| プロセッサ分岐 | `AE_PROC_PPC` / `AE_PROC_INTEL`、SSE 系は実行時判定 | `AEConfig.h:27-28` | source-reviewed |
| 命令セット前提 | 「最低要件は Pentium4 なので SSE2 は前提してよい」 | `AEConfig.h:34` | source-reviewed（Windows 前提の記述） |

### 3.2 構造的な非対称

- `AEConfig.h:53` は `_WIN32` を、`AEConfig.h:55` は `__GNUC__ && __MACH__` を見る。
  分岐は**コンパイル時の 1 択**であり、両方を同時に満たす構成は想定されていない。
- `SP/SPRuntme.h:263` の `SPResolveLinkProc` は `#if defined(WIN_ENV)` の中だけに存在する。
  つまり PICA ランタイムの手続き表は **OS ごとに形が違う**（`SP/SPRuntme.h:255-320`）。
- アーキテクチャ分岐は `__i386__` / `__x86_64__` / `__arm64__` / `_M_ARM64` を見る
  （`AEConfig.h:80-86`）。macOS の Apple Silicon は `__arm64__` 経路。

### 3.3 言えないこと

- Windows 版 SDK のヘッダーが同一かは**未確認**（macOS 配布しか手元に無い）。
- 上表の「ARGB / BGRA」はヘッダーのコメントであって、実機のピクセル順を測ったものではない。
- Windows でのパッキング既定値は、macOS 版ヘッダーの分岐からは決まらない。
- **AE 2026（26.5.3）と 2027（27.0.0）の差は検証していない。** 記録しない。

## 4. CPU / GPU

### 4.1 GPU フレームワーク

`PF_GPU_Framework` は 5 値を取る（`AE_Effect.h:2499-2505`）:

`NONE` / `OPENCL` / `METAL` / `CUDA` / `DIRECTX`

`PF_CUDAVersion` は 12080（`AE_EffectGPUSuites.h:47`）。`PF_GPUDeviceInfo` の
`devicePV` は「CUdevice / cl_device_id / MTLDevice / ID3D12Device」のいずれかであると
コメントされている（`AE_EffectGPUSuites.h:58`）。つまり**デバイスハンドルの型は
フレームワークごとに違う**。

### 4.2 GPU デバイスへの排他アクセス

`kPFGPUDeviceSuite`（`AE_EffectGPUSuites.h:49`、`frozen in AE 16.0`）が
`AcquireExclusiveDeviceAccess` / `ReleaseExclusiveDeviceAccess` を提供する
（`AE_EffectGPUSuites.h:94-96`）。ヘッダーのコメントは、フル GPU プラグインでは
**排他アクセスを常に保持する**と述べている（`AE_EffectGPUSuites.h:90`）。

さらに CUDA については `cuCtxPushCurrent` / `cuCtxPopCurrent` でコンテキストを
管理せよと明記されている（`AE_EffectGPUSuites.h:92`）。これは**スレッドと
GPU コンテキストが結合している**ことを示す。

### 4.3 GPU レンダのコマンド

GPU 経路には専用の selector がある: `PF_Cmd_SMART_RENDER_GPU`、
`PF_Cmd_GPU_DEVICE_SETUP`、`PF_Cmd_GPU_DEVICE_SETDOWN`（`AE_Effect.h:1284-1286`）。
これらは通常の `PF_Cmd_RENDER` とは別経路であり、**同じプラグインでも
呼ばれるコマンド列が変わる**。

### 4.4 未確認

- 実際にどの GPU が使えるか、`compatibleB` が何を基準に立つかはヘッダーからは決まらない。
- macOS で METAL と OPENCL のどちらが選ばれるかは**未検証**。
- GPU 経路の実動作は #18 の担当。

## 5. threading

### 5.1 明示されている規則

`PF_OutFlag2_SUPPORTS_THREADED_RENDERING`（`AE_Effect.h:940`）の説明が最も具体的:

- UI selector は**常にメインスレッド**（`AE_Effect.h:944`）
- `Sequence Setup` / `Sequence Resetup` / `Sequence SetDown` / `PreRender` / `Render` は
  **複数スレッドで同時に**呼ばれ得るため、これらは thread-safe でなければならない
  （`AE_Effect.h:944-946`）
- `Global Setup` / `Global Setdown` は**フラグに関係なくメインスレッドのみ**で、
  他の selector と同時に呼ばれない（`AE_Effect.h:948-949`）
- `sequence_data` は**レンダ時読み取り専用**で、`in_data->sequence_data` は
  レンダ中 `NULL`（`AE_Effect.h:954-956`）
- レンダ時に書き込みたい場合は `PF_EffectSequenceDataSuite` か
  `AEGP_ComputeCacheSuite` を使う。後者は**複数スレッドが同じ値を再計算しない**ように
  キャッシュを統合する（`AE_Effect.h:955-958`）
- それでも足りない場合のみ `PF_OutFlag2_MUTABLE_RENDER_SEQUENCE_DATA_SLOWER`
  （`AE_Effect.h:960-963`）。ただしその変更は**フレーム群の描画ごとに破棄される**。

### 5.2 13.5 での分離

ヘッダーは複数箇所で「13.5 で UI スレッドとレンダスレッドが分離した」と述べている
（`AE_Effect.h:742`、`AE_Effect.h:790`、`AE_GeneralPlug.h:5765`）。したがって
13.5 より前の前提（UI とレンダが同一スレッド）で書かれたコードは**そのままでは
成立しない**。これは版依存の制約であり、対象版を明示する必要がある。

### 5.3 無効化されているフラグ

`PF_OutFlag2_I_AM_THREADSAFE` と `PF_OutFlag2_AE13_5_THREADSAFE` は、いずれも
コメントに `(unused)` と付いている（`AE_Effect.h:1018`、`AE_Effect.h:1035`）。
**これらを立てても効果は無い**と読める。実効的なのは
`PF_OutFlag2_SUPPORTS_THREADED_RENDERING` の方。

### 5.4 未確認

- 実際のスレッド数、スケジューリング、レイテンシは未検証。
- MFR（下記）との相互作用は、ヘッダーに記述が見当たらないため**不明**。

## 6. MFR（multi-frame rendering）

### 6.1 ヘッダーに何があるか — 正直な記載

**MFR という語は `Examples/Headers` に存在しない。** `multi-frame` / `MFR` を
全ヘッダーに対して検索した結果、ヒットするのは次の 1 箇所のみ:

- `AEGP_OutputModuleSuite4` の `AEGP_GetExtraOutputModuleInfo` が返す
  `A_Boolean* multi_frameBP`（`AE_GeneralPlug.h:3842`）

これは**出力モジュールがマルチフレーム出力かどうかを問い合わせるフラグ**であり、
MFR（複数フレームの同時レンダ）そのものの API ではない。

### 6.2 関連するが同一ではない機構

ヘッダーに実在する非同期機構は以下。MFR と混同しないこと。

| 機構 | 出典 | 何をするか |
| --- | --- | --- |
| `AEGP_RenderAndCheckoutLayerFrame_Async` | `AE_GeneralPlug.h:5687` | レイヤフレームを非同期に要求し `AEGP_AsyncRequestId` を得る。キャンセル可 |
| `AEGP_AsyncFrameReadyCallback` | `AE_GeneralPlug.h:5650` | 上記の完了通知 |
| `AEGP_RenderAsyncManagerSuite1` | `AE_GeneralPlug.h:5766-5800` | 非同期要求をまとめて管理。古い要求を自動キャンセル |
| マルチマシン描画の注意 | `AE_GeneralPlug.h:4785` | 出力ファイルを予約すると複数マシン描画が失敗し得る |

`AE_GeneralPlug.h:5765` のコメントは、AsyncManager が 13.5 以降
`PF_EffectCustomUISuite2` の `PF_GetContextAsyncManager` 経由でしか得られず、
**`PF_Event_DRAW` 専用**であると述べている。つまりこれは UI 描画用の非同期機構であって、
MFR のレンダ経路ではない。

### 6.3 結論

- MFR の制約は**このヘッダー群からは記述できない**。記述が無いことを記述する。
- MFR の実体（対応版、設定、複数フレーム同時実行の規則）は
  **未確認**であり、SDK ヘッダー以外の一次資料（Adobe 公式ドキュメント）を
  別途当たる必要がある。
- 本 Issue では推測を書かない。CAP043（#18）の調査項目として送る。

## 7. 署名 / 配布

### 7.1 ヘッダーに書かれていないこと

`sign` / `notariz` / `codesign` / `entitle` を全ヘッダーに対して検索したが、
**署名や公証に関する記述は無い**。したがって以下は**未確認**:

- macOS でのコード署名・公証の要否
- Windows での Authenticode 署名の要否
- 配布時の Gatekeeper / SmartScreen の扱い

これらは SDK ヘッダーではなく、Adobe の配布ガイドラインと OS の要件に属する。

### 7.2 ヘッダーから読める配布境界

- プラグインは PiPL リソースで自身を登録する（`AE_Effect.h:178`、`AE_Effect.h:364`）。
  PiPL には版情報・フラグが入り、`PF_OutFlag_PiPL_OVERRIDES_OUTDATA_OUTFLAGS` のように
  **PiPL 側の値が実行時の値を上書きする**ものもある（`AE_Effect.h:795-797`）。
- `AEGP_PLUGIN_TYPE 'AEgx'`（`AE_GeneralPlug.h:54`）と
  `AEGP_INITFUNC_MAJOR/MINOR_VERSION`（`AE_GeneralPlug.h:56-57`）が
  AEGP プラグインの識別子と初期化版を定める。ホストはこれで互換性を判断する。
- ヘッダーの再配布については、**ライセンス許諾が配布物に含まれていない**。
  詳細は `provenance.json` と `README.md` を参照。本リポジトリは
  ヘッダー本文もシンボル一覧も公開しない。

### 7.3 未確認

署名・公証・インストーラ要件はすべて**未検証**。CAP040（#17）で実機の
インストール / 再起動 / アンロード経路と併せて確認する項目として送る。

## 8. 版の食い違い（重要）

ヘッダーが言及する最新の AE 版は **26.3**（`AE_GeneralPlug.h:890`、
`kAEGPCompSuiteVersion13 27 /* frozen in AE 26.3 */`）。26.x の言及は
26.0 / 26.2 / 26.3 のみ。

一方、手元の参照インストールは:

| アプリ | バージョン | 出典 |
| --- | --- | --- |
| Adobe After Effects 2026 | **26.5.3** | `Info.plist` の `CFBundleShortVersionString` |
| Adobe After Effects 2027 | **27.0.0** | 同上 |

つまり **SDK 26.5 のヘッダーは 26.3 までしか名指ししていない**。26.4 / 26.5 で
suite が追加された形跡は、少なくともこのヘッダー群のコメントからは読めない。
この差が実害を持つかは**未検証**であり、#17–#19 で確かめるべき点として記録する。

## 9. この文書が言っていないこと

- 実機 AE での動作（一切実行していない）
- Windows 配布のヘッダー内容
- AE 2026 と 2027 の挙動差
- MFR の実際の規則
- 署名・公証の要件
- GPU 経路が実際に有効化される条件

いずれも **unknown** であり、判明した時点でこの文書を更新する。
