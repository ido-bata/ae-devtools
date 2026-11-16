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
- `execute.mjs` — `runOperation()`: the ONLY dispatch path. Validates
  args, computes the consent scope itself (approval independence),
  requires an injected `consentProvider` for EVERY op (absence is a
  refusal, not an approval), forwards to `createJsxRunner()` with
  `mayMutatePartial` for mutating ops, and surfaces `mutating`/
  `destructive` metadata on the outcome. destructive ops still ride
  the execute consent class — a stronger destructive gate is a
  recorded non-claim (Issue #15).
- `fake-app.mjs` — minimal ExtendScript `app` surface (1-based
  collections via Proxy) so generated sources actually execute in tests.
- `tests/` — registry contract (member ids exist in
  `inventories/scripting/generated/symbols.json`, ES3-safe output, arg
  validation) + fake execution (comp/layer lifecycle, same-name type
  guard, not-found/wrong-type errors).

## Coverage honesty

- Ops claim symbol ids; tests verify each id exists in the inventory.
- `mutating:false` only for `read.projectSummary`; `destructive:true`
  on project.new/open/close + item.remove (lifecycle/data-loss class).
- Type discrimination uses `instanceof` ctor args, property access
  uses matchName (`ADBE ...`) — `typeName`/display names are localized
  and never branched on; results serialize via a hand-rolled ES3
  serializer (host `JSON` is not guaranteed).
- Adapter-level `implemented` ≠ verified: all ops are fake-level until
  disposable-project real-host tests run (Issue #15 acceptance —
  BLOCKED on owned AE session).
- #16 domains (animation/effects/render) are implemented on the same
  contract: anim.setValue/setKeyframe/setExpression, effect.add,
  render.queueComp/render.renderQueued — keyframe/expression/effect/
  render-queue each exercised as real fake-state mutations.

## Run

    node tests/run.mjs
