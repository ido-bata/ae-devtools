# ADR-0018 — ae-a8n 標準復旧への委譲と互換 adapter 撤去（移管マップ）

- Status: **Proposed**
- Date: 2026-11-27
- Issue: [#432](https://github.com/ido-bata/ae-devtools/issues/432)（親 [#425](https://github.com/ido-bata/ae-devtools/issues/425) T001、上流 program [ae-a8n#337](https://github.com/ido-bata/ae-a8n/issues/337) D-INTEGRATION / Plan A）
- 関連:
  - 本リポジトリ [ADR-0005](ADR-0005-ae-execution-boundaries-and-cross-repo-ownership.md) — D2（所有境界）/ D3（capability manifest）/ D7（product-surface ownership）を本 ADR が復旧領域について精緻化する
  - 本リポジトリ [ADR-0004-recovery-checkpoint-model.md](ADR-0004-recovery-checkpoint-model.md) — agent/Git checkpoint は**別責務として維持**（#425 FR 明記）
  - 本リポジトリ [ADR-0016-session-open-and-fake-host-boundary.md](ADR-0016-session-open-and-fake-host-boundary.md) — session-open 単一実装 / fake host 境界
  - ae-a8n [ADR-0005 session supervision](https://github.com/ido-bata/ae-a8n/blob/release-0-7-0/docs/adr/0005-session-supervision.md)（#278 系、addendum #338/#339）
  - ae-a8n [ADR-0006 standard-path anomaly recovery](https://github.com/ido-bata/ae-a8n/blob/release-0-7-0/docs/adr/0006-standard-path-anomaly-recovery.md)（#342）
  - ae-a8n [gui-supervision safety gates](https://github.com/ido-bata/ae-a8n/blob/release-0-7-0/docs/gui-supervision-safety-gates.md)（#338 Stage-0 audit）
  - 上流 contract: ae-a8n [#340](https://github.com/ido-bata/ae-a8n/issues/340)（terminate / verified rebuild 分離）、[#341](https://github.com/ido-bata/ae-a8n/issues/341)（機械可読 nextActions 統合）、[#342](https://github.com/ido-bata/ae-a8n/issues/342)（標準実行経路への異常対応統合）— いずれも `release-0-7-0` に merge 済み・**未 publish**

---

## Status

**Proposed。** 本 ADR は docs/contract の固定であり、コード変更・npm pin 更新・publish を含まない。版番号はすべて **未確定の提案** であり publish 権限を主張しない。

## Context

### 上流契約の確定状況（2026-11-27 時点）

ae-a8n `release-0-7-0` には Plan A の上流 contract が merge 済みである:

| 上流 Issue | 提供する公開契約（`release-0-7-0` の source 根拠） |
| --- | --- |
| #340 | `AfterEffects.terminate(options)` / `AfterEffects.rebuild(options)`（`src/api/index.ts`、`src/api/terminate.ts`、`src/api/rebuild.ts`、`src/driver/host-terminate.ts`、`src/driver/session-rebuild.ts`）。`TERMINATE_PERMIT = "terminate-owned-host"`。rebuild は消失証明後のみ、terminate は認可・所有権・lease・監査・有限期限つきの別経路。`TerminateReport.outcome`（`terminated`/`already-gone`/`survived`/`unproven`）と `phase` を返す |
| #341 | 構造化 `NextAction`（`kind`/`allowed`/`code`/`reason.code`）を `src/supervision/next-actions.ts`、`src/api/errors.ts`（`AeError.nextActions`）、`src/api/envelope.ts`、`supervisionNextActions`（`src/supervision/guidance.ts`）へ統合。runtime 事実・試行済み復旧・証跡・次行動を機械可読に返す |
| #342 | 標準 lifecycle への統合（ae-a8n ADR-0006）: script transport では `HostRecovery` が **opt-out 既定**（`session.recover: false` で解除、`true` は配線不能時に refuse）。`LaunchOptions.expectedModals` + `ae.expectModal(spec)`。trace `result` に `anomaly`（`src/driver/anomaly.ts` の `classifyAnomaly`）と `retryClass`（`classifyOperationRetry`）。復旧試行ごとに `artifacts/recovery-<requestId>.evidence.json`（`ae-a8n.recovery-evidence/v1`、`src/driver/recovery-evidence.ts`）。`ae.diagnostics()`（#336 系、`src/driver/session-diagnostics.ts`） |
| #339 / #338 | 起動前監視（boot monitor）と target attribution の観測契約。supervision monitor lease / durable state（`src/supervision/{state,lease,machine,monitor,wait}.ts`） |

**publish 状況:** `release-0-7-0` の `package.json` は依然 `0.6.0` であり、ae-a8n 0.7.0 は **未 publish**。ae-devtools-cli は `@ido-bata/ae-a8n` を `0.6.0` exact pin している（`packages/ae-devtools-cli/package.json`）。npm exact pin の更新は 0.7.0 publish（human authorization）後の別 ticket であり、本 ADR はその前に契約面を固定する。

### devtools 側の現状

`a8n-transport/supervision.mjs` は durable supervision state（`supervision.json` / `monitor.lease.json`、schema `ae-a8n.supervision/v1`）の **decode / health 再評価 / bounded wait をローカルに port 実装** している。理由は module header に明記されている通り、attached session・post-mortem の session dir・`--ae-a8n-root` build を含む全 reader が、単一の npm pin に依存せず file contract を読めるようにするため。ただしこれは「契約共有は実装共有ではない」（ADR-0005 D2 原則 1）の例外ではなく、**上流が公開 API を提供した後も残す必然性のない複製** である。上流 `release-0-7-0` は `supervisionReport` / `readSupervisionState` / `decodeSupervisionDoc` / `evaluateObservationHealth` / `waitForSupervisionPhase` / `supervisionNextActions` を export しており（`src/supervision/index.ts`）、委譲先が確定した。

同様に `recovery-orchestrator`（Issue #55）と `session-guard.mjs` の reaper は、GUI 観測・dialog 分類・host 生死判定・終了の host 共通部分を ae-a8n の recovery surface（当時 #109/#111）に委譲しつつ、run marker 相関・crash 証拠収集・verdict 語彙を devtools 側に残している。#340/#341/#342 により上流契約が「監視・分類・復旧試行・terminate/rebuild・nextActions」まで拡張されたため、委譲境界をここで固定する。

## Decision

### D1. ADR-0005 D2/D3/D7 の復旧領域への適用（改訂の正本宣言）

ADR-0005 D2/D3/D7 は本 ADR で **復旧・supervision 領域について次のように読み替える**（ADR-0005 本文は変更しない。本文末尾に pointer を追記する）:

- **supervision / GUI 観測・分類・安全な復旧操作・terminate/rebuild・nextActions の canonical owner は ae-a8n**（D2 表「所有権/対象同定」「実行 transport」行、「汎用 GUI 状態観測・モーダル分類・クラッシュ検出・セッション復旧 primitive © ae-a8n」行の延長。#340/#341/#342 でこの領域の上流契約が完成した）。
- **devtools が所有するのは開発者向け意味論のみ**: run marker / residue 記録、CLI/MCP/VSCode 各 surface への verdict・diagnostics・evidence の写像、dispatch 予算、source map、session-kind dispatch、attached session の consent/authorization、開発 checkpoint（ADR-0004）。
- **契約共有は実装共有ではない** は維持するが、**上流が公開 export を持つ複製 decoder/health/wait は「契約面の再実装」ではなく撤去対象** とする（D4）。durable file を直接読む reader（post-mortem、attached、`--ae-a8n-root`）も、pin が契約を満たす限り上流 export 経由で読む。上流 export が存在しない pin に対してのみ、現行の local port を **期限付き互換 adapter** として残す。

### D2. 維持・委譲・削除マップ

判定語彙: **委譲** = 上流公開 API/export を呼び、devtools 側の重複実装を撤去版で削除 / **維持** = devtools 固有の意味論として残す / **削除** = 撤去版で除去 / **条件付** = 上流契約の不足を確認済みのため条件付き。

#### `packages/ae-devtools-cli/a8n-transport/`

| module / 関数 | 判定 | 根拠（上流契約 / devtools 呼出元） |
| --- | --- | --- |
| `supervision.mjs` `decodeSupervisionDoc` / `readSupervisionState` / `evaluateObservationHealth` / `supervisionReport` / `readMonitorLease` / `monitorLeasePath` / `SUPERVISION_*` 定数 | **委譲→削除** | 上流 `src/supervision/{state,lease}.ts` が同名 export を `release-0-7-0` で提供（`src/supervision/index.ts`）。local 実装は header 自身が認める line-for-line port。呼出元: `dev-loop/supervision.mjs`、`recovery-orchestrator/orchestrator.mjs`、`devtools-cli/cli.mjs`（`supervision` サブコマンド）、`failure-record.mjs`（`record.supervision`） |
| `supervision.mjs` `waitForSupervisionPhase` | **条件付委譲** | 上流 `src/supervision/wait.ts` に同名 export があるが、**phase deadline を考慮しない**（`timeoutMs` のみ。`machine.ts` の `DEFAULT_PHASE_DEADLINE_MS` は wait に未接続 — `release-0-7-0` で確認）。devtools 版は phase deadline との小さい方で bound する。上流が phase deadline を契約化するまで、devtools は bounded wait adapter として維持し、契約テストで両方向を固定する（§D5） |
| `supervision.mjs` `supervisionSnapshot` / `needsHumanInfo` / `supervisionEscalation` / `supervisionBlocksClean` / `stricterVerdict` / `sessionDirFor` / `supervisionForSession` / `supportsSupervisionApi` | **維持** | devtools verdict/surface 語彙への写像と pin probe であり、上流に対応物なし。`stricterVerdict`/`supervisionBlocksClean` は diagnostics record の fail-closed 合成規則 |
| `dispatch-budget.mjs` `resolveDispatchBudgets` | **維持** | devtools dispatch 予算（`callTimeoutMs` vs runner `deadlineMs` の対と `deadline <= callTimeout` の USAGE refuse）は dev-loop の dispatch 意味論。#425 FR の「異なるホスト・dispatch・復旧・suite 期限は残余予算を伝達、二重再試行/早すぎる UNKNOWN を防ぐ」はこの module が担う。上流の operation timeout は `ae.call` 内部の話であり代替にならない |
| `launch-stages.mjs` | **維持** | `openSliceSession` の package build / host-script / launch / ready の段階分解（PASS/FAIL/BLOCKED/UNKNOWN）は devtools の launch 診断。上流の launch 内部段階を公開 API としては提供していない |
| `attached-session.mjs` `openAttachedSliceSession` / `ATTACHED_FORBIDDEN_OPS` / `policy.readOnly` / `mutatingOps` / `targetGuard` / `revalidateTarget` | **維持** | devtools の認可意味論（`aeDevtools.trustedEval` のみの grant、op-level mutation scope、project guard、dispatch 前再検証）。ownership 分類（owned/attached/unknown の判定と拒否）は上流 `AfterEffects.attach` が既に権威であり、devtools はその上の consent 層。#342 の標準経路統合は owned session の復旧を対象とし、attached の read-only/確認済み再実行区分は devtools に残る |
| `compat.mjs` `REQUIRED_AE_A8N_CONTRACT` / `missingContractExports` / `aeA8nContractError` / `probeAeA8n`、`contract.mjs` handshake battery | **維持・拡張** | pin/`--ae-a8n-root` 共通の契約 gate。撤去版で 0.7.0 surface（`terminate`/`rebuild`/`expectModal`/`diagnostics`/`supervisionState`/`supervisionNextActions`/supervision exports）を最小要求へ追加する。機構自体は不変 |
| `ae-a8n-resolve.mjs` | **維持** | `--ae-a8n-root` / npm 解決の単一 resolver。変更なし |
| `session.mjs` / `transport.mjs` / `extension.mjs` / `scenario.mjs` / `real-run.mjs` / `attach-target.mjs` | **維持** | 既に ae-a8n 公開 API（`AfterEffects.launch`/`attach`、extension build、`ae.call`）への委譲層。重複 host 判断なし |

#### `packages/ae-devtools-cli/dev-loop/`

| module | 判定 | 根拠 |
| --- | --- | --- |
| `supervision.mjs` | **維持（薄い adapter）** | `a8n-transport/supervision.mjs` の re-export + session 紐付け snapshot。読み取り経路の委譲後も surface 語彙への写像層として残る |
| `session-open.mjs` `openSession` | **維持** | fake/a8n/a8n-attached の canonical kind dispatch（ADR-0016）。CLI/MCP/VSCode の共通入口であり、上流に対応物なし |
| `outcomes.mjs` `failureOutcome` / `wireState` | **維持** | wire uppercase / adapter lowercase / COMPLETED+failed の fail-closed 正規化は devtools の outcome 語彙。#341 の `nextActions` は runtime error への additive 契約であり、これを置き換えない（#341 FR「開発ソースマップ/Outcome は devtools」）。T002 で diagnostics record へ `nextActions` を**参照** として載せるのは可、正本の複製は不可 |
| `failure-record.mjs` | **維持** | `ae-devtools.diagnostics/v1` record への写像。`record.supervision` は上流 snapshot を verbatim で載せる additive 契約のまま |
| `devloop.mjs` / `session-close.mjs` / `surface-guard.mjs` / `real-run-session.mjs` | **維持** | dev-loop orchestration・bounded close・非 CLI surface の run marker。上流に対応物なし |

#### `packages/ae-devtools-cli/devtools-cli/` + `diagnostics/`

| module | 判定 | 根拠 |
| --- | --- | --- |
| `session-guard.mjs` run marker lifecycle（`beginRun`/`markSession`/`endRun`/`recordRequestEvent`/`attachEvidence`/`listRuns`/`noteSessionProcess`） | **維持** | `ae-devtools.cli.run-guard/v1` は devtools の residue 契約。上流に run marker 概念なし |
| `session-guard.mjs` `reapRun` / `findAeProcesses` / `pidLiveness` / `pidAlive` / `processStartStamp` の host 帰属・終了部分 | **委譲→削除（撤去版）** | host の census・生死証明・終了は上流 `AfterEffects.terminate`（`TERMINATE_PERMIT`、`deadlineMs`、`TerminateReport`）+ supervision report + ownership が権威。#340 は「生存 host の停止は別の認可・実行経路」「OS 照会不明は拒否」を契約化済み。devtools reaper の fail-closed 規則（runner 生死・pid reuse・ownership）は marker 解釈として残るが、**AE process の列挙・quit 機構の複製は撤去版で削除**し、上流未到達の pin では reap を refuse（unsupported）にする。post-mortem で marker のみ残り sessionRoot/上流 API に到達できない場合は従来通り refuse — 「読めるが触れない」を維持 |
| `diagnostics.mjs` / `diagnostics/{schema,collectors,source-map}.mjs` | **維持** | `ae-devtools.diagnostics/v1` record・source map 解決・collector registry は devtools の診断意味論（#37/#95/#103/#127）。上流 `ae.diagnostics()`（#336）と `recovery-<id>.evidence.json`（#342）は**証拠源として参照** し、collector が収集対象に追加するのは可だが schema を複製しない。`source-map` は jsx-toolchain 由来の devtools 固有 |

#### `packages/ae-devtools-cli/recovery-orchestrator/`

| module / 部分 | 判定 | 根拠 |
| --- | --- | --- |
| host 共通判定（dialog の press 可否・分類、host gone/unresponsive/modal の解釈、supervision phase の意味） | **委譲** | 既に ae-a8n `HostRecovery.attempt`（#109/#111 系、#342 で標準経路化）と durable supervision report を消費する構造。#342 の `anomaly`/`retryClass`/`expectedModals`/evidence manifest が operation record と trace に載るため、orchestrator は**上流が記録した事実を読む** に留め、自前で window/census を再判定しない。`orchestrator.mjs` が import するのは `a8n-transport/supervision.mjs` の snapshot/escalation 関数のみであり、これは維持側に分類済み |
| crash 証拠相関（`crash-verified`/`crash-suspect`/`crash-unconfirmed` verdict、run marker への crash report 相関） | **維持** | devtools run marker・`session-guard` の request event・postmortem 診断に紐付く開発側相関。上流 `ae.diagnostics()` は host crash report を収集するが、**どの devtools run/request に相関するか** は devtools の証拠束縛（ADR-0017 evidence source binding の系） |
| verdict 語彙（`await-original`/`quarantined`/`refused`/`residue`/`clean`/`crash-*`/`unknown`）と `SCHEMA = ae-devtools.recovery-orchestrator/v2` | **維持** | devtools surface への写像語彙。上流 `nextActions`（kind/allowed/reason.code）を verdict へ**変換して添える** のは T002 の接続作業であり、語彙自体は残る |
| `cli.mjs` の `reap`/`recover` コマンド配線、`diagnostics.mjs` の crashEvidenceToDiagnostics | **維持（配線は T003 で委譲へ張替え）** | コマンド面と diagnostics 変換は devtools。内部の host 操作は上流 API 呼出しへ置き換える |
| 再試行・再送判断 | **委譲（読取）** | in-flight 再送禁止・`retryClass`（`read-only`/`verified-retry`/`unknown-side-effect`）は上流 operation record の契約。devtools は `retryClass`/`anomaly` を読んで surface 判断に使い、独自の resend 規則を持たない |

#### surface 層（`mcp-server/`、`vscode-extension/`、`devtools-cli/cli.mjs`）

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CLI `supervision` / `runs` / `reap` / `diagnose` サブコマンド、MCP tools、VSCode controller | **維持（内部委譲）** | surface は devtools（ADR-0005 D7）。#425 T002/T003 で標準復旧・nextActions への接続と Skill/help/MCP description の同期を行う。parity は T004 の契約テスト対象 |

### D3. reaper / host 帰属 / 終了 と recovery-orchestrator の境界（根拠付き）

**上流へ委譲する部分（host 共通判定）:**

1. **host の生死・帰属**: process census、pid+start stamp、install dir 帰属、ownership（owned/attached/unknown）は ae-a8n の session/transport/ownership 層が権威（ADR-0005 D7「AE 接続・所有権・対象同定・起動/終了/resume © ae-a8n」）。devtools は `recoveryTarget()`/`ownership()`/`attach` の結果を**読む**。
2. **終了（terminate）**: #340 で `AfterEffects.terminate` が「明示許可（`terminate-owned-host`）・専有 GUI/データ・所有権・対象再検証・lease・監査・有限期限・graceful 優先・強制停止は使い捨て環境のみ」を契約化。devtools reaper の「owned + install dir 一致 → AppleScript quit」はこの上流経路の**複製**であり、撤去版で削除する。attached/unknown は上流同様に決して terminate しない。
3. **復旧（rebuild）**: 消失証明後のみ `AfterEffects.rebuild`。devtools は rebuild を直接呼ばず、必要な場合は上流契約経由で要求し、結果（`phase`/transport readiness）を診断に記録する。
4. **異常分類・次行動**: `classifyAnomaly`、trace `result.anomaly`/`retryClass`、`supervisionNextActions`/`NextAction`（kind/allowed/code/reason.code）は上流が正本。devtools diagnostics record はこれらを**参照**し、独自の anomaly 語彙を併記しない（T002）。

**devtools に残す部分（開発固有）:**

1. **run marker / residue 契約**: `ae-devtools.cli.run-guard/v1`、request event（dispatched/timeout/resolved/recovery-attempted）、surface 別 marker。上流に対応物なし。
2. **クラッシュ証拠相関**: crash report を devtools run/request/marker に相関付ける postmortem 判定（`crash-verified` 等）。上流 diagnostics は収集、相関は devtools。
3. **タスク/開発ループ復旧**: fixture 復元・suite 継続・「元 FAILED/UNKNOWN と開発 Outcome を混同しない」写像は ae-test/ae-devtools の責務（#341 FR、#425 AC）。
4. **consent/authorization 層**: attached session の op scope、trusted-execution consent、run marker の attestation 要求（`ATTESTATION_SOURCE`）。上流の所有権証明を前提に devtools が追加する開発者向け gate。

**境界判定に使った根拠:** ADR-0005 D7 表の「汎用 GUI 状態観測・モーダル分類・クラッシュ検出・セッション復旧 primitive © ae-a8n / devtools ⊕（#55 はこの範囲に再スコープ）」行。#55 の再スコープは「primitive を自前実装しない」ことであり、本 ADR はその具体化である。#340 の「rebuild.ts に kill/terminate を混ぜない」「停止→消失証明→rebuild」の分離は、devtools が terminate と rebuild を**別々の認可で**呼ぶ設計を要求する — devtools は両者を 1 つの "recover" 操作に潰さない。

### D4. 互換 adapter 撤去版と ae-a8n 最小要求版（提案・未確定）

| 項目 | 提案値 | 状態 |
| --- | --- | --- |
| 撤去対象を含む devtools release | **ae-devtools-cli 0.9.0**（現行 train `release-0-9-0`、package version は現時点 0.8.0） | **提案**。実装開始時に競合・上流 contract 変更があれば代替版を #425/本 ADR に記録して確定する |
| ae-a8n 最小要求版 | **`@ido-bata/ae-a8n` 0.7.0 以降を exact pin** | **提案・未確定**。0.7.0 は未 publish（`release-0-7-0` の package.json は 0.6.0）。publish は human authorization であり、本 ADR は pin 更新を要求しない。publish 後に実在を確認してから exact pin を確定する |
| 撤去の完了条件 | 撤去版のリリース受入で §D6 の機械的チェックが PASS すること | **期限付き別 ticket を置くだけでは撤去版を PASS にしない**（#425 FR 明記） |
| 暫定 adapter | `waitForSupervisionPhase` の phase-deadline bound のみ（§D2 条件付）。その他の複製 decoder/health/wait に暫定 adapter は認めない | 上流 contract が phase deadline を提供した時点で削除。終了版は撤去版（0.9.0 提案）に固定 |
| 旧 local build / 旧 pin | `compat.mjs` の契約 gate が refuse（unsupported）。上流提供の読取互換（durable file の decode）が必要な場合のみ、schema version 検証つきの read-only fallback を認める — **write/press/terminate 経路の fallback は認めない** | #425 FR「旧 local build は明示 unsupported または上流提供の読取互換に限る」 |

### D5. 退行防止の契約テスト観点（T004 へ引き継ぐ固定項目）

撤去・委譲で退行させてはならない契約を、実装 ticket の契約テスト項目として列挙する:

1. **phase deadline**: supervision wait は `min(呼出側 timeout, phase deadline)` で必ず有限終了する。`needs-human`/`quarantined`/`monitor-lost`/`unavailable` は構造化結果で解決し、無期限 wait を生まない（ae-a8n ADR-0005 §4、devtools `waitForSupervisionPhase` 現行仕様）。上流 `wait.ts` が phase deadline を持たない現状では、adapter がこの bound を維持することをテストで固定する。
2. **終了済み session**: close 済み・sessionRoot 削除済み・monitor 死亡の session に対し、supervision 読取は `unavailable`/`monitor-lost` を返し healthy を捏造しない。terminate/rebuild は終了済み session で refuse する（上流契約）。devtools surface はその refuse を FAILED/REFUSED として正直に写像する。
3. **`--ae-a8n-root`**: local build は npm pin と**同一の export 契約**で判定される（`probeAeA8n`/`missingContractExports`）。root build が最小要求未満なら構造化 refuse。root と npm で判定が分岐しないことを parity テストで固定する。
4. **schema 互換**: supervision doc の未知/future `schemaVersion` は `unavailable`（healthy に fold しない）。`ae-devtools.diagnostics/v1`・`ae-devtools.cli.run-guard/v1`・`ae-devtools.recovery-orchestrator/v2` の version は exact-match で、未知 version を coerce しない（`diagnostics/schema.mjs` の既存不変条件を維持）。
5. **UNKNOWN / late result**: in-flight request の再送禁止、`retryClass=unknown-side-effect` の非再送、late result の authoritative 扱いは上流契約の読取であり、devtools が独自に resend/早期 UNKNOWN 化しない。`dispatch-budget` の `deadline <= callTimeout` USAGE refuse を維持する。
6. **fail-closed 写像**: `monitor-lost`/`degraded`/`unavailable` health、attestation なし marker、attached/unknown host はいずれも recover/reap の対象にしない（現行 `session-guard`/`orchestrator` の refuse 規則を撤去後も維持）。

### D6. 撤去を確認する機械的チェック（不在確認）

撤去版の受入で以下を機械的に確認する（T004 で契約テスト or `scripts/` チェックとして実装）:

1. **複製 decoder/health/wait の不在**: `packages/ae-devtools-cli` 内で `decodeSupervisionDoc` / `readSupervisionState` / `evaluateObservationHealth` / `supervisionReport` / `readMonitorLease` / `waitForSupervisionPhase` の**実装**（import ではなく関数本体・schema validation ロジック）が `@ido-bata/ae-a8n` 以外に存在しないこと。具体的には `rg` でこれらの識別子を検索し、残存が (a) `@ido-bata/ae-a8n` からの import/re-export、(b) `waitForSupervisionPhase` の phase-deadline adapter（上流 contract 提供までの期限付き例外、§D4）に限定されること。
2. **schema 文字列の単一性**: `ae-a8n.supervision/v1` の decode/validation ロジック（`supervision.json` の parse + field 検査）が `a8n-transport/supervision.mjs` から除去され、file path 定数（`SUPERVISION_STATE_FILE` 等）の re-export のみ残ること。
3. **reaper の host 操作不在**: `session-guard.mjs` に AE process への signal/quit を発行するコード（`osascript` quit、`taskkill`、`kill` の AE 対象呼出し）が存在しないこと。残存する process 検査は read-only census に限定されるか、上流 API 呼出しに置き換わっていること。
4. **pin の一致**: `packages/ae-devtools-cli/package.json` の `@ido-bata/ae-a8n` が exact pin で `>=0.7.0`（実在確認後の確定版）であり、`compat.mjs` の `REQUIRED_AE_A8N_CONTRACT` が 0.7.0 surface を要求すること。
5. **parity**: CLI/MCP/VSCode の 3 surface が同一の supervision/nextActions/outcome を返す契約テスト（#425 T004 AC）。

## Consequences

### Positive

- devtools の複製 decoder/health/wait・reaper の host 操作複製が撤去版で消え、supervision/recovery の正本が ae-a8n 単一になる。CLI/MCP/VSCode が同じ runtime 事実を読む（#425 US-A1/A4）。
- `nextActions`・`anomaly`/`retryClass`・evidence manifest を devtools が**再定義せず参照** するため、surface 間の語彙ずれと「Skill 未読込 agent の次行動判断」欠落（US-A4）が構造的に解消される。
- 期限・UNKNOWN・再送の不変条件が上流契約に一元化され、devtools 独自の早すぎる UNKNOWN/二重再試行リスクが減る。

### Negative

- 上流 0.7.0 が未 publish のため、撤去版は publish + human authorization を待つ。待機中は local port と上流 export の**二重経路**が併存し、pin によって読む実装が変わる期間がある — `supportsSupervisionApi` probe と §D5-3 の parity テストで誤読を防ぐ。
- `waitForSupervisionPhase` の phase-deadline は上流に無い契約差分であり、adapter 維持の終了条件（上流 contract 化 or 撤去版での許容判断）を #425 T003/T004 で確定する必要がある。
- post-mortem/attached/`--ae-a8n-root` の reader は pin 非依存を要求してきた経緯があり、全 reader を npm export 経由に揃えると「その pin が読めない session dir」の扱いを fail-closed で再確認する必要がある（§D4 の読取互換 fallback 範囲）。

### Neutral

- 本 ADR は Proposed であり、コード変更を含まない。検証レベルは `implemented`（docs/ADR）— マップの正しさは後続 T002〜T004 の契約テストで検証される。

## Open questions

1. **撤去版の確定**: ae-devtools-cli 0.9.0 提案が train 進行でずれた場合、または上流最小版が 0.7.0 以外になる場合は、実装開始時に #425/本 ADR へ代替版を記録する（#432 スコープ）。
2. **phase-deadline の上流 contract 化**: ae-a8n `waitForSupervisionPhase` へ phase deadline を入れるか、devtools adapter を恒久化するかは上流 owner との調整事項。devtools 側はどちらでも §D5-1 を満たす実装を選ぶ。
3. **読取互換 fallback の範囲**: post-mortem session dir を「pin が契約未満でも読める」範囲をどこまで認めるか（schema version 検証つき decode のみか、health 再評価も含むか）は T003 の実装判断。write/press/terminate は fallback 対象外で確定。
4. **recovery-orchestrator の存続形**: host 共通判定を全委譲した後、orchestrator が残るのは verdict 写像 + crash 相関 + CLI 配線のみになる。module を残すか surface 層へ畳むかは T003 で判断（本 ADR は削除を決めない）。

## Evidence

### internal — ae-devtools（`release-0-9-0`、access 2026-11-27）

- `packages/ae-devtools-cli/a8n-transport/supervision.mjs` — local decoder/health/wait port の header と export 一覧。
- `packages/ae-devtools-cli/a8n-transport/{dispatch-budget,launch-stages,attached-session,compat,ae-a8n-resolve,session}.mjs` — 各 module header。
- `packages/ae-devtools-cli/dev-loop/{supervision,session-open,outcomes,failure-record,devloop,session-close,surface-guard,real-run-session}.mjs`。
- `packages/ae-devtools-cli/devtools-cli/{session-guard,diagnostics,cli}.mjs`、`packages/ae-devtools-cli/diagnostics/{schema,collectors,source-map}.mjs`。
- `packages/ae-devtools-cli/recovery-orchestrator/{orchestrator,cli,diagnostics}.mjs`。
- `packages/ae-devtools-cli/package.json` — `@ido-bata/ae-a8n: 0.6.0` exact pin、version 0.8.0。
- [ADR-0005](ADR-0005-ae-execution-boundaries-and-cross-repo-ownership.md) D2/D3/D7、[ADR-0004](ADR-0004-recovery-checkpoint-model.md)、[ADR-0016](ADR-0016-session-open-and-fake-host-boundary.md)、[ADR-0017](ADR-0017-evidence-source-binding.md)。

### external — ae-a8n `release-0-7-0`（access 2026-11-27、未 publish）

- `src/supervision/index.ts` — export 一覧（`decodeSupervisionDoc`/`evaluateObservationHealth`/`readSupervisionState`/`supervisionReport`/`waitForSupervisionPhase`/`supervisionNextActions`/lease/machine/monitor）。
- `src/supervision/wait.ts` — `waitForSupervisionPhase` が `timeoutMs` のみで phase deadline を見ないこと（`DEFAULT_PHASE_DEADLINE_MS` は `machine.ts`）。
- `src/supervision/guidance.ts` / `next-actions.ts` — `NextAction`（kind/allowed/code/reason.code）と `supervisionNextActions`。
- `src/api/index.ts` / `types.ts` / `terminate.ts` / `rebuild.ts` — `AfterEffects.terminate`/`rebuild`/`expectModal`/`diagnostics`/`supervisionState`、`TERMINATE_PERMIT`、`TerminateReport`。
- `src/driver/anomaly.ts`、`src/driver/recovery-evidence.ts`、`src/driver/session-diagnostics.ts` — #342 の anomaly/retryClass/evidence manifest/diagnostics。
- [ADR-0005](https://github.com/ido-bata/ae-a8n/blob/release-0-7-0/docs/adr/0005-session-supervision.md)（addendum #338/#339）、[ADR-0006](https://github.com/ido-bata/ae-a8n/blob/release-0-7-0/docs/adr/0006-standard-path-anomaly-recovery.md)、[gui-supervision-safety-gates.md](https://github.com/ido-bata/ae-a8n/blob/release-0-7-0/docs/gui-supervision-safety-gates.md)。
- Issues [#340](https://github.com/ido-bata/ae-a8n/issues/340)/[#341](https://github.com/ido-bata/ae-a8n/issues/341)/[#342](https://github.com/ido-bata/ae-a8n/issues/342)/[#337](https://github.com/ido-bata/ae-a8n/issues/337)。
- `package.json` version `0.6.0` — 0.7.0 未 publish の確認。

## References

- ae-a8n program: https://github.com/ido-bata/ae-a8n/issues/337
- 本 repo program: https://github.com/ido-bata/ae-devtools/issues/425
