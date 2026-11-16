# jsx-toolchain — TypeScript/modern JS → ExtendScript ES3 JSX (Issue #52)

Experiment-grade vertical slice of the P1 build lane
(`specs/ae-capability-coverage/design/dev-loop-lanes.md` §2.2).

## What it does

| Command | Purpose |
| --- | --- |
| `lint <file>` | ES3-compat lint on source (AST-based, not regex): bare module specifiers, object accessors, ES5+ builtins (`JSON.`, `Object.keys`, `forEach/map/…`, `Date.now`, `.bind`, `trim*`) |
| `build <file> [-o dir]` | single-file transpile TS/JS → ES5 JSX + Source Map v3 (`sourcesContent` inlined); `import`/`export` rejected (no bundler); re-lints the **output** structurally |
| `build-project <entry> [-o dir] [--name n]` | multi-file project: esbuild bundles the module graph → ES2015 IIFE → tsc lowers to ES5 → AST proof the result is ES3. Emits `<name>.jsx`, `<name>.jsx.map` (jsx→bundle) and `<name>.bundle.js` + `.bundle.js.map` (bundle→original TS) |
| `watch <entry> [-o dir] [--name n]` | initial `build-project`, then watches the entry + its import dependencies (esbuild metafile inputs) via `node:fs`; each rebuild prints one JSON status line (`ae-devtools.jsx-toolchain.watch/v1`) with `status`/`artifacts`/`diagnostics`/`ts`. Build failures are reported and watching continues; SIGINT exits cleanly |
| `check <file\|dir>` | `tsc --noEmit` against generated `src/ae-api.d.ts` (656 inventory symbols) + `src/ae-globals.d.ts` (ExtendScript host objects) + `src/scriptui.d.ts` (ScriptUI); directory mode typechecks the whole project including cross-file imports. `lib` is pinned to ES5 — ExtendScript has no DOM, and the default DOM lib's `File`/`Window`/`Event` collide with the real host globals (Issue #97) |
| `map <file.jsx.map> <line> [col]` | generated position → bundle position (single-file mode) |
| `resolve <outdir\|prefix> <line> [col]` | JSX position → original TS position via the two-hop map chain |
| `gen-ae-types` (`src/gen-ae-types.mjs`) | regenerate `src/ae-api.d.ts` from `inventories/scripting/generated/symbols.json` |

## How ES3 compatibility is proven

Two **separate** checks, reported under distinct diagnostic codes —
syntax-legality and host-API availability are different questions:

1. **ES3 grammar proof** (`src/es3-syntax.mjs`): the emitted JSX is
   parsed by acorn at `ecmaVersion: 3` — a real recursive-descent ES3
   grammar, not a node-kind whitelist. It accepts what ES3 accepts
   (array trailing commas, `with`, labels) and rejects what ES3 rejects
   (object trailing commas, getters, arrows, `let/const`, templates,
   destructuring, for-of, spread, classes). acorn still accepts ES3
   *future reserved words* as identifiers (`var class`, `o.class`), so
   `checkReservedWords` walks the AST and rejects the full ES3
   ReservedWord set (§7.5.3: keywords + future reserved + `null/true/
   false`) in identifier position. Object-literal keys
   (`{ default: 1 }`) are tolerated — JScript/ExtendScript accepts them
   and transpilers emit them.
2. **Runtime API compatibility** (`src/es3-api.mjs`): a curated table
   of builtins absent from the ExtendScript ES3 host (`JSON.*`,
   `Object.keys/defineProperty/setPrototypeOf/create/…`, `Date.now`,
   `Math.trunc`, `String.fromCodePoint`, unambiguous ES5 prototype
   methods like `.forEach(`/`.map(`/`.bind(`). ES3 members are
   deliberately NOT flagged: `Date.UTC`, `Date.parse`,
   `String.fromCharCode`, `String/Array.prototype.indexOf`,
   `Function.prototype.call/apply` are all legal ES3.

Source lint (`lint`, `lintSourceAst` in `src/es3-ast.mjs`) is a third,
source-level pass: module-syntax rules, bare import specifiers, object
accessors, and the same API table — it rejects constructs that cannot
survive the pipeline; it is not itself a proof.

### What this does NOT prove (guarantee scope)

- **Not a complete ES3 semantic proof.** The grammar parse proves the
  artifact *parses* as ES3; the API table proves no *known-absent*
  builtin is referenced. It does not model ExtendScript host objects
  (`$`, `app`, … — covered name-level by `check`/`ae-api.d.ts`),
  host-object quirks, JScript deviations, Unicode/number edge cases,
  or behavior differences between ES3-spec and the real engine.
- **Curated table, not exhaustive.** `es3-api.mjs` lists absences we are
  confident about. `.indexOf` is deliberately unflagged (ES3 on String,
  ES5 on Array — name alone cannot distinguish). A member absent from
  the table is not proof it exists on the host.
- **Bundler helpers are checked, not trusted.** esbuild/tsc helpers that
  need ES5 builtins fail closed: class fields under define semantics
  emit `Object.defineProperty`, class inheritance emits tsc's
  `__extends` (`Object.setPrototypeOf`/`Object.create`). Use
  `useDefineForClassFields: false` (see `fixtures/project-helpers`) and
  avoid `extends` for ES3-clean output.
- acorn `ecmaVersion: 3` is the closest machine-checkable ES3 grammar;
  it is not a spec-certified parser.

## Honest limitations

- TypeScript 5.9 removed `target=ES3`; we emit `target=ES5` and verify
  the output with the grammar parse + API check described above.
  `build-project` goes through esbuild at `es2015` first because
  esbuild cannot emit ES5.
- Module syntax: allowed in project mode only (bundled away); rejected
  in single-file `build`. Bare specifiers (`fs`, `lodash`) always fail —
  ExtendScript has no module loader.
- `ae-api.d.ts` is **generated** from the scripting inventory (656
  symbols) but the inventory records names/kinds/access, not
  signatures — members are `any`-typed. It catches typos and gives
  discovery; it does not check argument types. Absence of a member is
  not proof of absence in the real API. Inventory classes are emitted
  as `interface` plus a structural value side only where the host
  really supports `instanceof` (the inventory's `instanceofCaveat`
  marks classes whose `instanceof` throws or always returns false —
  those get no value side, so the check is a type error; `baseOnly`
  abstract bases get a call signature so `instanceof` works but `new`
  does not). `new X(...)` on the remaining classes and the rest-args
  signature are over-approximations since no signature data exists.
- `scriptui.d.ts` and the `ae-globals.d.ts` host objects are
  **hand-maintained**, modeled on `types-for-adobe@7.2.6` (MIT —
  `shared/ScriptUI.d.ts`, `shared/JavaScript.d.ts`, `shared/global.d.ts`
  at github.com/docsforadobe/Types-for-Adobe, accessed 2026-11-16) and
  the After Effects Scripting Guide. Member *names* and the inheritance
  shape are sourced; every member is `any`-typed. The package itself is
  not a dependency: its core typings redeclare ES5 builtins (colliding
  with the default lib) and its per-app typings would duplicate
  `ae-api.d.ts`.
- Member coverage is bounded by the inventory: classes with
  `memberCount: 0` (e.g. `TextLayer`) and incomplete enums (e.g.
  `PropertyValueType` lacks `OneD`/`TwoD`/…) still produce member-level
  diagnostics on real consumer code. Those are inventory gaps, not user
  errors — filling them requires regenerating the inventory, not this
  file.
- The sourcemap consumer covers the lookup path used for host error
  mapping; it is not a general-purpose library.
- Windows: UNVERIFIED (all real-host runs were macOS arm64).

## Verification

- `node tests/run.mjs` — 41 unit/fake tests (ES3 grammar adversarial
  cases, runtime-API table cases, false-positive/miss regressions,
  bundler-helper builds, multi-file bundle, two-hop sourcemap,
  generated typings, CLI).
- Real-host: `node real-run.mjs` requires the a8n-transport slice
  (Issue #49 / Draft PR #50) **and** a local ae-a8n build containing the
  #103 + #105 fixes; see `EVIDENCE.md` for what actually ran. The
  multi-file/project pipeline is automated-test only — it has NOT been
  exercised on a real host.
