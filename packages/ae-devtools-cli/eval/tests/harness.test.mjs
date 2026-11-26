import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScenario } from "../run.mjs";
import { COLLECTION_ITEMS, SCENARIOS } from "../scenarios.mjs";

const SCENARIO_IDS = SCENARIOS.map((s) => s.id);

for (const scenarioId of SCENARIO_IDS) {
  test(`naive agent on ${scenarioId}: honest FAIL baseline, full evidence`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-eval-"));
    const { evidence, outPath } = await runScenario({
      scenarioId,
      conditionId: "baseline",
      backendId: "fake",
      agentImpl: "naive",
      outPath: join(dir, "run.json"),
    });
    assert.equal(evidence.schema, "ae-devtools.agent-eval/v1");
    assert.equal(evidence.verdict, "FAIL"); // naive stops at first failure
    // Every collection item is present (non-undefined).
    for (const item of COLLECTION_ITEMS) {
      assert.ok(item in evidence, `missing collection item: ${item}`);
    }
    // Written file round-trips.
    const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(onDisk.verdict, "FAIL");
    assert.equal(onDisk.scenarioId, scenarioId);
    // Safety contract held: no violations fabricated.
    assert.equal(evidence.safety.foreignTargetOps, 0);
    assert.equal(evidence.safety.unconditionalResend, 0);
    // Trace recorded real surface calls.
    assert.ok(evidence.trace.actions.length > 0);
    assert.ok(evidence.trace.events.length > 0);
  });

  test(`reference agent on ${scenarioId}: harness reaches PASS`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-eval-"));
    const { evidence } = await runScenario({
      scenarioId,
      conditionId: "guidance-skill", // condition id is a label; agent is the variable
      backendId: "fake",
      agentImpl: "reference",
      outPath: join(dir, "run.json"),
    });
    assert.equal(evidence.verdict, "PASS", JSON.stringify(evidence.oracle?.detail));
    assert.equal(evidence.safety.foreignTargetOps, 0);
    assert.equal(evidence.safety.unconditionalResend, 0);
  });
}

test("a8n backend refuses unimplemented scenario reproduction", async () => {
  const { createBackend } = await import("../backends.mjs");
  const { getScenario } = await import("../scenarios.mjs");
  await assert.rejects(
    () => createBackend({ scenario: getScenario("S1-startup-crash-repair"), backendId: "a8n" }),
    (e) => e.code === "EVAL_NOT_IMPLEMENTED",
  );
});

test("unknown condition is refused", async () => {
  await assert.rejects(
    () => runScenario({ scenarioId: SCENARIO_IDS[0], conditionId: "bogus", backendId: "fake" }),
    /unknown condition/,
  );
});
