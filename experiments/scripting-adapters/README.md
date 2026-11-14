# scripting-adapters — public Scripting API operation registry (Issue #15)

Versioned operation registry mapping Issue #15's domain
(project/items/comps/layers/selection/parenting/timing) onto the public
After Effects Scripting API — per the issue, NOT per-symbol MCP tools.

## Pieces

- `registry.mjs` — `OPERATIONS`: each op has a stable id, domain,
  `permission:"execute"`, `mutating` flag, claimed inventory symbol ids
  (`provisional.ae.scripting.*`), arg schema, and `source(args)` emitting
  ES3 ExtendScript for the trusted-execution runner. `buildSource()`
  validates args then emits source; `registryReport()` summarizes.
- `fake-app.mjs` — minimal ExtendScript `app` surface (1-based
  collections via Proxy) so generated sources actually execute in tests.
- `tests/` — registry contract (member ids exist in
  `inventories/scripting/generated/symbols.json`, ES3-safe output, arg
  validation) + fake execution (comp/layer lifecycle, same-name type
  guard, not-found/wrong-type errors).

## Coverage honesty

- Ops claim symbol ids; tests verify each id exists in the inventory.
- `mutating:false` only for `read.projectSummary`; everything else
  mutates project/AE state (feeds agent-loop dirty-state gating).
- Adapter-level `implemented` ≠ verified: all ops are fake-level until
  disposable-project real-host tests run (Issue #15 acceptance —
  BLOCKED on owned AE session).
- #16 domains (animation/effects/render) reuse this contract; domain
  defs live in `specs/ae-capability-coverage/domains/`.

## Run

    node tests/run.mjs
