# Fixture — disposable project for animation/effects/render write tests (Issue #16)

> Status: **fixture definition**, not yet executed. Real-host write/render
> tests are gated on Issue #14 trusted execution, #15's structural fixture,
> and ae-a8n #97–#99; this document fixes *what* the fixture must contain so
> CAP033–CAP036 tests are reproducible when the gate opens. Evidence level
> today: none — no AE has run this fixture.

Builds on the #15 disposable-project fixture (`disposable-project-items.md`);
this document adds only the animation/effects/render structures.

## Required structures

| # | Structure | Purpose |
| --- | --- | --- |
| A1 | Solid layer with animated Position: ≥3 keyframes with non-default eases (speed/influence set) | keyframe read/write, interpolation values, `KeyframeEase` (CAP033) |
| A2 | Layer with a static expression on Opacity (e.g. `value * 0.5`) and one looped expression (`loopOut`) | expression get/set, expression-error reporting (CAP033) |
| A3 | Text layer with a TextDocument containing styled ranges (color/font/size spans) | CharacterRange/text APIs (CAP033) |
| A4 | Shape layer with a rectangle path + trim paths animated | shape/path APIs (CAP033) |
| A5 | Layer with mask (masked path, inverted variant) | mask APIs (CAP033) |
| A6 | Layer with two effects applied: one built-in effect present in every AE (e.g. Gaussian Blur) and one **deliberately absent** effect name recorded per AE version | effect stack add/remove/reorder, matchName vs displayName, absent-effect refusal (CAP034) |
| A7 | Render queue item targeting the comp from #15-F3 with a small frame range (e.g. frames 0–5) and a distinct output path inside the disposable run dir | render queue/output module, render load/unknown outcome (CAP035/CAP036) |
| A8 | Preferences snapshot taken before/after a preferences-touching test | preferences read/write scoping (CAP035) |

## Identity and invalidation hooks

- Effect instances and property groups are addressed via `aeRef`
  descriptors with type tags (`effect`, `propertyGroup`, `property`) —
  never by display name, since third-party/localized names differ.
- Effect matching uses `matchName` where the API exposes it; display-name
  matching is a fallback that must be recorded as such in evidence.
- Render tests assert typed outcomes only: a render that cannot prove
  completion is `UNKNOWN`, never `PASS`-by-timeout (CAP036, Issue #21
  matrix `render` dimension).

## Explicitly out of scope

- SmartFX/MFR/GPU callback fixtures — #18.
- Third-party effect binaries — coverage of "installed status" only via
  the catalog's `requiredPlugins` axis; no plugin is installed by this
  fixture.
- Any real-host claim: fixture is specification until the transport and
  consent gates open.
