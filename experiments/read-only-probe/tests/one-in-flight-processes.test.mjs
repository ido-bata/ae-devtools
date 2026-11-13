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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("concurrent reclaim of an expired claim: exactly one winner, fresh claims never stolen", async () => {
  // Regression for the stale-claim TOCTOU: several processes may judge the
  // same expired claim stale at once. Only one may steal it and claim the
  // slot; every other must see the NEW valid claim and be BLOCKED — a
  // steal rename must never move a claim it did not verify as stale.
  const ROUNDS = 5;
  const N = 8;
  for (let round = 0; round < ROUNDS; round++) {
    const root = mkdtempSync(join(tmpdir(), `probe-reclaim-${round}-`));
    try {
      const { channel } = makeChannel(root);
      // Seed an expired claim, shaped like a real one (claimId + deadline).
      writeFileSync(join(channel, "in-flight.json"), JSON.stringify({
        id: "e".repeat(32), claimId: "deadbeef",
        state: "SENT_NOT_ACKNOWLEDGED",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        deadlineMs: Date.now() - 1_000,
      }) + "\n", { mode: 0o600 });
      const results = await Promise.all(
        Array.from({ length: N }, () => runProbe(channel, 400)),
      );
      for (const r of results) {
        assert.ok(r.event, `probe produced no JSON event: ${r.out} ${r.err}`);
      }
      const requests = requestIdInbox(channel);
      assert.equal(
        requests.length, 1,
        `round ${round}: reclaim race produced ${requests.length} in-flight requests`,
      );
      const blocked = results.filter(
        (r) => r.event.outcome === "BLOCKED" && r.event.blocker?.code === "ONE_IN_FLIGHT",
      );
      assert.equal(
        blocked.length, N - 1,
        `round ${round}: expected ${N - 1} ONE_IN_FLIGHT blockers, got ${blocked.length}`,
      );
      // The winner's claim must still be intact: its request id is the one
      // in the inbox and its outcome is UNKNOWN (no responder), not a
      // stolen-claim anomaly.
      const winner = results.find((r) => r.event.requestId === requests[0]);
      assert.ok(winner);
      assert.equal(winner.event.outcome, "UNKNOWN");
      // Exactly the winner's claim may remain (it stays until its deadline
      // or a release sweep); no probe/stale/temp/loser-claim litter.
      const leftovers = readdirSync(channel).filter(
        (f) => f.includes(".probe-") || f.includes(".stale-") || f.includes(".tmp-"),
      );
      assert.deepEqual(leftovers, [], `round ${round}: claim litter left behind`);
      const claimFiles = readdirSync(channel).filter((f) => f.startsWith("in-flight.claim-"));
      assert.equal(claimFiles.length, 1, `round ${round}: expected only the winner's claim file`);
    } finally {
      cleanup(root);
    }
  }
});
