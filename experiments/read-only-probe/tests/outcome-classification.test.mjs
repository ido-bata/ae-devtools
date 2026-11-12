/**
 * outcome-classification tests — CAP023 mapping table pinned as tests.
 *
 * Uses probe.mjs against a fake responder for COMPLETED/REFUSED and a
 * silent channel for UNKNOWN + BLOCKED.
 * Evidence level: automated-test (fake responder, no AE).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  makeChannel, fakeResponder, cleanup, TOKEN,
} from "./helpers.mjs";

const probe = join(import.meta.dirname, "..", "probe.mjs");

/** spawn (NOT spawnSync): the fake responder runs on this loop while the
 *  child runs, so the loop must stay alive. */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe, ...args]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      resolve({
        event: (() => { try { return JSON.parse(out); } catch { return null; } })(),
      });
    });
  });
}

const goodIdentity = {
  aeVersion: "27.0.0", aeBuildName: "27.0x55", scriptingVersion: "27.0",
  isoLanguage: "ja_JP", locale: "ja_JP", userName: "probeuser",
  sessionId: "sess-1", channelId: "chan-cccccccc", dispatchId: "disp-1",
};

test("COMPLETED: a genuine reply is COMPLETED with requestState ACKED and latency recorded", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-classify-ok-"));
  try {
    const { channel } = makeChannel(root);
    const stop = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-1", ok: true, hostEvalMs: 2,
      hostClock: "2026-11-12T09:00:00.000Z",
      result: { ...goodIdentity },
    }));
    try {
      const r = await run(["identify", channel, "5000"]);
      assert.equal(r.event.outcome, "COMPLETED");
      assert.equal(r.event.requestState, "ACKED");
      assert.equal(r.event.result.aeVersion, "27.0.0");
      assert.ok(typeof r.event.roundTripMs === "number" && r.event.roundTripMs >= 0);
      assert.equal(typeof r.event.durationMs, "number");
    } finally {
      stop();
    }
  } finally {
    cleanup(root);
  }
});

test("REFUSED: a host-issued refusal (EXPIRED) is REFUSED, never UNKNOWN", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-classify-refused-"));
  try {
    const { channel } = makeChannel(root);
    const stop = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-1", ok: false,
      refusal: { code: "EXPIRED", message: "request refused before execution" },
    }));
    try {
      const r = await run(["ping", channel, "5000"]);
      assert.equal(r.event.outcome, "REFUSED");
      assert.equal(r.event.refusal.code, "EXPIRED");
      assert.equal(r.event.requestState, "ACKED");
    } finally {
      stop();
    }
  } finally {
    cleanup(root);
  }
});

test("UNKNOWN: bridge missing / busy AE (indistinguishable) is UNKNOWN — not BLOCKED, not REFUSED", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-classify-unknown-"));
  try {
    const { channel } = makeChannel(root);   // no responder at all
    const r = await run(["ping", channel, "300"]);
    assert.equal(r.event.outcome, "UNKNOWN");
    assert.equal(r.event.unknownCategory, "NO_REPLY_BEFORE_DEADLINE");
    assert.ok(!r.event.blocker, "UNKNOWN must not carry a blocker (that would be BLOCKED)");
    assert.ok(!r.event.refusal, "UNKNOWN must not carry a refusal (that would be REFUSED)");
  } finally {
    cleanup(root);
  }
});

test("BLOCKED: unprepared channel is BLOCKED with requestState NOT_SENT", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-classify-blocked-"));
  try {
    const r = await run(["ping", join(root, "missing"), "1000"]);
    assert.equal(r.event.outcome, "BLOCKED");
    assert.equal(r.event.blocker.code, "CHANNEL_NOT_PREPARED");
    assert.equal(r.event.requestState, "NOT_SENT");
  } finally {
    cleanup(root);
  }
});

test("BLOCKED: group/other-readable channel is refused pre-dispatch (privacy gate)", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-classify-priv-"));
  try {
    const { channel } = makeChannel(root);
    chmodSync(channel, 0o757);   // group/other bits set
    const r = await run(["ping", channel, "1000"]);
    assert.equal(r.event.outcome, "BLOCKED");
    assert.equal(r.event.blocker.code, "CHANNEL_NOT_PRIVATE");
    assert.equal(r.event.requestState, "NOT_SENT");
  } finally {
    cleanup(root);
  }
});
