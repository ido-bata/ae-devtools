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
| `run-real-2027-a.json` | 2027 | 27.0x78 | owned | all steps ok (fixture loop) |
| `run-real-2026-a.json` | 2026 | 26.5.3x9 | owned | all steps ok (fixture loop) |
| `run-real-2027-b.json` | 2027 | 27.0x78 | owned | all steps ok (+ unknown-problem loop) |
| `run-real-2026-b.json` | 2026 | 26.5.3x9 | owned | all steps ok (+ unknown-problem loop) |

Each run: owned session launch → `ok.ts` build (status ok) → dispatch
COMPLETED → `$.global.__toolchainProbe` read-back `"hello ae <ver>"` →
`runtime-error.ts` build → dispatch FAILED (`ReferenceError`,
`__toolchainUndeclaredIdentifierは未定義です`, host line 3) → sourcemap
lookup → `runtime-error.ts:3` → close, no surviving main AE process.

The `-b` runs add the unknown-problem loop: a per-run generated fault
(`__tcMystery_<ts>` undeclared identifier, minted at runtime — not a
canned fixture) → FAILED with the host error naming that identifier →
sourcemap maps host line 3 to `mystery.ts:3` → fix applied → rebuild →
re-dispatch COMPLETED → `$.global.__toolchainMystery === "fixed"`
verified by a read-back dispatch. The *detection, diagnosis, rebuild and
verification* are real; the fix itself is a templated string edit — an
agent would perform the same edit from the diagnosed source position.

## What this does and does not prove

- Proves: TS source → ES3 JSX build → real dispatch → host error →
  sourcemap → TS source position, end to end, on two AE versions.
- Does not prove: debugger integration, or anything on Windows.

## Post-evidence expansion (automated test only — NOT real-host verified)

After the four real runs above, the toolchain gained (all covered by
`tests/run.mjs`, none exercised against real AE — the launch/GUI freeze
is still in effect):

- AST-based ES3 lint replacing the earlier regex lint
  (`src/es3-ast.mjs`): source lint only.
- Multi-file project builds (`build-project`): esbuild bundling,
  two-hop sourcemaps (`resolve` CLI), `check <dir>` cross-file
  typecheck.
- Generated AE API typings (`src/ae-api.d.ts` from the scripting
  inventory; name-level only, members are `any`-typed).
- Source-positioned diagnostics (file/line/column) across
  lint/build/check.

## Post-evidence lint rework (automated test only — NOT real-host verified)

The earlier "structural output proof" (a TypeScript SyntaxKind
whitelist in `es3-ast.mjs`) was **not** a complete ES3 proof and was
replaced:

- `src/es3-syntax.mjs` — final syntax validation is now an actual ES3
  *grammar* parse (acorn `ecmaVersion: 3`) plus an explicit ES3
  ReservedWord check for the cases acorn accepts (`var class`,
  `o.class`). Regression tests cover misses the whitelist had (object
  trailing commas) and false rejections (array trailing commas, `with`).
- `src/es3-api.mjs` — runtime API compatibility is a separate curated
  table. Fixed false positives: `Date.UTC` and `String.fromCharCode`
  are ES3 and are no longer flagged (along with `Date.parse`,
  `Array.prototype`, `Function.prototype`, etc.).
- Bundler/transpiler helpers are regression-tested both ways: helpers
  that stay ES3-clean pass; helpers needing ES5 builtins
  (`Object.defineProperty` via class fields under define semantics,
  `Object.setPrototypeOf`/`Object.create` via tsc `__extends`) fail
  closed with `es3-api-*` diagnostics.

Guarantee scope is documented in `README.md` §"What this does NOT
prove". All of the above is automated-test level; nothing here was
exercised against real AE (launch/GUI freeze remains in effect).

The single-file `build`/`lint`/`map`/`check` commands and artifact
formats used by `real-run.mjs` are unchanged; the real-host evidence
above still applies to the dispatch/sourcemap path. The reworked lint
internals themselves are automated-test only — they have NOT been
exercised against real AE (launch/GUI freeze remains in effect). The
project pipeline would need a new real-host run (frozen) before it can
be claimed verified.

## Attempt at ae-devtools `4a06639` (2026-11-17)

`evidence/run-real-2026-4a06639.json` — **PASS (AE 2026, 26.5.3x9)**,
single-file pipeline on an owned session: TS build → dispatch COMPLETED
→ `$.global` write verified → deliberate runtime fault FAILED with host
`ReferenceError` → sourcemap to `runtime-error.ts:3` → fix → rebuild →
re-dispatch COMPLETED → `mystery.ts` diagnose/fix/verify loop COMPLETED →
session close. `aeA8nSource: local:/tmp/ae-a8n-candidate`,
`aeA8nHead: null` (snapshot without `.git`).

This run exercises the **current** `buildFile` path, which includes the
reworked ES3 lint (`es3-syntax.mjs` grammar parse + `es3-api.mjs` curated
table) — so the single-file lint/build/dispatch/sourcemap surface is now
real-host exercised, upgrading that part of the earlier
"automated-test only" caveat. The multi-file project pipeline
(`build-project` / `check`) remains automated-test only — it was not
part of this run.

Provenance: ae-devtools runtime surface byte-identical to `4a06639`
(see a8n-transport/EVIDENCE.md "Attempt 5" for the unchanged-surface
check); ae-a8n bytes = commit `1dbd4de` (tree `e6003eab`, pre-0.2.0-rc),
`dist/` verified byte-identical to a clean build of that commit. Same
pre-RC caveat applies — not same-bytes proof against ae-a8n 0.2.0 RC or
published tarballs.

## Attempt at ae-a8n `0.2.0-beta.1` tarball (2026-11-17)

`evidence/run-real-2026-beta1.json` — **PASS (AE 2026, 26.5.3x9)** on the
publish-candidate tarball bytes (freeze `d895179`, sha1 `9ada37bc…`,
consumer-installed): full single-file pipeline green including the
reworked ES3 lint, sourcemap to TS source, fix/rerun/verify, owned
session close. Same candidate-bytes (not registry) caveat as
`a8n-transport/EVIDENCE.md` Attempt 6 — see Issue #173.
