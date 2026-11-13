/**
 * one-in-flight atomicity across independent processes — regression for
 * the claimInFlight TOCTOU (Issue #13 follow-up).
 *
 * Several `probe.mjs` processes are spawned against the SAME prepared
 * channel with no responder. The in-flight claim must be atomic: exactly
 * one process may write a request; every other must return
 * BLOCKED ONE_IN_FLIGHT without writing anything.
 *
 * Evidence level: automated-test (fake channel, real concurrent processes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeChannel, requestIdInbox, cleanup,
} from "./helpers.mjs";

const probe = join(import.meta.dirname, "..", "probe.mjs");

function runProbe(channel, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe, "ping", channel, String(timeoutMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      let event = null;
      try {
        event = JSON.parse(out);
      } catch {
        // leave null; assertions below report the raw streams
      }
      resolve({ code, event, out, err });
    });
  });
}

test("N concurrent probe processes produce exactly one in-flight request", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-conc-"));
  try {
    const { channel } = makeChannel(root);   // no responder: winner ends UNKNOWN
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () => runProbe(channel, 500)),
    );
    for (const r of results) {
      assert.equal(r.err, "", `probe wrote to stderr: ${r.err}`);
      assert.ok(r.event, `probe produced no JSON event: ${r.out}`);
    }
    const requests = requestIdInbox(channel);
    assert.equal(
      requests.length, 1,
      `one-in-flight violated: ${requests.length} request files for ${N} concurrent commands`,
    );
    const blocked = results.filter(
      (r) => r.event.outcome === "BLOCKED" && r.event.blocker?.code === "ONE_IN_FLIGHT",
    );
    assert.equal(blocked.length, N - 1, "every loser must be BLOCKED ONE_IN_FLIGHT");
    for (const r of blocked) {
      assert.equal(r.event.requestState, "NOT_SENT");
    }
    const winner = results.find((r) => r.event.requestId === requests[0]);
    assert.ok(winner, "the request file must belong to one of the spawned commands");
    assert.equal(winner.event.outcome, "UNKNOWN");
    // The losers wrote nothing: no extra request files, no trace events
    // beyond the single winner's UNKNOWN.
    const traceLines = readdirSync(channel).includes("trace.jsonl")
      ? readFileSync(join(channel, "trace.jsonl"), "utf8").trim().split("\n")
      : [];
    assert.equal(traceLines.length, 1, "exactly one trace event (the winner)");
  } finally {
    cleanup(root);
  }
});
