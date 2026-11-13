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
└── tests/
    ├── run.mjs                # node:test runner, zero deps
    └── codec.test.mjs         # differential + refusal tests (node:vm, JSON removed)
```

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

## Running

```sh
node experiments/trusted-execution/tests/run.mjs
```
