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
import { openFakeSession } from "../../devtools-cli/fake-session.mjs";
import { reapRun } from "../../devtools-cli/session-guard.mjs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), "ae-devtools-mcp-runs-"));
}

function readOnlyMarker(runsDir) {
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, `expected exactly one run marker, got ${files.join(",")}`);
  return JSON.parse(readFileSync(join(runsDir, files[0]), "utf8"));
}

/** Session shaped like the stripped a8n session mcp-server/session.mjs returns. */
function fakeA8nSession() {
  const s = openFakeSession();
  return {
    ...s,
    kind: "a8n",
    evidenceLevel: "verified on real host (macOS)",
    meta: { aeVersion: "26.5-fake", ownership: "owned", aeA8nHead: "deadbeef" },
  };
}

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

test("tools/list exposes the dev-loop tools including ae_session", async () => {
  const c = makeClient();
  const res = await c.request("tools/list");
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["ae_discover", "ae_execute", "ae_inspect", "ae_session", "ae_verify"]);
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

test("id-less tools/call is a notification: no dispatch, no response (Issue #219)", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  c.notify("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  });
  await new Promise((r) => setTimeout(r, 200));
  // No response may be written for a notification, and the session
  // factory must never have been invoked.
  assert.equal(c.inbox.length, 0);
  assert.equal(calls.count, 0);
  const ping = await c.request("ping");
  assert.deepEqual(ping.result, {});
  await c.server.close();
});

test("ae_discover lists ops with honest evidence; opens no session", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_discover", arguments: {},
  }));
  assert.equal(isError, false);
  const { OPERATIONS } = await import("../../scripting-adapters/registry.mjs");
  assert.equal(payload.operationCount, OPERATIONS.length);
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

test("ae_session reports closed state without opening a session (CAP049)", async () => {
  const { factory, calls } = countingSessionFactory();
  const c = makeClient({ sessionFactory: factory });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_session", arguments: {},
  }));
  assert.equal(isError, false);
  assert.equal(payload.session.state, "closed");
  assert.equal(payload.session.kind, "fake");
  assert.equal(payload.session.evidenceLevel, undefined, "closed state must not fabricate evidence");
  assert.equal(payload.session.pin, undefined);
  assert.equal(payload.api.mcp, "ae-devtools.mcp/v1");
  assert.equal(payload.api.devLoop, "ae-devtools.dev-loop/v1");
  assert.equal(calls.count, 0, "ae_session must never open a session");
  await c.server.close();
});

test("ae_session reports the open session's honest evidence after dispatch", async () => {
  const c = makeClient();
  await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  });
  const { payload } = toolPayload(await c.request("tools/call", {
    name: "ae_session", arguments: {},
  }));
  assert.equal(payload.session.state, "open");
  assert.equal(payload.session.kind, "fake");
  assert.equal(payload.session.evidenceLevel, "fake/mock only");
  assert.ok(payload.session.pin && typeof payload.session.pin === "object");
  await c.server.close();
});

test("ae_session reports failed state after a rejected session open", async () => {
  const c = makeClient({ sessionFactory: async () => { throw new Error("open boom"); } });
  await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  });
  const { payload } = toolPayload(await c.request("tools/call", {
    name: "ae_session", arguments: {},
  }));
  assert.equal(payload.session.state, "failed");
  assert.equal(payload.session.evidenceLevel, undefined);
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
  assert.equal(payload.outcome, "REFUSED");
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
  // Issue #196: the reported outcome is normalized — never COMPLETED.
  assert.equal(payload.outcome, "FAILED");
  assert.equal(payload.result.status, "failed");
  assert.equal(payload.result.adapterError.message, "adapter boom");
  // Issue #196: the failure payload carries the canonical
  // ae-devtools.diagnostics/v1 record — same mapping as CLI/VSCode.
  assert.equal(payload.diagnostics?.status, "ok");
  const rec = payload.diagnostics?.records?.[0];
  assert.equal(rec?.recordVersion, "ae-devtools.diagnostics/v1");
  assert.equal(rec?.kind, "transport-outcome");
  assert.equal(rec?.outcome, "FAILED");
  assert.equal(rec?.evidence, "fake");
  await c.server.close();
});

test("ae_execute failure payload carries diagnostics record; success payload does not (Issue #196)", async () => {
  const c = makeClient();
  // Adapter-level refusal (destructive confirm missing) is a dispatch
  // failure → record present.
  const refused = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "project.new", consent: "grant" },
  }));
  assert.equal(refused.isError, true);
  assert.equal(refused.payload.diagnostics?.records?.[0]?.recordVersion, "ae-devtools.diagnostics/v1");
  assert.equal(refused.payload.diagnostics.records[0].outcome, "REFUSED");

  // Clean completion → no diagnostics block at all.
  const ok = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  }));
  assert.equal(ok.isError, false);
  assert.equal(ok.payload.diagnostics, undefined);
  await c.server.close();
});

test("ae_execute result with error:null is NOT a failure — unified error rule (Issue #196)", async () => {
  // The old MCP-local `error !== undefined` patch reported error:null
  // as failure; the shared rule in dev-loop/outcomes.mjs does not.
  const factory = async () => ({
    kind: "fake",
    evidenceLevel: "fake/mock only",
    pin: { sessionId: "sess-null-error" },
    runner: {
      runScript: async () => ({
        outcome: "COMPLETED",
        error: null,
        result: JSON.stringify({ ok: true, result: "fine" }),
      }),
    },
  });
  const c = makeClient({ sessionFactory: factory });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  }));
  assert.equal(isError, false);
  assert.equal(payload.outcome, "COMPLETED");
  assert.equal(payload.diagnostics, undefined);
  await c.server.close();
});

test("server close is bounded when session.close hangs (Issue #196)", async () => {
  const factory = async () => ({
    kind: "fake",
    evidenceLevel: "fake/mock only",
    pin: { sessionId: "sess-hang" },
    runner: { runScript: async () => ({ outcome: "COMPLETED", result: null }) },
    close: () => new Promise(() => {}), // never resolves
  });
  const c = makeClient({ sessionFactory: factory, closeTimeoutMs: 80 });
  // Open the session via a dispatch, then close — must settle fast.
  await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  });
  const started = Date.now();
  await c.server.close();
  assert.ok(Date.now() - started < 10_000, "session close was not bounded");
});

test("server close() reports success/failure for the shutdown exit path (Issue #391)", async () => {
  // close() must resolve false when the owned session fails to close —
  // the entry's shutdown handler maps that to a non-clean exit code so
  // conformance cannot read exit 143 as "AE session closed".
  const okFactory = async () => ({
    kind: "fake",
    evidenceLevel: "fake/mock only",
    pin: { sessionId: "sess-ok" },
    runner: { runScript: async () => ({ outcome: "COMPLETED", result: null }) },
    close: async () => {},
  });
  const c1 = makeClient({ sessionFactory: okFactory });
  await c1.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  });
  assert.equal(await c1.server.close(), true);

  const failingFactory = async () => ({
    kind: "fake",
    evidenceLevel: "fake/mock only",
    pin: { sessionId: "sess-fail" },
    runner: { runScript: async () => ({ outcome: "COMPLETED", result: null }) },
    close: async () => { throw new Error("fixture: close refused"); },
  });
  const c2 = makeClient({ sessionFactory: failingFactory });
  await c2.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  });
  assert.equal(await c2.server.close(), false);
});

test("ae_execute unknown op is a typed refusal, not a crash", async () => {
  const c = makeClient();
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "no.such.op", consent: "grant" },
  }));
  assert.equal(isError, true);
  assert.equal(payload.outcome, "REFUSED");
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

// ---- run-guard residue markers for a8n sessions (Issue #198, 案 C) ----

test("a8n session open writes a run-guard marker (surface mcp) with request events and NO attestation", async () => {
  const runsDir = tempRunsDir();
  try {
    const c = makeClient({
      sessionKind: "a8n",
      sessionFactory: async () => fakeA8nSession(),
      runsDir,
    });
    const { payload, isError } = toolPayload(await c.request("tools/call", {
      name: "ae_execute",
      arguments: { opId: "read.projectSummary", consent: "grant" },
    }));
    assert.equal(isError, false);
    assert.equal(payload.outcome, "COMPLETED");

    const marker = readOnlyMarker(runsDir);
    assert.equal(marker.schema, "ae-devtools.cli.run-guard/v1");
    assert.equal(marker.surface, "mcp");
    assert.equal(marker.sessionKind, "a8n");
    assert.equal(marker.status, "open");
    // Ownership KIND is recorded (it is what the stripped session
    // actually reports via meta) — but as a bare claim, no evidence.
    assert.equal(marker.session.ownership?.kind, "owned");
    assert.equal(marker.session.ownership?.evidence ?? null, null);
    // Fail-closed: no process attestation was recorded — the slice
    // handle never reaches this surface.
    assert.equal(marker.session.process, undefined);
    // Request lifecycle: dispatched then resolved for the dispatch.
    const dispatched = marker.requests.filter((r) => r.event === "dispatched");
    const resolved = marker.requests.filter((r) => r.event === "resolved");
    assert.equal(dispatched.length, 1);
    assert.equal(resolved.length, 1);
    assert.equal(dispatched[0].requestId, resolved[0].requestId);
    assert.match(dispatched[0].requestId, /^req-mcp-/);
    assert.equal(dispatched[0].method, "read.projectSummary");

    // The marker is residue-visible but NOT recoverable: reap must
    // refuse at the missing-attestation gate even though the runner
    // pid is dead and ownership claims "owned".
    const verdict = await reapRun(marker.runId, {
      dir: runsDir, aliveFn: () => false,
    });
    assert.equal(verdict.verdict, "REFUSED");
    assert.equal(verdict.reason, "NO_A8N_ATTESTATION");

    // Clean close removes the marker — no residue on the happy path.
    await c.server.close();
    assert.equal(existsSync(join(runsDir, `${marker.runId}.json`)), false);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("fake session opens write NO run-guard marker (no AE residue possible)", async () => {
  const runsDir = tempRunsDir();
  try {
    const c = makeClient({ sessionKind: "fake", runsDir });
    const { isError } = toolPayload(await c.request("tools/call", {
      name: "ae_execute",
      arguments: { opId: "read.projectSummary", consent: "grant" },
    }));
    assert.equal(isError, false);
    assert.deepEqual(readdirSync(runsDir), []);
    await c.server.close();
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("a8n session open failure leaves an open-failed marker", async () => {
  const runsDir = tempRunsDir();
  try {
    const c = makeClient({
      sessionKind: "a8n",
      sessionFactory: async () => { throw new Error("open boom"); },
      runsDir,
    });
    const res = await c.request("tools/call", {
      name: "ae_execute",
      arguments: { opId: "read.projectSummary", consent: "grant" },
    });
    assert.equal(res.error?.code, -32603);
    const marker = readOnlyMarker(runsDir);
    assert.equal(marker.surface, "mcp");
    assert.equal(marker.status, "open-failed");
    assert.equal(marker.session, null);
    // close() must not rewrite the open-failed marker to "closed".
    await c.server.close();
    assert.equal(readOnlyMarker(runsDir).status, "open-failed");
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
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
    assert.equal(list.result.tools.length, 5);

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

// ---- entry-flag validation (Issue #383): valueless target pins must
// ---- refuse before the server exists — tested against the real
// ---- spawned entry point, not just createServer ----

test("spawned entry refuses valueless --project-file / --ae-version with exit 2", async () => {
  for (const argv of [
    ["--session", "a8n-attached", "--project-file"],
    ["--session", "a8n-attached", "--project-file="],
    ["--session", "a8n-attached", "--ae-version"],
    ["--session", "fake", "--ae-version="],
  ]) {
    const child = spawn(process.execPath, [SERVER, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 2, `argv ${JSON.stringify(argv)}: ${stderr}`);
    assert.match(stderr, /requires a nonempty value/);
  }
});

// ---- outcome normalization consistency (Issue #226) ----

test("lowercase adapter outcome spellings normalize on MCP surface; session meta cannot spoof kind/evidenceLevel", async () => {
  const runsDir = tempRunsDir();
  try {
    const inner = openFakeSession();
    const session = {
      ...inner,
      kind: "a8n",
      evidenceLevel: "verified on real host (macOS)",
      // meta must not override the honest top-level fields.
      meta: { aeVersion: "26.5-fake", ownership: "owned", kind: "fake", evidenceLevel: "spoofed" },
      runner: { runScript: async () => ({ outcome: "unknown", result: null }) },
      pin: { sessionId: "sess-lower-unknown" },
    };
    const c = makeClient({ sessionKind: "a8n", sessionFactory: async () => session, runsDir });
    const { payload, isError } = toolPayload(await c.request("tools/call", {
      name: "ae_execute",
      arguments: { opId: "read.projectSummary", consent: "grant" },
    }));
    assert.equal(isError, true);
    // Raw "unknown" is normalized to the wire spelling — consumers
    // comparing "UNKNOWN" must not miss it.
    assert.equal(payload.outcome, "UNKNOWN");
    assert.equal(payload.session.kind, "a8n");
    assert.equal(payload.session.evidenceLevel, "verified on real host (macOS)");
    // The run-guard event uses the same normalization: lowercase
    // "unknown" is the recoverable in-flight state → "timeout", never
    // "resolved".
    const marker = readOnlyMarker(runsDir);
    const events = marker.requests.map((r) => r.event);
    assert.ok(events.includes("timeout"), `expected timeout event, got ${JSON.stringify(events)}`);
    assert.ok(!events.includes("resolved"));
    await c.server.close();
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test("runner returning null produces a structured payload, not a throw (Issue #226)", async () => {
  const c = makeClient({
    sessionFactory: async () => ({
      kind: "fake",
      evidenceLevel: "fake/mock only",
      runner: { runScript: async () => null },
      pin: { sessionId: "sess-null-runner" },
      close: async () => {},
    }),
  });
  const { payload, isError } = toolPayload(await c.request("tools/call", {
    name: "ae_execute",
    arguments: { opId: "read.projectSummary", consent: "grant" },
  }));
  assert.equal(isError, true);
  assert.equal(payload.outcome, "FAILED");
  assert.equal(payload.result.reason, "EMPTY_RUNNER_RESULT");
  await c.server.close();
});
