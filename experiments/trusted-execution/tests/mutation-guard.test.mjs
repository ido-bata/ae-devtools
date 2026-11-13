/**
 * mutation-guard tests — CAP027: descriptor resolution, STALE_REFERENCE,
 * project scoping, retry policy. Fake-level only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDescriptor, guardMutation, retryDecision } from "../mutation-guard.mjs";

const SNAPSHOT = {
  projectIdentity: "proj-A",
  items: [
    { type: "comp", name: "Main", contentHash: "h1", items: [
      { type: "layer", name: "Shape 1", contentHash: "h2", items: [] },
      { type: "layer", name: "Null 1", items: [] },
    ] },
    { type: "comp", name: "Alt", items: [] },
  ],
};

const REF = { aeRef: { type: "layer", name: "Shape 1", path: [0, 0], contentHash: "h2" } };

test("descriptor resolves against the current snapshot", () => {
  const result = resolveDescriptor(REF, SNAPSHOT);
  assert.equal(result.status, "resolved");
  assert.equal(result.node.name, "Shape 1");
});

test("stale references refuse — never re-resolve by name", () => {
  const cases = [
    ["path out of range", { aeRef: { type: "layer", name: "x", path: [9] } }],
    ["descend into leaf", { aeRef: { type: "x", name: "x", path: [0, 0, 0] } }],
    ["empty path", { aeRef: { type: "x", name: "x", path: [] } }],
    ["type mismatch", { aeRef: { type: "footage", name: "Shape 1", path: [0, 0] } }],
    ["name mismatch (same path, renamed)", { aeRef: { type: "layer", name: "Renamed", path: [0, 0] } }],
    ["content hash drift", { aeRef: { type: "layer", name: "Shape 1", path: [0, 0], contentHash: "old" } }],
    ["hash on un-hashed node", { aeRef: { type: "comp", name: "Alt", path: [1], contentHash: "h" } }],
    ["not a descriptor", { foo: 1 }],
  ];
  for (const [label, descriptor] of cases) {
    const result = resolveDescriptor(descriptor, SNAPSHOT);
    assert.equal(result.status, "refused", label);
    assert.equal(result.reason, "STALE_REFERENCE", label);
  }
});

test("duplicate names do not confuse resolution — path wins, then exact match", () => {
  // Two layers named "Dup" at different paths: descriptor with the right
  // path+name resolves; a descriptor whose name matches a *different* node
  // at its own path is stale, not silently re-pointed.
  const snap = {
    projectIdentity: "p",
    items: [{ type: "comp", name: "c", items: [
      { type: "layer", name: "Dup", items: [] },
      { type: "layer", name: "Dup", items: [] },
    ] }],
  };
  const ok = resolveDescriptor({ aeRef: { type: "layer", name: "Dup", path: [0, 1] } }, snap);
  assert.equal(ok.status, "resolved");
  const stale = resolveDescriptor({ aeRef: { type: "layer", name: "Dup", path: [0, 1], contentHash: "x" } }, snap);
  assert.equal(stale.reason, "STALE_REFERENCE");
});

test("guardMutation enforces project identity before resolution", () => {
  assert.equal(
    guardMutation({ descriptor: REF, snapshot: SNAPSHOT, projectIdentity: "proj-B" }).reason,
    "PROJECT_MISMATCH",
  );
  assert.equal(
    guardMutation({ descriptor: REF, snapshot: SNAPSHOT, projectIdentity: null }).reason,
    "PROJECT_UNKNOWN",
  );
  assert.equal(
    guardMutation({ descriptor: REF, snapshot: { items: [] }, projectIdentity: "proj-A" }).reason,
    "PROJECT_UNKNOWN",
  );
  const ok = guardMutation({ descriptor: REF, snapshot: SNAPSHOT, projectIdentity: "proj-A" });
  assert.equal(ok.status, "resolved");
});

test("retry policy: UNKNOWN quarantines, pre-dispatch outcomes allow only new-request re-auth", () => {
  assert.equal(retryDecision({ outcome: "UNKNOWN", idempotent: true }), "quarantine");
  assert.equal(retryDecision({ outcome: "UNKNOWN", idempotent: false }), "quarantine");
  assert.equal(retryDecision({ outcome: "BLOCKED" }), "new-request-after-reauth");
  assert.equal(retryDecision({ outcome: "REFUSED" }), "new-request-after-reauth");
  assert.equal(retryDecision({ outcome: "not-sent" }), "new-request-after-reauth");
  assert.equal(retryDecision({ outcome: "COMPLETED" }), "quarantine");
  assert.equal(retryDecision({ outcome: "FAILED" }), "quarantine");
});
