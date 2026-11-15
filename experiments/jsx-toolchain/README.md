# jsx-toolchain — TypeScript/modern JS → ExtendScript ES3 JSX (Issue #52)

Experiment-grade vertical slice of the P1 build lane
(`specs/ae-capability-coverage/design/dev-loop-lanes.md` §2.2).

## What it does

| Command | Purpose |
| --- | --- |
| `lint <file>` | ES3-compat lint on source: rejects `import`/`export`, ES5+ builtins absent from ExtendScript (`JSON.`, `Array.isArray`, `Object.keys`, `forEach/map/…`, `Date.now`, `.bind(`, `trim*`) |
| `build <file> [-o dir]` | transpile TS/JS → ES3-target JSX + Source Map v3 (`sourcesContent` inlined); re-lints the **output** so a wrong compiler target cannot ship |
| `check <file>` | `tsc --noEmit` against `src/ae-globals.d.ts` (PARTIAL ambient surface) |
| `map <file.jsx.map> <line> [col]` | generated position → TS source position (minimal VLQ consumer, no deps) |

## Honest limitations

- **Single file only.** Multi-file bundling is follow-up work; `import`/
  `export` are lint errors until a bundler stage exists.
- TypeScript 5.9 removed `target=ES3`; we emit `target=ES5` and rely on
  `lintOutput` to prove no ES2015+ syntax survives. ES5 *syntax* edge cases
  (object-literal getters) are not covered — documented gap.
- `ae-globals.d.ts` is partial: the scripting inventory records symbols
  but not signatures, so AE-API member checking is shallow. Absence of a
  member is not proof of absence in the API.
- Lint is regex-based: it cannot type-resolve `"str".indexOf` vs
  `arr.indexOf`, so ambiguous constructs are deliberately not flagged.
- The sourcemap consumer covers the lookup path used for host error
  mapping; it is not a general-purpose library.

## Verification

- `node tests/run.mjs` — 16 unit/fake tests.
- Real-host: `node real-run.mjs` requires the a8n-transport slice
  (Issue #49 / Draft PR #50) **and** a local ae-a8n build containing the
  #103 + #105 fixes; see `EVIDENCE.md` for what actually ran.
