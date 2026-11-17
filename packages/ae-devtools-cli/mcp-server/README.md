# mcp-server — dev-loop MCP tools (Issue #20, CAP051 slice; packaged in Issue #107)

A minimal **stdio MCP server** (newline-delimited JSON-RPC 2.0) that exposes
the existing dev-loop core to AI coding agents. This is a thin client
surface — it adds **no dispatch path and no permission path** of its own.

## Tools

| Tool | Maps to | Behavior |
| --- | --- | --- |
| `ae_discover` | `devloop.discover()` | Lists executable registry ops + evidence levels. Metadata only; never opens a session. |
| `ae_inspect` | `devloop.inspect()` | Op schema/metadata. Never executes; never opens a session. |
| `ae_execute` | `devloop.execute()` → `runOperation()` | Canonical dispatch. Requires `consent:"grant"` (default deny, checked **before** the session opens). Destructive ops need `confirmDestructive:true`; render ops need `confirmRender:true` — enforced by `runOperation`, flags forwarded untouched. |
| `ae_verify` | `devloop.verify()` | Post-execution read-back via a read-only op (default `read.projectSummary`). Same consent contract. |

Every tool payload carries the evidence level of its source
(`session.evidenceLevel`, registry `evidence`). **Fake/mock results are
never presented as real-host verification.**

## Sessions

- `--session fake` (default): codec-faithful vm host via
  `../devtools-cli/fake-session.mjs` — **fake/mock evidence
  only**.
- `--session a8n`: owned AE session via `../a8n-transport/
  session.mjs` `openSliceSession` — the only path that can produce
  "verified on real host" evidence, and only when it actually runs.
- `--ae-a8n-root <dir>`, `--install-dir <dir>` are forwarded to the a8n
  opener.

The session is opened lazily on the first consented `ae_execute`/
`ae_verify`, shared for the server lifetime, and closed on stdin EOF /
SIGINT / SIGTERM.

## Protocol

Implemented JSON-RPC methods: `initialize`, `ping`, `tools/list`,
`tools/call`. Notifications (e.g. `notifications/initialized`) are
consumed silently. The server is hand-rolled NDJSON —
`@modelcontextprotocol/sdk` is not used anywhere in this repo and four
tools do not justify a new dependency (AGENTS.md §2; minimal side chosen
deliberately). Only protocol frames go to stdout; diagnostics go to
stderr.

## Safety contract (unchanged from CLI/core)

- `consent` is a local policy argument, **not** authenticated
  authorization (ae-a8n #97–#99 owns that).
- UNKNOWN outcomes are **never retried** — one `tools/call` is exactly
  one dispatch; the trusted runner quarantines UNKNOWN requestIds.
- Unimplemented inventory members are not listed as executable ops;
  coverage gaps live in the registry/catalog reports.

## Usage

```sh
# installed via @ido-bata/ae-devtools-cli:
ae-devtools-mcp                          # fake session (default)
ae-devtools-mcp --session a8n --ae-a8n-root /path/to/ae-a8n
# from this repo checkout:
node server.mjs
```

Point any MCP client at this via stdio, e.g.
`{"command": "ae-devtools-mcp", "args": []}` (after
`npm install @ido-bata/ae-devtools-cli`) or
`{"command": "node", "args": ["/abs/path/packages/ae-devtools-cli/mcp-server/server.mjs"]}`.

## Tests

```sh
node tests/run.mjs
```

Covers handshake, tools/list shape, discover/inspect without session,
consent default-deny (refused before session open), destructive/confirm
gates via the canonical path, execute→verify on the fake host, typed
refusals, and no-retry-on-UNKNOWN.

## Evidence

| Level | Status |
| --- | --- |
| implemented | yes — `server.mjs`, `tools.mjs`, `session.mjs` |
| automated test | yes — `node tests/run.mjs` (node:test, in-process + spawned stdio) |
| fake/mock only | yes — all current coverage runs against the codec-faithful fake host |
| verified on real host | yes (candidate bytes) — `real-run.mjs` drove initialize → `ae_discover` → `ae_execute`(`item.addComp`) → `ae_verify`(`read.projectSummary`) against an **owned** AE 2026 (26.5.3x9) session on macOS arm64, twice: `evidence/mcp-real-4a06639-ae2026.json` (pre-RC local build `1dbd4de`) and `evidence/mcp-real-beta1-2026.json` (**publish-candidate tarball** `0.2.0-beta.1`, freeze `d895179`, sha1 `9ada37bc…`, consumer-installed — not yet registry bytes). AE 2027 fail-closed run: `evidence/mcp-real-4a06639-ae2027-blocked.json`. Not exercised in CI |

## Real-host verification

`real-run.mjs` is the opt-in real-AE harness (REAL AE ONLY — never
present its output as anything but real-host evidence):

```sh
node real-run.mjs --session a8n \
  --ae-a8n-root /path/to/ae-a8n-checkout \
  --install-dir "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app" \
  --out evidence/mcp-real-<label>.json
```

It records every NDJSON frame (requests, responses, stderr) to the `--out`
JSON. `AE_DEVTOOLS_CLI` / `A8N_ROOT` / `AE_INSTALL_DIR` / `MCP_OUT` env
vars override the corresponding flags. Committed runs live under
`evidence/` together with their provenance notes in the release record —
the ae-a8n bytes used were a **pre-0.2.0-rc local build** (`release-0-2-0`
commit `1dbd4de`, tree `e6003eab`), not the published package.

Known limitations: single shared session per server process; no
`resources`/`prompts` surfaces; no run-guard residue markers (the CLI's
`session-guard.mjs` recovery bookkeeping is CLI-specific and was not
ported — a killed MCP server leaves no reap marker; noted as a
follow-up, not silently claimed).
