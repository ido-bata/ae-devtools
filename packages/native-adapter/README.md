# @ae-devtools/native-adapter

Native SDK adapter **contract level** work — Issue
[#19](https://github.com/ido-bata/ae-devtools/issues/19), task **CAP046**
(class-vs-operation redesign + CAP047 decomposition groundwork).

This package contains:

- `src/negotiate.ts` — the adapter↔native-host **version negotiation**
  contract (`ae-devtools/native-adapter-handshake/v2`): adapter protocol
  version, SDK release identity, and **per-operation** availability,
  all fail-closed.
- `src/matrix.ts` — the reader for
  `inventories/sdk/generated/aggregate.coverage-matrix.json`, the
  canonical coverage record (CAP045/CAP048 groundwork). Matrix classes
  are **reporting metadata only — never dispatchable**.
- `src/operations.ts` — the committed **per-operation registry**: the
  only place dispatchability is defined. Each entry carries
  `implemented`/`verifiedOnRealHost` evidence; `dispatchable` requires
  both. Seeded with the 21 AEGP/SPBasicSuite calls that
  `experiments/native-sdk/minimal-plugin/src/probe.cpp` actually makes.
- `src/probe-result.ts` — validator for the NativeProbe result contract
  (`ae-devtools/native-probe-result/v1`;
  `specs/ae-capability-coverage/contracts/native-probe-result.md`).
- `src/templates.ts` + `scripts/render-templates.ts` — generator for the
  per-class adapter kits under `templates/<class>/kit.md`.
- `templates/` — generated kits plus one authored concrete fixture
  (`build-test-lifecycle/fixture.sweetie-checkout.json`).

## Evidence level — read first

**Everything here is template/contract level. Nothing is
`verified-real-host`.** No After Effects process is launched, no plug-in
is built or loaded by this package, and no inventory-only API is
treatable as callable. The coverage matrix itself records
`verification: "not-run"` / `realHost: "not-run"`. Negotiation
`compatible` means "versions and advertised per-operation availability
line up" — it is not authorization and not behavioural proof.

**Dispatchable operation count today: 0.** All 21 registry entries are
`implemented-unverified` (NativeProbe compiles on macOS arm64; no
authorized AE session has loaded it).

## Negotiation contract (summary)

Normative description:
[`specs/ae-capability-coverage/contracts/native-adapter.md`](../../specs/ae-capability-coverage/contracts/native-adapter.md).
Ownership boundary: ADR-0005 D2 assigns the version-negotiation
*contract surface* to ae-devtools and runtime handshake execution to
ae-a8n; this package implements only the contract side.

Two messages, both `ae-devtools/native-adapter-handshake/v2`:

- `AdapterHello` (client → host): `adapterId`, `adapterVersion`,
  `protocolVersion {major, minor}`, required `sdkRelease
  {identifier, distribution}`, `requiredOperations` (concrete
  `"<Suite>.<member>"` ids), optional `acceptableStates` (default
  `["dispatchable"]`).
- `HostHello` (host → client): `hostId`, `protocolVersion`, actual
  `sdkRelease`, per-operation `{state, note}` advertisement, optional
  `classes` reporting echo.

`negotiate()` refuses, in order: `malformed-message`,
`incompatible-protocol-version` (major), `unsupported-minor-version`
(client minor newer than host), `sdk-release-mismatch` (exact
identifier+distribution match required), `operation-unavailable` (not
advertised, or advertised below the client's acceptable states).

Malformed includes: unknown operation ids, a host advertising
`dispatchable` for an entry lacking `implemented &&
verifiedOnRealHost` registry evidence, any advertised state stronger
than the registry derives, and **any matrix class advertised as
dispatchable** — class-level promotion is rejected outright.

This negotiation is distinct from the capability-catalog handshake
(`packages/capability-catalog/src/handshake.ts`): that negotiates
catalog capability IDs; this negotiates the plug-in boundary itself.
Per-capability dispatch authorization remains
`assertDispatchAllowed` — a compatible negotiation never bypasses it.

## Templates

`templates/<class>/kit.md` is generated per coverage-matrix class
(`build-test-lifecycle`, `external-command`, `host-callback`,
`in-host-plugin-command`, `unsupported-or-unknown`). Each kit carries
the class's matrix status verbatim **as reporting metadata** and
contains three fill-in sections: per-operation command envelope,
fixture, build-test — or, for `unsupported-or-unknown`, a
refusal/waiver record per spec FR-013.

```sh
bun install
bun run render   # regenerate templates/ from the coverage matrix
bun run verify   # fail on any drift between templates/ and the matrix
bun test         # unit tests
bunx tsc --noEmit
```

## Non-goals

- No SDK plug-in dispatch implementation.
- No claim that inventory-only classes or operations are callable.
- No real-host evidence of any kind; Windows remains entirely
  UNVERIFIED (macOS SDK distribution only).
