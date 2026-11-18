/**
 * server.test.mjs — MCP server tests (Issue #20). Fake/mock level only.
 *
 * Covers: JSON-RPC handshake (initialize/ping/tools/list/tools/call),
 * the four dev-loop tools, consent default-deny, confirm-flag gates,
 * evidence-level honesty, and the no-retry-on-UNKNOWN contract.
 * No After Effects is involved — the default session is the in-repo
 * codec-faithful fake host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, SERVER_NAME } from "../server.mjs";
import { loadTrustedCodec, createJsxRunner } from "../../trusted-execution/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");

/** In-process MCP client over PassThrough streams. */
function makeClient(serverOpts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createServer({ input, output, ...serverOpts });
  output.setEncoding("utf8");

  let buf = "";
  const inbox = [];
  const waiters = [];
  output.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim().length === 0) continue;
      const msg = JSON.parse(line);
      const w = waiters.findIndex((x) => x.id === msg.id);
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    }
  });

  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      waiters.push({
        id,
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      });
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    input.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  function raw(line) {
    input.write(line + "\n");
  }
  return { request, notify, raw, server, inbox };
}

function toolPayload(response) {
  assert.equal(response.error, undefined, `unexpected rpc error: ${JSON.stringify(response.error)}`);
  assert.ok(response.result?.content?.[0]?.text, "tool result missing text content");
  return {
    payload: JSON.parse(response.result.content[0].text),
    isError: response.result.isError === true,
  };
}

function countingSessionFactory(inner) {
  const calls = { count: 0 };
  const factory = async (kind, opts) => {
    calls.count++;
    calls.kind = kind;
    calls.opts = opts;
    return inner ?? (await import("../session.mjs")).openSession(kind, opts);
  };
  return { factory, calls };
}

test("initialize returns protocol version, capabilities, serverInfo", async () => {
  const c = makeClient();
  const res = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.equal(res.result.serverInfo.name, SERVER_NAME);
  assert.ok(res.result.capabilities.tools);
  c.notify("notifications/initialized", {});
  const ping = await c.request("ping");
  assert.deepEqual(ping.result, {});
  await c.server.close();
});

test("initialize falls back to latest supported protocol version", async () => {
  const c = makeClient();
  const res = await c.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(res.result.protocolVersion, "2025-06-18");
  await c.server.close();
});

test("tools/list exposes exactly the four dev-loop tools", async () => {
  const c = makeClient();
  const res = await c.request("tools/list");
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["ae_discover", "ae_execute", "ae_inspect", "ae_verify"]);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 0);
  }
  const exec = res.result.tools.find((t) => t.name === "ae_execute");
  assert.ok(exec.inputSchema.required.includes("consent"));
  await c.server.close();
});

test("unknown method → JSON-RPC method-not-found; bad JSON → parse error", async () => {
  const c = makeClient();
  const res = await c.request("resources/list");
  assert.equal(res.error.code, -32601);
  c.raw("{not json");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.inbox.length, 1);
  assert.equal(c.inbox[0].error.code, -32700);
  assert.equal(c.inbox[0].id, null);
  await c.server.close();
});

test("ae_discover lists ops with honest evidence; opens no session", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_discover", arguments: {},
  }));
  assert.equal(isError, false);
  assert.equal(payload.operationCount, 20);
  assert.equal(payload.evidence.realHostVerified, 0);
  assert.equal(payload.evidenceLevel, "registry metadata — no dispatch");
  assert.equal(calls.count, 0, "discover must not open a session");
  await c.server.close();
});

test("ae_inspect returns metadata without executing or opening a session", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  const { payload } = toolPayload(await c.request("tools/call", {
    name: "ae_inspect", arguments: { opId: "item.addComp" },
  }));
  assert.equal(payload.status, "ok");
  assert.ok(payload.op.members.length > 0);
  assert.equal(payload.evidenceLevel, "metadata only — nothing executed");
  const bad = toolPayload(await c.request("tools/call", {
    name: "ae_inspect", arguments: { opId: "no.such.op" },
  }));
  assert.equal(bad.payload.status, "unknown-operation");
  assert.equal(calls.count, 0);
  await c.server.close();
});

test("ae_execute without consent is refused BEFORE any session opens (default deny)", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  for (const consent of [undefined, "deny", "grant "]) {
    const { payload, isError } = toolPayload(await c.request("tools/call", {
      name: "ae_execute",
      arguments: { opId: "read.projectSummary", ...(consent === undefined ? {} : { consent }) },
    }));
    assert.equal(isError, true);
    assert.equal(payload.status, "refused");
    assert.equal(payload.reason, "CONSENT_NOT_GRANTED");
    assert.equal(payload.dispatched, false);
  }
  assert.equal(calls.count, 0, "denied calls must not open a session");
  await c.server.close();
});

test("ae_verify without consent is refused the same way", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  const { payload } = toolPayload(await c.request("tools/call", {
    name: "ae_verify", arguments: {},
  }));
  assert.equal(payload.status, "refused");
  assert.equal(payload.reason, "CONSENT_NOT_GRANTED");
  assert.equal(calls.count, 0);
  await c.server.close();
});

test("ae_execute destructive op without confirmDestructive is refused by the canonical gate", async () => {
  const c = makeClient();
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "project.new", consent: "grant" },
  }));
  assert.equal(isError, true);
  assert.equal(payload.outcome, "refused");
  assert.equal(payload.result.reason, "DESTRUCTIVE_CONFIRMATION_REQUIRED");
  assert.equal(payload.session.kind, "fake");
  assert.equal(payload.session.evidenceLevel, "fake/mock only");
  await c.server.close();
});

test("developer-loop vertical over MCP: discover→inspect→execute→verify on fake host", async () => {
  const c = makeClient();
  const ex = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: {
      opId: "item.addComp",
      args: { name: "C", width: 10, height: 10, pixelAspect: 1, duration: 1, frameRate: 30 },
      consent: "grant",
    },
  }));
  assert.equal(ex.isError, false);
  assert.equal(ex.payload.outcome, "COMPLETED");
  assert.equal(ex.payload.session.evidenceLevel, "fake/mock only");

  const v = toolPayload(await c.request("tools/call", {
    name: "ae_verify", arguments: { consent: "grant" },
  }));
  assert.equal(v.isError, false);
  assert.equal(v.payload.outcome, "COMPLETED");
  assert.equal(v.payload.result.result.count, 1);
  assert.equal(v.payload.result.result.items[0].name, "C");
  assert.equal(v.payload.session.evidenceLevel, "fake/mock only");
  await c.server.close();
});

test("ae_execute adapter-level failure is isError even when wire outcome is COMPLETED (Issue #181)", async () => {
  // Session whose runner reports a wire COMPLETED dispatch carrying an
  // adapter ok:false payload — the false-green shape the shared
  // outcome normalization (dev-loop/outcomes.mjs) now catches.
  const factory = async () => ({
    kind: "fake",
    evidenceLevel: "fake/mock only",
    pin: { sessionId: "sess-adapter-fail" },
    runner: {
      runScript: async () => ({
        outcome: "COMPLETED",
        result: JSON.stringify({ ok: false, error: { message: "adapter boom" } }),
      }),
    },
  });
  const c = makeClient({ sessionFactory: factory });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  }));
  assert.equal(isError, true, "adapter-level failure must not report isError:false");
  assert.equal(payload.result.status, "failed");
  assert.equal(payload.result.adapterError.message, "adapter boom");
  await c.server.close();
});

test("ae_execute unknown op is a typed refusal, not a crash", async () => {
  const c = makeClient();
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "no.such.op", consent: "grant" },
  }));
  assert.equal(isError, true);
  assert.equal(payload.outcome, "refused");
  assert.equal(payload.result.reason, "UNKNOWN_OPERATION");
  await c.server.close();
});

test("unknown tool name returns an error tool result", async () => {
  const c = makeClient();
  const { isError, payload } = toolPayload(await c.request("tools/call", {
    name: "ae_deleteEverything", arguments: {},
  }));
  assert.equal(isError, true);
  assert.match(payload.error, /unknown tool/);
  await c.server.close();
});

test("UNKNOWN outcome is never retried — exactly one transport send", async () => {
  // Injected session whose transport never replies; the runner deadline
  // classifies the dispatch UNKNOWN and quarantines the requestId. The
  // MCP layer must not re-issue it.
  const codec = loadTrustedCodec();
  let sends = 0;
  const runner = createJsxRunner({
    codec,
    deadlineMs: 60,
    transport: { send: () => { sends++; return new Promise(() => {}); } },
  });
  const session = {
    kind: "fake",
    evidenceLevel: "fake/mock only (injected hanging transport)",
    runner,
    pin: { sessionId: "mcp-unknown-test", aeVersion: "99.0-fake" },
    close: async () => {},
  };
  const c = makeClient({ sessionFactory: async () => session });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  }));
  assert.equal(isError, true);
  assert.equal(payload.outcome, "UNKNOWN");
  assert.equal(sends, 1, "UNKNOWN must not be retried — one dispatch, one send");
  await c.server.close();
});

// ---- spawned stdio smoke test: proves the real NDJSON-over-stdio path ----

test("spawned server over real stdio: initialize → tools → execute → verify", async () => {
  const child = spawn(process.execPath, [SERVER, "--session", "fake"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const inbox = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim().length === 0) continue;
      const msg = JSON.parse(line);
      const w = waiters.findIndex((x) => x.id === msg.id);
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });

  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}; stderr: ${stderr}`)), 20_000);
    waiters.push({ id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.result.serverInfo.name, SERVER_NAME);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const list = await request("tools/list");
    assert.equal(list.result.tools.length, 4);

    const ex = await request("tools/call", {
      name: "ae_execute",
      arguments: { opId: "read.projectSummary", consent: "grant" },
    });
    const exPayload = JSON.parse(ex.result.content[0].text);
    assert.equal(exPayload.outcome, "COMPLETED");
    assert.equal(exPayload.session.evidenceLevel, "fake/mock only");

    const v = await request("tools/call", {
      name: "ae_verify", arguments: { consent: "grant" },
    });
    const vPayload = JSON.parse(v.result.content[0].text);
    assert.equal(vPayload.outcome, "COMPLETED");

    // clean EOF → server closes the fake session and exits
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
