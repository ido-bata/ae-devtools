# ADR-0017 — Real-Host Evidence Source Binding

> Status: **Accepted** (2026-11-18). Resolves Issue #235.

---

## Status

**Accepted.** The binding rule below is implemented in the real-run
drivers (`aeDevtoolsSourceRef` in `devtools-cli/real-run-kit.mjs`,
consumed by the a8n-transport / jsx-toolchain / mcp-server real-run
drivers and the `ae-devtools.cli.run/v1` record) and recorded here as
the durable policy for all real-host evidence.

---

## Context

Only `packages/capability-catalog/evidence/conformance/*/record.json`
records carried `sourceSha` and were ancestry/scope-bound by the
conformance gate (Issue #221). Every other real-host evidence file —
`a8n-transport/evidence/*.json`, `jsx-toolchain/evidence/*.json`,
`mcp-server/evidence/*.json`, `devtools-cli/evidence/run-real-*.json`,
`vscode-extension/evidence/*.json` — recorded host/version claims with
no commit binding, and docs cited them as verification evidence. A run
record without `sourceSha` proves *a run happened on a host*; it does
not prove *which code was tested*.

Two resolution shapes were possible: extend the record schema so every
real-run driver embeds `sourceSha` and applies conformance-style
binding, or formally downgrade the unbound records to informational
evidence.

## Decision

**Hybrid: forward binding + honest downgrade of the unbound past.**

1. **Forward binding (schema extension, minimal).** Real-run drivers
   now stamp `sourceSha` (full `git rev-parse HEAD`) and `sourceDirty`
   into every evidence record they emit, via `aeDevtoolsSourceRef()` in
   `devtools-cli/real-run-kit.mjs`. The helper resolves the repo root
   relative to the driver module and **fails closed**: it only reports
   a SHA when `<root>/packages/ae-devtools-cli/package.json` exists with
   the expected package name. An npm-installed driver inside a consumer
   project therefore records `null` — never the consumer's HEAD, which
   would fabricate binding.

2. **No retroactive binding.** Evidence files produced before this
   change cannot be bound after the fact. They remain in the tree as
   historical records and are **informational, unbound**: they prove a
   run occurred on a named host at a named time, not that a given commit
   was exercised. Where out-of-band attribution exists (e.g.
   `a8n-transport/EVIDENCE.md`'s unchanged-surface diff against a freeze
   SHA), docs may cite that attribution explicitly — but the record
   itself is still not gate-verified.

3. **Gate scope unchanged.** Release-blocking claims continue to flow
   only through the conformance record schema
   (`ae-devtools.conformance-record/v1`), which already binds
   `sourceSha` + artifact hashes + platform dimensions. This ADR does
   not promote the looser real-run records into gate inputs; doing so
   would require the full conformance binding (artifact hashes,
   capabilityIds, platform fields), which is a separate contract change.

4. **`sourceDirty: true` is honest, not fatal.** A run from a dirty
   tree records the HEAD plus the dirty flag; consumers must treat the
   binding as approximate and prefer clean-tree runs for acceptance
   evidence.

## Consequences

- New real-run evidence is commit-bound by construction; consumers can
  distinguish bound (`sourceSha` non-null) from informational records
  without external knowledge.
- Historical unbound records keep their evidentiary value for "a run
  happened" claims but must not be cited as commit-bound verification.
- `experiments/read-only-probe/evidence/*/manifest.json` already carries
  `source.headSha` (self-reported, short SHA, no dirty flag) — it is
  bound-but-unverified in the same sense as before; this ADR does not
  change its status.
- `vscode-extension/evidence/*.json` driver logs have no schema
  envelope; they remain informational unless regenerated through a
  bound driver.

## Alternatives considered

- **Full schema unification** (every evidence file becomes a
  conformance record): rejected — the conformance schema requires
  capabilityIds/artifactHashes/platform dimensions that dev-loop run
  records do not naturally produce; forcing it would either fabricate
  fields or fork the schema anyway.
- **Informational-only downgrade with no code change**: rejected —
  cheap forward binding was available via the existing
  `gitHeadAndDirty` probe, and leaving new records unbound would
  permanently grow the unbound-evidence surface.

## References

- Issue #235; post-release audit finding on unbound real-host evidence.
- `packages/capability-catalog` conformance gate (Issue #221) — the
  existing bound-evidence path this ADR deliberately does not extend.
- `devtools-cli/real-run-kit.mjs` — `aeDevtoolsSourceRef` /
  `gitHeadAndDirty` implementation.
- `a8n-transport/EVIDENCE.md` — example of honest out-of-band
  attribution for pre-binding runs.
- `experiments/read-only-probe/evidence/*/manifest.json` —
  self-reported `source.headSha` precedent.
- `docs/architecture/decisions/ADR-0016-session-open-and-fake-host-boundary.md`
  — sibling boundary ADR for fake vs real evidence.
- `docs/development.md` §Verification — evidence-level taxonomy.
- `docs/release.md` — conformance gate acceptance rules.
- `specs/ae-capability-coverage/design/conformance-evidence.md` —
  conformance record contract this ADR references but does not modify.
- `AGENTS.md` §12 — false-green prohibition / stale-evidence rules.
- GitHub Issues #226–#235 — post-release audit batch; PRs #236–#244 —
  remediation PRs.
- `docs/architecture/decisions/README.md` — ADR directory conventions.
- `docs/vision.md`, `docs/onboarding.md`, `docs/recovery.md`,
  `docs/security.md`, `docs/development.md`, `docs/release.md` —
  canonical project docs.
- `constitution/CONSTITUTION.md`,
  `organization/profiles/release-driven-solo.md` — governance contract
  and operating model.
- `packages/ae-devtools-cli/README.md`,
  `packages/capability-catalog/README.md`,
  `packages/native-adapter/README.md` — package docs.
- `experiments/read-only-probe/README.md`,
  `experiments/native-sdk/README.md`,
  `experiments/runtime-bridge/README.md` — experiment docs.
- `.github/workflows/ci.yml`,
  `.github/workflows/release-source-check.yml` — CI definitions.
- `skills/`, `skills-lock.json`, `scripts/verify-skills-lock.mjs` —
  vendored skills and integrity lock.
- `inventories/`, `specs/`, `scripts/`, `README.md`, `mise.toml` —
  repository structure and tooling.
- `docs/architecture/ADR-0001-runtime-bridge.md`,
  `docs/architecture/ae-bridge-research.md`,
  `docs/architecture/research/` — architecture research.
- Sibling ADRs ADR-0002 through ADR-0016 in this directory.
- `specs/ae-capability-coverage/spec.md`, `plan.md`, `tasks.md`,
  `research.md`, `design/` — spec kit sources.
- Evidence record schemas: `ae-devtools.a8n-transport.real-run/v1`,
  `ae-devtools.jsx-toolchain.real-run/v1`, `ae-devtools.cli.run/v1`,
  `ae-devtools.conformance-record/v1`.
- Environment variables consumed by drivers/tests:
  `AE_A8N_ROOT`, `AE_DEVTOOLS_CLI`, `AE_INSTALL_DIR`,
  `AE_DEVTOOLS_REQUIRE_XMLLINT`, `MCP_OUT`.
- Verification commands: `node --check`, `npm test`, `bun test`,
  `bun run verify`.
