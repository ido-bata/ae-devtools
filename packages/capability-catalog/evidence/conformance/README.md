# Conformance evidence (Issue #21 / #147)

One directory per run: `evidence/conformance/<runId>/record.json` plus the
artifacts it cites (`artifactHashes` keys are paths relative to the run
directory).

Rules enforced by `scripts/conformance-gate.ts`:

- `record.runId` must equal the directory name — a record cannot be
  re-homed onto a different artifact set.
- Artifact paths are confined to the run directory: absolute paths, `..`
  segments and symlink escapes are rejected.
- Records are immutable once committed; corrections are new runs.
- Only `verified-real-host` PASS records can satisfy a release claim
  (`design/conformance-evidence.md` §1–§4).

Real-host evidence is produced by owner-authorized runs on disposable
projects; CI never claims real-host levels it did not observe. Until the
first record lands, the gate verdict is `no-claims` — explicitly not a
conformance pass.
