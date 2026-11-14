# agent-loop — fake-level agent dev loop (Issue #38, CAP065)

Minimal vertical slice of the "run JSX → diagnose → fix → rerun →
regression" development loop, at **fake/mock level only**.

## Pieces

- `fake-host.mjs` — a fake ExtendScript host: `send(codec-envelope)`
  runs the probe source in a Node `vm` sandbox with a stub `app`
  object, returning codec-serialized replies with `{ok,result}` or
  `{ok:false,error:{name,message,line,file}}`. Ordinary JS errors
  (TypeError, ReferenceError) occur with real positions — the same
  fields a real host reports via `aeError`.
- `loop.mjs` — `runDevLoop({source, transport, fixer})`: dispatch once
  per attempt (no silent retry), classify via the trusted-execution
  `classifyWriteResult`, normalize `FAILED` replies into
  diagnostics-shaped records (`toDiagnostic`, host-reported positions
  only), invoke the injected `fixer`, rerun within a bounded fix
  budget, then `regressionCheck` reruns the final source.
- `fixtures/` — `broken.jsx` (two seeded bugs) and `clean.jsx`.

## Evidence level

**fake/mock only** — automated tests prove the loop mechanics and
reply-identity handling. NOT proven: real AE dispatch, ExtendScript
semantics, consent/catalog gates (PR #42), real diagnostics schema
(Issue #37), real-host regression. The diagnostics records here mirror
the #37 field names but do not import that branch.

## Run

    node tests/run.mjs
