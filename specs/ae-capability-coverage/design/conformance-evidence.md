# Design note — conformance evidence and release gate (Issue #21, CAP053–056)

- Status: **Proposed design note**, not an accepted contract. Row contents
  and gate thresholds remain open until the upstream capability issues
  (#14–#20) produce the surfaces being measured.
- Parent spec: [spec.md](../spec.md); plan: [plan.md](../plan.md);
  catalog contract: [contracts/capability-catalog.md](../contracts/capability-catalog.md).
- Prerequisites not yet integrated at time of writing: Issue #14 runtime
  execution (PR #30 design note), #15–#20 capability surfaces, ae-a8n
  #97–#99 (execution boundary / transport), ae-test #19 (E2E evidence
  exchange). This note consumes their *decided semantics*; it does not
  re-open them.

## 1. Evidence record (CAP053)

Every conformance claim binds to one immutable evidence record. Fields:

| Field | Rule |
| --- | --- |
| `recordVersion` | schema version; unknown versions are `UNKNOWN`, never coerced |
| `capabilityIds` | catalog IDs covered by this run; drift vs catalog is a gate failure, not a warning |
| `platform` | `{ os, osVersion, arch }` — recorded verbatim from the host, not assumed |
| `aeVersion` | exact AE version string **and** build number observed at run time |
| `sdkBuild` | hash of the SDK/plugin binaries under test; `null` + `sdkBuildStatus: "not-applicable"` only for pure-script rows |
| `verificationLevel` | one of the repo taxonomy: `implemented` / `automated test` / `fake/mock only` / `verified on real host`. A row's level is the **minimum** across its evidence — fake-host success never upgrades a real-host requirement |
| `result` | `PASS` / `FAIL` / `BLOCKED` / `UNKNOWN` — `unsupported` and `unknown` are recorded distinctly and **never count as PASS** |
| `sourceSha` | git SHA of the code under test; evidence produced from different bytes is a different record |
| `runId` / `artifactHashes` | run directory id + sha256 of every artifact cited |
| `environment` | disposable-project flag, host pid/session identity reference (probe `target.json` shape), `sideEffects: "none-observed"` assertion with its evidence pointer |
| `recordedAt` | UTC timestamp |

Rules:

- Real-host fixtures use **disposable projects**; the record must state
  that the user's interactive AE session was not the target (the probe's
  `target.json` ownership/session-pin evidence is the existing pattern).
- A record is immutable once written; corrections are new records that
  supersede by `sourceSha` + `runId`, never edits.
- Windows rows exist in the matrix from day one with result `UNKNOWN`
  until real Windows evidence exists — absence of a row is itself a gate
  failure, not a pass.

## 2. Acceptance matrix (CAP053/CAP054)

Matrix axes: `aeVersion × os × sdkBuild` (plugin build where applicable).
Each cell lists the capability IDs in scope and their per-dimension
results. Conformance dimensions for CAP054:

- `script` — Scripting DOM operations return typed, codec-clean results
- `native` — SDK/plugin path executes and reports honestly
- `transport` — request/reply survives the declared transport incl.
  reconnect semantics (ADR-0005 boundary; no new transport decided here)
- `ownership` — session pin / target identity holds; wrong-target refuses
- `timeout` — deadline behavior yields `UNKNOWN`, never silent retry
- `reconnect` — dispatcher re-activation does not resurrect old ids
- `undo` — mutations are undoable or explicitly declared non-undoable
- `render` — render-queue path reports typed outcomes

A capability row is `PASS` for a cell only when **every applicable
dimension** has real-host evidence at `verified on real host` level.
Dimensions not yet implemented record `BLOCKED` with the blocking
dependency named — `BLOCKED` is honest, `PASS`-by-absence is forbidden.

## 3. Cross-repo evidence exchange (CAP055)

- ae-test / ae-a8n / ae-farm produce their own evidence records in this
  schema (or a mapped subset); ae-devtools consumes them by
  `sourceSha` + `artifactHashes` — the consumer must be able to recompute
  every cited hash.
- **Same-bytes rule:** evidence is only release proof for the exact
  `sourceSha` (and `sdkBuild` where applicable) it names. A green run
  against a different commit, a dirty tree, or repackaged artifacts does
  not transfer. Rebase/rebuild ⇒ new evidence required for affected rows.
- Stale evidence = `sourceSha` not an ancestor of (or equal to) the
  release candidate, or artifact hash mismatch ⇒ gate failure.

## 4. Release gate (CAP056)

The gate is a catalog-side check composed from existing pieces, not a new
system:

- Reuse the drift gate: catalog↔manifest↔evidence consistency already
  fails closed on drift; extend the same mechanism so a capability marked
  `release-blocking` without a `verified on real host` record on **every
  claimed platform** fails the gate.
- Windows is a first-class gate input: `release-0-1-0` claims Windows
  support only when Windows rows carry real evidence; until then the
  honest gate output is `BLOCKED (windows: UNVERIFIED)`, matching Issue
  #21's standing constraint.
- CI wiring: the gate runs as a catalog script (`verify`-adjacent) so PR
  checks enforce it before release-branch integration; real-host evidence
  upload is a manual, owner-authorized step — CI never claims real-host
  levels it did not observe.

## 5. Explicit non-goals

- No production transport, consent-token, or ownership-protocol decisions
  — those belong to ADR-0005 / ae-a8n #97–#99.
- No generalization of the probe's claim-election filesystem assumptions
  (verified on local APFS-class FS only; FAT/exFAT/network FS remain
  UNVERIFIED for that mechanism).
- No Windows host usage by agents; Windows evidence arrives only through
  the dedicated-host path defined upstream.
