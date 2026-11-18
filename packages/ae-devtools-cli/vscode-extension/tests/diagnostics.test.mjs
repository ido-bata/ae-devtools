/**
 * diagnostics.test.mjs — Problems-panel publish plan tests (Issue #153).
 *
 * Fake/mock level only: records come from the canonical diagnostics
 * schema/collectors and the committed jsx-toolchain sourcemap fixtures
 * under ../diagnostics/tests/fixtures. No vscode API, no After Effects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  toDiagnosticItem,
  recordsFromExecuteResult,
  recordsFromLoopReport,
  buildPublishPlan,
  DIAGNOSTICS_PUBLISH_SCHEMA,
} from "../diagnostics.mjs";
import { makeDiagnosticsRecord } from "../../diagnostics/schema.mjs";
import { createController } from "../controller.mjs";
import { openFakeSession } from "../../devtools-cli/fake-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SINGLE_DIR = join(HERE, "..", "..", "diagnostics", "tests", "fixtures", "single");
const SINGLE_JSX = join(SINGLE_DIR, "runtime-error.jsx");

function recordWith(source, extra = {}) {
  return makeDiagnosticsRecord({
    kind: "script-exception",
    severity: "error",
    message: "test failure",
    collector: "test",
    source,
    ...extra,
  });
}

// --- toDiagnosticItem ----------------------------------------------------

test("sourcemap-resolved position produces a mapped range to the TS file", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 3 });
  const item = toDiagnosticItem(rec, { sourceMapOpts: { mapDir: SINGLE_DIR } });
  assert.equal(item.mappingStatus, "mapped");
  assert.equal(item.range.file, "runtime-error.ts");
  assert.equal(item.range.start.line, 2); // 1-based → 0-based
  assert.ok(item.range.start.character >= 0);
  assert.equal(item.severity, "error");
});

test("record without position yields range null — nothing fabricated", () => {
  const rec = recordWith({ assetKind: "transport" });
  const item = toDiagnosticItem(rec);
  assert.equal(item.range, null);
  assert.equal(item.mappingStatus, "no-position");
});

test("unmapped generated position falls back to the record's own line honestly", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 9999 });
  const item = toDiagnosticItem(rec, { sourceMapOpts: { mapDir: SINGLE_DIR } });
  assert.equal(item.mappingStatus, "unmapped");
  assert.equal(item.range.file, SINGLE_JSX);
  assert.equal(item.range.start.line, 9998);
});

test("missing map falls back to record position with no-map status", () => {
  const rec = recordWith({ assetKind: "jsx-script", path: "/nonexistent/x.jsx", line: 7, column: 3 });
  const item = toDiagnosticItem(rec);
  assert.equal(item.mappingStatus, "no-map");
  assert.equal(item.range.start.line, 6);
  assert.equal(item.range.start.character, 2);
  assert.equal(item.range.end.character, 3);
});

test("severity maps error/warning/info verbatim", () => {
  for (const [sev, level] of [["error", "error"], ["warning", "warning"], ["info", "info"]]) {
    const rec = recordWith({ assetKind: "transport" }, { severity: sev });
    assert.equal(toDiagnosticItem(rec).severity, level);
  }
});

// --- recordsFromExecuteResult --------------------------------------------

test("FAILED outcome with host error becomes a script-exception record", () => {
  const result = {
    outcome: "FAILED",
    status: "failed",
    requestId: "req-1",
    error: { name: "ReferenceError", message: "x is undefined", line: 3, file: SINGLE_JSX, hostReported: true },
  };
  const records = recordsFromExecuteResult(result, { session: { kind: "fake" } });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "script-exception");
  assert.equal(records[0].source.hostReported, true);
  assert.equal(records[0].source.line, 3);
});

test("non-COMPLETED outcome without error becomes a transport-outcome record", () => {
  const records = recordsFromExecuteResult({ outcome: "REFUSED", code: "HOST_BUSY", detail: "try later" });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "transport-outcome");
  assert.equal(records[0].severity, "warning");
});

test("adapter-level refusal without wire outcome still yields a record (Issue #181)", () => {
  // status:"refused" with no `outcome` field — the shape that used to
  // produce zero Problems-panel records.
  const records = recordsFromExecuteResult(
    { status: "refused", stage: "adapter", reason: "UNKNOWN_OPERATION", detail: "no such op" },
    { session: { kind: "fake" } },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "transport-outcome");
  assert.equal(records[0].outcome, "REFUSED");
  assert.equal(records[0].severity, "warning");
});

test("adapter ok:false payload beats COMPLETED wire outcome (Issue #181)", () => {
  const records = recordsFromExecuteResult({
    outcome: "COMPLETED",
    status: "failed",
    adapterError: { message: "adapter boom" },
    result: { ok: false },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "FAILED");
  assert.equal(records[0].severity, "error");
});

test("COMPLETED outcome produces no diagnostic records", () => {
  assert.deepEqual(recordsFromExecuteResult({ outcome: "COMPLETED", result: { ok: true } }), []);
  assert.deepEqual(recordsFromExecuteResult(null), []);
  assert.deepEqual(recordsFromExecuteResult("garbage"), []);
});

// --- recordsFromLoopReport ------------------------------------------------

test("loop report diagnostics pass through; malformed entries are dropped", () => {
  const good = recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 3 });
  const report = { diagnostics: [good, { bogus: true }, null] };
  const records = recordsFromLoopReport(report);
  assert.equal(records.length, 1);
  assert.equal(records[0], good);
  assert.deepEqual(recordsFromLoopReport({}), []);
  assert.deepEqual(recordsFromLoopReport(null), []);
});

// --- buildPublishPlan ------------------------------------------------------

test("publish plan summarizes positioned/unmapped/no-position honestly", () => {
  const records = [
    recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 3 }),
    recordWith({ assetKind: "jsx-script", path: SINGLE_JSX, line: 9999 }),
    recordWith({ assetKind: "transport" }),
  ];
  const plan = buildPublishPlan(records, { sourceMapOpts: { mapDir: SINGLE_DIR } });
  assert.equal(plan.schema, DIAGNOSTICS_PUBLISH_SCHEMA);
  assert.equal(plan.summary.total, 3);
  // positioned counts range!==null: mapped(1) + unmapped record-fallback(1);
  // the transport record has no position at all.
  assert.equal(plan.summary.positioned, 2);
  assert.equal(plan.summary.noPosition, 1);
  assert.equal(plan.summary.unmapped, 1);
});

// --- controller integration ----------------------------------------------

test("execute failure attaches a diagnostics publish plan (fake host error)", async () => {
  process.env.AE_DEVTOOLS_CLI_FAKE_HOST_ERROR = JSON.stringify({
    name: "ReferenceError",
    message: "injected failure",
    line: 3,
    file: SINGLE_JSX,
  });
  try {
    const ui = {
      prompts: [],
      async confirm() { return true; },
      async info() {},
      async error() {},
    };
    const c = createController({
      sessionFactory: async () => openFakeSession(),
      ui,
    });
    const res = await c.execute({ opId: "read.projectSummary" });
    assert.ok(res.diagnostics, "expected diagnostics plan on failed execute");
    assert.equal(res.diagnostics.summary.total, 1);
    const item = res.diagnostics.items[0];
    assert.equal(item.kind, "script-exception");
    // The record's jsx path resolves through the committed sourcemap
    // fixture automatically — the Problems item points at the TS file.
    assert.equal(item.mappingStatus, "mapped");
    assert.equal(item.range.file, "runtime-error.ts");
    assert.equal(item.range.start.line, 2);
    await c.close();
  } finally {
    delete process.env.AE_DEVTOOLS_CLI_FAKE_HOST_ERROR;
  }
});
