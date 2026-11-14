---
name: writing-discipline
description: reader-oriented writing / 作業 context から独立した artifact への再構成 / Select-Compose-Reread pipeline。
---

# writing-discipline

## 対象

README / docs / ADR / commit message / PR body / Issue body を **未来の第三者** が読んで意味が
通る artifact として書く。 作業 context / 会話 log / agent scratchpad を 永久ドキュメントに残さない。

## Canonical pointer

- `AGENTS.md` §4, §7, §16
- `docs/architecture/decisions/README.md`

## Select-Compose-Reread pipeline

1. **Select** — 残すべき fact / intent / evidence / pointer を 重み付けで選ぶ
2. **Compose** — reader が 30 秒で orientation できるように並べる（ canonical pointer → fact → evidence ）
3. **Reread** — 作業 context を知らずに読み、 意味が通るかを third-party review 観点で確認

## 推奨 evidence 形

- URL + access date（ docs/security.md §Evidence pattern 準拠 ）
- internal pointer（link、 file:line ）
- scope / out-of-scope を冒頭で明示
- 「未確定」を **明示的に残す**
