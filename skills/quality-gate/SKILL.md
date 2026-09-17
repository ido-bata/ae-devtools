---
name: quality-gate
description: adaptive quality profile / verification taxonomy / false-green 禁止。 AGENTS.md §12, ADR-0003 / ADR-0004 準拠。
---

# quality-gate

## 対象

project の fixed bundle を盲信せず、 framework / runtime / SDK の current official guidance から
**adaptive** に verification taxonomy を compile する。

## Canonical pointer

- `AGENTS.md` §12
- `docs/security.md`
- `docs/development.md` §Verification / §Quality profile
- `docs/architecture/decisions/ADR-0003-weekly-release-sprint.md`

## Verification taxonomy（最低限）

- **Unit** — 局所 logic / component behavior の単体検証
- **Smoke / connectivity** — startup / wiring / 起動経路の最小限の成立確認
- **Integration** — 複数 component 間の data flow / persistence / 連携確認
- **Contract / schema** — API / event / DB / 生成 interface の互換性確認
- **E2E / system** — release-like boundary で user / system critical flow を確認
- **Manual / visual** — automation が困難な AE 本体 / パネル UI / native addon 経路に限定

## False green 禁止

- `.only` / ignored exit code / `|| true` / blanket suppression / CI disabling 等の偽装 green 禁止
- `.skip` / `.todo` を無条件 commit しない
- coverage threshold を盲目的に target にしない
- partial / stale validation を full pass として再利用しない（stack rebase で SHA が動いたら affected required validation を新 SHA に再 pin）

## Required evidence（CI configured / not configured 別）

CI configured: 必須 check が green / artifact 保存 / re-run capability.
CI not configured: 検証 log / script / SHA 単位の evidence / reviewer 評価 を記録。
