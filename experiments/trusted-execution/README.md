# trusted-execution — CAP025–028 groundwork (Issue #14)

> Status: **reference implementation at fake/mock level.** Transport-agnostic
> contract pieces for trusted execution: the ES3 codec, permission-class
> mapping, consent scope, mutation guard and outcome vocabulary. This is
> **not** a transport, not a dispatcher, and not a shipped feature. Transport
> selection stays with ADR-0005; consent issuance and real-AE runs stay with
> ae-a8n #97–#99. See
> [`../../specs/ae-capability-coverage/design/trusted-execution.md`](../../specs/ae-capability-coverage/design/trusted-execution.md)
> for the design note these units implement.

## Layout

```
experiments/trusted-execution/
├── README.md                  # this file
├── codec/
│   └── trusted-codec.js       # ES3 strict codec (TrustedJson + ae* wrappers)
├── permissions.mjs            # CAP025/027: execution classes + consent scope
├── mutation-guard.mjs         # CAP027: aeRef resolution, project scope, retry policy
├── outcomes.mjs               # CAP028: write-outcome taxonomy + contract mapping
├── runner.mjs                 # CAP028: safe eval pipeline — consent gate → codec
│                              #   envelope → injected transport → outcome + retry
└── tests/
    ├── run.mjs                # node:test runner, zero deps
    ├── codec.test.mjs         # differential + refusal tests (node:vm, JSON removed)
    ├── permissions.test.mjs   # class resolution + consent-scope tests
    ├── mutation-guard.test.mjs# STALE_REFERENCE / project mismatch / retry policy
    ├── outcomes.test.mjs      # busy-vs-unknown, mayHaveMutated, undo separation
    └── runner.test.mjs        # consent-before-send, UNKNOWN no-resend, aeError pass-through
```

## Runner pipeline (CAP028)

`runner.mjs` is the client-side composition of the units above into one
safe eval path: `runScript({source, pin, operationId, consent, ...})`:

1. **validate** — non-empty source, ≤ `MAX_SOURCE_BYTES` (256 KiB);
   violations are `BLOCKED`/`not-sent` before anything else.
2. **consent** — `authorizeExecution` with `EVAL_ADVERTISEMENT`
   (`execute` permission → `trusted-dev-script`): requires explicit
   `trustedScriptOptIn`, `scriptProvenance`, and a consent token whose
   scope matches {session pin, operationId, argument hash, project}.
   Refusal ⇒ `BLOCKED`, transport is never called.
3. **send** — codec-serialized `{v:1, kind:"extendscript.eval", ...}`
   envelope through the **injected** `transport.send` (no channel is
   chosen here — ADR-0005 Open Q1). One deadline; no retry.
4. **classify** — `classifyWriteResult` + `toContractOutcome` +
   `retryDecision`: `UNKNOWN` quarantines and is never resent; host
   `aeError` fields (name/message/line/file) pass through verbatim for
   the diagnostics surface (Issue #37) — positions are host-reported,
   never inferred.

## Evidence level

Everything under `tests/` is **automated-test / fake-level** evidence: the
codec executes in `node:vm` with native `JSON` removed, which is the same
code path the ES3 host takes. No After Effects is involved. Real-host
verification is a separate, later gate (Issue #21 matrix); nothing here may
be reported as `verified on real host`.

## Codec contract (CAP026)

`codec/trusted-codec.js` exposes `TrustedCodec`:

- `stringify(value)` / `parse(text)` — strict JSON. The serializable set is
  exactly `null`, boolean, finite number, string, array, plain object.
  Functions, `undefined`, non-finite numbers, `Date`s and host objects are
  **refused**, never coerced. Nesting is depth-bounded.
- Domain wrappers (plain objects with a single marker key):
  - `codec.ref(type, name, path, contentHash?)` → `{"aeRef": {...}}` —
    stable identity descriptor for a host object; never a live handle.
  - `codec.enumValue(name, value)` → `{"aeEnum": {...}}` — enum name plus
    observed numeric value, so version skew is detectable.
  - `codec.path(path, pathKind)` → `{"aePath": {...}}` —
    `pathKind` ∈ `project-item | filesystem | absolute`.
  - `codec.error(name, message, line?, file?)` → `{"aeError": {...}}` —
    host exception with source-map position; absent fields stay absent.
- `parse` validates wrapper shapes, so a malformed `ae*` object arriving
  over the wire is refused at the codec boundary.

Known boundary: a host object whose `Object.prototype.toString` tag is
`[object Object]` is indistinguishable from a plain data object by type tag
alone. Keeping host objects off the wire is the **dispatcher's** wrapping
discipline (always `aeRef`); the codec enforces everything type tags can
express. This limitation is recorded, not hidden.

## Permission classes and consent (CAP025/CAP027 groundwork)

`permissions.mjs` implements the class layer that sits **after** the
catalog dispatch gate (`assertDispatchAllowed`):

- `executionClassFor(advertisement, permission)` resolves
  `read-only` / `intentional-write` / `trusted-dev-script` from the
  declared permission plus catalog axes; unmapped combinations return
  `null` and fail closed.
- `consentScopeFor(...)` builds the consent scope — session pin
  (`sessionId`/`aeVersion`/`dispatchId`), operation id, canonical
  argument hash (sha256), project identity. `canonicalJson` gives every
  JS value a distinct preimage: non-finite numbers, `undefined`,
  functions and non-plain objects get `#`-sentinels instead of collapsing
  to `null`/`{}` the way `JSON.stringify` would — consent for `{a: NaN}`
  can never silently cover `{a: null}`.
- `authorizeExecution(input)` enforces, in order: class resolution →
  per-class consent requirement (`session-pin` / `per-dispatch` /
  `explicit-opt-in`) → exact scope match. Consent never survives session
  re-pin, project change, or argument drift; `trusted-dev-script`
  additionally requires an explicit opt-in flag and a provenance
  declaration. Malformed dispatch input, session pin, operation id or
  consent scope are **typed refusals** (`MALFORMED_REQUEST` /
  `CONSENT_REQUIRED`), never exceptions.
- **Consent authenticity boundary:** this layer checks scope *equality*
  only. A consent token is unauthenticated plain data here — issuance,
  signing and verification against a trusted authority are production
  authorization (ADR-0005 / ae-a8n #97–#99) and deliberately absent. A
  forged-but-well-formed scope passes this check by design; do not read
  `pass` as production-grade authorization.

## Mutation guard and outcomes (CAP027/CAP028 groundwork)

- `mutation-guard.mjs` — `resolveDescriptor` resolves an `aeRef` against a
  plain project snapshot. Shape violations (missing/non-string `type` or
  `name`, non-array or non-integer `path`, wrong-typed `contentHash`) are
  `INVALID_REFERENCE` — a caller bug refused before lookup; a
  well-formed descriptor that fails to resolve is `STALE_REFERENCE`,
  never a best-effort re-resolution. `guardMutation` additionally binds
  the dispatch's project identity to the snapshot's (`PROJECT_MISMATCH` /
  `PROJECT_UNKNOWN`). `retryDecision` encodes the quarantine rule:
  `UNKNOWN` is never resent for any operation.
- `outcomes.mjs` — `classifyWriteResult` extends the probe outcome model
  to write paths: `BLOCKED`/`not-sent` only when nothing was dispatched,
  `REFUSED HOST_BUSY` only on **attributable host evidence**
  (`hostBusyEvidence: { source: "ae-host" | "os-signal",
  provedNonDispatch: true }`) — a bare boolean or client-side "AE seems
  busy" guess stays `UNKNOWN` per the probe outcome model, `FAILED`
  carries `mayHaveMutated` when the host cannot prove atomicity, and
  timeout after possible dispatch is always `UNKNOWN` +
  `mayHaveMutated: true`. `toContractOutcome` maps wire outcomes onto
  catalog contract §5 (`not-sent`/`refused`/`completed`/`failed`/
  `unknown`). Undo is a separate operation whose failure is never folded
  into the original operation's success.

## Running

```sh
node experiments/trusted-execution/tests/run.mjs
```
