/**
 * dispatch-budget.test.mjs — Issue #383: the runner deadline must
 * always cover the per-call budget, for BOTH a8n openers.
 * Fake-level only: budget resolution refuses before ae-a8n resolution,
 * so no AE and no ae-a8n fixture is needed for the refusal paths.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDispatchBudgets,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_DEADLINE_MARGIN_MS,
} from "../dispatch-budget.mjs";
import { openSliceSession } from "../session.mjs";
import { openAttachedSliceSession } from "../attached-session.mjs";

test("defaults preserve the historical 9500/10000 pair", () => {
  const b = resolveDispatchBudgets({});
  assert.equal(b.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
  assert.equal(b.deadlineMs, DEFAULT_CALL_TIMEOUT_MS + DEFAULT_DEADLINE_MARGIN_MS);
});

test("deadline derives from callTimeoutMs when unspecified", () => {
  const b = resolveDispatchBudgets({ callTimeoutMs: 30_000 });
  assert.equal(b.callTimeoutMs, 30_000);
  assert.equal(b.deadlineMs, 30_000 + DEFAULT_DEADLINE_MARGIN_MS);
  assert.ok(b.deadlineMs > b.callTimeoutMs);
});

test("explicit compatible pair passes through", () => {
  const b = resolveDispatchBudgets({ callTimeoutMs: 5_000, deadlineMs: 20_000 });
  assert.deepEqual(b, { callTimeoutMs: 5_000, deadlineMs: 20_000 });
});

test("explicit deadline <= callTimeout refuses USAGE", () => {
  for (const deadlineMs of [1_000, 9_500]) {
    assert.throws(
      () => resolveDispatchBudgets({ callTimeoutMs: 9_500, deadlineMs }),
      (e) => e.code === "USAGE",
    );
  }
});

test("non-positive/non-finite values fall back to defaults", () => {
  const b = resolveDispatchBudgets({ callTimeoutMs: 0, deadlineMs: -5 });
  assert.equal(b.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
  assert.equal(b.deadlineMs, DEFAULT_CALL_TIMEOUT_MS + DEFAULT_DEADLINE_MARGIN_MS);
});

test("openSliceSession refuses an incompatible pair before ae-a8n resolution", async () => {
  await assert.rejects(
    () => openSliceSession({ callTimeoutMs: 30_000, deadlineMs: 10_000 }),
    (e) => e.code === "USAGE" && /deadlineMs/.test(e.message),
  );
});

test("openAttachedSliceSession refuses an incompatible pair before census/attach", async () => {
  await assert.rejects(
    () => openAttachedSliceSession({ callTimeoutMs: 30_000, deadlineMs: 10_000 }),
    (e) => e.code === "USAGE" && /deadlineMs/.test(e.message),
  );
});
