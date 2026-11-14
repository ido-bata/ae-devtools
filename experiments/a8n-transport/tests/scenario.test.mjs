/**
 * scenario tests — runVerticalSlice end-to-end against the fake `ae`
 * through the REAL trusted-execution runner + a8n transport composition.
 * This is the same step list real-run.mjs executes against real AE; only
 * the peer differs. Fake-level evidence only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createJsxRunner } from "../../trusted-execution/runner.mjs";
import { createA8nTransport } from "../transport.mjs";
import { runVerticalSlice } from "../scenario.mjs";
import { createFakeAe } from "./fake-ae.mjs";

const PIN = { sessionId: "sess-fake", aeVersion: "99.9.9-fake", dispatchId: "disp-fake" };

function stepByLabel(steps, label) {
  return steps.find((s) => s.label === label);
}

test("vertical slice: read -> error -> fix -> verify -> consent gates", async () => {
  const ae = createFakeAe();
  const transport = createA8nTransport({ ae });
  const runner = createJsxRunner({ transport, deadlineMs: 5_000 });
  const { steps } = await runVerticalSlice({
    runner,
    pin: PIN,
    sendCount: transport.sendCount,
  });

  const labels = steps.map((s) => s.label);
  assert.deepEqual(labels, [
    "connect.state",
    "project.state",
    "error.capture",
    "fix.rerun",
    "verify.counter.1",
    "verify.counter.2",
    "consent.tampered",
    "consent.denied",
  ]);

  assert.equal(stepByLabel(steps, "connect.state").outcome, "COMPLETED");
  assert.equal(stepByLabel(steps, "connect.state").result, "99.9.9-fake");
  assert.equal(stepByLabel(steps, "project.state").outcome, "COMPLETED");
  assert.equal(stepByLabel(steps, "project.state").result, "3");

  const errored = stepByLabel(steps, "error.capture");
  assert.equal(errored.outcome, "FAILED");
  // normalizeReply unwraps error.aeError, so the host-reported fields sit
  // directly on outcome.error.
  assert.equal(errored.error?.name, "ReferenceError");

  assert.equal(stepByLabel(steps, "fix.rerun").outcome, "COMPLETED");
  assert.equal(stepByLabel(steps, "fix.rerun").result, "3");

  // $.global persists across dispatches in one session: 1 then 2.
  assert.equal(stepByLabel(steps, "verify.counter.1").result, "1");
  assert.equal(stepByLabel(steps, "verify.counter.2").result, "2");

  // Tampered consent: runner refuses before send — transport count flat.
  const tampered = stepByLabel(steps, "consent.tampered");
  assert.equal(tampered.outcome, "BLOCKED");
  assert.equal(tampered.sendsBefore, tampered.sendsAfter);

  // Policy denial: refused before the runner is even invoked.
  const denied = stepByLabel(steps, "consent.denied");
  assert.equal(denied.outcome, "REFUSED-BEFORE-SEND");
  assert.equal(denied.sendsBefore, denied.sendsAfter);

  // Exactly the six dispatched steps reached the transport.
  assert.equal(transport.sendCount(), 6);
});

test("slice requires a sessionId pin", async () => {
  const ae = createFakeAe();
  const transport = createA8nTransport({ ae });
  const runner = createJsxRunner({ transport });
  await assert.rejects(
    () => runVerticalSlice({ runner, pin: { aeVersion: "x" } }),
    /sessionId/,
  );
});
