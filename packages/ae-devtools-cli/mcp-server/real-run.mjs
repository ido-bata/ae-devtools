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
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.AE_DEVTOOLS_CLI ?? join(HERE, "..");
const OUT =
  process.env.MCP_OUT ??
  join(HERE, "evidence", `mcp-real-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const session = arg("--session") ?? "a8n";
const serverArgs = ["mcp-server/server.mjs", "--session", session];
const a8nRoot = arg("--ae-a8n-root") ?? process.env.A8N_ROOT;
if (a8nRoot) serverArgs.push("--ae-a8n-root", a8nRoot);
const installDir = arg("--install-dir") ?? process.env.AE_INSTALL_DIR;
if (installDir) serverArgs.push("--install-dir", installDir);

const log = [];
const rec = (o) => {
  log.push({ t: new Date().toISOString(), ...o });
  writeFileSync(OUT, JSON.stringify(log, null, 2));
};

const child = spawn(process.execPath, serverArgs, {
  cwd: CLI,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => rec({ stderr: String(d).slice(0, 500) }));
let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      rec({ rx: msg });
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      rec({ rxRaw: line.slice(0, 300) });
    }
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const notify = (method) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
const call = (name, args) => send("tools/call", { name, arguments: args });
const timeout = (p, ms, tag) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + tag)), ms))]);

try {
  rec({ step: "initialize", argv: serverArgs });
  await timeout(
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
  await timeout(call("ae_discover", {}), 60000, "discover");
  rec({ step: "ae_discover-done" });

  rec({ step: "ae_execute (launches owned AE)" });
  await timeout(
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
  await timeout(call("ae_verify", { consent: "grant" }), 120000, "verify");
  rec({ step: "ae_verify-done" });
} catch (e) {
  rec({ fatal: String(e?.message ?? e) });
} finally {
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
    process.exit(0);
  }, 5000).unref();
}
