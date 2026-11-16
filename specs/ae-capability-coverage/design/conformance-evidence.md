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
| `verification` | catalog `coverage.verification` axis: `not-run` / `automated-fake` / `verified-real-host`. This is deliberately the **catalog vocabulary**, not a third taxonomy: `automated-fake` corresponds to the repo-level "automated test"/"fake/mock only" levels and `verified-real-host` to "verified on real host"; `implemented`-only and `source-reviewed` states are expressed through the capability's catalog row, not re-claimed per run |
| `result` | `NOT_RUN` / `BLOCKED` / `PASS` / `FAIL` / `UNKNOWN` — plan §6.2 matrix vocabulary; `unsupported` and `unknown` are recorded distinctly and **never count as PASS** |
| `catalogBinding` | the `evidenceRefs` entry this record satisfies: `{ kind: "real-host", ref: <record hash>, platform }` — the record is an artifact the catalog cites, so the existing drift gate's promotion checks (`unjustified-promotion`, `windows-unverified`, `platform-unverified`) consume it unchanged |
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
dimension** has real-host evidence at `verified-real-host` level.
Dimensions not yet implemented record `BLOCKED` with the blocking
dependency named — `BLOCKED` is honest, `PASS`-by-absence is forbidden.

## 3. Cross-repo evidence exchange (CAP055)

- ae-test / ae-a8n / ae-farm produce their own evidence records in this
  schema (or a mapped subset); ae-devtools consumes them by recomputing
  every cited `artifactHashes` entry — the consumer must be able to
  recompute every cited hash.
- **Same-bytes rule:** evidence is release proof only for artifacts whose
  content hashes match the release candidate's. `sourceSha` is provenance,
  not the binding: commit ancestry does not imply byte equality (a
  descendant commit can change unrelated files, and a cherry-pick can
  preserve bytes at a different SHA). Concretely: a record transfers to a
  release candidate iff every artifact it cites — packaged tarball, host
  script, plugin binary, fixture — hashes identically to the candidate's
  corresponding artifact; a `sourceSha` that is an ancestor of the
  candidate additionally requires a path-scoped diff proving the tested
  surface unchanged, otherwise it is `stale`. Dirty trees, repackaged
  artifacts and rebuilds with different bytes produce a different record.
- Stale evidence = artifact hash mismatch, missing artifact, or an
  ancestry claim without the unchanged-surface proof above ⇒ gate failure.

## 4. Release gate (CAP056)

The gate is a catalog-side check composed from existing pieces, not a new
system. Its **scope is the release's claimed capability set**, not the
whole denominator: rows the supported release declares in scope (the
`supportedRelease` set once recorded under plan §6.1, plus the acceptance
scope of Issues #15–#20). Unsupported, `host-callback`-only and
`denominator-unsupplied` rows are not release-blocking by default; making
one blocking is an explicit scope decision recorded against the Issue,
not a per-record flag.

- Layer 1 (exists today): the drift gate already fails closed when a
  manifest row claims `coverage.verification: "verified-real-host"`
  without a `real-host` `evidenceRef` per claimed `compatibility.os`
  platform (`windows-unverified` / `platform-unverified` /
  `unjustified-promotion` in `src/evidence.ts`). Evidence records from §1
  enter the catalog through exactly this path — as `real-host`
  `evidenceRefs` — so no parallel claim channel is created.
- Layer 2 (this note, CAP056): for each in-scope capability and each
  claimed platform cell, a §1 evidence record must exist whose
  `artifactHashes` recompute against the release candidate (same-bytes,
  §3) and whose `result` is `PASS` at `verified-real-host`. Absence,
  `BLOCKED`, `UNKNOWN`, `FAIL`, stale SHA or hash mismatch fails the gate.
  A per-record `release-blocking` marker would be a `CapabilityRecord`
  schema change and is deliberately **not** assumed here — it requires
  the contract §7 compatibility rules if ever proposed.
- Windows is a first-class gate input: `release-0-1-0` claims Windows
  support only when Windows rows carry real evidence; until then the
  honest gate output is `BLOCKED (windows: UNVERIFIED)`, matching Issue
  #21's standing constraint.
- CI wiring: layer 2 runs as a catalog script (`verify`-adjacent) so PR
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
