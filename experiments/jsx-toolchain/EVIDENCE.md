# EVIDENCE — jsx-toolchain real-host runs (Issue #52)

Recorded per the repo verification taxonomy. The toolchain core is
**automated test** level; the dispatch/sourcemap loop below is
**verified on real host** on macOS only. Windows: UNVERIFIED.

## Environment

- macOS 27.2.1 (arm64), Node v24.x
- AE installs: "Adobe After Effects 2027" = 27.0.0 (`27.0x78`),
  "Adobe After Effects 2026" = 26.5.3 (`26.5.3x9`)
- ae-a8n consumed: local build `be78ca6` (`verify-105-103` = #105
  LaunchServices fix + #103 extension fix) via `--ae-a8n-root`
- transport: a8n-transport slice from branch `49` merged with this
  branch in a scratch worktree (PR #50 not yet merged)

## Runs

| evidence | AE | version | ownership | result |
| --- | --- | --- | --- | --- |
| `run-real-2027-a.json` | 2027 | 27.0x78 | owned | all steps ok |
| `run-real-2026-a.json` | 2026 | 26.5.3x9 | owned | all steps ok |

Each run: owned session launch → `ok.ts` build (status ok) → dispatch
COMPLETED → `$.global.__toolchainProbe` read-back `"hello ae <ver>"` →
`runtime-error.ts` build → dispatch FAILED (`ReferenceError`,
`__toolchainUndeclaredIdentifierは未定義です`, host line 3) → sourcemap
lookup → `runtime-error.ts:3` → close, no surviving main AE process.

## What this does and does not prove

- Proves: TS source → ES3 JSX build → real dispatch → host error →
  sourcemap → TS source position, end to end, on two AE versions.
- Does not prove: multi-file bundling, full API typings coverage,
  debugger integration, or anything on Windows.
