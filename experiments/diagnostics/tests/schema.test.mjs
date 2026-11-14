/**
 * Tests for diagnostics schema + collectors — automated-test / fake-level
 * evidence only. No After Effects is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIAGNOSTICS_RECORD_VERSION,
  DIAGNOSTIC_KINDS,
  validateDiagnosticsRecord,
  makeDiagnosticsRecord,
  DiagnosticsSchemaError,
} from "../schema.mjs";
import {
  COLLECTOR_STATUS,
  collectorStatus,
  fromAeError,
  fromTransportOutcome,
} from "../collectors.mjs";

const VALID = {
  kind: "script-exception",
  severity: "error",
  message: "test failure",
  collector: "test",
  occurredAt: "2026-11-14T00:00:00.000Z",
};

test("accepts a minimal valid record", () => {
  const r = { recordVersion: DIAGNOSTICS_RECORD_VERSION, ...VALID };
  assert.equal(validateDiagnosticsRecord(r), r);
});

test("makeDiagnosticsRecord fills version and timestamp", () => {
  const r = makeDiagnosticsRecord({ kind: "panel-log", severity: "info", message: "hi", collector: "c" });
  assert.equal(r.recordVersion, DIAGNOSTICS_RECORD_VERSION);
  assert.ok(!Number.isNaN(Date.parse(r.occurredAt)));
});

test("refuses wrong recordVersion", () => {
  assert.throws(
    () => validateDiagnosticsRecord({ ...VALID, recordVersion: "v0", occurredAt: VALID.occurredAt }),
    DiagnosticsSchemaError
  );
  assert.throws(
    () => validateDiagnosticsRecord({ ...VALID, occurredAt: VALID.occurredAt }),
    /recordVersion/
  );
});

test("refuses unknown kind and severity", () => {
  assert.throws(
    () => validateDiagnosticsRecord({ ...VALID, recordVersion: DIAGNOSTICS_RECORD_VERSION, kind: "bogus" }),
    /kind/
  );
  assert.throws(
    () => validateDiagnosticsRecord({ ...VALID, recordVersion: DIAGNOSTICS_RECORD_VERSION, severity: "fatal" }),
    /severity/
  );
});

test("every declared kind has a collector status entry", () => {
  for (const kind of DIAGNOSTIC_KINDS) {
    const st = collectorStatus(kind);
    assert.ok(["implemented-fake", "pending-real-host", "unsupported-with-reason"].includes(st.status), kind);
    assert.ok(typeof st.reason === "string" && st.reason.length > 0, kind);
  }
});

test("unregistered kind reports unknown status", () => {
  assert.equal(collectorStatus("bogus").status, "unknown");
});

test("source position must be well-formed when present", () => {
  const base = { recordVersion: DIAGNOSTICS_RECORD_VERSION, ...VALID };
  assert.throws(
    () => validateDiagnosticsRecord({ ...base, source: { assetKind: "not-a-kind" } }),
    /assetKind/
  );
  assert.throws(
    () => validateDiagnosticsRecord({ ...base, source: { assetKind: "jsx-script", line: 0 } }),
    /line/
  );
  assert.throws(
    () => validateDiagnosticsRecord({ ...base, source: { assetKind: "jsx-script", line: 1.5 } }),
    /line/
  );
  // absent position stays absent — valid
  const ok = validateDiagnosticsRecord({ ...base, source: { assetKind: "jsx-script", hostReported: true } });
  assert.equal(ok.source.line, undefined);
});

test("fromAeError maps host position fields without fabrication", () => {
  const rec = fromAeError({ aeError: { name: "ReferenceError", message: "x is undefined", line: 42, file: "probe.jsx" } });
  assert.equal(rec.kind, "script-exception");
  assert.equal(rec.severity, "error");
  assert.match(rec.message, /ReferenceError: x is undefined/);
  assert.deepEqual(rec.source, { assetKind: "jsx-script", hostReported: true, path: "probe.jsx", line: 42 });
  assert.equal(rec.evidence, "fake");
});

test("fromAeError leaves position absent when host reported none", () => {
  const rec = fromAeError({ aeError: { name: "Error", message: "boom" } });
  assert.equal(rec.source.path, undefined);
  assert.equal(rec.source.line, undefined);
  assert.equal(rec.source.hostReported, true);
});

test("fromAeError refuses malformed input", () => {
  assert.throws(() => fromAeError(null), /aeError/);
  assert.throws(() => fromAeError({ aeError: { message: "" } }), /message/);
  assert.throws(() => fromAeError({ aeError: { message: 42 } }), /message/);
});

test("fromTransportOutcome maps outcome states to severity", () => {
  const completed = fromTransportOutcome({ outcome: "COMPLETED", requestId: "r1" });
  assert.equal(completed.severity, "info");
  assert.equal(completed.kind, "transport-outcome");
  assert.equal(completed.source.assetKind, "transport");
  assert.equal(completed.requestId, "r1");

  const refused = fromTransportOutcome({ outcome: "REFUSED", code: "WRONG_TARGET" });
  assert.equal(refused.severity, "warning");
  assert.match(refused.message, /WRONG_TARGET/);

  const unknown = fromTransportOutcome({ outcome: "UNKNOWN", detail: "no reply" });
  assert.equal(unknown.severity, "error");

  const failed = fromTransportOutcome({ outcome: "FAILED", code: "HOST_ERROR" });
  assert.equal(failed.severity, "error");
});

test("fromTransportOutcome refuses missing state", () => {
  assert.throws(() => fromTransportOutcome({}), /outcome/);
  assert.throws(() => fromTransportOutcome(null), /outcome/);
});

test("COLLECTOR_STATUS honestly marks unimplemented sources", () => {
  assert.equal(COLLECTOR_STATUS["expression-error"].status, "pending-real-host");
  assert.equal(COLLECTOR_STATUS["panel-log"].status, "pending-real-host");
  assert.equal(COLLECTOR_STATUS["native-crash"].status, "pending-real-host");
  assert.equal(COLLECTOR_STATUS["plugin-load-failure"].status, "pending-real-host");
  assert.equal(COLLECTOR_STATUS["render-failure"].status, "pending-real-host");
});
