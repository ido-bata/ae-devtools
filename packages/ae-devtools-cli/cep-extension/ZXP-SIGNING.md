# ZXP-SIGNING — `.zxp` signing decision note (Issue #193, CAP058)

Decision record only. **No signing was executed or is planned in this
repository**; this note fixes the policy the dev loop and any future
distribution path follow.

## Options considered

1. **Unsigned debug-load (`PlayerDebugMode`)** — the documented CEP
   development path. Per the CEP HTML Extension Cookbook, setting
   `PlayerDebugMode=1` for the CSXS version domain bypasses the extension
   signature check:
   - macOS: `defaults write com.adobe.CSXS.<n> PlayerDebugMode 1`
   - Windows: `regedit > HKCU\Software\Adobe\CSXS.<n>`, string value `1`
     (Windows registry path is **UNVERIFIED** — modeled in
     `lifecycle.mjs` `playerDebugModeStatus` as unsupported/off-darwin;
     see EVIDENCE.md)
   - `lifecycle.mjs` already reports this setting **read-only**; it never
     writes it. Writing it remains a load-proof authorization decision
     (LOAD-PROOF.md).

2. **Signed `.zxp` distribution** — pack the extension with ZXPSignCmd
   and an Adobe-issued signing certificate (`.p12`/`.pfx` + password).
   Required for any distribution path where `PlayerDebugMode` cannot or
   should not be set (end users, CEP exchange submission, post-2027 CEP
   submission rules per Adobe's CEP→UXP transition blog).

## Decision

- **Dev loop: unsigned debug-load via `PlayerDebugMode`.** This is the
  only path this repo mechanizes. Rationale: zero certificate handling,
  zero secret material in the repo, matches how every CEP dev loop is
  documented to work, and keeps the safety boundary clean — enabling
  unsigned panels is an explicit, recorded, per-host operator action,
  never something the tooling does silently.
- **Distribution: signed `.zxp` is the required future path**, deferred
  to a separate milestone. When it lands it needs: ZXPSignCmd invocation
  (external Adobe tool, not vendored), certificate storage outside the
  repo (never committed), and per-OS `PlayerDebugMode` handling for the
  dev path alongside it.
- **UXP note:** if/when UXP reaches GA, its packaging/signing path is a
  different mechanism entirely; this decision does not pre-judge it
  (CAP060 stays BLOCKED/UNVERIFIED).

## Evidence level

- `PlayerDebugMode` mechanism: **source-reviewed** (Adobe CEP
  documentation) + **verified on real host** that the keys exist and are
  already set on the dev Mac (EVIDENCE.md). Effect on *our* extension:
  **UNVERIFIED** (no load proof yet).
- `.zxp` / ZXPSignCmd: **not exercised** — decision only, no execution,
  no certificate handling implemented.
- Windows `PlayerDebugMode` registry path: **UNVERIFIED** (documented in
  Adobe docs; no Windows host).
