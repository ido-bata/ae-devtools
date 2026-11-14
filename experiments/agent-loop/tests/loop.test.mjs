/*
 * agent-loop tests — fake-level E2E for Issue #38 (CAP065).
 * Evidence: fake/mock only. Dispatch/consent/identity/classification
 * are delegated to the canonical trusted-execution runner (PR #42);
 * these tests prove the LOOP policy on top of it. NOT real AE.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeHost, createFakeApp } from "../fake-host.mjs";
import { loadTrustedCodec } from "../../trusted-execution/runner.mjs";
import { runDevLoop, regressionCheck, toDiagnostic, FAKE_SESSION } from "../loop.mjs";
import { consentScopeFor } from "../../trusted-execution/permissions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "..", "fixtures", name), "utf8");

function makeTransport() {
  const codec = loadTrustedCodec();
  const host = createFakeHost({ app: createFakeApp() });
  const calls = [];
  return {
    codec,
    calls,
    send: async (text) => {
      calls.push(text);
      return host.send(text, codec);
    },
  };
}

// Stand-in for an EXTERNAL consent authority. The loop must never mint
// consent itself; this provider plays the role of the deployment's
// consent service in tests. It binds each attempt's exact source.
function makeConsentProvider(spy) {
  return async (source, attempt) => {
    if (spy) spy.push({ source, attempt });
    return {
      consent: {
        scope: consentScopeFor({
          pin: FAKE_SESSION.pin,
          operationId: FAKE_SESSION.operationId,
          args: { source, dispatchArgs: null },
          projectIdentity: FAKE_SESSION.projectIdentity,
        }),
      },
      trustedScriptOptIn: true,
      scriptProvenance: "test-consent-provider",
    };
  };
}
const PROVIDER = makeConsentProvider();
const RESET = async () => {}; // fake project-state reset

// Deterministic stand-in for the "agent": fixes the two seeded bugs.
function fixtureFixer(diag, source, attempt) {
  if (attempt === 0) return source.replace("items.addd(", "items.add(");
  if (attempt === 1) return source.replace('f.setName("final");', 'f.name = "final";');
  return null;
}

test("clean fixture completes on first dispatch", async () => {
  const t = makeTransport();
  const report = await runDevLoop({ source: fixture("clean.jsx"), transport: t, consentProvider: PROVIDER });
  assert.equal(report.outcome, "COMPLETED");
  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0].result, "final");
  assert.equal(t.calls.length, 1);
});

test("E2E: broken fixture -> diagnostic -> fix -> rerun -> COMPLETED", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: fixtureFixer,
    consentProvider: PROVIDER,
    stateReset: RESET,
  });
  assert.equal(report.outcome, "COMPLETED");
  assert.equal(report.iterations.length, 3); // fail, fail, pass
  assert.equal(report.iterations[0].outcome, "FAILED");
  assert.equal(report.iterations[1].outcome, "FAILED");
  assert.equal(report.iterations[2].outcome, "COMPLETED");
  // Consent was evaluated per attempt: every iteration carries a
  // requestId and the runner's contract outcome.
  for (const it of report.iterations) {
    assert.ok(it.requestId);
    assert.ok(it.contractOutcome);
  }
  // Two diagnostics collected, both host-positioned script exceptions.
  assert.equal(report.diagnostics.length, 2);
  for (const d of report.diagnostics) {
    assert.equal(d.kind, "script-exception");
    assert.equal(d.location.origin, "host-reported");
    assert.equal(typeof d.location.line, "number");
  }
  // First bug is on line 4 (var f = ...addd), second on line 5.
  assert.equal(report.diagnostics[0].location.line, 4);
  assert.equal(report.diagnostics[1].location.line, 5);
});

test("regression check reruns final source and requires COMPLETED", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: fixtureFixer,
    consentProvider: PROVIDER,
    stateReset: RESET,
  });
  const reg = await regressionCheck({
    source: report.finalSource,
    transport: t,
    consentProvider: PROVIDER,
    assumeIdempotent: true,
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.outcome, "COMPLETED");
});

test("fixer returning null stops the loop as FAILED (no infinite retry)", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: () => null,
    consentProvider: PROVIDER,
    stateReset: RESET,
  });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.iterations.length, 1);
  assert.equal(t.calls.length, 1);
});

test("no fixer configured: first FAILED ends the loop", async () => {
  const t = makeTransport();
  const report = await runDevLoop({ source: fixture("broken.jsx"), transport: t, consentProvider: PROVIDER });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.diagnostics.length, 1);
});

test("fix budget exhausted -> FAILED, bounded sends", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: (d, s, a) => s + `\n// attempt ${a}`,
    consentProvider: PROVIDER,
    stateReset: RESET,
    maxFixes: 2,
  });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.iterations.length, 3); // initial + 2 fixes
  assert.equal(t.calls.length, 3);
});

test("toDiagnostic preserves host fields and never invents positions", () => {
  const d = toDiagnostic({
    requestId: "req-1",
    error: {
      name: "ReferenceError",
      message: "x is not defined",
      line: 9,
      file: "probe.jsx",
      hostReported: true,
    },
  });
  assert.equal(d.location.line, 9);
  assert.equal(d.location.file, "probe.jsx");
  assert.equal(d.location.origin, "host-reported");
  const noPos = toDiagnostic({ error: { name: "E", message: "m" } });
  assert.equal(noPos.location, null);
  assert.equal(toDiagnostic({ outcome: "COMPLETED" }), null);
});

test("reply with wrong requestId -> UNKNOWN via runner, loop stops, id quarantined", async () => {
  const codec = loadTrustedCodec();
  const host = createFakeHost({ app: createFakeApp() });
  const t = {
    send: async (text) => {
      const real = host.send(text, codec);
      const parsed = codec.parse(real);
      parsed.requestId = "someone-else";
      return codec.stringify(parsed);
    },
  };
  const report = await runDevLoop({ source: fixture("clean.jsx"), transport: t, consentProvider: PROVIDER });
  assert.equal(report.outcome, "UNKNOWN");
  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0].outcome, "UNKNOWN");
  assert.equal(report.quarantined.length, 1);
});

/* ---- PR #45 re-review: loop safety contract ---- */

test("S1: no consentProvider -> BLOCKED before any send (loop must not self-issue consent)", async () => {
  const t = makeTransport();
  const report = await runDevLoop({ source: fixture("clean.jsx"), transport: t, fixer: fixtureFixer });
  assert.equal(report.outcome, "BLOCKED");
  assert.equal(t.calls.length, 0);
});

test("S2: consentProvider is invoked per attempt with the EXACT source being dispatched", async () => {
  const t = makeTransport();
  const seen = [];
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: fixtureFixer,
    consentProvider: makeConsentProvider(seen),
    stateReset: RESET,
  });
  assert.equal(report.outcome, "COMPLETED");
  assert.equal(seen.length, 3);
  // Each consent request binds the precise source of that attempt —
  // the provider saw broken, then fix1, then fix2 (never a stale source).
  assert.ok(seen[0].source.includes("items.addd("));
  assert.ok(!seen[1].source.includes("items.addd("));
  assert.ok(seen[1].source.includes("setName("));
  assert.ok(!seen[2].source.includes("setName("));
});

test("S3: FAILED mayHaveMutated -> rerun refused unless stateReset or explicit allowDirtyRerun", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: fixtureFixer,
    consentProvider: PROVIDER,
    // NO stateReset, NO allowDirtyRerun: partial mutation may persist.
  });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.iterations.length, 1);
  assert.equal(t.calls.length, 1);
  assert.equal(report.stateDirty, true);
});

test("S4: stateReset is awaited before rerun after a dirty FAILED", async () => {
  const t = makeTransport();
  const resets = [];
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: fixtureFixer,
    consentProvider: PROVIDER,
    stateReset: async (src, attempt) => { resets.push(attempt); },
  });
  assert.equal(report.outcome, "COMPLETED");
  assert.equal(resets.length, 2); // once before each rerun
});

test("S5: allowDirtyRerun:true permits rerun without stateReset (explicit operator acceptance)", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: fixtureFixer,
    consentProvider: PROVIDER,
    allowDirtyRerun: true,
  });
  assert.equal(report.outcome, "COMPLETED");
  assert.equal(report.iterations.length, 3);
});

test("S6: regressionCheck refuses a possibly-mutating source unless assumeIdempotent", async () => {
  const t = makeTransport();
  const skipped = await regressionCheck({ source: fixture("clean.jsx"), transport: t });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.skipped, "mutating-unverified");
  assert.equal(t.calls.length, 0);
  const ran = await regressionCheck({
    source: fixture("clean.jsx"),
    transport: t,
    consentProvider: PROVIDER,
    assumeIdempotent: true,
  });
  assert.equal(ran.ok, true);
  assert.equal(t.calls.length, 1);
});
