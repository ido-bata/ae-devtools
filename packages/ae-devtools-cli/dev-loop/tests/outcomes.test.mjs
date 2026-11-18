/**
 * outcomes.test.mjs — shared outcome normalization + failure-record
 * mapping (Issue #181).
 *
 * These are the semantics every dev-loop surface (CLI diagnostics
 * block, MCP isError, VSCode Problems collector) must agree on:
 * adapter `status` spellings count, the failure-bearing status wins
 * over a COMPLETED wire outcome, and a host error object is failure
 * evidence even when every outcome spelling looks clean.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { failureOutcome, isFailureResult, wireState } from "../outcomes.mjs";
import { recordFromExecuteResult } from "../failure-record.mjs";
import { fromAeError, fromTransportOutcome } from "../../diagnostics/collectors.mjs";

const COLLECTORS = { fromAeError, fromTransportOutcome };

test("wireState normalizes every known spelling to the wire vocabulary", () => {
  assert.equal(wireState("refused"), "REFUSED");
  assert.equal(wireState("FAILED"), "FAILED");
  assert.equal(wireState("Completed"), "COMPLETED");
  assert.equal(wireState("bogus"), "bogus");
  assert.equal(wireState(undefined), "UNKNOWN");
});

test("failureOutcome: adapter status beats a COMPLETED wire outcome", () => {
  assert.equal(failureOutcome({ outcome: "COMPLETED", status: "failed" }, "COMPLETED"), "FAILED");
  assert.equal(failureOutcome({ status: "refused", reason: "CONSENT_DENIED" }, "refused"), "REFUSED");
  assert.equal(failureOutcome({ outcome: "REFUSED" }, "REFUSED"), "REFUSED");
  assert.equal(failureOutcome({ outcome: "COMPLETED", error: { message: "x" } }, "COMPLETED"), "FAILED");
  assert.equal(failureOutcome({ outcome: "COMPLETED" }, "COMPLETED"), null);
  assert.equal(isFailureResult({ outcome: "COMPLETED" }, "COMPLETED"), false);
});

test("failureOutcome is fail-closed: unknown non-empty spellings are failures (Issue #196)", () => {
  // Spellings that used to pass through unrecognized — none may read
  // as success on any surface (CLI exit 0 / MCP isError:false).
  for (const spelling of ["error", "ERROR", "cancelled", "timeout", "bogus"]) {
    assert.notEqual(failureOutcome({ outcome: spelling }, spelling), null, spelling);
    assert.equal(isFailureResult({ outcome: spelling }, spelling), true, spelling);
    assert.notEqual(failureOutcome({ status: spelling }, null), null, `status:${spelling}`);
  }
  // The failure-bearing spelling is preserved verbatim for the record.
  assert.equal(failureOutcome({ outcome: "cancelled" }, null), "cancelled");
  // "COMPLETED" (any case) remains the only success spelling.
  assert.equal(failureOutcome({ outcome: "completed" }, null), null);
  assert.equal(failureOutcome({ outcome: "Completed" }, "COMPLETED"), null);
  // No outcome spelling at all is still not a failure by itself.
  assert.equal(failureOutcome({}, null), null);
  assert.equal(failureOutcome(null, null), null);
});

test("failureOutcome: error-field rule is unified — any non-nullish value is evidence", () => {
  assert.equal(failureOutcome({ outcome: "COMPLETED", error: { message: "x" } }, "COMPLETED"), "FAILED");
  assert.equal(failureOutcome({ outcome: "COMPLETED", error: "host said no" }, "COMPLETED"), "FAILED");
  // error:null / error:undefined are NOT failure evidence — the old
  // MCP-local `!== undefined` patch reported error:null as a failure.
  assert.equal(failureOutcome({ outcome: "COMPLETED", error: null }, "COMPLETED"), null);
  assert.equal(failureOutcome({ outcome: "COMPLETED", error: undefined }, "COMPLETED"), null);
});

test("recordFromExecuteResult: adapter-level refusal without wire outcome yields a record", () => {
  // The shape that used to produce ZERO diagnostics on the VSCode
  // surface: status:"refused", no outcome field.
  const record = recordFromExecuteResult({
    result: { status: "refused", stage: "adapter", reason: "UNKNOWN_OPERATION", detail: "no such op", opId: "x.y" },
    collectors: COLLECTORS,
  });
  assert.ok(record);
  assert.equal(record.kind, "transport-outcome");
  assert.equal(record.outcome, "REFUSED");
  assert.equal(record.severity, "warning");
});

test("recordFromExecuteResult: adapter ok:false payload beats COMPLETED wire outcome", () => {
  const record = recordFromExecuteResult({
    result: {
      outcome: "COMPLETED",
      status: "failed",
      adapterError: { message: "adapter boom" },
      result: { ok: false },
    },
    collectors: COLLECTORS,
  });
  assert.ok(record);
  assert.equal(record.outcome, "FAILED");
  assert.equal(record.severity, "error");
  assert.match(record.message, /adapter boom/);
});

test("recordFromExecuteResult: host error becomes script-exception; clean outcome yields null", () => {
  const rec = recordFromExecuteResult({
    result: { outcome: "FAILED", error: { name: "ReferenceError", message: "x is undefined", line: 3, file: "a.jsx" } },
    session: { kind: "fake" },
    collectors: COLLECTORS,
  });
  assert.equal(rec.kind, "script-exception");
  assert.equal(rec.source.hostReported, true);
  assert.equal(rec.evidence, "fake");

  assert.equal(recordFromExecuteResult({ result: { outcome: "COMPLETED" }, collectors: COLLECTORS }), null);
  assert.equal(recordFromExecuteResult({ result: null, collectors: COLLECTORS }), null);
});

test("recordFromExecuteResult: evidence label is honest about observation level", () => {
  // a8n session + wire outcome observed → real-host
  const observed = recordFromExecuteResult({
    result: { outcome: "FAILED" },
    session: { kind: "a8n" },
    collectors: COLLECTORS,
  });
  assert.equal(observed.evidence, "real-host");
  // a8n session + client-side refusal (no wire outcome) → no evidence claim
  const refused = recordFromExecuteResult({
    result: { status: "refused", reason: "CONSENT_DENIED" },
    session: { kind: "a8n" },
    collectors: COLLECTORS,
  });
  assert.equal("evidence" in refused, false);
  // absent session → no evidence claim
  const none = recordFromExecuteResult({
    result: { outcome: "FAILED" },
    collectors: COLLECTORS,
  });
  assert.equal("evidence" in none, false);
});

test("recordFromExecuteResult: collectors injection is required", () => {
  assert.throws(
    () => recordFromExecuteResult({ result: { status: "refused" } }),
    /collectors/,
  );
});
