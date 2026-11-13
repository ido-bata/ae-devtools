# Contract — AE capability catalog, coverage and negotiation

- Status: **Finalized for CAP013–CAP016** by [#11](https://github.com/ido-bata/ae-devtools/issues/11). The machine-readable schema lives in `packages/capability-catalog/src/schema.ts` and the handshake in `packages/capability-catalog/src/handshake.ts`; this document remains the normative description. Sections below that were "proposed" are now binding for the catalog package; changes to the public schema require explicit major/minor compatibility rules, migration tests and a source-linked ADR/Issue (§7).
- Parent [#6](https://github.com/ido-bata/ae-devtools/issues/6); [spec](../spec.md); [plan](../plan.md).
- The catalog is **metadata and evidence**, not an execution authorization token or a promise of availability.

## 1. Identity and denominator

Every public Adobe symbol or independently evidenced tool operation has a stable catalog ID and an origin. Suggested namespaces:

- `ae.scripting.<class>.<member>`: documented ExtendScript members.
- `ae.sdk.aegp.<suite>.<entry>`, `ae.sdk.effect.<suite-or-selector>.<entry>`, `ae.sdk.io.<...>`: public SDK entrypoints, callbacks and selectors.
- `ae.operation.<semantic-operation>`: developer-level behavior mapping to one or more underlying symbols.
- `ae.tool.<project>.<operation>`: source-verified existing-tool operation, mapped to a semantic operation where equivalent.

The exact normalized ID grammar and SDK header parser are **not frozen** before CAP005–016. Preserve source symbol spelling and origin separately; never rewrite Adobe SDK symbols into misleading invented remote method names. A source version may add/remove entries, but IDs remain stable and aliases/deprecations are explicit.

Denominator rules:

1. Public scripting symbol count and SDK entrypoint count are reported **separately** by exact AE/SDK release and source revision.
2. Existing-tool operation parity is a **separate denominator**; semantic duplicates are linked, not counted twice as Adobe APIs.
3. Unsupported and host-callback-only entries **remain in the denominator**. Exclusions require source, reason, reviewer and revision.
4. A new Adobe release/tool snapshot creates a new denominator and diff; no silent denominator shrink to reach 100%.

### 1.1 Persistence policy is not uniform across sources

The catalog distinguishes **what this repository may publish** from **what it may measure**. These differ by source.

| Source | Persisted in this repository | Supplied at build time |
| --- | --- | --- |
| Public Scripting API (docs) | Per-symbol rows | — |
| Existing-tool operations (public source, licence permitting) | Per-operation rows with source link | — |
| Semantic operations | Per-operation rows | — |
| **AE SDK headers/symbols** | **Aggregate counts, classification totals, provenance and hashes only** | **Per-symbol rows**, generated locally by a consumer who holds the SDK |

Rationale: the AE SDK 26.5 headers carry an `ADOBE CONFIDENTIAL` notice stating that dissemination or reproduction of the material is forbidden without prior written permission from Adobe, and the distribution contains no licence text granting broader use (measured 2026-11-12: 24 of 40 top-level headers carry the identical notice; see [#10](https://github.com/ido-bata/ae-devtools/issues/10)). Publishing a per-symbol dump of those headers would be a reproduction of that material.

The consequence is a contract obligation, not a documentation preference:

1. A reader must not be able to reconstruct an SDK symbol list from this repository alone. That is the test for whether an SDK-derived artifact may be committed.
2. The SDK itself is never vendored. The extractor reads a user-supplied path.
3. `unknown` covers the case where no SDK-derived rows were supplied to the current environment. It is not 0% and not 100%.
4. Coverage and drift reports must state whether SDK-derived input was supplied. A report produced without it may not claim "no drift".
5. This asymmetry is a default pending an owner/legal decision; if a broader grant is confirmed, the SDK column can be widened without changing the record schema.

Denominators for SDK entrypoints therefore exist per environment, not per repository revision. Where a denominator has not been supplied, it is reported as `unknown` with the reason, never as a completed count.

## 2. Machine-readable record (finalized)

The canonical TypeScript type is `CapabilityRecord` in `packages/capability-catalog/src/schema.ts`. Relative to the illustrative sketch this contract previously carried, the finalized schema makes these bindings explicit:

- `persistence: "repository" | "build-time-supplied"` is a required field on every record; `sdk-symbol` rows are always `build-time-supplied` and are refused by the manifest generator (`src/generate.ts`).
- `coverage` gains `reachability` (`reachable | not-reachable | unknown`) alongside `inventory`, `implementation`, `verification`; the input-side `inventory`/`verification` axes are preserved verbatim and never collapsed.
- `coverage.unknownKind` distinguishes the three `unknown` flavours from issue #11 comment 6813348033: `undiscovered`, `unclassifiable`, `denominator-unsupplied`.
- `coverage.evidenceRefs` is a typed list (`source-doc | source-impl | automated-test | real-host`, optional `platform`) so the drift gate can verify a coverage claim never outruns its artifact (`src/evidence.ts`).
- `access` additionally admits `"read-write"` and `"unknown"`; `links` records cross-source dedupe (`semantic-grouping | underlying-symbol`) so one underlying capability is counted once.
- `contractVersion` is `{ major, minor }`, currently `1.0`; ID grammar is frozen in `src/ids.ts` (`ae.scripting.*`, `ae.sdk.*`, `ae.operation.*`, `ae.tool.*`).

Field spelling is now the catalog package's internal contract; promotion to a public npm contract still requires the §7 compatibility rules.

## 3. Example (illustrative, not a support claim)

```json
{
  "id": "ae.scripting.app.version",
  "kind": "scripting-symbol",
  "source": {
    "publisher": "adobe",
    "uri": "https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html",
    "version": "unresolved",
    "symbol": "app.version",
    "observedAt": "2026-11-12",
    "authority": "primary"
  },
  "category": "application",
  "access": "read",
  "execution": {
    "class": "extendscript",
    "lifecycle": "AE scripting host",
    "canRemoteInvoke": null
  },
  "compatibility": {},
  "risk": {
    "effect": "none",
    "trust": "read-only",
    "undoable": null,
    "retrySafety": "unknown"
  },
  "coverage": {
    "inventory": "discovered",
    "implementation": "unknown",
    "verification": "not-run",
    "evidenceRefs": [],
    "issueRefs": ["https://github.com/ido-bata/ae-devtools/issues/13"]
  }
}
```

The ae-a8n #98 fake dispatcher is **not** enough to set `verified-real-host`; it can be linked as a separate automated test artifact once a source SHA is recorded.

## 4. Capability discovery / handshake (finalized)

Implemented in `packages/capability-catalog/src/handshake.ts` (`CONTRACT_SCHEMA = "ae-devtools.capability-handshake/v1"`, `contractVersion 1.0`). Read-only discovery returns a `HandshakeResponse` containing:

- `contractVersion`, `catalogRevision`, `hostId`, `host` (`ae` version/build/scriptingVersion when known, `os`, `arch`, `executionMode` (`local`, `remote`, `isolated-user` experimental), `transport`).
- `target` (`identity`, `ownership` ∈ `owned | explicitly-attached | unknown`, `nonInterference` ∈ `proven | by-construction | unproven`).
- `inventorySupply` per source (`supplied | not-supplied`) and `availableCapabilities[]` with IDs, declared permissions, adapter/execution class, actual proof level (`verified-real-host | automated-test | source-reviewed | unverified`), and the executability axes `implementation` / `verification` so a client can distinguish discovery from dispatchability. Capabilities whose inventory was not supplied are omitted from `available` and represented in `diagnostics` (`inventory-not-supplied`, `capability-unassessed`) — never reported as absent.
- `diagnostics[]` (`code`, optional `source`, `effect`), including `no-real-host-evidence` and `supported-release-set-not-recorded`.
- `provenance`: catalog revision, host id, generation timestamp, per-source evidence levels (the §1.1 `inventory`/`verification`/`realHost` axes preserved), SDK aggregate totals with `denominatorCaveats`, and session/evidence references as they become available.

Client behavior (enforced by `negotiate` / `assertDispatchAllowed`, with refusal tests in `tests/handshake.test.ts`):

1. Negotiate major contract version before any write; incompatible major refuses `incompatible-contract-version`, a client minor newer than the server refuses `unsupported-minor-version`, a foreign schema refuses `malformed-response`.
2. Compare target identity, required permission, operation trust class and host version before dispatch; failures refuse `unknown-capability`, `capability-unassessed`, `missing-permission` or `ownership-unproven`.
3. A capability advertisement is **not** authorization to run an operation. The two functions have distinct responsibilities: `negotiate` is metadata *preflight* only — a `compatible` result means contract version, capability existence and declared permission line up; it assesses neither executability nor ownership. `assertDispatchAllowed` is the per-dispatch *authorization* gate and fails closed, in order: malformed response → `malformed-response`; `implementation !== "implemented"` → `not-implemented`; `verification === "not-run"` → `unverified`; `execution.canRemoteInvoke !== true` → `no-execution-path`; a dispatch that omits its permission class or names an undeclared one → `missing-permission` (permission is **required**, never skipped); ownership is proven only by the handshake's own `target.ownership` — a caller-supplied ownership claim that contradicts the attested evidence, or an attested `unknown`, refuses `ownership-unproven`. Caller claims corroborate; they never override server attestation. ae-a8n's ownership, static extension and consent checks still apply per call.
4. Cache is scoped to host/session/AE build/adapter/plugin hashes and invalidated on restart, project/session change or proof expiry.
5. No implicit fallback from dedicated-host to console or from named operation to arbitrary script execution.

## 5. Execution outcome contract

| Outcome | Meaning | Retry |
| --- | --- | --- |
| `not-sent` | No host dispatch occurred and evidence proves this | May be reissued only after new authorization and state check |
| `refused` | Invalid target/version/permission/capability or explicit safety refusal before execution | Fix prerequisite; do not silently retry |
| `completed` | Host result matched request identity and authenticated session | No automatic replay |
| `failed` | Host reported a definitive error for this request | New intent required |
| `unknown` | Could have been dispatched or partially executed; timeout, crash, busy AE or missing proof | **Never auto-retry**; quarantine/recover |

Native render/host callbacks may be **host initiated**, so their test outcome is the resulting plugin/artifact/evidence, not a direct synchronous RPC return.

## 6. Coverage reports and CI

A report must include per source/version:

```text
source_revision / ae_build / sdk_version / platform
discovered | source_reviewed | implemented | fake_tested | real_host_verified
unsupported_with_reason | unknown | uncovered
excluded_with_approved_reason | denominator | timestamp
```

- Fail CI when a source snapshot adds a symbol without a catalog row, removes one without a deprecation/exclusion reason, or a test claims a higher evidence level than its artifact supports.
- Report `implemented` and `verified-real-host` percentages **separately** and always show denominator and unknown count.
- Verify that no unsupported host callback is treated as an ordinary `remote-invocable` method without explicit SDK lifecycle proof.
- Tests cover duplicate IDs, renamed symbols, SDK release changes, missing plugin, wrong AE target, stale session, incompatible major, unsafe write and timeout UNKNOWN.

## 7. Cross-repo compatibility and ownership

- **ae-devtools #11:** schema/ID/canonical coverage; generator and provenance.
- **ae-a8n #102:** transport-specific `capabilities` negotiation and execution adapters; do not break existing `AfterEffects.launch` or `ae.call`.
- **ae-test #21:** conformance/evidence artifact producer; immutable host/SDK/plugin/package metadata.
- **ae-farm #4:** future worker capability advertisement and scheduling; no shared runtime dependency until its own ADR decision.
- **ae-devtools #20:** VSCode/MCP display the same catalog IDs but expose a bounded developer-loop interface, not one MCP tool per API symbol.

Changes to the public schema require explicit major/minor compatibility rules, migration tests and a source-linked ADR/Issue. This proposal does not change the currently published ae-a8n package.
