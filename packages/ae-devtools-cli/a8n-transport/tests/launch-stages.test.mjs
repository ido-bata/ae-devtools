/**
 * launch-stages.test.mjs — staged launch diagnostic tests (Issue #144).
 * Fake level: all host interaction is via injected probes; no AE.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { diagnoseLaunchStages, LAUNCH_DIAG_SCHEMA, LAUNCH_STAGES } from "../launch-stages.mjs";

const MOD = { negotiateCapabilities: () => {}, assertDispatchAllowed: () => {} };

test("no probes: resolution BLOCKED, later stages honest, verdict UNKNOWN (gui unobservable outranks BLOCKED)", async () => {
  const r = await diagnoseLaunchStages({});
  assert.equal(r.schema, LAUNCH_DIAG_SCHEMA);
  assert.equal(r.verdict, "UNKNOWN");
  const byId = Object.fromEntries(r.stages.map((s) => [s.id, s]));
  assert.equal(byId["ae-a8n-resolution"].status, "BLOCKED");
  assert.equal(byId["gui-modal-state"].status, "UNKNOWN");
  assert.equal(byId["ae-launch"].status, "BLOCKED");
  assert.ok(r.guidance.length > 0);
});

test("module resolution failure stops the chain at stage 1", async () => {
  const r = await diagnoseLaunchStages({
    probes: { loadModule: async () => { throw new Error("dist/index.js missing"); } },
  });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.stages.length, 1);
  assert.equal(r.stages[0].id, "ae-a8n-resolution");
  assert.match(r.stages[0].detail, /dist\/index\.js missing/);
});

test("contract gate failure refuses before launch stages", async () => {
  let launched = false;
  const r = await diagnoseLaunchStages({
    probes: {
      loadModule: async () => ({ mod: MOD, source: "npm:test" }),
      runContractGates: async () => ({ ok: false, failures: [{ id: "negotiation-malformed" }] }),
      launch: async () => { launched = true; return {}; },
    },
  });
  assert.equal(r.verdict, "FAIL");
  assert.equal(launched, false);
  const ids = r.stages.map((s) => s.id);
  assert.ok(!ids.includes("ae-launch"));
  assert.match(r.stages.find((s) => s.id === "contract-gates").detail, /negotiation-malformed/);
});

test("full happy path with probes: all stages PASS except honest UNKNOWN gui", async () => {
  const ae = { close: async () => {} };
  const r = await diagnoseLaunchStages({
    probes: {
      loadModule: async () => ({ mod: MOD, source: "npm:test", version: "0.0.0-test" }),
      runContractGates: async () => ({ ok: true, failures: [] }),
      buildHostScript: async () => ({ path: "/tmp/host.js" }),
      launch: async () => ae,
      checkOwnership: async () => ({ kind: "owned" }),
      dispatchProbe: async () => ({ ok: true, outcome: "COMPLETED" }),
    },
  });
  const byId = Object.fromEntries(r.stages.map((s) => [s.id, s]));
  assert.equal(byId["ae-a8n-resolution"].status, "PASS");
  assert.equal(byId["contract-gates"].status, "PASS");
  assert.equal(byId["host-script-build"].status, "PASS");
  assert.equal(byId["ae-launch"].status, "PASS");
  assert.equal(byId["ownership"].status, "PASS");
  assert.equal(byId["gui-modal-state"].status, "UNKNOWN"); // never observable
  assert.equal(byId["dispatch-result"].status, "PASS");
  assert.equal(r.verdict, "UNKNOWN"); // gui UNKNOWN outranks PASS but not FAIL
  assert.ok(r.guidance.some((g) => /UXPLogs|root cause/i.test(g)));
});

test("launch failure marks downstream BLOCKED, never guesses GUI/dispatch", async () => {
  const r = await diagnoseLaunchStages({
    probes: {
      loadModule: async () => ({ mod: MOD }),
      runContractGates: async () => ({ ok: true }),
      buildHostScript: async () => ({ path: "/tmp/h.js" }),
      launch: async () => { throw new Error("launch timed out"); },
    },
  });
  const byId = Object.fromEntries(r.stages.map((s) => [s.id, s]));
  assert.equal(byId["ae-launch"].status, "FAIL");
  assert.equal(byId["ownership"].status, "BLOCKED");
  assert.equal(byId["dispatch-result"].status, "BLOCKED");
  assert.equal(byId["gui-modal-state"].status, "BLOCKED");
});

test("unowned session fails ownership honestly", async () => {
  const ae = { close: async () => {} };
  const r = await diagnoseLaunchStages({
    probes: {
      loadModule: async () => ({ mod: MOD }),
      runContractGates: async () => ({ ok: true }),
      launch: async () => ae,
      checkOwnership: async () => ({ kind: "attached" }),
    },
  });
  const byId = Object.fromEntries(r.stages.map((s) => [s.id, s]));
  assert.equal(byId["ownership"].status, "FAIL");
  assert.match(byId["ownership"].detail, /attached/);
});

test("dispatch UNKNOWN is never retried or upgraded", async () => {
  const ae = { close: async () => {} };
  let calls = 0;
  const r = await diagnoseLaunchStages({
    probes: {
      loadModule: async () => ({ mod: MOD }),
      runContractGates: async () => ({ ok: true }),
      launch: async () => ae,
      checkOwnership: async () => ({ kind: "owned" }),
      dispatchProbe: async () => { calls++; throw new Error("no reply"); },
    },
  });
  assert.equal(calls, 1);
  const d = r.stages.find((s) => s.id === "dispatch-result");
  assert.equal(d.status, "UNKNOWN");
  assert.match(d.detail, /never retried/);
});

test("stage list is the documented decomposition", () => {
  assert.deepEqual([...LAUNCH_STAGES], [
    "ae-a8n-resolution", "contract-gates", "host-script-build",
    "ae-launch", "ownership", "gui-modal-state", "dispatch-result",
  ]);
});
