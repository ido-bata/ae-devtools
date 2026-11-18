/**
 * real-run-session tests — guarded session open for real-AE drivers
 * (Issue #252).
 *
 * Everything here is fake-level: `openSessionFn` is injected, so no
 * After Effects and no ae-a8n module is touched. What is verified is
 * the marker lifecycle contract the drivers now share: a marker exists
 * BEFORE open, carries session + attested process evidence after open,
 * survives a "killed" driver as reap/recover-visible residue, and is
 * removed only on a confirmed "closed".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openRealRunSession, sliceProcessEvidence } from "../real-run-session.mjs";
import { ATTESTATION_SOURCE } from "../../devtools-cli/session-guard.mjs";

function tmpRunsDir() {
  return mkdtempSync(join(tmpdir(), "real-run-session-"));
}

function markerFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

function readOnlyMarker(dir) {
  const files = markerFiles(dir);
  assert.equal(files.length, 1, `expected exactly one marker, got ${files.join(",")}`);
  return JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
}

/** Fake opened session in the shape openSession("a8n") returns. */
function fakeOpened({ withTarget = true } = {}) {
  return {
    kind: "a8n",
    evidenceLevel: "fake/test — not real-host evidence",
    runner: {},
    pin: { sessionId: "fake-session" },
    close: async () => {},
    meta: { aeVersion: "26.5", ownership: "owned", aeA8nHead: "deadbeef" },
    slice: {
      ae: withTarget
        ? { recoveryTarget: () => ({ pid: 4242, session: { uid: 501, asid: 42 } }) }
        : {},
      ownership: { kind: "owned", evidence: "probe answered in owned session" },
      transportKind: "fake-transport",
      aeA8nHead: "deadbeef",
    },
  };
}

test("openRealRunSession: marker + attested process evidence recorded", async () => {
  const dir = tmpRunsDir();
  try {
    const { guard, opened, slice } = await openRealRunSession({
      surface: "test-real-run",
      argv: ["--install-dir", "/x"],
      runsDir: dir,
      openSessionFn: async (kind, opts) => {
        assert.equal(kind, "a8n");
        assert.deepEqual(opts, { aeA8nRoot: "/root", installDir: "/x" });
        return fakeOpened();
      },
      sessionOptions: { aeA8nRoot: "/root", installDir: "/x" },
    });
    assert.equal(opened.kind, "a8n");
    assert.equal(opened.pin.sessionId, "fake-session");
    assert.equal(slice.ownership.kind, "owned");

    const marker = readOnlyMarker(dir);
    assert.equal(marker.status, "open");
    assert.equal(marker.surface, "test-real-run");
    assert.equal(marker.sessionKind, "a8n");
    assert.deepEqual(marker.argv, ["--install-dir", "/x"]);
    assert.equal(marker.session.process.aePid, 4242);
    assert.deepEqual(marker.session.process.guiSession, { uid: 501, asid: 42 });
    assert.equal(marker.session.process.attestation.source, ATTESTATION_SOURCE);
    assert.equal(marker.session.process.attestation.ownershipKind, "owned");
    assert.equal(marker.session.process.attestation.aeA8nVersion, "deadbeef");

    // Simulated kill: no guard.end() — the marker MUST remain as
    // residue (this is the whole point of Issue #252).
    assert.equal(markerFiles(dir).length, 1);
    guard.end("closed");
    assert.equal(markerFiles(dir).length, 0, "closed run removes its marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openRealRunSession: close-failed keeps residue marker", async () => {
  const dir = tmpRunsDir();
  try {
    const { guard } = await openRealRunSession({
      surface: "test-real-run",
      runsDir: dir,
      openSessionFn: async () => fakeOpened(),
    });
    guard.end("close-failed");
    const marker = readOnlyMarker(dir);
    assert.equal(marker.status, "close-failed");
    assert.ok(marker.session.process.attestation, "attestation survives for reap/recover");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openRealRunSession: open failure -> open-failed marker, error rethrown", async () => {
  const dir = tmpRunsDir();
  try {
    const failure = new Error("launch refused: attached session");
    failure.code = "AE_A8N_CONTRACT_UNSUPPORTED";
    await assert.rejects(
      () => openRealRunSession({
        surface: "test-real-run",
        runsDir: dir,
        openSessionFn: async () => { throw failure; },
      }),
      (e) => e === failure,
    );
    const marker = readOnlyMarker(dir);
    assert.equal(marker.status, "open-failed");
    assert.equal(marker.session, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openRealRunSession: unattested slice -> no process evidence (fail-closed)", async () => {
  const dir = tmpRunsDir();
  try {
    const { guard } = await openRealRunSession({
      surface: "test-real-run",
      runsDir: dir,
      openSessionFn: async () => fakeOpened({ withTarget: false }),
    });
    const marker = readOnlyMarker(dir);
    assert.equal(marker.status, "open");
    assert.equal(marker.session.process, undefined,
      "no recoveryTarget -> no process block -> recover/reap refuse");
    guard.end("closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sliceProcessEvidence: null target and missing session fields degrade honestly", async () => {
  assert.equal(await sliceProcessEvidence(null), null);
  assert.equal(await sliceProcessEvidence({ ae: {} }), null);
  const ev = await sliceProcessEvidence({
    ae: { recoveryTarget: () => ({ pid: 7, session: null }) },
    ownership: { kind: "owned", evidence: "e" },
    transportKind: "t",
    aeA8nHead: "h",
  });
  assert.equal(ev.aePid, 7);
  assert.equal(ev.guiSession, null);
  assert.equal(ev.attestation.source, ATTESTATION_SOURCE);
});
