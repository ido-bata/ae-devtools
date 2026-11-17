/*
 * agent-loop evidence serialization tests — Issue #150 (CAP066).
 * Fake-level only: proves the evidence document is deterministic,
 * honest about its evidence level, and refuses real-host promotion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeHost, createFakeApp } from "../fake-host.mjs";
import { loadTrustedCodec } from "../../trusted-execution/runner.mjs";
import { runDevLoop, regressionCheck, FAKE_SESSION } from "../loop.mjs";
import { consentScopeFor } from "../../trusted-execution/permissions.mjs";
import { DiagnosticsSchemaError } from "../../diagnostics/schema.mjs";
import {
  serializeLoopEvidence,
  serializeLoopEvidenceJson,
  LOOP_EVIDENCE_SCHEMA,
} from "../evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "..", "fixtures", name), "utf8");

function makeTransport() {
  const codec = loadTrustedCodec();
  const host = createFakeHost({ app: createFakeApp() });
  return { codec, send: (text) => host.send(text, codec) };
}

const consentProvider = async (source) => ({
  consent: {
    scope: consentScopeFor({
      pin: FAKE_SESSION.pin,
      operationId: FAKE_SESSION.operationId,
      args: { source, dispatchArgs: null },
      projectIdentity: FAKE_SESSION.projectIdentity,
    }),
  },
  trustedScriptOptIn: true,
  scriptProvenance: "test",
});

const fixtureFixer = (diag, source, attempt) => {
  if (attempt === 0) return source.replace("items.addd(", "items.add(");
  if (attempt === 1) return source.replace('f.setName("final");', 'f.name = "final";');
  return null;
};

test("E2E evidence doc: broken -> fix -> rerun -> COMPLETED serializes honestly", async () => {
  const source = fixture("broken.jsx");
  const report = await runDevLoop({
    source,
    transport: makeTransport(),
    fixer: fixtureFixer,
    consentProvider,
    stateReset: async () => {},
    maxFixes: 3,
  });
  assert.equal(report.outcome, "COMPLETED");
  const regression = await regressionCheck({
    source: report.finalSource,
    transport: makeTransport(),
    consentProvider,
    assumeIdempotent: true,
  });

  const doc = serializeLoopEvidence({
    report,
    regression,
    initialSource: source,
    finalSource: report.finalSource,
  });

  assert.equal(doc.schema, LOOP_EVIDENCE_SCHEMA);
  assert.equal(doc.recordVersion, 1);
  assert.equal(doc.evidenceLevel, "fake");
  assert.equal(doc.finalOutcome, "COMPLETED");
  assert.equal(doc.iterations.length, 3);
  for (const it of doc.iterations) {
    assert.ok(Number.isFinite(it.durationMs), "iteration carries durationMs");
    assert.ok(typeof it.requestId === "string" && it.requestId.length > 0);
  }
  assert.equal(doc.diagnostics.length, 2);
  assert.equal(doc.regression.ok, true);
  assert.equal(doc.conformanceBinding.status, "fake-only");
  assert.equal(doc.conformanceBinding.promotable, false);

  const expectedInitial = createHash("sha256").update(source, "utf8").digest("hex");
  const expectedFinal = createHash("sha256").update(report.finalSource, "utf8").digest("hex");
  assert.equal(doc.sources.initialSha256, expectedInitial);
  assert.equal(doc.sources.finalSha256, expectedFinal);
  assert.notEqual(doc.sources.initialSha256, doc.sources.finalSha256);
});

test("serialization is deterministic for identical input", async () => {
  const report = await runDevLoop({
    source: fixture("clean.jsx"),
    transport: makeTransport(),
    consentProvider,
  });
  // durationMs varies; strip it for the determinism check.
  const strip = (doc) => {
    const d = JSON.parse(JSON.stringify(doc));
    d.iterations.forEach((i) => { i.durationMs = 0; });
    if (d.regression) d.regression.durationMs = 0;
    return d;
  };
  const a = strip(serializeLoopEvidence({ report, initialSource: "x", finalSource: "x" }));
  const b = strip(serializeLoopEvidence({ report, initialSource: "x", finalSource: "x" }));
  assert.deepEqual(a, b);
});

test("real-host evidenceLevel is refused — fake success never promotes", () => {
  const report = { outcome: "COMPLETED", iterations: [], diagnostics: [], quarantined: [] };
  assert.throws(
    () => serializeLoopEvidence({ report, evidenceLevel: "real-host" }),
    /refused/,
  );
});

test("invalid diagnostics records are rejected, not serialized", async () => {
  const report = await runDevLoop({
    source: fixture("clean.jsx"),
    transport: makeTransport(),
    consentProvider,
  });
  report.diagnostics.push({ kind: "not-a-kind" });
  assert.throws(() => serializeLoopEvidence({ report }), DiagnosticsSchemaError);
});

test("skipped regression preserves the skip reason", async () => {
  const report = await runDevLoop({
    source: fixture("clean.jsx"),
    transport: makeTransport(),
    consentProvider,
  });
  const regression = await regressionCheck({
    source: report.finalSource,
    transport: makeTransport(),
    consentProvider,
    assumeIdempotent: false, // mutating-unverified -> explicit skip
  });
  assert.equal(regression.skipped, "mutating-unverified");
  const doc = serializeLoopEvidence({ report, regression });
  assert.equal(doc.regression.skipped, "mutating-unverified");
  assert.equal(doc.regression.ok, false);
});

test("JSON serialization round-trips and stays stable", async () => {
  const report = await runDevLoop({
    source: fixture("clean.jsx"),
    transport: makeTransport(),
    consentProvider,
  });
  const json = serializeLoopEvidenceJson({ report });
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema, LOOP_EVIDENCE_SCHEMA);
  assert.ok(json.endsWith("\n"));
});
