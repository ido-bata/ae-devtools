/**
 * outcomes tests — CAP028: write-path outcome classification, busy vs
 * unknown, mayHaveMutated, undo separation, contract vocabulary mapping.
 * Fake-level only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOMES,
  CONTRACT_OUTCOME,
  toContractOutcome,
  classifyWriteResult,
  undoTraceRecord,
} from "../outcomes.mjs";

test("wire outcomes map onto the catalog contract §5 vocabulary", () => {
  assert.equal(toContractOutcome("COMPLETED"), "completed");
  assert.equal(toContractOutcome("REFUSED"), "refused");
  assert.equal(toContractOutcome("FAILED"), "failed");
  assert.equal(toContractOutcome("UNKNOWN"), "unknown");
  assert.equal(toContractOutcome("BLOCKED"), "not-sent");
  assert.throws(() => toContractOutcome("MAYBE"), /unknown wire outcome/);
  for (const o of OUTCOMES) assert.ok(CONTRACT_OUTCOME[o], `unmapped ${o}`);
});

test("not dispatched → BLOCKED/not-sent, mayHaveMutated false", () => {
  const r = classifyWriteResult({ dispatched: false });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.requestState, "NOT_SENT");
  assert.equal(r.mayHaveMutated, false);
  assert.equal(toContractOutcome(r.outcome), "not-sent");
});

test("host ok reply → COMPLETED with mayHaveMutated true", () => {
  const r = classifyWriteResult({ dispatched: true, reply: { ok: true, result: { id: 1 } } });
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(r.mayHaveMutated, true);
  assert.deepEqual(r.result, { id: 1 });
});

test("host refusal → REFUSED, mayHaveMutated false", () => {
  const r = classifyWriteResult({
    dispatched: true,
    reply: { ok: false, refusal: { code: "STALE_REFERENCE", message: "gone" } },
  });
  assert.equal(r.outcome, "REFUSED");
  assert.equal(r.refusal.code, "STALE_REFERENCE");
  assert.equal(r.mayHaveMutated, false);
});

test("host error → FAILED; partial mutation is flagged, not hidden", () => {
  const partial = classifyWriteResult({
    dispatched: true,
    reply: { ok: false, error: { aeError: { name: "IOError", message: "disk" } } },
    partialMutation: true,
  });
  assert.equal(partial.outcome, "FAILED");
  assert.equal(partial.mayHaveMutated, true);
  const clean = classifyWriteResult({
    dispatched: true,
    reply: { ok: false, error: { aeError: { name: "Error", message: "x" } } },
  });
  assert.equal(clean.mayHaveMutated, false);
});

test("timeout after possible dispatch → UNKNOWN + mayHaveMutated, never retried", () => {
  const r = classifyWriteResult({ dispatched: true, reply: null, deadlineExceeded: true });
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "NO_REPLY_BEFORE_DEADLINE");
  assert.equal(r.requestState, "SENT_NOT_ACKNOWLEDGED");
  assert.equal(r.mayHaveMutated, true);
  assert.match(r.note, /do not resend/);
});

test("client-side 'AE seems busy' is UNKNOWN — only attributable host evidence is REFUSED HOST_BUSY", () => {
  const guessed = classifyWriteResult({ dispatched: true, reply: null, deadlineExceeded: true });
  assert.equal(guessed.outcome, "UNKNOWN"); // no evidence → cannot claim busy

  // Weak or non-attributable signals must NOT produce HOST_BUSY.
  const weak = [
    ["bare boolean (legacy guess)", true],
    ["string guess", "busy"],
    ["client-sourced evidence", { source: "client", provedNonDispatch: true }],
    ["host source without non-dispatch proof", { source: "ae-host" }],
    ["os-signal without non-dispatch proof", { source: "os-signal", provedNonDispatch: false }],
    ["proof flag not exactly true", { source: "ae-host", provedNonDispatch: "yes" }],
    ["scalar", 1],
  ];
  for (const [label, hostBusyEvidence] of weak) {
    const r = classifyWriteResult({
      dispatched: true,
      reply: null,
      deadlineExceeded: true,
      hostBusyEvidence,
    });
    assert.equal(r.outcome, "UNKNOWN", label);
    assert.equal(r.unknownCategory, "NO_REPLY_BEFORE_DEADLINE", label);
  }

  // Attributable in-host attestation with proven non-dispatch → HOST_BUSY.
  for (const source of ["ae-host", "os-signal"]) {
    const hostSaid = classifyWriteResult({
      dispatched: true,
      reply: null,
      deadlineExceeded: true,
      hostBusyEvidence: { source, provedNonDispatch: true, detail: "modal up" },
    });
    assert.equal(hostSaid.outcome, "REFUSED", source);
    assert.equal(hostSaid.refusal.code, "HOST_BUSY");
    assert.equal(hostSaid.refusal.detail, "modal up");
    assert.equal(hostSaid.mayHaveMutated, false);
  }
});

test("unattributable reply → UNKNOWN, not accepted", () => {
  const r = classifyWriteResult({ dispatched: true, reply: { garbage: true } });
  assert.equal(r.outcome, "UNKNOWN");
  assert.equal(r.unknownCategory, "UNATTRIBUTABLE_REPLY");
});

test("undo failure stays FAILED and is never folded into the original op", () => {
  const op = classifyWriteResult({ dispatched: true, reply: { ok: true, result: {} } });
  const undo = classifyWriteResult({
    dispatched: true,
    reply: { ok: false, error: { aeError: { name: "Error", message: "undo failed" } } },
  });
  assert.equal(op.outcome, "COMPLETED");
  assert.equal(undo.outcome, "FAILED");
  const trace = undoTraceRecord({ operationId: "ae.operation.comp.create", undoResult: undo });
  assert.equal(trace.kind, "undo");
  assert.equal(trace.outcome, "FAILED");
  assert.equal(trace.foldedInto, null);
});
