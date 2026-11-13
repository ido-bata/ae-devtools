# Proposed contract — AE capability catalog, coverage and negotiation

- Status: **Proposed**, to be finalized in [#11](https://github.com/ido-bata/ae-devtools/issues/11) after source inventories [#8–#10](https://github.com/ido-bata/ae-devtools/issues/8).
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

## 2. Proposed machine-readable record

```ts
type CapabilityRecord = {
  id: string;
  kind: "scripting-symbol" | "sdk-symbol" | "tool-operation" | "semantic-operation";
  source: {
    publisher: "adobe" | "community" | "third-party" | "local";
    uri: string;
    version: string;
    revision?: string;
    symbol?: string;
    license?: string;
    observedAt: string;
    authority: "primary" | "community-maintained" | "source-verified" | "claim-only";
  };
  category: string;  // project/layer/animation/render/AEGP/effect/IO/etc
  access: "read" | "write" | "execute" | "host-callback" | "build-test";
  execution: {
    class: "extendscript" | "aegp-native" | "effect-native" |
           "native-io" | "cep" | "uxp" | "aerender" | "os-automation" | "unknown";
    lifecycle: string; // e.g. AE-main-thread, render-callback, plugin-register
    adapter?: string;
    canRemoteInvoke: boolean | null; // null = unverified
  };
  compatibility: {
    aeBuilds?: string[];
    sdkVersions?: string[];
    os?: Array<"win32" | "darwin">;
    architectures?: string[];
    requiredPlugins?: string[];
    requiredPermissions?: string[];
  };
  risk: {
    effect: "none" | "project-write" | "filesystem" | "host-lifecycle" | "unknown";
    trust: "read-only" | "named-operation" | "privileged-dev-code" | "native-plugin";
    undoable: boolean | null;
    retrySafety: "idempotent-proven" | "never" | "unknown";
  };
  coverage: {
    inventory: "discovered" | "source-reviewed" | "unverified";
    implementation: "none" | "adapter-present" | "implemented" | "unsupported" | "unknown";
    verification: "not-run" | "automated-fake" | "verified-real-host";
    evidenceRefs: string[];
    unsupportedReason?: string;
    issueRefs?: string[];
  };
  aliases?: string[];
};
```

The schema is illustrative until #11; field spelling is not yet a public npm contract. `null` is meaningful: absence of proof must not be coerced to false or true.

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

## 4. Capability discovery / handshake (proposed)

Read-only discovery returns:

- `contractVersion`, `catalogRevision`, `hostId`, `AE build/version`, `OS/arch`, `executionMode` (`local`, `remote`, `isolated-user` experimental), `transport`, `SDK/plugin identities`.
- `targetIdentity` and `ownership` evidence (`owned`, `explicitly-attached`, `unknown`), plus `nonInterference` separately (`proven`, `by-construction`, `unproven`).
- `availableCapabilities[]` with IDs, version bounds, declared permissions, adapter and actual proof level. Unknown/unsupported capabilities must be omitted from `available` and represented in diagnostics.
- `provenance`: exact code/plugin binary SHA, source package version, probe timestamp, session identity and evidence references.

Client behavior:

1. Negotiate major contract version before any write; unknown major refuses with a typed error.
2. Compare target identity, required permission, operation trust class and host version before dispatch.
3. A capability advertisement is **not** authorization to run an operation. ae-a8n's ownership, static extension and consent checks still apply per call.
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
