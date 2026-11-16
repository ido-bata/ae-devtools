# devtools-cli — developer CLI over the dev-loop core (Issue #54)

Thin CLI wrapper around `packages/ae-devtools-cli/dev-loop/devloop.mjs`
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
| `runs` | list run-guard markers — residue from runs that did not close cleanly (exit 1 when any exist) |
| `diagnose <record.json\|marker\|runId> [--map-dir d] [--jsx p] [--jsx-map p] [--bundle-map p]` | read a stored diagnostics/evidence/run-marker record and re-resolve every `ae-devtools.diagnostics/v1` record through sourcemaps; read-only, no dispatch. Failed execute/verify runs also embed an additive `diagnostics` block in their `ae-devtools.cli.run/v1` evidence (Issue #103); the record schema/collectors/sourcemap resolver live in the packaged `../diagnostics/` module (Issue #113) |
| `reap <runId> [--confirm]` | recover ONE stale leftover; only when the marker proves `ownership: owned` **with ae-a8n attestation provenance** (`session.process.attestation` recorded from `AfterEffects.recoveryTarget()`/`ownership()` at open — a self-declared claim cannot authorize a quit), the runner pid is dead (PID-reuse checked via start stamp), and the single AE candidate **is the attested aePid** with a matching start stamp. Attached/unknown hosts and unattested markers are reported, never quit |

## Sessions

- `--session fake` (default): codec-faithful vm host — **fake/mock only** evidence.
- `--session a8n`: owned AE session via `packages/ae-devtools-cli/a8n-transport`
  (Issue #49, Draft PR #50). Requires that experiment on the branch and,
  for unreleased ae-a8n builds, `--ae-a8n-root <checkout>`.

## Consent

`--consent grant` is required for any dispatch; the default is deny.
This is a local policy flag, not authenticated authorization
(ae-a8n #97–#99 owns that). Destructive/render ops additionally require
`--confirm-destructive` / `--confirm-render`.

## Evidence

Every execute/verify prints a `ae-devtools.cli.run/v1` record including
session kind + evidence level + a `cleanup` block; `--out <file>` persists
it. Cleanup is part of the contract: output is emitted only after
`session.close()` settles (bounded by `--close-timeout-ms`, default 20s),
close failures are reported (exit 3) and keep a run marker under
`$TMPDIR/ae-devtools-cli-runs/` (`AE_DEVTOOLS_CLI_RUNS_DIR` overrides, for
tests). SIGINT/SIGTERM run the same cleanup before exiting 130/143.
`reap` is the external recovery path for a runner that died mid-cleanup;
it is deliberately narrower than ae-a8n #108's adopt/resume — it can only
*quit* a proven-owned leftover, never reattach to it.

## Verification

- `node tests/run.mjs` — 17 fake-level tests covering success, refusal,
  close failure, close timeout, SIGTERM, stale-marker reap, ownership
  refusal, PID reuse, missing/forged attestation, and quit-target
  identity (attested pid vs. any AE under the install).
- Real-host: `node cli.mjs execute read.projectSummary --session a8n
  --ae-a8n-root <local-a8n> --consent grant` on an owned macOS session —
  evidence in `evidence/run-real-2027-readprojectsummary.json`.
