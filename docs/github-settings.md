# GitHub settings

このリポジトリの GitHub settings がどうあるべきか、そしてどれが script で
適用されるかを記録する。rulesets は 2026-11-20 に PR #342 の誤 merge を
受けて導入した（経緯は末尾）。

## Repository settings

| Setting | Value |
| --- | --- |
| Merge methods | merge commit + rebase 許可、squash off（`allow_merge_commit: true`, `allow_squash_merge: false`, `allow_rebase_merge: true`） |
| Delete head branches after merge | off |
| Auto-merge | off |
| `GITHUB_TOKEN` default permissions | read（`default_workflow_permissions: read`） |
| Actions may approve pull requests | no |

確認:

```bash
gh api repos/ido-bata/ae-devtools -q '{allow_merge_commit,allow_squash_merge,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge}'
gh api repos/ido-bata/ae-devtools/actions/permissions/workflow
```

## Rulesets（`scripts/github-rulesets.js` で適用）

| Ruleset | Refs | Rules |
| --- | --- | --- |
| `main-branch-protection` | `refs/heads/main` | PR 必須（merge commit のみ、approval 0、review thread 解決必須）、required checks = ci.yml 全 job + `Verify head branch shape` + `Conformance release gate (CAP056)`、force push / 削除禁止、**bypass なし（admin 含む全員に適用）** |
| `release-branch-protection` | `refs/heads/release-*` | PR 必須（同上）、required checks = ci.yml 全 job（release-source-check は main 宛 PR のみで走るため対象外）、force push / 削除禁止、bypass なし |
| `release-tag-protection` | `refs/tags/v*` | update / force push / 削除禁止（tag 作成は許可）、bypass なし |

```bash
node scripts/github-rulesets.js           # dry run: 適用予定の内容を表示
node scripts/github-rulesets.js --apply   # 作成または更新して readback
```

`gh` が repository admin 権限で login している必要がある。name + target で
照合するため再実行は冪等。他の ruleset には触れない。

required checks は GitHub Actions app（id 15368）発の check run のみを
対象とする。job 名を変更した場合は script の `CI_CHECKS` /
`RELEASE_GATE_CHECKS` を更新して `--apply` しないと main が永久に
待ち続ける — script 変更と workflow 変更は同じ commit に入れること。

## Legacy branch protection について

`main` には旧 branch protection（PR review 枠・conversation resolution）
も残っている。rulesets と併存するが、実効的な強制は rulesets 側
（required checks・bypass なし）が担う。旧 protection の削除は任意で、
残しても矛盾しない。

## 経緯: PR #342 の誤 merge（2026-11-20）

PR #342（`341 → main`、release-gate 形状 check FAILURE・conformance
SKIPPED のまま）を repository owner が手動 merge し、v0.5.0 開発 line
の大部分が release PR を経ずに main へ流入した。当時の `main` 保護は
required status checks 未設定・approval 0・`enforce_admins: false`
であり、FAILURE check は merge を機械的に阻止しなかった。

再発防止として rulesets を導入し、required checks を GitHub Actions
発に限定、`bypass_actors: []` で admin を含む全 actor に適用した。
`release-*` にも同じ PR + checks 強制を敷き、ticket PR 以外の直接
push（証拠 commit を含む）を今後は PR 経由に限定する。

## Agent / operator 境界

- agent は `main` への merge・`release-* → main` の merge・tag・
  publish を実行しない（ADR-0012 / docs/release.md §Release PR merge
  authorization）。rulesets は人間 operator の誤操作も機械的に
  阻止するが、agent 側の境界は引き続き明示的承認制。
- ruleset の bypass actor を追加する変更は、この文書と ADR-0012 の
  改訂を伴う owner decision とする。
