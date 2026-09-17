---
name: linear-release-control
description: Linear optional release planning / portfolio control plane の併用契約（採用時のみ）。
---

# linear-release-control

## 対象

Linear を **optional** release planning / portfolio control plane として併用する場合の契約。
GitHub Issues が canonical dependency SoT を保持し、 Linear は planning / portfolio surface に
とどまる（ ADR-0014 ）。

## Default

Linear は **採用しない**。 GitHub Projects を planning control plane に使う。

## Canonical pointer

- `AGENTS.md` §10, §11
- `docs/architecture/decisions/ADR-0014-linear-profile.md`
- `docs/development.md` §Source / Work State of Truth / §Ticket Done

## 採用時の境界（contract）

- Linear の ticket / dependency は **canonical にしない**
- ticket 作成 / 更新は GitHub Issue を canonical、 Linear は mirror（ GitHub Issue 開設後 link する ）
- Done boundary は **GitHub Issue close のみ**。 Linear の per-ticket status は同期しない
- release-level reconciliation で Linear Project を Completed に揃える
- 採用には ADR amendment（ workspace / team / projects / cycles / reconciliation owner / reconciliation job ）が必要

## Forbidden

- Linear ticket が GitHub Issue と無関係に存在すること
- Linear 側の status で merge / Ready を駆動すること
- Linear Project を canonical な release management surface として使うこと
