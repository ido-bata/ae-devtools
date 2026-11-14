/*
 * agent-loop tests — fake-level E2E for Issue #38 (CAP065).
 * Evidence: fake/mock only. Proves loop mechanics: error -> diagnostic
 * -> fix -> rerun -> regression. NOT real AE, NOT real ExtendScript.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeHost, createFakeApp } from "../fake-host.mjs";
import { loadCodec, runDevLoop, regressionCheck, toDiagnostic } from "../loop.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "..", "fixtures", name), "utf8");

function makeTransport() {
  const codec = loadCodec();
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

// Deterministic stand-in for the "agent": fixes the two seeded bugs.
function fixtureFixer(diag, source, attempt) {
  if (attempt === 0) return source.replace("items.addd(", "items.add(");
  if (attempt === 1) return source.replace('f.setName("final");', 'f.name = "final";');
  return null;
}

test("clean fixture completes on first dispatch", async () => {
  const t = makeTransport();
  const report = await runDevLoop({ source: fixture("clean.jsx"), transport: t });
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
  });
  assert.equal(report.outcome, "COMPLETED");
  assert.equal(report.iterations.length, 3); // fail, fail, pass
  assert.equal(report.iterations[0].outcome, "FAILED");
  assert.equal(report.iterations[1].outcome, "FAILED");
  assert.equal(report.iterations[2].outcome, "COMPLETED");
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
  });
  const reg = await regressionCheck({ source: report.finalSource, transport: t });
  assert.equal(reg.ok, true);
  assert.equal(reg.outcome, "COMPLETED");
});

test("fixer returning null stops the loop as FAILED (no infinite retry)", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: () => null,
  });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.iterations.length, 1);
  assert.equal(t.calls.length, 1);
});

test("no fixer configured: first FAILED ends the loop", async () => {
  const t = makeTransport();
  const report = await runDevLoop({ source: fixture("broken.jsx"), transport: t });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.diagnostics.length, 1);
});

test("fix budget exhausted -> FAILED, bounded sends", async () => {
  const t = makeTransport();
  const report = await runDevLoop({
    source: fixture("broken.jsx"),
    transport: t,
    fixer: (d, s, a) => s + `\n// attempt ${a}`,
    maxFixes: 2,
  });
  assert.equal(report.outcome, "FAILED");
  assert.equal(report.iterations.length, 3); // initial + 2 fixes
  assert.equal(t.calls.length, 3);
});

test("toDiagnostic preserves host fields and never invents positions", () => {
  const d = toDiagnostic(
    { error: { name: "ReferenceError", message: "x is not defined", line: 9, file: "probe.jsx" } },
    "req-1"
  );
  assert.equal(d.location.line, 9);
  assert.equal(d.location.file, "probe.jsx");
  const noPos = toDiagnostic({ error: { name: "E", message: "m" } }, "req-2");
  assert.equal(noPos.location, null);
  assert.equal(toDiagnostic({ ok: true }, "req-3"), null);
});

test("reply with wrong requestId -> UNKNOWN, loop stops without retry", async () => {
  const codec = loadCodec();
  const host = createFakeHost({ app: createFakeApp() });
  const t = {
    send: async (text) => {
      const real = host.send(text, codec);
      const parsed = codec.parse(real);
      parsed.requestId = "someone-else";
      return codec.stringify(parsed);
    },
  };
  const report = await runDevLoop({ source: fixture("clean.jsx"), transport: t });
  assert.equal(report.outcome, "UNKNOWN");
  assert.equal(report.iterations.length, 1);
});
