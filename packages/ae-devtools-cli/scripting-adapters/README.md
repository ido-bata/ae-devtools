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
- Existing-item selector args (`compName`, item-target `name` such as
  `item.remove`/`item.setLabel`/`read.itemDetail`, `footageName`, and
  folder selectors `parentFolder`) accept either a legacy name string
  or an `itemRef` object `{id?, name?, path?, project?}`. `id` uses
  `Project.itemByID` (project-local persistent id); `name`+`path`
  resolves a unique direct child under a folder path from
  `Project.rootFolder`; `id` with `name`/`path`/`project` treats them
  as consistency checks (`project` compares `Project.file.fsName` and
  requires a saved project). Legacy strings keep project-wide
  name+type lookup and still refuse same-name ambiguity. `id` is only
  meaningful inside the project bound by the dispatch's
  `projectIdentity`/session pin — the selector does not prove
  cross-project identity by itself, and unsaved projects have no
  `Project.file` to check against.
- Adapter-level `implemented` ≠ verified: all ops are fake-level until
  disposable-project real-host tests run (Issue #15 acceptance —
  BLOCKED on owned AE session).
- #16 domains (animation/effects/render) are implemented on the same
  contract: anim.setValue/setKeyframe/setExpression, effect.add,
  render.queueComp/render.renderQueued — keyframe/expression/effect/
  render-queue each exercised as real fake-state mutations.

## Run

    node tests/run.mjs
