# Security Profile

> ae-devtools リポジトリの security profile / advisory intake / release 分岐の canonical 入口。

関連 canonical:

- [AGENTS.md §12](../AGENTS.md#12-quality--verification--security-profile)
- [`docs/architecture/decisions/ADR-0012-release-merge-authorization.md`](./architecture/decisions/ADR-0012-release-merge-authorization.md)
- [`docs/release.md`](./release.md) §Release PR merge authorization
- [`docs/architecture/research/05-security.md`](./architecture/research/05-security.md)（ADR-0001 の threat model と mitigations の研究）

## Scope / invariants

- ae-devtools は AE 開発を支援するツール群であり、 **AE 本体を attack surface に直接する立場** を取らない（vision.md §アーキテクチャ + AGENTS.md §9 と整合）。
- ただし、after-AE app や local developer machine に常駐する daemon / panel のセキュリティ posture は **第一級 concern**（[research/05-security.md の threat model](./architecture/research/05-security.md)）。
- public なリリース経路を取る前に、本 profile + ADR-0001 の脅威評価に基づく mitigation を維持する。

## Secret / credential handling

- secret は snapshot / checkpoint / commit / log / agent result / ADR へ含めない
- actual dotenv（`.env`, `.env.development`, `.env.production`）は Git ignore
- committed examples（`.env.example`, `.env.development.example`, `.env.production.example`）のみ許容
- `experiments/runtime-bridge/node-server/server.js` のように per-launch shared-secret を必要とする daemon は、`.ae-bridge-token` のようなローカル artifact のみに保存し、`.gitignore` で除外する。コミットしない
- daemon 側で token を保存する場合は 256-bit 共有 secret を OS 環境変数経由で受け取り、起動時に missing で `exit 2` する形（research 05 §Mitigations required #1）を遵守する

## Security advisory intake

framework / runtime / SDK / dependency の **advisory を実際に使用中の version に紐付けて** 継続的に扱う。

source priority:

1. official framework / runtime / SDK security advisory
2. official release / security announcement
3. ecosystem official advisory source
4. GitHub Security Advisories / dependency alerts
5. maintainer patch information
6. trusted secondary source

priority は **severity だけでなく** 次で決める:

- exploitability
- project reachability（プロジェクトがその advisory の対象 dependency / version を使っているか）
- external exposure
- required privilege
- impact
- fix availability
- workaround quality
- regression risk
- release timing

### Issue 化と target release 割当

meaningful advisory は GitHub Issue へ変換し target release を割り当てる。

- **critical exposed vulnerability**: current sprint を中断して patch release を優先してよい。ただし public repository の `main` を直接変更せず **patch release branch からの release PR** を使う（[AGENTS.md §12](../AGENTS.md) + [`docs/release.md`](./release.md) と整合）
- **non-critical**: 通常の weekly release sprint 内に取り込み
- **not exploitable in this project**: Issue に decision record を残し `closed as not applicable` する

## Network / IPC surface

研究・ADR で決まった次の rule は実 daemon 実装でも維持する（[research/05-security.md](./architecture/research/05-security.md) / [ADR-0001 Decision 3](./architecture/ADR-0001-runtime-bridge.md#3-daemon)）:

- bind to `127.0.0.1` のみ（外部 interface へ bind しない）
- ephemeral port / Unix domain socket
- per-launch 256-bit shared secret token（`crypto.timingSafeEqual` 等の定数時間比較を使う。length 短絡は length 漏洩の side channel を持つので、`SHA-256` 等で固定長化してから比較する）
- Origin / Host header allowlist
- audit log を disk へ書く
- 1 MiB 未満の body cap（実 daemons はより小さく 64 KiB 程度が妥当）
- request timeout（AE 本体にネイティブ timeout がない以上、daemon 側 deadline が必須）

`csinterface-wrapper.js` のように `unsafe-eval` を含む CSP は、適用理由と threat-analysis への bridge を panel のコメントと research/05-security に残す。`unsafe-eval` が不要なら CSP から外す。

## Prohibited patterns

次の security-relevant な anti-pattern を本リポジトリで禁止する:

- host Docker socket を worker へ直接渡す運用
- panel / daemon を `0.0.0.0` に bind する設定
- token をコードに埋め込む
- secret を log / error payload に流す
- `.gitignore` されず commit に含まれた actual credential
- critical advisory を `wontfix` で閉じる運用（評価記録 + 代替 mitigation を必ず残す）

## Reviewer separation

- reviewer / CODEOWNERS が意味のある separation を提供する場合、それを使う（[AGENTS.md §26](../AGENTS.md) + [`docs/development.md`](./development.md) §PR metadata）
- 自 reviewer だけで完了としない
- 意味のある reviewer が不在の場合、configured review automation / CI / explicit final review 等の代替 path を PR body に明記する。恒常的な self-approval serialization は禁止

## Reporting

- ae-devtools は AE 開発者向けツールであり、AE 上で動く panel / daemon は **local attacker model**（同一 machine の別 user / web page からの loopback 侵害）を主に防御する
- report path は現時点では repository の Issue / Discussion を一次とする
- Adobe 公式の ESTK / VSCode Debugger を始め、 third-party AE bridging 全体の legitimacy question（research/05 §Unverified item 22, ADR-0001 §Open questions 4）は **public release 前に必ず** 整理し、その結論を ADR へ反映する
