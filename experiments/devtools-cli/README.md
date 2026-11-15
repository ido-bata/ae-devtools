# devtools-cli — developer CLI over the dev-loop core (Issue #54)

Thin CLI wrapper around `experiments/dev-loop/devloop.mjs`
(discover/inspect/execute/verify). Adds **no** permission path — every
dispatch still goes through `runOperation()` (consent scope, gates,
trusted runner, quarantine).

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | environment probe (node, AE installs found, transport presence) — contacts no AE |
| `discover [--domain d]` | list executable registry ops with honest evidence levels |
| `inspect <opId>` | op schema/metadata; never executes |
| `execute <opId> [--args json] [--confirm-destructive] [--confirm-render]` | dispatch via canonical path |
| `verify [--read-op opId]` | post-execution read-back; never infers success from the write |

## Sessions

- `--session fake` (default): codec-faithful vm host — **fake/mock only** evidence.
- `--session a8n`: owned AE session via `experiments/a8n-transport`
  (Issue #49, Draft PR #50). Requires that experiment on the branch and,
  for unreleased ae-a8n builds, `--ae-a8n-root <checkout>`.

## Consent

`--consent grant` is required for any dispatch; the default is deny.
This is a local policy flag, not authenticated authorization
(ae-a8n #97–#99 owns that). Destructive/render ops additionally require
`--confirm-destructive` / `--confirm-render`.

## Evidence

Every execute/verify prints a `ae-devtools.cli.run/v1` record including
session kind + evidence level; `--out <file>` persists it.

## Verification

- `node tests/run.mjs` — 8 fake-level tests.
- Real-host: `node cli.mjs execute read.projectSummary --session a8n
  --ae-a8n-root <local-a8n> --consent grant` on an owned macOS session —
  pending merge of the a8n-transport stack.
