/**
 * wrong-target / mis-delivery tests — CAP023 §5 + CAP021 identity checks.
 *
 * A fake responder that speaks the right protocol but answers with ANOTHER
 * AE's identity must produce REFUSED/WRONG_TARGET (or UNKNOWN when the
 * reply is unattributable), never a silent pass.
 * Evidence level: automated-test (fake responder, no AE).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  makeChannel, fakeResponder, cleanup, readChannelJson, TOKEN,
} from "./helpers.mjs";

const probe = join(import.meta.dirname, "..", "probe.mjs");

/** spawn (not spawnSync): the fake responder needs this loop alive. */
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

const goodIdentity = (over = {}) => ({
  aeVersion: "27.0.0", aeBuildName: "27.0x55", scriptingVersion: "27.0",
  isoLanguage: "ja_JP", locale: "ja_JP", userName: "probeuser",
  sessionId: "sess-1", channelId: "chan-cccccccc", dispatchId: "disp-1",
  ...over,
});

test("reply from a different sessionId than pinned → REFUSED WRONG_TARGET", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-wrongtarget-"));
  try {
    const { channel } = makeChannel(root);
    // pin the target as if a previous identify had succeeded
    writeFileSync(join(channel, "target.json"), JSON.stringify({
      sessionId: "sess-expected", aeVersion: "27.0.0",
      pinnedAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });

    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-other", ok: true, hostEvalMs: 1,
      result: goodIdentity({ sessionId: "sess-ANOTHER" }),  // wrong session
    }));
    try {
      const r = await run(["ping", channel, "5000"]);
      assert.equal(r.event.outcome, "REFUSED");
      assert.equal(r.event.refusal.code, "WRONG_TARGET");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("reply with the wrong channel token → UNKNOWN UNATTRIBUTABLE_REPLY", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-wrongtoken-"));
  try {
    const { channel } = makeChannel(root);
    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: "f".repeat(64), channelId: "chan-cccccccc",
      ok: true, result: goodIdentity(),
    }));
    try {
      const r = await run(["ping", channel, "5000"]);
      assert.equal(r.event.outcome, "UNKNOWN");
      assert.equal(r.event.unknownCategory, "UNATTRIBUTABLE_REPLY",
        "a token mismatch cannot be attributed to any host — never REFUSED, never accepted");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("identify accepts the FIRST identity and pins it; a second identity change is then caught", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-pin-"));
  try {
    const { channel } = makeChannel(root);
    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-a", ok: true, hostEvalMs: 1,
      result: goodIdentity({ sessionId: "sess-first" }),
    }));
    try {
      const r = await run(["identify", channel, "5000"]);
      assert.equal(r.event.outcome, "COMPLETED");
      assert.ok(r.event.result.sessionId.length > 0);
      const pinned = readChannelJson(channel, "target.json");
      assert.equal(pinned.sessionId, "sess-first");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("pinned channel + success reply WITHOUT session identity → REFUSED WRONG_TARGET (fail closed)", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-noident-"));
  try {
    const { channel } = makeChannel(root);
    writeFileSync(join(channel, "target.json"), JSON.stringify({
      sessionId: "sess-expected", aeVersion: "27.0.0",
      pinnedAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });

    // a reply that matches token/channelId/id but carries no identity at
    // all (e.g. a host that answers echo without an identity block)
    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-x", ok: true, hostEvalMs: 1,
      result: { echoed: "ping" },
    }));
    try {
      const r = await run(["ping", channel, "5000"]);
      assert.equal(r.event.outcome, "REFUSED");
      assert.equal(r.event.refusal.code, "WRONG_TARGET");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("pinned channel + identify from a DIFFERENT session → REFUSED and pin is NOT overwritten", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-repin-"));
  try {
    const { channel } = makeChannel(root);
    writeFileSync(join(channel, "target.json"), JSON.stringify({
      sessionId: "sess-A", aeVersion: "27.0.0", dispatchId: "disp-A",
      pinnedAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });

    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-B", ok: true, hostEvalMs: 1,
      result: goodIdentity({ sessionId: "sess-B", dispatchId: "disp-B" }),
    }));
    try {
      const r = await run(["identify", channel, "5000"]);
      assert.equal(r.event.outcome, "REFUSED");
      assert.equal(r.event.refusal.code, "WRONG_TARGET");
      const pinned = readChannelJson(channel, "target.json");
      assert.equal(pinned.sessionId, "sess-A", "pin must survive a refused re-identify");
      assert.equal(pinned.dispatchId, "disp-A");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("identify --pin-session is the explicit re-pin: overwrites a stale pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-repin-ok-"));
  try {
    const { channel } = makeChannel(root);
    writeFileSync(join(channel, "target.json"), JSON.stringify({
      sessionId: "sess-OLD", aeVersion: "26.5.3x9",
      pinnedAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });

    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-new", ok: true, hostEvalMs: 1,
      result: goodIdentity({ sessionId: "sess-new", dispatchId: "disp-new" }),
    }));
    try {
      const r = await run(["identify", channel, "5000", "--pin-session"]);
      assert.equal(r.event.outcome, "COMPLETED");
      const pinned = readChannelJson(channel, "target.json");
      assert.equal(pinned.sessionId, "sess-new");
      assert.equal(pinned.dispatchId, "disp-new");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("pinned dispatchId mismatch (dispatcher re-activated) → REFUSED WRONG_TARGET", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-dispatchid-"));
  try {
    const { channel } = makeChannel(root);
    writeFileSync(join(channel, "target.json"), JSON.stringify({
      sessionId: "sess-1", aeVersion: "27.0.0", dispatchId: "disp-OLD",
      pinnedAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });

    const stopResponder = fakeResponder(channel, (id) => ({
      v: 1, id, token: TOKEN, channelId: "chan-cccccccc",
      dispatchId: "disp-NEW", ok: true, hostEvalMs: 1,
      result: goodIdentity({ sessionId: "sess-1", dispatchId: "disp-NEW" }),
    }));
    try {
      const r = await run(["ping", channel, "5000"]);
      assert.equal(r.event.outcome, "REFUSED");
      assert.equal(r.event.refusal.code, "WRONG_TARGET");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("unparseable reply → UNKNOWN UNREADABLE_REPLY (quarantine, do not retry)", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-unreadable-"));
  try {
    const { channel } = makeChannel(root);
    const stopResponder = fakeResponderRaw(channel, (id) => "{not json");
    try {
      const r = await run(["ping", channel, "5000"]);
      assert.equal(r.event.outcome, "UNKNOWN");
      assert.equal(r.event.unknownCategory, "UNREADABLE_REPLY");
    } finally {
      stopResponder();
    }
  } finally {
    cleanup(root);
  }
});

test("environment-proven failure is BLOCKED before anything is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-blocked-"));
  try {
    const r = await run(["ping", join(root, "does-not-exist"), "1000"]);
    assert.equal(r.event.outcome, "BLOCKED");
    assert.equal(r.event.blocker.code, "CHANNEL_NOT_PREPARED");
    assert.equal(r.event.requestState, "NOT_SENT");
  } finally {
    cleanup(root);
  }
});

/** A responder that publishes arbitrary RAW text (not JSON). */
import { publishResult, publishRawResult, requestIdInbox } from "./helpers.mjs";
function fakeResponderRaw(channel, buildRaw) {
  const timer = setInterval(async () => {
    try {
      for (const id of requestIdInbox(channel)) {
        publishRawResult(channel, id, buildRaw(id));
      }
    } catch {
      // channel may be gone during cleanup
    }
  }, 20);
  return () => clearInterval(timer);
}

