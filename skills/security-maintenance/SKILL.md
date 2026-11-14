---
name: security-maintenance
description: security advisory intake / priority / release 割り / loopback 境界・shared secret。 AGENTS.md §12 + docs/security.md 準拠。
---

# security-maintenance

## 対象

framework / runtime / SDK / dependency の security advisory を、 実際に使用中の version と紐付けて
継続的に取り扱う。 experiments/runtime-bridge の loopback + per-launch token 境界を含む。

## Canonical pointer

- `AGENTS.md` §12, §16
- `docs/security.md`
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md`

## Priority model（少なくとも含む）

- severity
- exploitability
- reachability
- external exposure
- required privilege
- impact
- fix availability
- workaround quality
- regression risk
- release timing

## Required actions

- 有意 advisory を GitHub Issue に変換し、 target release を割り当てる
- critical exposed vulnerability では current sprint を中断して patch release を優先してよいが、 public repository の `main` を直接変更せず **patch release branch からの release PR** を使う
- dependabot alert 経由の advisory は `docs/security.md` priority model 経由で処理

## Loopback / shared secret boundary（ experiments/runtime-bridge ）

- 127.0.0.1 bind のみ
- ephemeral port allocation（ port 衝突回避 ）
- 256-bit 共有 secret を AES / `timingSafeEqual` 等で比較
- Origin / Host allowlist 検証
- audit log
- body cap
- request timeout

## Forbidden

- secret を snapshot / checkpoint / commit / log / agent result に含める
- `.ae-bridge-token` を commit / PR body / docs に貼る
- dotenv actual を commit する
