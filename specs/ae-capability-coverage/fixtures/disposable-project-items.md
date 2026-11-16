# Fixture — disposable project for project/items/comps/layers write tests (Issue #15)

> Status: **fixture definition**, not yet executed. Real-host write tests
> are gated on Issue #14 trusted execution and ae-a8n #97–#99; this document
> fixes *what* the fixture must contain so CAP029–CAP031 tests are
> reproducible when the gate opens. Evidence level today: none — no AE has
> run this fixture.

## Rules (inherited, non-negotiable)

- The fixture is a **disposable project created by the test harness** —
  never the operator's interactive project, never a saved user file.
- Every write test runs against this fixture (or a per-test clone); the
  "no unintended project write" invariant is checked by project-identity
  binding (trusted-execution design §3) plus before/after item counts.
- Fixture contents are expressed as *required structures*, not a binary
  `.aep`: the harness builds them through the same named operations under
  test where possible, so fixture creation is itself conformance evidence.

## Required structures

| # | Structure | Purpose |
| --- | --- | --- |
| F1 | Empty project (no items) | baseline create/import/save/close paths (CAP029) |
| F2 | Project with 2 footage items (distinct source files, one missing-on-disk path) | import/save/close, missing-footage behaviour, path resolution (CAP029/CAP031) |
| F3 | Comp "Main" (1920×1080, 30fps, 300 frames) + comp "Alt" | duplicate-name discrimination, comp create/delete/reorder (CAP030) |
| F4 | Comp "Main" layers: solid, text-less AV layer, **two layers with the same name** "Dup", a parented pair (child→parent), a layer with non-zero in-point | duplicate names, parenting, timing, selection (CAP030/CAP031) |
| F5 | Layer transform with 2+ keyframes | timing/transform read paths feeding #16 (CAP030 boundary) |
| F6 | Saved-then-reopened project | save/reload/ID-collision and reference-invalidation checks (CAP031) |

## Identity and invalidation hooks

- Every fixture item is addressed in tests by `aeRef` descriptor
  (type + name + index path [+ contentHash]) — never by bare name, so the
  duplicate-name rows (F4) prove `STALE_REFERENCE` behaviour rather than
  silent mis-resolution.
- The fixture records `projectIdentity` at creation; tests assert consent
  scope and mutation guards bind to it (trusted-execution U2/U3).

## Explicitly out of scope for this fixture

- Expressions, effects, render queue, text animation — #16's fixture.
- Native SDK/plugin load — #17/#18.
- Any assertion of real-host behaviour: until Issue #14 transport and
  ae-a8n consent gates open, this fixture is specification only.
