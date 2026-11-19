# Design note — trusted execution boundary (Issue #14, CAP025–028)

- Status: **Proposed design note**, not an accepted contract. Architecture
  choices remain gated by ADR-0005 and ae-a8n #97–#99.
- Parent spec: [spec.md](../spec.md); plan: [plan.md](../plan.md);
  catalog contract: [contracts/capability-catalog.md](../contracts/capability-catalog.md).
- Prerequisite outputs: PR #28 (read-only probe session pinning / outcome
  model, merged as `61174e3`) and PR #29 (capability catalog fail-closed
  gates, merged as `9e99e1e`) are integrated on `release-0-1-0`; this note
  consumes their *decided semantics* and does not re-open them.

## 1. Permission classes (CAP025)

Three execution classes, mapped onto the catalog's existing axes rather
than a parallel permission system:

| Class | Catalog precondition | Declared `Permission` | Consent | Examples |
| --- | --- | --- | --- | --- |
| `read-only` | `implementation=implemented`, `verification!=not-run`, `execution.canRemoteInvoke===true` | `read` | target pin only (session identity) | `identify`, `ping`, `snapshot`, `sysinfo` |
| `intentional-write` | same + `access` ∈ {`write`, `read-write`} and per-operation manifest entry | `write` | explicit per-dispatch consent token + disposable-project scope | named comp/layer/property operations |
| `trusted-dev-script` | same + `risk.trust="privileged-dev-code"` | `execute` | explicit opt-in flag; never reachable via generic untrusted RPC | operator-supplied ExtendScript |

Known contract gap (recorded, not silently patched): `risk.trust` admits
`"privileged-dev-code"` (`schema.ts`), but `riskForAccess` never produces
it — no `AccessClass` maps to it today. Until the catalog gains an access
class or an explicit override path, a `trusted-dev-script` row cannot be
expressed without hand-editing `risk`. This is a §7-compatible schema
question for a follow-up, not something this note resolves.

Rules:

- `assertDispatchAllowed` gating applies **before** consent is even
  evaluated; an unimplemented/unverified/no-execution-path row refuses
  regardless of consent (fail-closed order preserved from the catalog).
  As finalized on PR #29 head `45665bc`: the dispatch must declare its
  permission class (required, closed enum), and ownership is proven only
  by the handshake's attested `target.ownership` — caller claims corroborate
  but never override. Write classes additionally require the consent scope
  below; `negotiate` remains metadata preflight only.
- Arbitrary runtime code evaluation is a separate privileged action. No
  request field may cause a string to be `eval`'d implicitly; the script
  body is always an explicit, separately-authorized payload.
- Consent is scoped to (session pin, operation id, argument hash). It does
  not survive session re-pin, dispatcher re-activation, or project change.
  The argument hash uses a canonical encoding in which non-finite numbers,
  `undefined` and non-plain objects cannot collide with `null`/`{}` the
  way `JSON.stringify` would collapse them — consent issued for one value
  never silently covers a different one. Consent *scope equality* is what
  this layer checks; token issuance/authenticity is production
  authorization (ADR-0005, ae-a8n #97–#99), not implied by a `pass` here.
  Malformed pins, operation ids, dispatch inputs and consent scopes are
  typed refusals, never exceptions (same discipline as the catalog
  gate's malformed-response).

## 2. ES3 codec rules (CAP026)

- Wire values are JSON produced/consumed **inside the ES3 host** by the
  dispatcher's own codec (native `JSON` is not assumed — the probe host
  already ships a private codec; reuse that pattern).
- Serializable set: `null`, boolean, finite number, string, array, plain
  object. Host objects (Project, Comp, Layer, Property, Item) are **never**
  exported — only their stable identity descriptors (§3) and primitive
  snapshots.
- Enum-like values serialize as their string name plus the numeric value
  observed, so version skew is detectable rather than silently coerced.
- Paths serialize as project-relative POSIX-style strings with an explicit
  `pathKind` (`project-item` | `filesystem` | `absolute`); absolute
  filesystem paths require the write class and are recorded in trace.
- Errors carry `{ name, message, line?, file? }` where available; the host
  maps its stack position into the reply so the client can source-map
  without trusting client-side guesses. Missing position fields stay
  absent — they are not fabricated.

## 3. Identity and invalidation (CAP027 groundwork)

- Every mutating request binds to the **pinned session identity**
  (`sessionId`, `aeVersion`, `dispatchId`) established by the read-only
  probe semantics: existing pins are immutable unless explicitly re-pinned.
- Project identity is part of the consent scope: a write consent issued
  against project A does not apply after project close/open or a detected
  `projectOpen` transition.
- Host-object references use **snapshot identity descriptors**
  (name + index path + type tag + content hash where cheap), never live
  handles. A descriptor that fails to resolve at dispatch time is
  `REFUSED STALE_REFERENCE`, not a best-effort re-resolution. A
  descriptor whose *shape* violates the `aeRef` contract (the codec's
  type/name/path requirements) is `REFUSED INVALID_REFERENCE` — a caller
  bug refused before any lookup, kept distinct from state drift so the
  two failure modes are not conflated.
- Idempotency: operations that cannot prove idempotence are marked
  `idempotent: false` in the manifest; the client must not auto-retry them
  after `UNKNOWN` (same rule as the probe: unknown outcome is quarantined,
  never resent).

## 4. Outcome model (CAP028 groundwork)

Reuse the probe's outcome taxonomy verbatim so read and write paths share
one vocabulary:

- `COMPLETED` — host acknowledged and returned a result.
- `REFUSED <code>` — terminal, pre-execution rejection (`WRONG_TARGET`,
  `MISSING_PERMISSION`, `NOT_IMPLEMENTED`, `UNVERIFIED`,
  `NO_EXECUTION_PATH`, `STALE_REFERENCE`, `INVALID_REFERENCE`,
  `CONSENT_REQUIRED`, `CONSENT_SCOPE_MISMATCH`, `MALFORMED_REQUEST`,
  ...). Releases the in-flight guard immediately.
- `FAILED` — executed and reported an error; includes partial-mutation
  flag when the host cannot prove atomicity.
- `UNKNOWN` — dispatched or possibly dispatched, no definitive reply;
  in-flight guard held until deadline, **never auto-retried**, request
  artifact retained for manual reconciliation.
- `BLOCKED` — client-side guard (one-in-flight, expired marker); nothing
  was sent.

Vocabulary bridge to the catalog contract (§5): the probe's wire
outcomes are the same five states under different spelling —
`COMPLETED`↔`completed`, `REFUSED <code>`↔`refused`, `FAILED`↔`failed`,
`UNKNOWN`↔`unknown`, and `BLOCKED`↔`not-sent` (environment-proven
non-dispatch). Write paths reuse this mapping verbatim; `BLOCKED`/
`not-sent` remains the only outcome that may be re-issued, and only as a
new request after re-authorization (§4 invariants of the probe outcome
model apply unchanged).

Additional write-specific rules:

- AE UI busy / modal state → `REFUSED HOST_BUSY` (pre-execution) rather
  than `UNKNOWN`, **only** on attributable host evidence — an in-host
  typed signal or an OS-visible attributable signal that also proves this
  request was not dispatched (probe outcome-model rule, binding). A
  client-side "AE seems busy" inference, a bare flag, or evidence without
  proven non-dispatch stays `UNKNOWN`.
- Undo is a separate named operation; a failed undo is `FAILED`, never
  folded into the original operation's success.
- Timeout-after-possible-dispatch is always `UNKNOWN`; the client records
  `mayHaveMutated: true` in trace.

## 5. Transport-independent implementation units

Decomposition of CAP025–028 into units that need no transport decision
(ADR-0005 Open Q1) and no real AE. Each lands as its own reviewable
commit/PR on this Issue's branch; fake-level evidence is labelled
`fake/mock only`, never promoted.

| Unit | CAP | Content | Depends on |
| --- | --- | --- | --- |
| U1 codec | CAP026 | ES3 strict codec: serializable-set enforcement, `aeRef`/`aeEnum`/`aePath`/`aeError` wrappers, error source-map fields; differential `node:vm` tests (JSON removed) | none — reference implementation pending runtime placement |
| U2 permission classes | CAP025 | permission-class → catalog axis mapping as data + pure check functions mirroring `assertDispatchAllowed` order; consent-scope shape (session pin + operation id + argument hash) | catalog contract (merged) |
| U3 mutation guard | CAP027 | snapshot identity descriptor resolve/refuse (`STALE_REFERENCE`), project-identity scoping, `idempotent` flag handling, `mayHaveMutated` trace field | U1 (descriptor codec), U2 |
| U4 outcome extension | CAP028 | write-outcome taxonomy (`HOST_BUSY` typed refusal, undo `FAILED`, timeout→`UNKNOWN`+`mayHaveMutated`), fake-responder tests reusing the probe harness pattern | U1–U3 |

Explicitly **not** in these units: transport selection, consent token
issuance/storage, dispatcher activation, any real-AE run. Those stay
behind ADR-0005 and ae-a8n #97–#99.

## 6. Open decisions (explicitly not fixed here)

- Transport selection remains ADR-0005's; this note assumes only a
  request/reply channel with the probe's pinning semantics.
- Consent token format and storage (per-dispatch vs session-scoped
  capability grant) — needs threat-model pass under `docs/security.md`.
- Whether `trusted-dev-script` lives in ae-devtools or delegates entirely
  to an ae-a8n static extension — depends on ae-a8n #97–#99 outcomes.
- ES3 codec canonical schema versioning — to be fixed when the first
  write operation is implemented, versioned alongside the catalog contract.

## 7. What this note does not claim

- No transport, no consent UX, and no write operation is implemented by
  this document.
- Fake-host coverage of these rules is `fake/mock only` until real-AE
  evidence exists per OS; Windows stays `UNVERIFIED` until Issue #21's
  gate.

## 8. Native-channel mutation path — concrete design (Issue #318 follow-up)

Design only — nothing in this section is implemented. It fixes how a
future mutating `NATIVE_INTAKE_OPERATIONS` entry would satisfy §1–§4 on
the file channel (`contracts/native-channel.md`), reusing guarantees the
channel already has instead of inventing parallel machinery.

### 8.1 Authorization

- A mutating op enters the allowlist only with a catalog row whose
  `access` is `write`/`read-write` and a manifest `idempotent` flag —
  the same §1 preconditions as every write class. Intake membership
  still never promotes dispatchability.
- Consent scope = (session pin, operationId, canonical arg hash). On the
  file channel the pin is already carried: `session.{sessionId,
  aeVersion, sdkRelease}` is shape-validated today and `channel.json`'s
  `sessionAeVersion` pin already refuses `WRONG_TARGET` on mismatch —
  project identity joins the scope via the §7e `aeRefProject` descriptor
  (index + name + path), which is exactly the corroborated identity a
  consent must bind to.
- The arg hash covers the **canonical serialized args object**,
  including descriptor bytes verbatim — consent issued for descriptor D
  never covers a mutated D' (same argument-hash rule as §1).
- `authorizationRef` stays opaque: the plug-in checks presence/shape
  only; token issuance, storage, and verification are ae-a8n-owned
  (ADR-0005, ae-a8n #97–#99). The channel cannot prove a consent token
  is genuine — that boundary is documented, not patched over.

### 8.2 Audit

- The evidence window already brackets every dispatch:
  `SPBasicSuite.AcquireSuite`/`ReleaseSuite` + resolution records +
  the op's own `AEGP_*` record in `opCalls`, plus the atomic
  `*.result.json` artifact and the retained `*.claimed` file. A
  mutating op adds no new evidence channel — it inherits this trail.
- `mayHaveMutated` becomes meaningful: read-only paths hardcode `false`;
  a mutating op sets `true` whenever the outcome cannot prove the host
  call did not run (§8.3). The field already exists in the result
  schema — the contract change is semantic, not structural.
- Request artifacts are retained for reconciliation: `*.claimed` is
  never deleted before a verdict publishes, and a crash leaves it as
  evidence (native-channel.md §5). Mutations additionally record the
  pre-dispatch descriptor state (the resolved identity fields) in the
  request file itself — the file is already the audit input.

### 8.3 UNKNOWN and reconciliation

- The channel's existing rule carries over verbatim: a claimed request
  whose plug-in crashes or whose result publish fails is client-side
  `UNKNOWN`, **never resent**, `mayHaveMutated:true` in trace.
  `not-sent` (unclaimed/expired/suite-unavailable) remains the only
  re-issuable outcome, and only as a new request after re-authorization.
- Reconciliation is read-back, not retry: after `UNKNOWN` the client
  re-issues the read-only descriptor getters (§7b–§7f) against the same
  descriptors. If the descriptors still resolve and state reads match
  the intended post-state, the mutation provably landed; if state is
  unchanged, it provably did not (for ops whose effect is observable
  through existing getters). Where an op's effect is **not**
  observable through any allowlisted getter, the manifest must mark it
  `idempotent:false` + `reconcilable:false`, and `UNKNOWN` stays
  quarantined for manual reconciliation — never guessed.
- Timeout-after-possible-dispatch is always `UNKNOWN` (§4); the
  `STALE_REQUEST` pre-execution refusal stays `not-sent` because claim
  order proves non-dispatch.
- Undo is a separate named mutating op with its own consent scope and
  `idempotent:false`; a failed undo is `FAILED`, never folded into the
  original outcome (§4).

### 8.4 What must change before the first mutating op

1. Catalog/manifest rows for the specific members (access, idempotent,
   reconcilable flags) — per-op review, not a blanket write class.
2. `native-channel.md` §4/§8: `mayHaveMutated` semantics for mutating
   ops + consent-scope fields (`authorizationRef` shape check).
3. Fake-host mutation fixtures proving: consent-scope mismatch refuses
   before any AEGP call; `UNKNOWN` path never resends; reconciliation
   read-back distinguishes landed/not-landed.
4. Real-host evidence per #223 before any `verified` claim — fake
   coverage here is `fake/mock only`.
