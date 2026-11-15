# @ae-devtools/native-adapter

Native SDK adapter **contract level** work — Issue
[#19](https://github.com/ido-bata/ae-devtools/issues/19), task **CAP046**.

This package contains:

- `src/negotiate.ts` — the adapter↔native-host **version negotiation**
  contract: adapter protocol version, SDK release identity, and
  per-suite-family availability, all fail-closed.
- `src/matrix.ts` — the reader that derives every status label from
  `inventories/sdk/generated/aggregate.coverage-matrix.json`, the
  canonical coverage record (CAP045/CAP048 groundwork, commit 4628623).
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
`compatible` means "versions and advertised availability line up" — it
is not authorization and not behavioural proof.

## Negotiation contract (summary)

Normative description:
[`specs/ae-capability-coverage/contracts/native-adapter.md`](../../specs/ae-capability-coverage/contracts/native-adapter.md).
Ownership boundary: ADR-0005 D2 assigns the version-negotiation
*contract surface* to ae-devtools and runtime handshake execution to
ae-a8n; this package implements only the contract side.

Two messages, both `ae-devtools/native-adapter-handshake/v1`:

- `AdapterHello` (client → host): `adapterId`, `adapterVersion`,
  `protocolVersion {major, minor}`, required `sdkRelease
  {identifier, distribution}`, `requiredFamilies`, optional
  `acceptableStates` (default `["dispatchable"]`).
- `HostHello` (host → client): `hostId`, `protocolVersion`, actual
  `sdkRelease`, per-family `{state, note}` advertisement.

`negotiate()` refuses, in order: `malformed-message`,
`incompatible-protocol-version` (major), `unsupported-minor-version`
(client minor newer than host), `sdk-release-mismatch` (exact
identifier+distribution match required), `unknown-suite-family`,
`suite-family-unavailable` (not advertised, or advertised below the
client's acceptable states). Unknown is never treated as available.

Family states: `dispatchable` (reserved — only claimable for a matrix
row with `implemented && verifiedOnRealHost`; **no row qualifies
today**), `build-probe-only`, `inventory-only`,
`unsupported-or-unknown`. `hostHelloFromMatrix()` builds an honest host
advertisement straight from the coverage matrix; against the current
matrix it refuses every required family — that is the intended
fail-closed posture.

This negotiation is distinct from the capability-catalog handshake
(`packages/capability-catalog/src/handshake.ts`): that negotiates
catalog capability IDs; this negotiates the plug-in boundary itself.
Per-capability dispatch authorization remains
`assertDispatchAllowed` — a compatible negotiation never bypasses it.

## Templates

`templates/<class>/kit.md` is generated per coverage-matrix class
(`build-test-lifecycle`, `external-command`, `host-callback`,
`in-host-plugin-command`, `unsupported-or-unknown`). Each kit carries
the class's matrix status verbatim and contains three fill-in
sections: adapter command envelope, fixture, build-test — or, for
`unsupported-or-unknown`, a refusal/waiver record per spec FR-013.

```sh
bun install
bun run render   # regenerate templates/ from the coverage matrix
bun run verify   # fail on any drift between templates/ and the matrix
bun test         # unit tests
bunx tsc --noEmit
```

## Non-goals

- No SDK plug-in dispatch implementation.
- No claim that inventory-only families are callable.
- No real-host evidence of any kind; Windows remains entirely
  UNVERIFIED (macOS SDK distribution only).
