# a8n-transport — real-host JSX dispatch slice (Issue #49)

First real-host vertical slice for the trusted-execution pipeline: the
`createJsxRunner()` pipeline from `experiments/trusted-execution` (branch 14)
drives **arbitrary ExtendScript** against an **owned** After Effects session
launched through `@ido-bata/ae-a8n`, with consent gating, outcome
classification and UNKNOWN-never-resend semantics unchanged.

```text
runner.runScript(source)
  → consent scope + opt-in/provenance        (permissions.mjs, local policy)
  → trusted-codec envelope                   (requestId, pin, source)
  → transport.send                           (this experiment)
      → ae.call("aeDevtools.trustedEval", {source, requestId})
          → ES3 extension method evals source inside AE
      → trusted-codec reply envelope         (ok | error.aeError | refusal)
  → COMPLETED / FAILED / REFUSED / UNKNOWN
```

## Files

- `extension.mjs` — `HostExtension` for `ae-a8n extension build`; declares
  the single ES3 method `aeDevtools.trustedEval`. Its body evals
  `params.source` and returns `{requestId, ok, resultJson|valueText}` or a
  structured `evalError` with host-reported name/message/line/file.
- `transport.mjs` — `createA8nTransport({ae})`: the runner's injected
  `send(requestText)`. Maps ae-a8n outcomes onto codec replies:
  `TimeoutError` → `null` (UNKNOWN), proved-not-sent errors
  (`ScriptNotSentError`, `HostNotOwnedError`, `HostQuarantinedError`,
  `ExtensionMethodNotFoundError`) → refusal, host/eval errors → FAILED.
  Optional `pin.aeVersion` check against `ae.info()` before dispatch.
- `session.mjs` — real-host assembly: builds the host script via the
  canonical `ae-a8n extension build` CLI, launches an owned session, mints
  the consent pin, returns `{ae, transport, runner, pin, close}`.
- `scenario.mjs` — the transport-agnostic vertical slice (read → error →
  fix → re-execute → session-state verify → consent gates). Identical steps
  run against the fake and the real peer.
- `real-run.mjs` — opt-in CLI: `node real-run.mjs [--install-dir D] [--out evidence.json]`.
- `tests/` — dependency-free `node:test` suite (`node tests/run.mjs`).

## Verification levels

| Level | Status |
| --- | --- |
| implemented | yes |
| automated test (fake `ae`) | yes — `tests/` |
| fake/mock only | the fake suite |
| verified on real host | see `EVIDENCE.md` / `evidence/*.json` — recorded per run, never assumed |

## Explicit non-claims (Issue #49)

- Consent is a **local policy** minting scopes via `consentScopeFor`; it is
  not authenticated authorization. Token issuance/verification is ae-a8n
  #97–#99 territory.
- `aeDevtools.trustedEval` is an experiment seam: arbitrary JSX gated by
  the client-side pipeline, built per-launch, owned sessions only. It must
  not be presented as a shipped capability.
- The slice scenario is **read-only against the project** — AE may restore
  the user's last-opened project on launch, so no comp/layer/project
  mutation is performed here.
- No GUI-state observation, modal-dialog recovery, crash/log collection, or
  session rebuild — separate slices.
- Windows unverified; evidence is macOS-only unless stated.
