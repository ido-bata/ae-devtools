---
name: correctness-assurance
description: 正しい答えを作る前提 / 不変条件・事前/事後条件 / 型・静的解析・runtime assertion / プロパティ・差分・review。
---

# correctness-assurance

## 対象

「答えが正しい」という前提を supply chain 視点で扱う。 局所テストだけでなく contract / schema / 型 /
静的解析 / runtime assertion / property test / 差分 test / review を 組み合わせる。

## Canonical pointer

- `AGENTS.md` §5, §12
- `docs/development.md` §Verification

## Layered assurance

1. **不変条件 / 事前・事後条件** をコード上に明示（型 / assertion）
2. **static analysis**（`tsc --noEmit` / `eslint` / framework 標準 linter）
3. **runtime assertion**（厳格 mode が可能な範囲）
4. **property / differential / snapshot test**（ frame capture / probe differential 等）
5. **review**（ ADR / docs / code review を重ねる）

## 設計上の禁止

- 「テストが green = 正しい」 を短絡採用
- 既存コード majority に引きずられて canonical design / policy を上書き
- 「過去動いていた」のみを evidence として supply

## 推奨 evidence 形

- command / SHA / output / link の組合せ
- affected required validation を新 SHA に再 pin
- review conversation の resolution を durable state に残す
