---
name: engineering-decisions
description: decision precedence / user escalation / 質問の整え方の handbook。 AGENTS.md §11 準拠。
---

# engineering-decisions

## 対象

判断の precedence と、 user escalation が必要な境界を共通認識として固定する。

## Canonical pointer

- `AGENTS.md` §11

## Decision precedence（順序）

1. **project-wide policy / canonical architecture / invariant**（AGENTS.md §1〜§9、現状 Accepted の ADR）
2. **design / specification / explicit task instruction**（Issue / PR 本文、ユーザーのタスク指示）
3. **coherent existing implementation majority**
4. **current official framework / runtime / SDK guidance**
5. established ecosystem convention
6. local best judgment

同一 level で矛盾する場合は、 より **specific かつ新しい canonical source** を優先する。

## Agent が自分で判断して進める条件

すべて満たす場合:

- precedence から答えが一意 / 実質一意
- reversible かつ局所的
- acceptance criteria を変更しない
- public / external contract を新規確定しない
- security / privacy / cost / release scope を重大に変えない

## User escalation が必要な境界

- canonical source 同士が矛盾し product semantics が変わる
- acceptance criteria が複数解釈でき user-visible behavior が変わる
- irreversible / destructive な操作
- public / external API contract の確定
- security / privacy / compliance risk の受容
- meaningful cost increase
- release scope / date の変更
- explicit design-first approval gate

## 質問の整え方

調査可能な fact を先に確認し、 選択肢・影響・推奨案を整理してから聞く。
**自明な判断を user に逐次 escalate しない**。
