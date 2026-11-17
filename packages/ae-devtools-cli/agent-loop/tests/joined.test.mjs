/*
 * joined.test.mjs — the #37 × #38 joined dev-loop chain (Issue #38,
 * CAP065/CAP066 fake level).
 *
 * One fixture, one evidence chain, all fake/mock:
 *
 *   probe.ts --jsx-toolchain buildFile--> probe.jsx + probe.jsx.map
 *     --agent-loop dispatch (codec-faithful fake host)--> FAILED
 *     --toDiagnostic (ae-devtools.diagnostics/v1, jsx position) -->
 *     --diagnostics/source-map.mjs resolveDiagnosticsSource -->
 *        original TS {file,line}
 *     --fixer patches the TS line, rebuilds--> new probe.jsx
 *     --rerun--> COMPLETED --regressionCheck--> evidence doc
 *        (serializeLoopEvidence, evidenceLevel "fake" only)
 *
 * NOT real AE: the fake host is a vm sandbox; positions are real vm
 * stack positions surfaced through the same fields a host reports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeHost, createFakeApp } from "../fake-host.mjs";
import { loadTrustedCodec } from "../../trusted-execution/runner.mjs";
import { runDevLoop, regressionCheck, FAKE_SESSION } from "../loop.mjs";
import { serializeLoopEvidence, LOOP_EVIDENCE_SCHEMA } from "../evidence.mjs";
import { buildFile } from "../../jsx-toolchain/src/build.mjs";
import { resolveDiagnosticsSource } from "../../diagnostics/source-map.mjs";
import { consentScopeFor } from "../../trusted-execution/permissions.mjs";

// Top-level statements only: the fake host reports the vm stack's
// first frame, which for a call inside a function is the call site —
// keep the fault at top level so the host-reported jsx line is the
// faulting expression itself (same discipline as fixtures/broken.jsx).
// Non-mutating probe: the regression check measures state via
// fingerprint, so the fixture must not add project items — a mutating
// script would (correctly) report mutationDetected:true.
const TS_V1 = [
  "var x = __toolchainMissingFn();", // bug: undeclared identifier
  "var y = x + 1;",
  "",
].join("\n");

function makeTransport(app) {
  const codec = loadTrustedCodec();
  const host = createFakeHost({ app });
  return {
    send: async (text) => host.send(text, codec),
  };
}

function makeConsentProvider() {
  return async (source) => ({
    consent: {
      scope: consentScopeFor({
        pin: FAKE_SESSION.pin,
        operationId: FAKE_SESSION.operationId,
        args: { source, dispatchArgs: null },
        projectIdentity: FAKE_SESSION.projectIdentity,
      }),
    },
    trustedScriptOptIn: true,
    scriptProvenance: "joined-test",
  });
}

test("joined chain: TS -> jsx build -> execute -> diagnostic -> sourcemap -> TS fix -> rerun -> regression -> evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-loop-joined-"));
  const tsPath = join(dir, "probe.ts");
  const outDir = join(dir, "out");
  writeFileSync(tsPath, TS_V1);

  const b1 = buildFile(tsPath, { outDir });
  assert.equal(b1.status, "ok", JSON.stringify(b1.diagnostics));
  assert.ok(b1.jsxPath && b1.mapPath, "expected jsx + map artifacts");

  const app = createFakeApp();
  const transport = makeTransport(app);
  const consentProvider = makeConsentProvider();

  // The fixer IS the developer loop: diagnostic (jsx position) ->
  // sourcemap -> original TS line -> patch TS -> rebuild -> new jsx.
  const fixer = async (diag, jsxSource, attempt) => {
    assert.equal(attempt, 0);
    assert.equal(diag.kind, "script-exception");
    assert.equal(diag.source.assetKind, "jsx-script");
    const resolved = resolveDiagnosticsSource(diag, { jsxMapPath: b1.mapPath });
    assert.equal(resolved.status, "mapped");
    assert.equal(resolved.original.file, "probe.ts");
    assert.equal(resolved.original.line, 1); // the faulting line in TS
    const lines = readFileSync(tsPath, "utf8").split("\n");
    assert.match(lines[resolved.original.line - 1], /__toolchainMissingFn/);
    lines[resolved.original.line - 1] = 'var x = 41;';
    writeFileSync(tsPath, lines.join("\n"));
    const b2 = buildFile(tsPath, { outDir });
    assert.equal(b2.status, "ok", JSON.stringify(b2.diagnostics));
    return b2.output;
  };

  const report = await runDevLoop({
    source: b1.output,
    transport,
    fixer,
    consentProvider,
    stateReset: async () => {},
    stateFingerprint: () => app.__state.fingerprint(),
  });

  assert.equal(report.outcome, "COMPLETED");
  assert.equal(report.iterations.length, 2); // FAILED then COMPLETED
  assert.equal(report.iterations[0].outcome, "FAILED");
  assert.equal(report.iterations[1].outcome, "COMPLETED");
  assert.equal(report.diagnostics.length, 1);

  // The collected diagnostic resolves back to the SAME TS position the
  // fixer used — one evidence chain, not two parallel mappings.
  const resolved = resolveDiagnosticsSource(report.diagnostics[0], { jsxMapPath: b1.mapPath });
  assert.equal(resolved.status, "mapped");
  assert.equal(resolved.original.file, "probe.ts");
  assert.equal(resolved.original.line, 1);

  const reg = await regressionCheck({
    source: report.finalSource,
    transport,
    session: FAKE_SESSION,
    consentProvider,
    assumeIdempotent: true,
    stateFingerprint: () => app.__state.fingerprint(),
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.outcome, "COMPLETED");
  assert.equal(reg.mutationDetected, false);

  const evidence = serializeLoopEvidence({
    report,
    regression: reg,
    initialSource: b1.output,
    finalSource: report.finalSource,
    evidenceLevel: "fake",
  });
  assert.equal(evidence.schema, LOOP_EVIDENCE_SCHEMA);
  assert.equal(evidence.evidenceLevel, "fake");
  assert.equal(evidence.finalOutcome, "COMPLETED");
  assert.equal(evidence.iterations.length, 2);
  assert.equal(evidence.diagnostics.length, 1);
  assert.equal(evidence.regression.ok, true);
  assert.equal(evidence.conformanceBinding.status, "fake-only");
  assert.equal(evidence.conformanceBinding.promotable, false);
});
