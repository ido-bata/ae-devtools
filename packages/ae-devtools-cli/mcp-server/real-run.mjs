#!/usr/bin/env node
/**
 * real-run.mjs — opt-in REAL-AE verification for the MCP server.
 *
 * Drives `mcp-server/server.mjs` over stdio (NDJSON) against a real AE
 * session and records every frame to a JSON evidence file. REAL AE ONLY —
 * never run against the fake session and present the result as real-host
 * evidence.
 *
 *   node packages/ae-devtools-cli/mcp-server/real-run.mjs \
 *     --session a8n --ae-a8n-root /path/to/ae-a8n-checkout \
 *     --install-dir "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app" \
 *     --out evidence/mcp-real-<label>.json
 *
 * Environment overrides (all optional):
 *   AE_DEVTOOLS_CLI  — ae-devtools-cli package root (default: this file's package)
 *   A8N_ROOT         — ae-a8n checkout root with a built dist/ (a8n session only)
 *   AE_INSTALL_DIR   — AE install dir forwarded to the session opener
 *   MCP_OUT          — evidence output path (default: ./mcp-real-run.json)
 *
 * The scenario is deliberately minimal and non-destructive beyond one
 * disposable comp: initialize → ae_discover → ae_execute(item.addComp,
 * consent:"grant") → ae_verify(read.projectSummary). Consent gates are
 * part of the contract under test; the run refuses to proceed without
 * them.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arg } from "../devtools-cli/argv.mjs";
import { spawnMcpStdio, withTimeout } from "../devtools-cli/real-run-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.AE_DEVTOOLS_CLI ?? join(HERE, "..");
const OUT =
  process.env.MCP_OUT ??
  join(HERE, "evidence", `mcp-real-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const session = arg("--session") ?? "a8n";
const serverArgs = ["mcp-server/server.mjs", "--session", session];
const a8nRoot = arg("--ae-a8n-root") ?? process.env.A8N_ROOT;
if (a8nRoot) serverArgs.push("--ae-a8n-root", a8nRoot);
const installDir = arg("--install-dir") ?? process.env.AE_INSTALL_DIR;
if (installDir) serverArgs.push("--install-dir", installDir);

const log = [];
let fatal = false;
const rec = (o) => {
  log.push({ t: new Date().toISOString(), ...o });
  writeFileSync(OUT, JSON.stringify(log, null, 2));
};

// NDJSON stdio client harness shared with conformance/mcp-real-run.mjs
// (Issue #197).
const { child, send, notify, call } = spawnMcpStdio({
  scriptArgs: serverArgs,
  cwd: CLI,
  onRecord: rec,
  onStderr: (d) => rec({ stderr: d.slice(0, 500) }),
});

try {
  rec({ step: "initialize", argv: serverArgs });
  await withTimeout(
    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ae-devtools-real-run", version: "0" },
    }),
    30000,
    "init",
  );
  notify("notifications/initialized");
  rec({ step: "initialized" });

  rec({ step: "ae_discover" });
  await withTimeout(call("ae_discover", {}), 60000, "discover");
  rec({ step: "ae_discover-done" });

  rec({ step: "ae_execute (launches owned AE)" });
  await withTimeout(
    call("ae_execute", {
      opId: "item.addComp",
      args: { name: "MCP QA Comp", width: 1920, height: 1080, pixelAspect: 1, duration: 5, frameRate: 30 },
      consent: "grant",
    }),
    300000,
    "execute",
  );
  rec({ step: "ae_execute-done" });

  rec({ step: "ae_verify" });
  await withTimeout(call("ae_verify", { consent: "grant" }), 120000, "verify");
  rec({ step: "ae_verify-done" });
} catch (e) {
  rec({ fatal: String(e?.message ?? e) });
  fatal = true;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
    // A recorded `fatal` is a failed verification run — exit nonzero so
    // callers/CI cannot read it as success (Issue #234). The evidence
    // JSON remains the verdict record either way.
    process.exit(fatal ? 1 : 0);
  }, 5000).unref();
}
