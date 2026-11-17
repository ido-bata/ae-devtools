# agent-loop — fake-level agent dev loop (Issue #38, CAP065; packaged in Issue #117)

Minimal vertical slice of the "run JSX → diagnose → fix → rerun →
regression" development loop, at **fake/mock level only**. Ships inside
the `@ido-bata/ae-devtools-cli` tarball so external coding agents / consumers
can drive the loop from an installed package.

## Library surface

No bin is provided: the `fixer` (and `consentProvider` / `stateReset`)
are injected by the calling agent/deployment, so there is no honest
default CLI. Import from the installed package:

```js
import { runDevLoop, regressionCheck, toDiagnostic, FAKE_SESSION }
  from "@ido-bata/ae-devtools-cli/agent-loop";
import { createFakeHost, createFakeApp }
  from "@ido-bata/ae-devtools-cli/agent-loop/fake-host";
```

Deep imports such as `@ido-bata/ae-devtools-cli/agent-loop/loop.mjs` also work
(the package `exports` map keeps `"./*"` passthrough for the other
modules).

`runDevLoop({source, transport, fixer, consentProvider, session?,
stateReset?, stateFingerprint?, allowDirtyRerun?, maxFixes?})` —
dispatch once per attempt (no silent retry), bounded fix budget,
consent evaluated per attempt by the injected provider, dirty-state
gating after a possibly-mutating FAILED. `regressionCheck` re-dispatches
only when `assumeIdempotent: true`.

## Pieces

- `fake-host.mjs` — a fake ExtendScript host: `send(codec-envelope)`
  runs the probe source in a Node `vm` sandbox with a stub `app`
  object, returning codec-serialized replies with `{ok,result}` or
  `{ok:false,error:{name,message,line,file}}`. Ordinary JS errors
  (TypeError, ReferenceError) occur with real positions — the same
  fields a real host reports via `aeError`.
- `loop.mjs` — the loop policy described above, delegated to the
  canonical trusted-execution runner for dispatch, consent gating,
  reply-identity checks, outcome classification, deadline handling and
  UNKNOWN quarantine.
- `fixtures/` — `broken.jsx` (two seeded bugs) and `clean.jsx` plus
  mutation fixtures used by the dirty-state tests.
- `evidence.mjs` — `serializeLoopEvidence` / `serializeLoopEvidenceJson`
  (Issue #150, CAP066): turns a loop report (+ optional `regressionCheck`
  result) into a deterministic `ae-devtools.agent-loop-evidence/v1`
  document — per-iteration request/result/diagnostics/regression data,
  source sha256 pins, state-dirty flags. `evidenceLevel` accepts only
  `"fake"`: real-host promotion goes through the #21 conformance
  pipeline, never through this serializer.

## Evidence level

**fake/mock only** — automated tests prove the loop mechanics and
reply-identity handling. NOT proven: real AE dispatch, ExtendScript
semantics, consent/catalog gates (PR #42), real diagnostics schema
(Issue #37), real-host regression. The diagnostics records here mirror
the #37 field names but do not import that module.

## Run

    node tests/run.mjs
