/**
 * supervision.test.mjs — ae-a8n supervision contract consumer tests
 * (Issue #408). Fake level only: durable state files are written into
 * temp dirs; no After Effects, no monitor, no GUI is involved.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SUPERVISION_SCHEMA_VERSION,
  SUPERVISION_STATE_FILE,
  decodeSupervisionDoc,
  evaluateObservationHealth,
  needsHumanInfo,
  readMonitorLease,
  readSupervisionState,
  supervisionBlocksClean,
  supervisionEscalation,
  supervisionReport,
  supervisionSnapshot,
  stricterVerdict,
  supervisionStatePath,
  waitForSupervisionPhase,
} from "../supervision.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "ae-sup-"));
}

const NOW = new Date("2026-11-20T12:00:00.000Z");

function doc(overrides = {}) {
  return {
    schemaVersion: SUPERVISION_SCHEMA_VERSION,
    sessionId: "sess-1",
    phase: "running",
    observationHealth: "ok",
    blocking: null,
    pendingRequests: [],
    enteredAt: "2026-11-20T11:59:00.000Z",
    deadline: null,
    evidence: [],
    monitor: {
      ownerId: "mon-1",
      pid: 1234,
      pidStart: null,
      acquiredAt: "2026-11-20T11:58:00.000Z",
      heartbeatAt: "2026-11-20T11:59:59.000Z",
    },
    history: [],
    updatedAt: "2026-11-20T11:59:59.000Z",
    ...overrides,
  };
}

function writeState(dir, value) {
  writeFileSync(supervisionStatePath(dir), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

// ------------------------------------------------------------ decode

test("decodeSupervisionDoc accepts a valid running doc", () => {
  assert.equal(decodeSupervisionDoc(doc()) !== null, true);
});

test("decodeSupervisionDoc rejects wrong schema version (future/corrupt)", () => {
  assert.equal(decodeSupervisionDoc(doc({ schemaVersion: "ae-a8n.supervision/v2" })), null);
  assert.equal(decodeSupervisionDoc(doc({ schemaVersion: "other/v9" })), null);
});

test("decodeSupervisionDoc enforces the bounded-wait invariant", () => {
  // Non-running phases MUST carry a deadline — a doc without one is corrupt.
  assert.equal(decodeSupervisionDoc(doc({ phase: "blocked", deadline: null })), null);
  assert.equal(
    decodeSupervisionDoc(doc({ phase: "needs-human", deadline: "2026-11-20T12:05:00.000Z" })) !== null,
    true,
  );
});

test("decodeSupervisionDoc rejects malformed windows/pending/monitor", () => {
  assert.equal(decodeSupervisionDoc(doc({ blocking: { host: "bogus", detail: "x", windows: [] } })), null);
  assert.equal(decodeSupervisionDoc(doc({ pendingRequests: [{ id: 1 }] })), null);
  assert.equal(decodeSupervisionDoc(doc({ monitor: { ownerId: "x" } })), null);
});

// ------------------------------------------------------------ read/report

test("readSupervisionState: absent vs corrupt vs state", () => {
  const dir = tmp();
  assert.deepEqual(readSupervisionState(dir), { kind: "absent" });
  writeState(dir, "{not json");
  assert.equal(readSupervisionState(dir).kind, "corrupt");
  writeState(dir, doc());
  assert.equal(readSupervisionState(dir).kind, "state");
});

test("supervisionReport: absent is unavailable, never healthy", () => {
  const r = supervisionReport(tmp(), { now: NOW });
  assert.equal(r.status, "unavailable");
  assert.equal(r.source, "absent");
});

test("supervisionReport: corrupt is unavailable", () => {
  const dir = tmp();
  writeState(dir, "garbage");
  const r = supervisionReport(dir, { now: NOW });
  assert.equal(r.status, "unavailable");
  assert.equal(r.source, "corrupt");
});

test("evaluateObservationHealth: stale heartbeat is monitor-lost even when doc claims ok", () => {
  const d = doc({
    monitor: { ownerId: "m", pid: 1, pidStart: null, acquiredAt: "x", heartbeatAt: "2026-11-20T11:00:00.000Z" },
  });
  const r = evaluateObservationHealth(d, NOW, 30_000);
  assert.equal(r.health, "monitor-lost");
});

test("evaluateObservationHealth: no monitor recorded downgrades stored ok to unavailable", () => {
  const r = evaluateObservationHealth(doc({ monitor: null }), NOW);
  assert.equal(r.health, "unavailable");
});

test("evaluateObservationHealth: fresh heartbeat preserves stored degraded", () => {
  const d = doc({ observationHealth: "degraded" });
  const r = evaluateObservationHealth(d, NOW, 30_000);
  assert.equal(r.health, "degraded");
});

test("readMonitorLease: absent/corrupt/lease", () => {
  const dir = tmp();
  assert.equal(readMonitorLease(dir).kind, "absent");
  writeFileSync(join(dir, "monitor.lease.json"), "{}");
  assert.equal(readMonitorLease(dir).kind, "corrupt");
  writeFileSync(
    join(dir, "monitor.lease.json"),
    JSON.stringify({ schemaVersion: "ae-a8n.monitor-lease/v1", ownerId: "m", pid: 1, acquiredAt: "x", heartbeatAt: "y" }),
  );
  assert.equal(readMonitorLease(dir).kind, "lease");
});

// ------------------------------------------------------------ snapshot + needs-human

test("supervisionSnapshot carries phase/health/needsHuman and stays honest on unavailable", () => {
  const dir = tmp();
  const absent = supervisionReport(dir, { now: NOW });
  const snap = supervisionSnapshot(absent);
  assert.equal(snap.status, "unavailable");
  assert.equal(snap.needsHuman ?? null, null);

  writeState(dir, doc({
    phase: "needs-human",
    deadline: "2026-11-20T12:10:00.000Z",
    blocking: {
      host: "none",
      detail: "sign-in dialog is up",
      windows: [{
        title: "Sign In", role: "AXDialog", subrole: null, blocking: true,
        tier: "human-required", dialogClass: "sign-in", code: "A8N-AUTH-001",
        texts: ["Please sign in"], buttons: ["Cancel", "Sign In"],
      }],
    },
  }));
  const report = supervisionReport(dir, { now: NOW });
  const s2 = supervisionSnapshot(report);
  assert.equal(s2.phase, "needs-human");
  assert.equal(s2.health, "ok");
  assert.equal(s2.needsHuman.phase, "needs-human");
  assert.deepEqual(s2.needsHuman.options.sort(), ["Cancel", "Sign In"]);
  assert.match(s2.needsHuman.resumePath, /supervision status/);
});

test("needsHumanInfo is null for non-human phases", () => {
  const dir = tmp();
  writeState(dir, doc({ phase: "blocked", deadline: "2026-11-20T12:05:00.000Z" }));
  assert.equal(needsHumanInfo(supervisionReport(dir, { now: NOW })), null);
});

// ------------------------------------------------------------ verdict mapping

test("supervisionEscalation: corrupt → unknown, absent → null", () => {
  const dir = tmp();
  assert.equal(supervisionEscalation(supervisionReport(dir, { now: NOW })), null);
  writeState(dir, "junk");
  assert.equal(supervisionEscalation(supervisionReport(dir, { now: NOW })), "unknown");
});

test("supervisionEscalation: monitor-lost/unavailable health → unknown regardless of phase", () => {
  const dir = tmp();
  writeState(dir, doc({
    phase: "running",
    monitor: { ownerId: "m", pid: 1, pidStart: null, acquiredAt: "x", heartbeatAt: "2026-11-20T10:00:00.000Z" },
  }));
  assert.equal(supervisionEscalation(supervisionReport(dir, { now: NOW })), "unknown");
});

test("supervisionEscalation: phase mapping", () => {
  const cases = [
    ["quarantined", "quarantined"],
    ["needs-human", "quarantined"],
    ["blocked", "await-original"],
    ["recovering", "await-original"],
    ["running", null],
    ["resumed", null],
  ];
  for (const [phase, expected] of cases) {
    const dir = tmp();
    writeState(dir, doc({
      phase,
      deadline: phase === "running" || phase === "resumed" ? null : "2026-11-20T12:05:00.000Z",
    }));
    assert.equal(supervisionEscalation(supervisionReport(dir, { now: NOW })), expected, phase);
  }
});

test("supervisionEscalation: degraded health does not escalate but is not clean", () => {
  const dir = tmp();
  writeState(dir, doc({ observationHealth: "degraded" }));
  const report = supervisionReport(dir, { now: NOW });
  assert.equal(report.health, "degraded");
  assert.equal(supervisionEscalation(report), null);
  assert.equal(supervisionBlocksClean(report), true);
});

test("supervisionBlocksClean: ok+running passes; ok+blocked fails", () => {
  const dir = tmp();
  writeState(dir, doc());
  assert.equal(supervisionBlocksClean(supervisionReport(dir, { now: NOW })), false);
  writeState(dir, doc({ phase: "blocked", deadline: "2026-11-20T12:05:00.000Z" }));
  assert.equal(supervisionBlocksClean(supervisionReport(dir, { now: NOW })), true);
});

test("stricterVerdict only escalates", () => {
  assert.equal(stricterVerdict("await-original", "quarantined"), "quarantined");
  assert.equal(stricterVerdict("quarantined", "await-original"), "quarantined");
  assert.equal(stricterVerdict("clean", "unknown"), "unknown");
  assert.equal(stricterVerdict("unknown", null), "unknown");
  assert.equal(stricterVerdict("await-original", null), "await-original");
});

// ------------------------------------------------------------ bounded wait

test("waitForSupervisionPhase returns immediately on matching phase", async () => {
  const dir = tmp();
  writeState(dir, doc({ phase: "blocked", deadline: "2026-11-20T12:05:00.000Z" }));
  const r = await waitForSupervisionPhase(dir, {
    phases: ["blocked"], timeoutMs: 50, now: () => NOW,
  });
  assert.equal(r.timedOut, false);
  assert.equal(r.report.doc.phase, "blocked");
});

test("waitForSupervisionPhase real-clock bound: times out on running phase", async () => {
  const dir = tmp();
  writeState(dir, doc());
  const started = Date.now();
  const r = await waitForSupervisionPhase(dir, {
    phases: ["blocked"], timeoutMs: 120, intervalMs: 30,
  });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 2_000, "wait stayed bounded");
});

test("waitForSupervisionPhase honours the phase deadline over a larger timeout", async () => {
  const dir = tmp();
  // deadline already in the past relative to real now
  writeState(dir, doc({
    phase: "needs-human",
    deadline: new Date(Date.now() - 1_000).toISOString(),
    blocking: { host: "none", detail: "x", windows: [] },
  }));
  // phases excludes needs-human → must wait, but deadline already passed → deadlineExceeded
  const r = await waitForSupervisionPhase(dir, {
    phases: ["resumed"], timeoutMs: 60_000, intervalMs: 50,
  });
  assert.equal(r.deadlineExceeded, true);
  assert.equal(r.timedOut, false);
});
