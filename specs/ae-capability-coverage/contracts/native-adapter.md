# Contract — native SDK adapter negotiation and kits

- Status: **Proposed for CAP046** by [#19](https://github.com/ido-bata/ae-devtools/issues/19). Machine-readable shapes live in `packages/native-adapter/src/negotiate.ts` and `src/matrix.ts`; generated templates live in `packages/native-adapter/templates/`.
- Parent [#6](https://github.com/ido-bata/ae-devtools/issues/6); [spec](../spec.md) (FR-06, FR-09, FR-13); [capability-catalog contract](capability-catalog.md).
- Ownership: ADR-0005 D2 assigns the version-negotiation *contract surface* to ae-devtools (©) and runtime handshake execution to ae-a8n (© runtime). This contract is the devtools-owned surface only; it does not pick a transport and does not authorize dispatch.

## 1. Scope

Two artefacts:

1. **Negotiation** between an external devtools adapter and a native SDK plugin/host: protocol version, SDK release, suite-family availability. Fail-closed on every mismatch or unknown.
2. **Adapter kits**: per coverage-matrix class, fill-in templates for the adapter command envelope, a fixture, and a build-test path — each carrying the class's matrix status verbatim.

This is not the capability-catalog handshake. That contract negotiates catalog capability IDs (`ae-devtools.capability-handshake/v1`); this one negotiates the plug-in boundary (`ae-devtools/native-adapter-handshake/v1`). A compatible result on either is never dispatch authorization — `assertDispatchAllowed` in the catalog package remains the per-capability gate.

## 2. Messages

Both messages carry `schema: "ae-devtools/native-adapter-handshake/v1"`.

### AdapterHello (client → host)

| Field | Rule |
| --- | --- |
| `adapterId`, `adapterVersion` | identity; version is informational, not compatibility math |
| `protocolVersion {major, minor}` | client speaks this adapter↔host protocol |
| `sdkRelease {identifier, distribution}` | exact SDK release the adapter targets (e.g. `26.5` / `macos`) |
| `requiredFamilies` | suite families the adapter intends to use; each must be a known coverage-matrix class |
| `acceptableStates` | optional; defaults to `["dispatchable"]`. Widening (e.g. accepting `build-probe-only` for a compile probe) is an explicit client decision |

### HostHello (host → client)

| Field | Rule |
| --- | --- |
| `hostId` | identity |
| `protocolVersion` | host's supported adapter↔host protocol |
| `sdkRelease` | the SDK release the plugin/host **actually** runs |
| `families` | per-family `{state, note}`; an unadvertised family is unavailable, not absent-but-supported |
| `host` | informational only (AE version, OS, arch); never used in compatibility decisions |

## 3. Negotiation rules (fail closed, in order)

1. `malformed-message` — either side fails shape/schema validation. Unknown family names or states are malformed, never ignored.
2. `incompatible-protocol-version` — protocol major differs.
3. `unsupported-minor-version` — client minor is newer than host minor.
4. `sdk-release-mismatch` — identifier **and** distribution must match exactly; no compatible-range inference.
5. `unknown-suite-family` — a required family is not a coverage-matrix class.
6. `suite-family-unavailable` — the host does not advertise the family, or advertises a state below the client's `acceptableStates`.

Result `compatible` returns the granted per-family states. It asserts version/availability alignment only.

## 4. Family states and matrix derivation

States: `dispatchable` | `build-probe-only` | `inventory-only` | `unsupported-or-unknown`.

- `dispatchable` may be claimed **only** for a coverage-matrix row with `implemented === true` AND `verifiedOnRealHost === true`. No row satisfies this today, so an honest host advertises nothing dispatchable and every required-family negotiation refuses.
- `hostHelloFromMatrix()` derives the entire advertisement from `inventories/sdk/generated/aggregate.coverage-matrix.json`; the advertised `sdkRelease` is the matrix release, so negotiation can never drift from the inventory it describes.
- Unknown/missing matrix rows and unrecognised states map to `unsupported-or-unknown` — conservative on every axis.

## 5. Adapter kits

`packages/native-adapter/templates/<class>/kit.md` is generated (`bun run render`) and drift-checked (`bun run verify`). Each kit records the class's `state`, `implemented`, `verifiedOnRealHost`, symbol count, SDK release and evidence level verbatim, then provides:

- **Adapter command envelope** — `commandId`/`family`/`operation`/`params`/`deadlineMs`; result states exactly `not-sent | refused | completed | failed | unknown`; unknown-after-dispatch is never retried.
- **Fixture template** — preconditions, ordered steps, expected result state and evidence level.
- **Build-test template** — build against the negotiated `sdkRelease`, load proof per `experiments/native-sdk/LOAD-PROOF.md` (owned session only), honest evidence-level recording.

For `unsupported-or-unknown` the kit instead carries a **refusal/waiver record** (spec FR-013): decision, technical rationale, reevaluation condition, and a required follow-up issue before exclusion from supported coverage.

`build-test-lifecycle` additionally ships a concrete authored fixture, `fixture.sweetie-checkout.json`, exercising the compile-only probe already evidenced by `experiments/native-sdk` (Sweetie/Checkout, macOS arm64). It explicitly does not claim load, execution, Windows, or real-host evidence.

## 6. Non-goals / explicit limitations

- No SDK plug-in dispatch is implemented; kits are fill-in templates.
- Inventory-only families are not callable; negotiation refuses them under default `acceptableStates`.
- No transport is selected; message shapes are transport-agnostic.
- Real-host execution remains UNVERIFIED; Windows is entirely UNVERIFIED.
