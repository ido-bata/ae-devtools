/**
 * supervision.test.mjs — dev-loop supervision snapshot tests
 * (Issue #408). Fake level only: durable ae-a8n.supervision/v1 files in
 * temp dirs; no AE, no monitor, no GUI.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  supervisionSnapshotForSession,
  awaitSupervisionClassification,
} from "../supervision.mjs";
import { supervisionStatePath } from "../../a8n-transport/supervision.mjs";
import { recordFromExecuteResult } from "../failure-record.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "ae-dl-sup-"));
}

function writeDoc(dir, overrides = {}) {
  const doc = {
    schemaVersion: "ae-a8n.supervision/v1",
    sessionId: "s1",
    phase: "running",
    observationHealth: "ok",
    blocking: null,
    pendingRequests: [],
    enteredAt: new Date().toISOString(),
    deadline: null,
    evidence: [],
    monitor: {
      ownerId: "m", pid: 1, pidStart: null,
      acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    },
    history: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(supervisionStatePath(dir), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

test("supervisionSnapshotForSession: null for sessions without an ae-a8n root", () => {
  assert.equal(supervisionSnapshotForSession({ kind: "fake" }), null);
  assert.equal(supervisionSnapshotForSession(null), null);
});

test("supervisionSnapshotForSession reads sessionRoot and slice.sessionRoot", () => {
  const dir = tmp();
  writeDoc(dir);
  const snap = supervisionSnapshotForSession({ kind: "a8n", sessionRoot: dir });
  assert.equal(snap.status, "observed");
  assert.equal(snap.phase, "running");
  assert.equal(snap.health, "ok");
  const snap2 = supervisionSnapshotForSession({ kind: "a8n-attached", slice: { sessionRoot: dir } });
  assert.equal(snap2.phase, "running");
});

test("supervisionSnapshotForSession: absent state is unavailable, corrupt is unavailable — never healthy", () => {
  const absent = supervisionSnapshotForSession({ sessionRoot: tmp() });
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.source, "absent");
  const dir = tmp();
  writeFileSync(supervisionStatePath(dir), "not json");
  const corrupt = supervisionSnapshotForSession({ sessionRoot: dir });
  assert.equal(corrupt.status, "unavailable");
  assert.equal(corrupt.source, "corrupt");
});

test("awaitSupervisionClassification: bounded wait returns blocking phase or times out", async () => {
  const dir = tmp();
  writeDoc(dir, {
    phase: "blocked",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    blocking: { host: "busy-suspected", detail: "AE busy", windows: [] },
  });
  const hit = await awaitSupervisionClassification({ sessionRoot: dir }, { timeoutMs: 2_000 });
  assert.equal(hit.timedOut, false);
  assert.equal(hit.snapshot.phase, "blocked");

  // running phase never classifies → bounded timeout, not a hang
  const dir2 = tmp();
  writeDoc(dir2);
  const started = Date.now();
  const miss = await awaitSupervisionClassification({ sessionRoot: dir2 }, { timeoutMs: 150, intervalMs: 30 });
  assert.equal(miss.timedOut, true);
  assert.ok(Date.now() - started < 2_000);
});

test("awaitSupervisionClassification: no session root returns immediately", async () => {
  const r = await awaitSupervisionClassification({ kind: "fake" }, { timeoutMs: 60_000 });
  assert.equal(r.snapshot, null);
  assert.equal(r.timedOut, false);
});

test("recordFromExecuteResult attaches supervision snapshot additively", () => {
  const dir = tmp();
  writeDoc(dir, {
    phase: "needs-human",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    blocking: {
      host: "none", detail: "license expired",
      windows: [{
        title: "License", role: "AXWindow", subrole: "AXDialog", blocking: true,
        tier: "human-required", dialogClass: "license", code: "X",
        texts: [], buttons: ["OK"],
      }],
    },
  });
  const supervision = supervisionSnapshotForSession({ sessionRoot: dir });
  const record = recordFromExecuteResult({
    result: { status: "FAILED", error: { code: "E_TIMEOUT", message: "timed out" } },
    outcome: "FAILED",
    session: { kind: "a8n-attached", pin: null },
    supervision,
    collectors: {
      fromAeError: () => ({ kind: "transport-outcome", severity: "error" }),
      fromTransportOutcome: () => ({ kind: "transport-outcome", severity: "error" }),
    },
  });
  assert.ok(record !== null);
  assert.equal(record.supervision.phase, "needs-human");
  assert.equal(record.supervision.needsHuman.reason, "license expired");
  // Without supervision the record shape is unchanged.
  const plain = recordFromExecuteResult({
    result: { status: "FAILED", error: { code: "E_TIMEOUT", message: "timed out" } },
    outcome: "FAILED",
    session: { kind: "a8n-attached", pin: null },
    collectors: {
      fromAeError: () => ({ kind: "transport-outcome", severity: "error" }),
      fromTransportOutcome: () => ({ kind: "transport-outcome", severity: "error" }),
    },
  });
  assert.equal("supervision" in plain, false);
});
