# Contract — native SDK adapter negotiation and kits

- Status: **Proposed for CAP046** by [#19](https://github.com/ido-bata/ae-devtools/issues/19), **revised** so dispatchability is per concrete operation, never per coverage-matrix class. Machine-readable shapes live in `packages/native-adapter/src/negotiate.ts`, `src/matrix.ts` and `src/operations.ts`; generated templates live in `packages/native-adapter/templates/`.
- Parent [#6](https://github.com/ido-bata/ae-devtools/issues/6); [spec](../spec.md) (FR-06, FR-09, FR-13); [capability-catalog contract](capability-catalog.md); [NativeProbe result contract](native-probe-result.md).
- Ownership: ADR-0005 D2 assigns the version-negotiation *contract surface* to ae-devtools (©) and runtime handshake execution to ae-a8n (© runtime). This contract is the devtools-owned surface only; it does not pick a transport and does not authorize dispatch.

## 1. Scope

Two artefacts:

1. **Negotiation** between an external devtools adapter and a native SDK plugin/host: protocol version, SDK release, and *per-operation* availability. Fail-closed on every mismatch, unknown, or evidence-free claim.
2. **Adapter kits**: per coverage-matrix **class**, fill-in templates for the adapter command envelope, a fixture, and a build-test path — each carrying the class's matrix status verbatim **as reporting metadata**.

This is not the capability-catalog handshake. That contract negotiates catalog capability IDs (`ae-devtools.capability-handshake/v1`); this one negotiates the plug-in boundary (`ae-devtools/native-adapter-handshake/v2`). A compatible result on either is never dispatch authorization — `assertDispatchAllowed` in the catalog package remains the per-capability gate.

### 1.1 Class vs operation — the central distinction

The coverage matrix's five classes (`build-test-lifecycle`, `external-command`, `host-callback`, `in-host-plugin-command`, `unsupported-or-unknown`) are **extractor reporting buckets**. They say where a symbol was attributed; they are not capabilities and are **never dispatchable**.

Dispatchability is defined per concrete **operation entry** (`src/operations.ts`):

| Entry state | Derivation |
| --- | --- |
| `dispatchable` | `implemented === true` **and** `verifiedOnRealHost === true` **and** `externalDispatchVerified === true` — the only dispatchable path. The three axes are independent evidence: `implemented` = code compiles; `verifiedOnRealHost` = the call was observed succeeding **inside AE** on a real host; `externalDispatchVerified` = an **authorized external dispatch path** (transport + authorization) exists and was exercised. In-AE call success alone never authorizes external dispatch. |
| `implemented-unverified` | code exists and compiles; no real-host proof |
| `inventory-only` | structurally attributed; no implementation |
| `unsupported-or-unknown` | `unsupportedReason` recorded (technical basis + re-evaluation condition, FR-013) |

The committed matrix contains **no per-symbol rows** — symbol-level detail is license-restricted to a local git-ignored path (`inventories/sdk/README.md` §再配布制約). The per-entry contract lives in `packages/native-adapter/src/operations.ts`, seeded with the calls `experiments/native-sdk/minimal-plugin/src/probe.cpp` actually makes (`implemented`), plus inventory-only suite surface registered ahead of implementation by the CAP047 cluster Issues (#63 project/item, #69 PICA/SP). `tests/registry-reconcile.test.ts` mechanically enforces that every `implemented` entry is a real probe.cpp call and that every emitted `OpRecordV` id literal is a registry id.

**Dispatchable count today: 0.** Registry entries are `implemented-unverified` (the NativeProbe call set — builds on macOS arm64, no authorized AE session has loaded it) or `inventory-only` (suite surface registered ahead of implementation). Even a future real-host getter success would only set `verifiedOnRealHost`; `dispatchable` additionally requires `externalDispatchVerified`, which no transport/authorization path currently provides.

## 2. Messages

Both messages carry `schema: "ae-devtools/native-adapter-handshake/v2"` (v2: `requiredFamilies`/`families` replaced by `requiredOperations`/`operations`; v1 messages are malformed under v2).

### AdapterHello (client → host)

| Field | Rule |
| --- | --- |
| `adapterId`, `adapterVersion` | identity; version is informational, not compatibility math |
| `protocolVersion {major, minor}` | client speaks this adapter↔host protocol |
| `sdkRelease {identifier, distribution}` | exact SDK release the adapter targets (e.g. `26.5` / `macos`) |
| `requiredOperations` | concrete operation ids (`"<Suite>.<member>"`); each must exist in the committed registry. Matrix class names are **not** valid operation ids |
| `acceptableStates` | optional; defaults to `["dispatchable"]`. Widening (e.g. accepting `implemented-unverified` for inspection) is an explicit client decision |

### HostHello (host → client)

| Field | Rule |
| --- | --- |
| `hostId` | identity |
| `protocolVersion` | host's supported adapter↔host protocol |
| `sdkRelease` | the SDK release the plugin/host **actually** runs |
| `operations` | per-operation `{state, note}`; an unadvertised operation is unavailable. Unknown ids are malformed; `dispatchable` requires the registry entry to be `implemented && verifiedOnRealHost && externalDispatchVerified`; no advertised state may outrank the registry-derived state (downgrades allowed, upgrades malformed) |
| `classes` | OPTIONAL reporting echo of matrix classes. Never consulted for availability; `state: "dispatchable"` on any class is **malformed** — class-level promotion is rejected |
| `host` | informational only (AE version, OS, arch); never used in compatibility decisions |

## 3. Negotiation rules (fail closed, in order)

1. `malformed-message` — either side fails shape/schema validation. Unknown operation ids, unknown states, evidence-free `dispatchable` claims, stronger-than-registry states, and class-level `dispatchable` claims are all malformed, never ignored.
2. `incompatible-protocol-version` — protocol major differs.
3. `unsupported-minor-version` — client minor is newer than host minor.
4. `sdk-release-mismatch` — identifier **and** distribution must match exactly; no compatible-range inference.
5. `operation-unavailable` — the host does not advertise the operation, or advertises a state below the client's `acceptableStates`.

Result `compatible` returns the granted per-operation states. It asserts version/availability alignment only.

## 4. Evidence and derivation

- `hostHelloFromMatrix()` builds the advertisement from the coverage matrix (release identity + reporting `classes` echo) **and** the committed operation registry (per-operation states). It can never claim more than the registry supports.
- A host may advertise a *weaker* state than the registry derives (e.g. not yet wired up); it may never advertise a stronger one.
- Kits (`packages/native-adapter/templates/<class>/kit.md`) are generated (`bun run render`) and drift-checked (`bun run verify`); each carries the class's matrix status verbatim plus an explicit "reporting metadata only, never dispatchable" banner.

## 5. NativeProbe result contract

The structured result a future adapter collects from NativeProbe is specified in [native-probe-result.md](native-probe-result.md) (`ae-devtools/native-probe-result/v1`, implemented as `src/probe-result.ts`). It is **UNVERIFIED**: it describes what the adapter *would* collect, aligned to `probe.cpp`'s debug-log emissions. It does not mean native dispatch is implemented.

The post-negotiation dispatch envelope — the request/result shape an adapter would use to invoke one registry operation against a pinned session — is specified in [native-dispatch.md](native-dispatch.md) (`ae-devtools/native-dispatch/v1`, implemented as `src/dispatch.ts`). Like this contract it is a devtools-owned surface only: transport, authorization issuance, and in-AE intake remain ae-a8n-owned per ADR-0005 D7, and every committed operation currently refuses `operation-not-dispatchable`.

## 6. Non-goals / explicit limitations

- No SDK plug-in dispatch is implemented; kits are fill-in templates and the operation registry is contract-level.
- No matrix class is dispatchable; no operation is dispatchable today (0 entries) — and none can become dispatchable on in-AE evidence alone: `externalDispatchVerified` requires an authorized external dispatch path that does not yet exist.
- No transport is selected; message shapes are transport-agnostic.
- Real-host execution remains UNVERIFIED; Windows is entirely UNVERIFIED.
