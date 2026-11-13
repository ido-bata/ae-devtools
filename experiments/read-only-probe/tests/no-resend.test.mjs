/**
 * no-resend regression — the absolute rule of outcome-model.md §4:
 * after a timeout the client MUST NOT re-send, re-create, or delete the
 * request. The next command must use a new id, and the old id must never
 * appear again.
 *
 * A fake responder that never answers simulates an absent dispatcher /
 * busy AE — indistinguishable from here, hence UNKNOWN.
 * Evidence level: automated-test (fake responder, no AE).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  makeChannel, requestIdInbox, cleanup, readChannelJson,
} from "./helpers.mjs";

const probe = join(import.meta.dirname, "..", "probe.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [probe, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    event: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })(),
  };
}

test("timeout yields UNKNOWN and the request file is left in place, never removed", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-noresend-"));
  try {
    const { channel } = makeChannel(root);   // no responder: bridge missing
    const r = run(["ping", channel, "300"]);
    assert.equal(r.event.outcome, "UNKNOWN");
    assert.equal(r.event.unknownCategory, "NO_REPLY_BEFORE_DEADLINE");
    assert.equal(r.event.requestState, "SENT_NOT_ACKNOWLEDGED");
    const ids = requestIdInbox(channel);
    assert.equal(ids.length, 1, "request file must be left in the inbox after UNKNOWN");
    assert.equal(ids[0], r.event.requestId);
  } finally {
    cleanup(root);
  }
});

test("a second command after UNKNOWN uses a NEW id — no id is ever reused", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-noresend2-"));
  try {
    const { channel } = makeChannel(root);
    const first = run(["ping", channel, "250"]);
    const second = run(["ping", channel, "250"]);
    assert.equal(first.event.outcome, "UNKNOWN");
    assert.equal(second.event.outcome, "UNKNOWN");
    const id1 = first.event.requestId;
    const id2 = second.event.requestId;
    assert.notEqual(id1, id2, "the burned id must never be re-issued");
    const ids = readChannelJson(channel, "ids.json").burned;
    assert.ok(ids.includes(id1) && ids.includes(id2));
    assert.equal(new Set(ids).size, ids.length, "no id is duplicated in the registry");
    // both request files remain (never deleted, never overwritten)
    assert.equal(requestIdInbox(channel).length, 2);
  } finally {
    cleanup(root);
  }
});

test("one invocation writes exactly one request — there is no auto-retry path", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-noresend3-"));
  try {
    const { channel } = makeChannel(root);
    run(["ping", channel, "400"]);
    assert.equal(requestIdInbox(channel).length, 1,
      "one ping must produce exactly one request file (no resend loop)");
    const trace = readFileSync(join(channel, "trace.jsonl"), "utf8").trim().split("\n");
    assert.equal(trace.length, 1, "exactly one trace event per invocation");
    const event = JSON.parse(trace[0]);
    assert.equal(event.outcome, "UNKNOWN");
  } finally {
    cleanup(root);
  }
});

test("one-in-flight: a SECOND command while the first is un-acknowledged writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-noresend4-"));
  try {
    const { channel } = makeChannel(root);
    // simulate a still-in-flight request whose deadline is in the future
    writeInFlight(channel, {
      id: "f".repeat(32), state: "SENT",
      startedAt: new Date().toISOString(),
      deadlineMs: Date.now() + 60_000,
    });
    const before = readdirSync(join(channel, "inbox"));
    const r = run(["ping", channel, "300"]);
    assert.equal(r.event.outcome, "BLOCKED");
    assert.equal(r.event.blocker.code, "ONE_IN_FLIGHT");
    assert.equal(r.event.requestState, "NOT_SENT");
    assert.deepEqual(readdirSync(join(channel, "inbox")), before,
      "the blocked command must not write anything");
  } finally {
    cleanup(root);
  }
});

test("an expired in-flight marker does not block forever (deadline-bounded)", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-noresend5-"));
  try {
    const { channel } = makeChannel(root);
    writeInFlight(channel, {
      id: "0".repeat(32), state: "SENT",
      startedAt: new Date(Date.now() - 70_000).toISOString(),
      deadlineMs: Date.now() - 10_000,   // long past
    });
    const r = run(["ping", channel, "300"]);
    assert.equal(r.event.outcome, "UNKNOWN");   // proceeds, then times out
    assert.equal(requestIdInbox(channel).length, 1);
  } finally {
    cleanup(root);
  }
});

function writeInFlight(channel, data) {
  writeFileSync(join(channel, "in-flight.json"), JSON.stringify(data) + "\n", { mode: 0o600 });
}
