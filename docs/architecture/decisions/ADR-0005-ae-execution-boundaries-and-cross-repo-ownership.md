# ADR-0005 — AE実行境界と cross-repository 責務（CAP017–CAP020）

- Status: **Proposed**
- Date: 2026-11-12
- Issue: [#12](https://github.com/ido-bata/ae-devtools/issues/12)（CAP017–CAP020）
- 関連:
  - 本リポジトリ [ADR-0001-runtime-bridge.md](../ADR-0001-runtime-bridge.md)（**Proposed**。本 ADR はその昇格条件を変更しない）
  - 本リポジトリ [vision.md](../../vision.md)（未確定事項を本 ADR で先取りしない）
  - ae-a8n [ADR-0001 bridge transport](https://github.com/ido-bata/ae-a8n/blob/main/docs/adr/0001-bridge-transport.md)（**Accepted**。現行 shipped transport）
  - ae-a8n [ADR-0003 execution modes](https://github.com/ido-bata/ae-a8n/blob/97/docs/adr/0003-ae-execution-modes.md)（**Proposed**。[PR #100](https://github.com/ido-bata/ae-a8n/pull/100)）
  - ae-a8n [static extension contract](https://github.com/ido-bata/ae-a8n/blob/main/specs/isolated-ae/contracts/extensions.md)
  - ae-test [dependency policy](https://github.com/ido-bata/ae-test/blob/main/docs/dependency-on-ae-a8n.md)、ae-farm [README](https://github.com/ido-bata/ae-farm/blob/main/README.md)
  - ae-devtools §6 capability spec の [spec.md](https://github.com/ido-bata/ae-devtools/blob/6/specs/ae-capability-coverage/spec.md) / [plan.md](https://github.com/ido-bata/ae-devtools/blob/6/specs/ae-capability-coverage/plan.md)（branch `6`）

---

## Status

**Proposed。** 本 ADR は transport や実行方式を **確定しない**。
4 リポジトリ（ae-devtools / ae-a8n / ae-test / ae-farm）をまたぐ決定であり、実機 evidence と
各 owner の承認が揃わない限り Accepted には昇格しない（§D6 参照）。

---

## Context

ae-devtools は developer tooling を、ae-a8n → ae-test → ae-farm は自動化系列を所有する。
両者は現在 **transport の第一候補が一致していない**:

| 主体 | 主張 | Status | 引き合いに出される根拠 |
| --- | --- | --- | --- |
| ae-devtools [ADR-0001](../ADR-0001-runtime-bridge.md) | CEP 12 panel + `CSInterface.evalScript` + 外部 daemon | **Proposed** | 実機検証は未実施（2026-09-18 時点で AE 非搭載環境）。Accepted 条件は **Windows gate W1–W7** |
| ae-a8n [ADR-0003](https://github.com/ido-bata/ae-a8n/blob/97/docs/adr/0003-ae-execution-modes.md) | AE 内 ES3 dispatcher（`app.scheduleTask` polling）を第一仮説、Apple Event / `AfterFX.exe -r` は compatibility fallback | **Proposed**（[PR #100](https://github.com/ido-bata/ae-a8n/pull/100)）。ただし現行 shipped は ADR-0001 の file-envelope OS-script | macOS 実機観測: TCC 帰属が Ghostty に割り当てられ `-1743`（[ae-a8n #95](https://github.com/ido-bata/ae-a8n/issues/95)、Aulymo #332）。#98 の fake dispatcher は read-only `app.version` のみ |
| ae-a8n [ADR-0001](https://github.com/ido-bata/ae-a8n/blob/main/docs/adr/0001-bridge-transport.md) | file-envelope OS-script transport（`AfterFX.exe -r` / `osascript DoScriptFile` + rename publication） | **Accepted** | macOS AE 26.5x89 で実機確認済み。Windows `AfterFX.exe -r` は **実機未検証**（「not verified here」と明記） |

現行の実装事実として、ae-a8n は Accepted な file-envelope transport を持ち、ae-devtools は何も
実装していない（ADR-0001 の W1–W7 は一度も実施されていない）。すべての実機検証はまだ先である。

## Decision

以下の区切りを決める。各項は「決定」と「Open」に分け、決定していないものは決定していないと明示する。

### D1. 実行境界は 2 層に分離する（CAP017 の一部、R2）

ae-a8n ADR-0003 が定義する分離を **cross-repo の共通語彙として採用する**:

| 層 | 意味 | 頻度 | 例 |
| --- | --- | --- | --- |
| **bootstrap** | AE 側コンポーネントの導入・有効化と OS/Adobe 権限の付与 | 1 回（または AE 再インストール時） | panel インストール、Startup Scripts 登録、`Allow Scripts to Write Files and Access Network` の有効化、TCC 同意、`.zxp` 署名検証 |
| **per-operation dispatch** | 個々の操作の配送 | 毎回 | `evalScript`、`app.scheduleTask` ポーリングでの要求取得、Apple Event、envelope の送受信 |

**決定:** すべての transport 候補の評価・比較はこの 2 層で独立に行う。ae-devtools plan §3 の
execution class（scripting read/write、native、CLI）は dispatch 層の内訳であり、bootstrap 層と
混同しない。ADR-0001（devtools）の「panel はユーザーが `Window > Extensions` から読み込む」
（bootstrap）と「`evalScript` を request/response で撃つ」（dispatch）が、この区切りに乗る。

**理由:** ae-a8n ADR-0003 は「bootstrap は `sudo` / cross-user `launchctl` / `osascript` permission
prompt を要求してもよいが、per-operation dispatch は要求しない」という合格条件を既に定式化しており、
これは transport 非依存の良い性質である。devtools 側の CEP 評価も同じ軸で測られるべきで、
「CEP は panel インストールという bootstrap 手数が増える」という評価は、dispatch 層の
評価（`evalScript` の serializability、callback、main-thread 制約）から切り離して語られるべきである。

### D2. serialization / ownership / permission / trusted code / plug-in lifecycle / version negotiation の境界（CAP019）

以下の 6 項目の **所有境界** を定義する。「©」は canonical owner（その領域の正）、「⊕」は契約経由での参照・消費。

| 領域 | ae-devtools | ae-a8n | ae-test | ae-farm |
| --- | --- | --- | --- | --- |
| **serialization schema**（capability record、coverage 状態） | **©** catalog/IDs/denominator、生成 metadata、型 | ⊕（ただし execution 結果の serialization、report/trace schema は ae-a8n が ©） | ⊕ | ⊕（将来） |
| **ownership / target identity**（owned / attached / quarantine / non-interference の意味論） | ⊕ | **©** | ⊕ | ⊕ |
| **permission / trusted code**（script 実行同意、`PlayerDebugMode`、native plugin の install intent、development script の区分） | ©（開発者向けの trusted-script permission UI/UX の表面） | ©（実行ごとの consent、ownership gate、allow/refuse） | ⊕ | ⊕（将来） |
| **plug-in lifecycle**（build / load / register / unload / crash containment / ABI） | ©（SDK 調査と plugin 開発者向け harness。ただし lifecycle 管理の最終 owner は R3 として Open） | ©（AE process 内で動くものの process lifecycle 管理） | ⊕ | ⊕（将来） |
| **version negotiation**（capability handshake の契約面） | ©（contractVersion / catalogRevision の schema と意味論） | ©（runtime での handshake 実行・refusal） | ⊕ | ⊕（将来） |
| **execution transport**（bootstrap + per-operation dispatch の実装） | 独自に検証する場合は自 repo 内で。共有する場合は「契約共有は実装共有ではない」に従う | ©（現行実装は [`HostTransport`](https://github.com/ido-bata/ae-a8n/blob/main/docs/adr/0001-bridge-transport.md) 配下の file-envelope transport。将来の transport 選定は D4 / Open Q1 に従う） | ⊕ | ⊕ |

**決定された原則:**

1. **契約共有は実装共有ではない**（plan.md §1 の原則を confirm）。ae-devtools は versioned
   manifest（capability IDs、coverage 状態、生成型）を配布でき、ae-a8n / ae-test はそれを
   読む。実装 module を bi-directional に link しない。ae-farm README の「共通依存を前提としない」
   は、farm 自身の ADR 決定（ae-farm #4）まで変えない。
2. **境界は API 契約でまたぐ。** ae-a8n の static named extension contract（`ae.call` と
   build 済み host script、call-time eval なし）は、capability catalog の `execution.adapter`
   を満たす唯一の sanctioned なコード配送経路の一つであり、devtools はこれを迂回する
   runtime eval を前提とした契約を作らない。
3. **native plug-in は host lifecycle 内で動く**（spec FR-09）。外部からの generic remote
   C invocation は存在しない。`ae.sdk.*` capability の remote 呼び出し可能性
   （`canRemoteInvoke`）は SDK lifecycle を通じた build/load/test 操作としてのみ catalog 化する。

### D3. capability manifest の canonical 保持者 — ae-devtools（R4）

**決定:** capability ID、その provenance、coverage denominator の canonical な保持者は
**ae-devtools** とする。ae-a8n は自前の capability 一覧を再定義せず、#102 で
`capabilities()` プラス extension 点を通じて ae-devtools の manifest を **参照** する。

**理由（両案の比較）:**

- 案 A（devtools が manifest を配布）— plan.md §1 は既に「canonical capability IDs and coverage
  denominator」を ae-devtools の欄に置いている。catalog は SDK ヘッダー由来の行を
  build 時に供給する設計（capability-catalog §1.1 の CONFIDENTIAL 対応）であり、
  provenance 収集は devtools の inventory（#8–#10）から出る。denominator 管理（FR-13/FR-14）は
  どの repo も devtools ほどこの構造を持っていない。
- 案 B（ae-a8n が自前 `capabilities()` を持つ）— ae-a8n #102 A8NCAP01 は read-only
  query のみを要求しており、「ae-a8n が capability universe を定義する」ではない。
  A8NCAP02–04 は既存 built-in / static extension への mapping を要求し、catalog の再定義を
  要求していない。

両立する。manifest の canonical 保持者を devtools と決めても、ae-a8n の `capabilities()`
という位置づけは維持される。

**未確定として残す点（Open）:**

- manifest の **配布形式**。ae-test は ae-a8n を npm で exact pin するが、capability manifest を
  どこから得るか（devtools package 経由 / ae-a8n 経由 / 独立 artifact）は未決。
  配布形式は vision.md §未確定 の「配布形態」に接続するため、本 ADR では決めない。
  何が閉じるか: 配布形式 ADR（#11 schema 確定後、owner 承認）。

### D4. transport の第一検証候補と判定基準（R1、CAP018 の一部）

**決定:** 第一検証候補の決定は実施せず、**判定基準** をここに固定する。どの transport も
real-host evidence を持たない段階で「第一候補」を決めることは、constraint 3（実機未検証を
根拠に transport を確定しない）に触れる。

代わりに、以下の **等価な検証課題** を置く。ADR-0001（devtools）の Windows gate W1–W7 と、
ae-a8n #98 の proof 要件は、**「実機で何を測るか」の共通集合** として交叉する:

| 検証課題 | devtools W gate 対応 | ae-a8n #98 対応 | なぜ先に必要か |
| --- | --- | --- | --- |
| V1. panel/コンポーネントの **bootstrap** 成功率と UX（インストール、初回同意、再起動後再有効化） | W6（daemon reconnect）に直結 | #98 の startup script gate（ADR-0003 §Bootstrap is the first production gate） | bootstrap 失敗はどの dispatch 方式でも致命的 |
| V2. **per-operation dispatch** の基本往復（read-only 1 操作） | W1–W3（`evalScript` snapshot、throw、mutation） | #98 の read-only `app.version` proof | すべての候補に共通する最小 proof |
| V3. **main-thread contention 下での動作**（render 中の呼び出し、busy AE） | W1（evalScript during render） | #98 の「scheduled polling runs under host load without freezing AE」 | CEP と in-AE dispatcher のどちらも main-thread 制約を持つ |
| V4. **エラーと unknown outcome の区別**（timeout と AE busy の区別、非再試行） | W3、W7（daemon recovery） | #99（#98 では確認不可） | unknown-outcome discipline は 4 リポジトリ共通 |
| V5. **再接続・再起動耐性**（AE quit + relaunch、panel 生死） | W6 | #99 reconnect/recovery | panel と startup script の両方で必須 |
| V6. **TCC/権限の帰属**（どのプロセスに TCC 帰属するか、-1743 の再現の有無） | （W gate には明示的に無い。ADR-0001 の Open Q4 に該当） | #98 で実測済みの主戦場 | macOS では dispatch が Apple Event か AE 内かで帰属主体が変わり得る |
| V7. **複数 AE インスタンス / 複数 client の共存** | W4（serialize two evalScript） + ADR-0001 Open Q2 | （#98 は単一 AE 想定） | daemon/controller 共存の前提 |

**決定された判定基準（どの候補もこの軸で測る）:** bootstrap 手数の少なさ / dispatch の
決定論性（呼び出しと結果の 1:1 対応、非 atomic watch の有無）/ main-thread contention 耐性 /
unknown-outcome の区別可能性 / consent・署名の在り方（`PlayerDebugMode` vs startup script か）
/ AE version 変更に対する安定性。**優劣は実測後にしか決めない。**

**Open（第一候補の選定自体）:** W1–W7（devtools）と #98（ae-a8n）の **両方** の証拠が、
同一の AE build・OS 上で取得されるまでは、どの transport も「第一候補」として提示されない。
何が閉じるか: （1）#98 の macOS+Windows 実機 proof、（2）W1–W7 の Windows 実機実施、
（3）両 owner の本 ADR 受領。

### D5. 候補ルートの記録（CAP018）

比較の対象をここに記録する。優劣は付けない。各ルートの評価は D4 の判定基準で行う。

| Route | bootstrap 手数 | dispatch の性質 | 既知の根拠（未確定を含む） |
| --- | --- | --- | --- |
| **CEP panel + evalScript**（devtools ADR-0001） | 高（panel install、`PlayerDebugMode` or `.zxp` 署名、AE再起動でpanel消滅） | request/response、main-thread、callback 1:1 | ADR-0001 research 01/02/05。実機 W1–W7 未実施 |
| **in-AE ES3 dispatcher**（ae-a8n ADR-0003、startup script or 手動 File > Scripts） | 中（per-user Startup Scripts 登録 + AE 起動時に同意）  | `app.scheduleTask` 要求監視 + envelope、main-thread | #98 fake dispatcher あり。実機は macOS read-only のみ |
| **UXP** | 不明（beta のみ plugin loading が未整備） | beta 時点で remote IPC 未整備 | Adobe 2026-11: private beta。ADR-0003 は「released build で評価」を要求 |
| **native AEGP / Effect SDK plug-in** | 高（build、install、署名、crash containment、ABI） | host-lifecycle-driven、remote からは command 登録のみ | FR-09: generic remote C invocation はしない。#17/#18 で proof |
| **CLI（`aerender` 等）** | 低 | render-only、外部コマンド | ae-a8n ADR-0001: render only; later candidate |
| **OS automation / GUI** | 低 | fragile、非決定論的 | ae-a8n ADR-0001 で last resort と明記。model 操作には使わない |
| **file-envelope OS-script**（現行 shipped） | 中（script file と network 権限の同意、staging folder） | `AfterFX.exe -r` / `osascript`、file 改名 publication、polling | ae-a8n ADR-0001 Accepted（macOS 実機確認済み）。Windows は未検証 |

**決定:** UXP は released AE build で plugin loading・remote IPC が確認できるまで
**選外**（beta での採用はしない）。これは両 ADR の立場と一致する（ADR-0001 devtools
「not adopted for v1」、ADR-0003 ae-a8n「do not require a beta」）。

### D6. 本 ADR の Status と昇格条件（CAP020）

Status は **Proposed** のまま維持する。昇格（Accepted 化）・却下・再評価の条件を明示する。

**Accepted への昇格条件（両 owner の承認が前提）:**

1. D4 の V1–V5 に相当する real-host evidence が、**macOS と Windows の両方で** 存在する
   （ae-a8n #98/#99 の実施、devtools W1–W7 の実施、またはそれらを置き換える実証）。
2. transport の第一候補が evidence に基づき両 owner（ae-devtools と ae-a8n）によって合意され、
   その transport の owner と fallback policy が別の ADR または PR で明文化される。
3. capability manifest の canonical 保持者の決定（D3）が ae-a8n #102 の実装で確認される。
4. devtools ADR-0001 の Accepted 条件（W1–W7）と本 ADR が矛盾なく併存すること。

（注: ae-devtools ADR-0001 の Accepted 条件 W1–W7 は「Windows gate」に固定されているが、
本 ADR はこれを macOS 側の必要条件に **変えない**。devtools ADR-0001 の条件は devtools の
所有物であり、本 ADR がその text を書き換えることはしない。）

**却下（reject）となる条件:**

- V6 の実測で、CEP と in-AE dispatcher のどちらも未知の TCC/権限状態を残し、かつ
  UXP が released build で同等の条件を満たすことが確定した場合（本 ADR 全体の前提が
  置き換わる）。
- ae-a8n ADR-0003 が不成立と判定され（#98 不成立）、かつ ADR-0001（devtools）の W gate
  がクリアされ、CEP 路線に一本化することが決定された場合、本 ADR は CEP に特化して
  再提案されるべきである。

**再評価の trigger:**

- AE 26.x（CEP 13）のリリース、UXP の production availability、macOS/Windows の
  TCC/loopback ACL 変更、Adobe の third-party external ExtendScript invocation に対する
  姿勢変化（ADR-0001 Risks）、SDK release の ABI 変更。

---

## CAP017 に対する記録: 矛盾と共通点

（CAP017 の要件は D1–D6 に分散しているため、ここに明示的にまとめる。）

### 矛盾している点（real conflicts）

1. **第一実行コンポーネントの置き場所。** ADR-0001（devtools）は AE 内 CEF/Chromium process
   の CEP panel、ADR-0003（ae-a8n）は AE scripting/GUI process 内の ES3 dispatcher。どちらも
   not Accepted であり、両者は「AE のどこで code が走るか」が物理的に異なる主張を持つ。
2. **TCC 帰属の位置づけ。** ADR-0001（devtools）は Open Q4 として Adobe legitimacy を
   挙げるが、TCC 帰属という現象は検証課題に含まれていない（W gate のどこにも無い）。
   ADR-0003（ae-a8n）は macOS 実機で観測された `-1743` TCC 帰属問題を **out-of-scope ではない
   first-class の拒否理由** として扱う。つまり: **両者は「実機で何を測るか」の優先順位が違う。**
3. **bootstrap の重み。** ADR-0001（devtools）は panel install + `PlayerDebugMode` を
   開発時の前提として重く扱っていない（Windows では registry 設定 1 つ）。ADR-0003 は
   bootstrap を「first production gate」に位置づけ、`sudo` 無しの per-user Scripts/Startup
   導入を検証するまで production としない。

### 共通している点（common ground）

1. **ExtendScript は ES3** である、という制約の認識（devtools ADR-0001 research 02、
   ae-a8n ADR-0001/0003、extensions contract「no JSON」）。JSON codec を独自に持つ必要がある
   ことも共通認識（ae-a8n は `a8n-json.js` を既に配送している）。
2. **main-thread / host 側での直列化** の必要性（devtools ADR-0001 Decision 4 の serialization、
   ae-a8n ADR-0003 の「once claimed a long AE operation remains serialized」）。
3. **request/response + deadline + 非再試行** の default semantics（devtools ADR-0001
   Decision 4/5、ae-a8n ADR-0001 の polling + typed TimeoutError、ADR-0003 の
   「never retry unknown host actions」）。
4. **project-state event は存在しない** 認識（devtools ADR-0001 Decision 5、
   ae-a8n の polling 設計）。
5. **UXP は v1/beta 時点では採用しない**（D5 のとおり、双方の ADR text が一致）。
6. **静的 named method / closed read surface** の方向（devtools ADR-0001 Decision 2 の
   `inspect_*` closed set、ae-a8n extension contract §1 の static/named 原則）。
7. **両者とも「実機未検証が残る」ことを明示的に認め** ている（devtools ADR-0001 Status
   の cannot perform real-AE validation、ae-a8n ADR-0003 の Evidence and exit rules）。

---

## R1–R5 の取り扱い（監修コメント 6813325701 への応答）

| 論点 | 本 ADR での扱い | 根拠 | 状態 |
| --- | --- | --- | --- |
| R1 | D4: 判定基準と検証課題 V1–V7 を固定し、第一候補の選定自体は Open（両 owner の合意 + 実機 evidence が条件） | 実機 evidence が存在しないため | **Open**（判定基準は固定） |
| R2 | D1: bootstrap / per-operation dispatch の 2 層分離を cross-repo 共通語彙として採用 | ae-a8n ADR-0003 が既に分離しており、実装面（plan §3）と混同しない旨を明記 | **決定**（語彙・区切りの採用） |
| R3 | D2 表: plug-in の harness・調査側は ae-devtools、AE process 内 lifecycle 管理は ae-a8n と **側面ごとに分割**。ただし native SDK adapter 全体の owner は Open | hybrid 位置づけは #17/#18 の前には確定できない。plan.md §1 の責任マップを根拠にしつつ、AE process 内実行が ae-a8n の ownership と交差することを尊重 | **部分的に決定**（lifecycle 管理の owner は Open。harness 側の調査は devtools と明記） |
| R4 | D3: canonical 保持者は ae-devtools。manifest 配布形式は `Open` | plan.md §1、ae-a8n #102 A8NCAP01–03 の text | **決定**（保持者）。**Open**（配布形式） |
| R5 | 採番は次の空き番号 0005 を使用（index 確認済み: 0001–0004、0012、0014 が使用済み） | decisions/README.md の既存 index | **決定** |

---

## Why

- **同じ検証課題を 2 度実施しないために。** W1–W7 と #98 の要件は本質的に同じ V2–V5 に
  写像される（D4 表）。別々に実施すれば AE 実機リソースを二重に消費する。4 リポジトリが
  同一の実機上で互いに比較可能な evidence を残す方が、単一の owner の主観より強い。
- **決定できないものを決定済みと書かないため。** constraint 3・5 に従い、real-host evidence
  が存在しない論点（R1、R3 の一部、配布形式）は Open と明示した。vision.md の未確定事項
  （core 言語 / MCP transport / 配布形態 / 対応 AE 版）は本 ADR では固定しない。
- **ae-a8n ADR-0003 の昇格・内容は devtools 側で確定しない。** 本 ADR は「何を検証するか」
  （D4）と「境界の語彙」（D1/D2）のみを固定し、ae-a8n 側の ADR の内容・採否は両 owner の
  判断に委ねる（constraint 2）。
- **ADR-0001（devtools）への非干渉。** 本 ADR は devtools ADR-0001 の Accepted 条件
  （Windows gate W1–W7）を書き換えず、昇格もしない（constraint 1）。ADR-0001 と本 ADR は
  矛盾なく共存する: ADR-0001 は devtools の shared-core bridge の形状を、本 ADR は
  cross-repo の境界と評価軸を定義する。

## Consequences

### Positive

- 4 リポジトリの検証投資が V1–V7 の共通課題に集約され、二度手間が減る。
- bootstrap と dispatch の区切りが言語化されたため、以後の ADR/Issue（#13 以降）がどの層の
  話をしているか機械的に判定できる。
- capability record の所有が ae-devtools に、実行・ownership の所有が ae-a8n に区分され、
  ae-test / ae-farm は契約面のみを消費する形が確立する。
- 未確定事項が Open として可視化され、#13 以降の検証の着手点が明確になる。

### Negative

- transport の第一候補が決まらないため、#13（read-only AE probe）は「候補に依存しない
  検証課題」のみを先行実施する必要があり、実装はやや抽象的な作り込みから始めることになる。

### Neutral

- 本 ADR は文書のみ。実装コードは含まない（Issue #12 の scope）。

---

## Open questions

1. **R1: transport の第一検証候補。** D4 の条件が揃うまで決めない。Close に必要な evidence:
   ae-a8n #98 macOS+Windows 実機 proof、devtools W1–W7 Windows 実機実施、両 owner の合意。
2. **R3: native SDK adapter の owner。** #17/#18（AEGP / Effect 最小縦切り）の前に、plug-in
   lifecycle 管理の owner（devtools harness か、ae-a8n process ownership への統合か）を
   決める必要がある。Close に必要な evidence: #17/#18 の AEGP 実機 build/load の最小 proof と
   両 owner の合意。本 ADR では、native plug-in は host lifecycle 内で動く（FR-09）ため
   process identity / crash containment の管理責務が ae-a8n の ownership 概念と交差する、
   という事実のみを記録する。
3. **manifest 配布形式。** devtools package 経由 / ae-a8n 経由 / 独立 artifact の選択。
   vision.md の「配布形態」未確定に接続。Close に必要な evidence: #11 schema 確定 +
   owner 承認の配布形式 ADR。
4. **複数 AE インスタンスの port/channel 割当。** ADR-0001 Open Q2 と共通の論点。Close に
   必要な evidence: 複数 AE 実機での channel collision 観測（devtools ADR-0001 では
   port-per-instance が community pattern とされるが未確定）。
5. **macOS TCC 帰属が CEP panel / in-AE dispatcher で実際にどう違うか。** ADR-0001 の W gate
   は Windows 向けであり V6 を含まない。Close に必要な evidence: macOS 実機での
   TCC responsible process の帰属観測（CEP panel と startup-script dispatcher の双方）。
6. **Adobe の third-party external-ExtendScript 姿勢。** ADR-0001 Risks と同型の未解決。
   Close に必要な evidence: Adobe の公式 statement（存在しない間は risk として残置）。

## Evidence

（access date: 2026-11-12）

### internal — ae-devtools

- [ADR-0001-runtime-bridge.md](../ADR-0001-runtime-bridge.md) — CEP+daemon 提案、Windows gate W1–W7、Open Q1–Q9、Risks（Adobe legitimacy）。**Proposed**, 2026-09-18。access 2026-11-12。
- [vision.md](../../vision.md) — shared core / daemon 図、未確定事項リスト。access 2026-11-12。
- [decisions/README.md](README.md) — ADR lifecycle と採番（既存 0001–0004、0012、0014 を確認、次は 0005）。access 2026-11-12。
- specs/ae-capability-coverage/spec.md FR-09/FR-10、plan.md §1–§3、contracts/capability-catalog.md §1.1/§4/§7（branch `6`; [PR #7](https://github.com/ido-bata/ae-devtools/pull/7)）。access 2026-11-12。

### external (other ido-bata repositories)

- ae-a8n [ADR-0001-bridge-transport.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/adr/0001-bridge-transport.md) — **Accepted**、file-envelope OS-script transport、Windows 未検証の明記。access 2026-11-12。
- ae-a8n [ADR-0003-ae-execution-modes.md](https://github.com/ido-bata/ae-a8n/blob/97/docs/adr/0003-ae-execution-modes.md)（[PR #100](https://github.com/ido-bata/ae-a8n/pull/100)） — **Proposed**、in-AE dispatcher 第一仮説、bootstrap/dispatch 分離、TCC 帰属の分析。access 2026-11-12。
- ae-a8n [specs/isolated-ae/contracts/extensions.md](https://github.com/ido-bata/ae-a8n/blob/main/specs/isolated-ae/contracts/extensions.md) — static/named/owned extension 契約 v1。access 2026-11-12。
- ae-a8n [#102](https://github.com/ido-bata/ae-a8n/issues/102) — A8NCAP01–04、capabilities negotiation の要求範囲。access 2026-11-12。
- ae-test [docs/dependency-on-ae-a8n.md](https://github.com/ido-bata/ae-test/blob/main/docs/dependency-on-ae-a8n.md) — exact pin + integrity の依存方針。access 2026-11-12。
- ae-farm [README.md](https://github.com/ido-bata/ae-farm/blob/main/README.md) —「共通依存を前提としない」明記。access 2026-11-12。

### unverified / 推定を含むもの

- 本 ADR が挙げる transport 候補の macOS/Windows 実機挙動は **いずれも real-host evidence を
  持たない**（ae-a8n ADR-0001 の macOS 実機確認は「file-envelope OS-script」のみ）。
- 本 ADR に実装意図はない。#13 以降の検証は Open question を潰すためのものである。

## References

- [AE scripting guide — scripts](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html) access 2026-11-12
- [CEP 12 HTML Extension Cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md) access 2026-11-12（ADR-0001 経由）
- [Adobe UXP 投入発表 (2026-09-24)](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications) access 2026-11-12（ae-a8n ADR-0003 経由）
