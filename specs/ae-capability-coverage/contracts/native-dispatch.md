# Contract — native dispatch envelope (CAP039 groundwork)

- Status: **Proposed contract surface for Issue #17 / CAP039**, schema `ae-devtools/native-dispatch/v1`. Machine-readable shapes and validators: `packages/native-adapter/src/dispatch.ts`.
- Sibling contracts: [native-adapter.md](native-adapter.md) (pre-dispatch negotiation), [native-probe-result.md](native-probe-result.md) (in-host call evidence), [trusted-execution.md](../design/trusted-execution.md) (permission classes, consent scope, outcome taxonomy — CAP025–028 groundwork).
- Ownership: per ADR-0005 D7, execution transport / IPC / serialization / execution authorization / timeout / UNKNOWN non-resend are **ae-a8n-owned (©)**. This contract is the devtools-owned API surface only: the shape a dispatch request/result takes once negotiation has returned `compatible`. It does not select a transport, does not mint or verify authorization, and does not implement any dispatch path.

## 1. What this envelope is for

After `negotiate()` returns `compatible` for a set of operation ids, an adapter needs a defined way to express "run `<Suite>.<member>` once, bound to this session, with these arguments, and tell me the outcome." This contract fixes that envelope. It applies equally to read-only getters and (future, FR-07/US3-gated) mutations; the permission class a given operation requires is determined by the trusted-execution permission model, not by this envelope.

## 2. Request — `ae-devtools/native-dispatch/v1`

| Field | Rule |
| --- | --- |
| `schema` | exactly `ae-devtools/native-dispatch/v1` |
| `requestId` | non-empty client-generated correlation key; echoed verbatim in the result. Re-issues after `not-sent`/`refused` use a **new** `requestId` — requests are never resent under the same id |
| `session` | session pin `{sessionId, aeVersion, sdkRelease?}` — the read-only probe pinning semantics. All fields non-empty strings; `sdkRelease` carries `{identifier, distribution}` when present. Semantic equality with the host-attested session is enforced host-side |
| `operationId` | `"<Suite>.<member>"` registry id from `operations.ts`. Must exist **and** derive `dispatchable` at resolution time — see §4 |
| `args` | optional; must satisfy the ES3-serializable set (trusted-execution.md §2): `null`, boolean, finite number, string, array, plain object — recursively. `undefined`, functions, symbols, non-finite numbers, and non-plain objects are malformed. Host objects are never arguments; identity descriptors are CAP027 scope. Inspection is hostile-input safe: cycles reject, depth is bounded at 64, total nodes at 100,000, and any exception while inspecting (throwing getter, revoked Proxy) rejects rather than propagates |
| `authorizationRef` | optional opaque reference to an authorization grant issued by the owning runtime. This contract never defines, stores, or validates grant contents |

## 3. Result — same schema id

| Field | Rule |
| --- | --- |
| `requestId` | echoes the request |
| `outcome` | `completed \| refused \| failed \| unknown \| not-sent` — the trusted-execution.md §4 vocabulary in catalog spelling |
| `refusalCode` | required when `outcome=refused`; machine-readable class (`WRONG_TARGET`, `MISSING_PERMISSION`, `NOT_IMPLEMENTED`, `UNVERIFIED`, `NO_EXECUTION_PATH`, `STALE_REFERENCE`, `INVALID_REFERENCE`, `CONSENT_REQUIRED`, `CONSENT_SCOPE_MISMATCH`, `MALFORMED_REQUEST`, `HOST_BUSY`, `OPERATION_NOT_DISPATCHABLE`, ...) |
| `result` | required when `outcome=completed`; ES3-serializable payload |
| `mayHaveMutated` | required when `outcome=unknown` or `failed`; `true` whenever the host cannot prove the operation did not mutate state |
| `opCalls` | optional; registry ids of the `op ` records the host emitted for this request — the linkage into `native-probe-result/v1` per-operation evidence (`completeness.operationsEvidenced`) |
| `detail` | optional human-readable string; never load-bearing |

Cross-field rules enforced by `validateDispatchResult`: `refused` ⇒ `refusalCode`; `completed` ⇒ `result`; `unknown`/`failed` ⇒ `mayHaveMutated`.

## 4. Fail-closed resolution order

`resolveDispatchOperation` mirrors `negotiate()`'s ordering:

1. `malformed-request` — `operationId` missing/empty/non-string.
2. `unknown-operation` — id not in the committed registry.
3. `operation-not-dispatchable` — entry exists but does not derive `dispatchable` (`implemented && verifiedOnRealHost && externalDispatchVerified`).

A `compatible` handshake result is point-in-time availability, never per-operation evidence: an operation that negotiated as advertised can still refuse at dispatch if its registry state has since weakened, and vice versa the registry is the ceiling — a host may advertise weaker, never stronger.

## 5. Retry and UNKNOWN semantics

- `unknown` = dispatched or possibly dispatched, no definitive reply. **Never auto-retried.** The client retains the request artifact for manual reconciliation; `mayHaveMutated` is expected `true` for any operation that is not provably side-effect-free.
- `not-sent` = environment-proven non-dispatch (the probe `BLOCKED` analogue). This is the only outcome that may be re-issued — as a **new** request after re-authorization, never a resend.
- `refused` is terminal pre-execution; retrying requires changing the cause (pin, consent, arguments), again as a new request.
- `failed` with `mayHaveMutated=false` is unambiguous; with `true` it joins `unknown` in requiring reconciliation.

`outcomeRequiresReconciliation(outcome, mayHaveMutated)` encodes both cases: `unknown` always, and `failed` when `mayHaveMutated === true`. Callers pass the result's flag through; for `unknown` the flag is advisory since reconciliation is required regardless.

## 6. Evidence level — what a passing validator means

`validateDispatchRequest`/`validateDispatchResult` check **shape and vocabulary only**. A structurally valid `completed` result is a claim, not evidence. Real-host promotion still requires the `native-probe-result/v1` artifact rules: an authorized session, a bounded completed probe-run or attributed dispatch segment, `err===0` `op` records for the operation id, and provenance declarations — per OS, never cross-promoted.

## 7. Non-goals / explicit limitations

- No transport is selected or implied; message shapes are transport-agnostic (ADR-0005 D4 Open Q1 unchanged).
- No consent token issuance, storage, or verification — `authorizationRef` is opaque by design.
- In-AE intake exists only as the **opt-in verification lane** of [native-channel.md](native-channel.md) (Issue #267 Slice A): a fixed read-only allowlist (`NATIVE_INTAKE_OPERATIONS`), off by default, and explicitly *not* the `dispatchable` gate — every committed operation still refuses `operation-not-dispatchable` through `resolveDispatchOperation`, and no intake result promotes a registry entry. The general dispatch path (arbitrary operation dispatch into the host-dispatched context) remains future work gated on the transport/authorization decisions above.
- No operation is dispatchable today (registry count: 0). `resolveDispatchOperation` refuses every committed entry — expected, honest state.
- Windows remains entirely UNVERIFIED.
