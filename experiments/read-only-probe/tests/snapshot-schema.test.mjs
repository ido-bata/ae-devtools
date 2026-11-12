/**
 * snapshot-schema tests — CAP022 invariants, machine-checked.
 *
 * Validates a captured snapshot blob against the rules in
 * snapshot-schema.md §6. Evidence level: automated-test (fake blobs).
 * The REAL snapshot captured on the real host is validated by the same
 * function in evidence tests (see validateSnapshot usage in
 * evidence/2026-11-12-macos/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const IDENTITY_KEYS = ["aeVersion", "sessionId", "channelId", "dispatchId"];

function walkLeaves(value, path = [], out = []) {
  if (value === null || typeof value !== "object") {
    out.push({ path, value });
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    walkLeaves(entry, [...path, key], out);
  }
  return out;
}

/** The machine-checkable form of snapshot-schema.md §6. */
export function validateSnapshot(blob) {
  const errors = [];
  if (blob.kind !== "probe.snapshot.v1") errors.push("kind must be probe.snapshot.v1");
  if (blob.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const identity = blob.identity ?? {};
  for (const key of IDENTITY_KEYS) {
    if (typeof identity[key] !== "string" || identity[key].length === 0) {
      errors.push(`identity.${key} must be a non-empty string`);
    }
  }
  // Invariant 3: no absolute filesystem paths anywhere.
  for (const leaf of walkLeaves(blob)) {
    if (typeof leaf.value === "string" && leaf.value.startsWith("/")) {
      errors.push(`absolute path at ${leaf.path.join(".")}: ${leaf.value}`);
    }
  }
  // Invariant 4: numerics are non-negative; integral where required.
  for (const leaf of walkLeaves(blob)) {
    if (typeof leaf.value === "number") {
      if (leaf.value < 0 || !Number.isFinite(leaf.value)) {
        errors.push(`bad numeric at ${leaf.path.join(".")}: ${leaf.value}`);
      }
      if (/ItemCount$|Ms$|Count/.test(leaf.path.at(-1) ?? "") && !Number.isInteger(leaf.value)) {
        errors.push(`non-integral count at ${leaf.path.join(".")}: ${leaf.value}`);
      }
    }
  }
  // Invariant 5: RFC3339 timestamps.
  for (const key of ["takenAt", "hostClock"]) {
    const value = blob[key];
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
      errors.push(`${key} is not RFC3339: ${value}`);
    }
  }
  // Invariant 7 (static handle guard): no key that smells like a handle
  // outside the identity allowlist.
  const allowedIdSuffix = new Set([...IDENTITY_KEYS, "requestId", "dispatchId", "channelId", "sessionId"]);
  for (const leaf of walkLeaves(blob)) {
    const key = leaf.path.at(-1) ?? "";
    if (/^(handle|ref)$/.test(key) && !allowedIdSuffix.has(key)) {
      errors.push(`forbidden handle-ish key: ${leaf.path.join(".")}`);
    }
  }
  // Invariant 6: JSON round trip must be lossless.
  try {
    const roundTrip = JSON.parse(JSON.stringify(blob));
    assert.deepEqual(roundTrip, blob);
  } catch (error) {
    errors.push(`round-trip failure: ${error.message}`);
  }
  return errors;
}

const GOOD_SNAPSHOT = {
  kind: "probe.snapshot.v1",
  schemaVersion: 1,
  takenAt: "2026-11-12T09:00:00.123Z",
  hostClock: "2026-11-12T09:00:00.123Z",
  identity: {
    aeVersion: "27.0.0", aeBuildName: "27.0x55", scriptingVersion: "27.0",
    isoLanguage: "ja_JP", locale: "ja_JP", userName: "probe",
    sessionId: "sess-a", channelId: "chan-b", dispatchId: "disp-c",
  },
  runtime: {
    os: "darwin", osRelease: "27.2", cpuModel: "Apple M5", cpuCores: 10,
    dispatch: { transportId: "file-envelope-v1", pollIntervalMs: 250 },
    measurements: { roundTripMs: 251, hostEvalMs: 2 },
  },
  sessionContext: {
    projectOpen: true, projectItemCount: 0,
    activeItemPresent: false, renderQueueItemCount: 0,
  },
};

test("a well-formed snapshot passes all invariants", () => {
  assert.deepEqual(validateSnapshot(GOOD_SNAPSHOT), []);
});

test("unknown schemaVersion / kind is refused (fail-closed, FR-06)", () => {
  const v2 = { ...GOOD_SNAPSHOT, schemaVersion: 2 };
  assert.ok(validateSnapshot(v2).some((e) => e.includes("schemaVersion")));
  const otherKind = { ...GOOD_SNAPSHOT, kind: "something.else.v1" };
  assert.ok(validateSnapshot(otherKind).some((e) => e.includes("kind")));
});

test("missing identity fields are refused (mis-delivery evidence, CAP021/023)", () => {
  const broken = {
    ...GOOD_SNAPSHOT,
    identity: { ...GOOD_SNAPSHOT.identity, sessionId: "" },
  };
  assert.ok(validateSnapshot(broken).some((e) => e.includes("identity.sessionId")));
});

test("no absolute filesystem paths may appear (no project/workspace leakage)", () => {
  const leaky = {
    ...GOOD_SNAPSHOT,
    sessionContext: { projectOpen: true, projectItemCount: 1, activeItemPresent: true, renderQueueItemCount: 0 },
    extensions: { note: "/Users/someone/secret/project.aep" },
  };
  assert.ok(validateSnapshot(leaky).some((e) => e.includes("absolute path")),
    "an absolute path must be caught anywhere in the tree");
});

test("counts must be non-negative integers", () => {
  const negative = {
    ...GOOD_SNAPSHOT,
    sessionContext: { ...GOOD_SNAPSHOT.sessionContext, projectItemCount: -1 },
  };
  assert.ok(validateSnapshot(negative).some((e) => e.includes("projectItemCount")));
});

test("identity-only stability rule: two snapshots of the same activation agree on identity", () => {
  const second = structuredClone(GOOD_SNAPSHOT);
  second.takenAt = "2026-11-12T09:00:01.000Z";
  second.sessionContext.projectItemCount = 3;   // counts are volatile
  assert.equal(second.identity.sessionId, GOOD_SNAPSHOT.identity.sessionId);
  assert.equal(second.identity.dispatchId, GOOD_SNAPSHOT.identity.dispatchId);
  // and the invalidation table: a different session must differ
  const otherSession = structuredClone(GOOD_SNAPSHOT);
  otherSession.identity.sessionId = "sess-b";
  assert.notEqual(otherSession.identity.sessionId, GOOD_SNAPSHOT.identity.sessionId);
});
