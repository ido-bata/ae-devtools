# jsx-toolchain — TypeScript/modern JS → ExtendScript ES3 JSX (Issue #52)

Experiment-grade vertical slice of the P1 build lane
(`specs/ae-capability-coverage/design/dev-loop-lanes.md` §2.2).

## What it does

| Command | Purpose |
| --- | --- |
| `lint <file>` | ES3-compat lint on source (AST-based, not regex): bare module specifiers, object accessors, ES5+ builtins (`JSON.`, `Object.keys`, `forEach/map/…`, `Date.now`, `.bind`, `trim*`) |
| `build <file> [-o dir]` | single-file transpile TS/JS → ES5 JSX + Source Map v3 (`sourcesContent` inlined); `import`/`export` rejected (no bundler); re-lints the **output** structurally |
| `build-project <entry> [-o dir] [--name n]` | multi-file project: esbuild bundles the module graph → ES2015 IIFE → tsc lowers to ES5 → AST proof the result is ES3. Emits `<name>.jsx`, `<name>.jsx.map` (jsx→bundle) and `<name>.bundle.js` + `.bundle.js.map` (bundle→original TS) |
| `check <file\|dir>` | `tsc --noEmit` against generated `src/ae-api.d.ts` (656 inventory symbols) + `src/ae-globals.d.ts`; directory mode typechecks the whole project including cross-file imports |
| `map <file.jsx.map> <line> [col]` | generated position → bundle position (single-file mode) |
| `resolve <outdir\|prefix> <line> [col]` | JSX position → original TS position via the two-hop map chain |
| `gen-ae-types` (`src/gen-ae-types.mjs`) | regenerate `src/ae-api.d.ts` from `inventories/scripting/generated/symbols.json` |

## How ES3 compatibility is proven

Regexes are gone. `src/es3-ast.mjs` parses source and emitted output with
the TypeScript compiler's parser:

- **Source lint** walks the AST: ES5+ builtins are detected by syntax
  shape (`JSON.parse`, `x.forEach(`), bare import specifiers and object
  accessors are errors. Keywords inside strings/comments cannot trigger
  it — there is no text matching.
- **Output proof** parses the emitted JSX and requires every node to be
  an ES3-legal kind: arrows, classes, template literals, let/const,
  destructuring, spread, for-of, shorthand properties, accessors —
  anything outside the whitelist fails with a source position. This is
  the actual ES3 guarantee; a wrong transpile target cannot ship.

## Honest limitations

- TypeScript 5.9 removed `target=ES3`; we emit `target=ES5` and prove
  the output ES3-clean structurally. `build-project` goes through
  esbuild at `es2015` first because esbuild cannot emit ES5.
- Module syntax: allowed in project mode only (bundled away); rejected
  in single-file `build`. Bare specifiers (`fs`, `lodash`) always fail —
  ExtendScript has no module loader.
- `ae-api.d.ts` is **generated** from the scripting inventory (656
  symbols) but the inventory records names/kinds/access, not
  signatures — members are `any`-typed. It catches typos and gives
  discovery; it does not check argument types. Absence of a member is
  not proof of absence in the real API.
- The sourcemap consumer covers the lookup path used for host error
  mapping; it is not a general-purpose library.
- Windows: UNVERIFIED (all real-host runs were macOS arm64).

## Verification

- `node tests/run.mjs` — 26 unit/fake tests (AST lint adversarial cases,
  multi-file bundle, two-hop sourcemap, generated typings, CLI).
- Real-host: `node real-run.mjs` requires the a8n-transport slice
  (Issue #49 / Draft PR #50) **and** a local ae-a8n build containing the
  #103 + #105 fixes; see `EVIDENCE.md` for what actually ran. The
  multi-file/project pipeline is automated-test only — it has NOT been
  exercised on a real host.
