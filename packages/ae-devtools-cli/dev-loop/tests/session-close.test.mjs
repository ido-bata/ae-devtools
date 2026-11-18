/**
 * session-close.test.mjs — bounded session close shared by CLI/MCP/
 * VSCode (Issue #196).
 *
 * The fake session honors AE_DEVTOOLS_CLI_FAKE_CLOSE=hang|throw, so
 * the timeout path is exercised without a real host.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { closeSessionWithTimeout, DEFAULT_CLOSE_TIMEOUT_MS } from "../session-close.mjs";
import { openFakeSession } from "../../devtools-cli/fake-session.mjs";

test("closeSessionWithTimeout: no session / no close() is not attempted, not a failure", async () => {
  assert.deepEqual(await closeSessionWithTimeout(null), { attempted: false, ok: null, error: null, result: null, timedOut: false });
  assert.deepEqual(await closeSessionWithTimeout({}), { attempted: false, ok: null, error: null, result: null, timedOut: false });
});

test("closeSessionWithTimeout: clean close reports ok with the close result", async () => {
  const r = await closeSessionWithTimeout({ close: async () => ({ quit: true }) });
  assert.equal(r.attempted, true);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.result, { quit: true });
});

test("closeSessionWithTimeout: a throwing close is reported, never swallowed", async () => {
  const r = await closeSessionWithTimeout({ close: async () => { throw new Error("boom"); } });
  assert.equal(r.attempted, true);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test("closeSessionWithTimeout: a hung close is bounded by timeoutMs (fake hang seam)", async () => {
  const prev = process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
  process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE = "hang";
  try {
    const started = Date.now();
    const r = await closeSessionWithTimeout(openFakeSession(), { timeoutMs: 80 });
    assert.ok(Date.now() - started < 10_000, "close was not bounded");
    assert.equal(r.attempted, true);
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out after 80ms/);
  } finally {
    if (prev === undefined) delete process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
    else process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE = prev;
  }
});

test("closeSessionWithTimeout: fake close failure seam reports ok:false", async () => {
  const prev = process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
  process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE = "throw";
  try {
    const r = await closeSessionWithTimeout(openFakeSession(), { timeoutMs: 1_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /injected fake close failure/);
  } finally {
    if (prev === undefined) delete process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
    else process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE = prev;
  }
});

test("closeSessionWithTimeout: invalid timeoutMs falls back to the shared default", async () => {
  assert.equal(DEFAULT_CLOSE_TIMEOUT_MS, 20_000);
  const r = await closeSessionWithTimeout({ close: async () => {} }, { timeoutMs: Number.NaN });
  assert.equal(r.ok, true);
});
