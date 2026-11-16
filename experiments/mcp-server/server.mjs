#!/usr/bin/env node
/**
 * server.mjs — stdio MCP server for the ae-devtools dev-loop core
 * (Issue #20, CAP051 slice).
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio
 * transport). Hand-rolled on purpose: @modelcontextprotocol/sdk is not
 * used anywhere in this repo, and four tools over NDJSON do not justify
 * a new dependency (AGENTS.md §2 — minimal side chosen deliberately).
 *
 * Implemented methods: initialize, ping, tools/list, tools/call.
 * Notifications (e.g. notifications/initialized) are consumed silently.
 * Nothing but protocol frames is ever written to stdout; diagnostics go
 * to stderr.
 *
 *   node server.mjs [--session fake|a8n] [--ae-a8n-root <dir>]
 *                   [--install-dir <dir>]
 *
 * Session is opened LAZILY on the first ae_execute/ae_verify that passes
 * the consent pre-gate — discover/inspect/denied calls never touch a
 * host. One session is shared for the server lifetime and closed on
 * stdin EOF / SIGINT / SIGTERM.
 *
 * Evidence honesty: every tool payload carries the evidence level of
 * the session/registry it came from. The default `--session fake` host
 * is FAKE/MOCK level — it proves wiring only, never After Effects
 * behavior. Real-host evidence requires `--session a8n` on an owned AE
 * session via experiments/a8n-transport.
 */
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOLS, callTool, MCP_SCHEMA } from "./tools.mjs";
import { openSession } from "./session.mjs";

export const SERVER_NAME = "ae-devtools-mcp";
export const SERVER_VERSION = "0.1.0";

// MCP revisions this server understands. The client proposes a version
// in `initialize`; we answer with the newest mutually supported one.
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Create a server bound to arbitrary streams (tests inject PassThrough;
 * the CLI entry uses process.stdin/stdout).
 *
 * @param {object} opts
 *   input          — readable stream of NDJSON requests (default stdin)
 *   output         — writable stream for NDJSON responses (default stdout)
 *   sessionFactory — async (kind, options) => session (default openSession)
 *   sessionKind    — "fake" (default) | "a8n"
 *   sessionOptions — { aeA8nRoot, installDir } forwarded to the factory
 * @returns {{close: () => Promise<void>}}
 */
export function createServer(opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const sessionFactory = opts.sessionFactory ?? openSession;
  const sessionKind = opts.sessionKind ?? "fake";
  const sessionOptions = opts.sessionOptions ?? {};

  // Lazy single-flight session: opened on first dispatch-capable call,
  // shared by every later call, closed by close().
  let sessionPromise = null;
  let resolvedSession = null;
  const getSession = () => {
    if (!sessionPromise) {
      sessionPromise = Promise.resolve()
        .then(() => sessionFactory(sessionKind, sessionOptions))
        .then((s) => { resolvedSession = s; return s; });
    }
    return sessionPromise;
  };

  async function close() {
    if (!sessionPromise) return;
    try {
      const s = await sessionPromise;
      if (s && typeof s.close === "function") await s.close();
    } catch (e) {
      process.stderr.write(`mcp-server: session close failed: ${e?.message ?? e}\n`);
    }
  }

  function write(msg) {
    output.write(JSON.stringify(msg) + "\n");
  }

  async function handleMessage(msg) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return rpcError(null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC object");
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    // Notifications never get a response — consume and drop.
    if (typeof method === "string" && method.startsWith("notifications/")) {
      return null;
    }

    try {
      switch (method) {
        case "initialize": {
          const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
          const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
          return rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              "ae-devtools dev-loop tools. ae_execute/ae_verify require arguments.consent:\"grant\"; " +
              "destructive ops need confirmDestructive:true, render ops confirmRender:true. " +
              "Default session is the codec-faithful fake host — results are fake/mock evidence, not real AE.",
          });
        }
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: TOOLS });
        case "tools/call": {
          const name = params?.name;
          const args = params?.arguments ?? {};
          if (typeof name !== "string" || name.length === 0) {
            return rpcError(id, INVALID_PARAMS, "tools/call requires params.name (string)");
          }
          const result = await callTool(name, args, { getSession });
          return rpcResult(id, result);
        }
        default:
          if (isNotification) return null;
          return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${String(method)}`);
      }
    } catch (e) {
      return rpcError(id ?? null, INTERNAL_ERROR, String(e?.message ?? e));
    }
  }

  const rl = createInterface({ input, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write(rpcError(null, PARSE_ERROR, "Parse error: line is not valid JSON"));
      return;
    }
    handleMessage(msg)
      .then((response) => { if (response !== null) write(response); })
      .catch((e) => {
        process.stderr.write(`mcp-server: handler failure: ${e?.message ?? e}\n`);
      });
  });

  // stdin EOF means the client went away — release the session.
  rl.on("close", () => { close(); });

  return { close, getSession };
}

// ---- CLI entry ----

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    }
  }
  return flags;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const sessionKind = flags.session ?? "fake";
  if (!["fake", "a8n"].includes(sessionKind)) {
    process.stderr.write("usage: server.mjs [--session fake|a8n] [--ae-a8n-root <dir>] [--install-dir <dir>]\n");
    process.exit(2);
  }
  const server = createServer({
    sessionKind,
    sessionOptions: {
      aeA8nRoot: typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined,
      installDir: typeof flags["install-dir"] === "string" ? flags["install-dir"] : undefined,
    },
  });
  process.stderr.write(
    `mcp-server: ${SERVER_NAME}@${SERVER_VERSION} schema=${MCP_SCHEMA} session=${sessionKind} ` +
    `(stdio NDJSON; fake session = fake/mock evidence only)\n`,
  );

  let shuttingDown = false;
  const shutdown = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`mcp-server: unhandled rejection: ${reason?.message ?? reason}\n`);
    shutdown(1);
  });
}
