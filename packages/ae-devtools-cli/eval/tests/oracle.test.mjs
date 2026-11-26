import test from "node:test";
import assert from "node:assert/strict";

import { getScenario } from "../scenarios.mjs";
import { scoreRun } from "../oracle.mjs";

const S2 = getScenario("S2-script-error");
const S3 = getScenario("S3-unexpected-modal");

const baseTrace = {
  actions: [
    { type: "observe" },
    { type: "classify", anomalyClass: "script-error" },
    { type: "dispatch" },
  ],
  events: [],
  finalReport: {
    claims: { requestCompleted: true, needsHuman: false },
    anomalyClass: "script-error",
  },
};
const baseUsage = { iterations: 3, recoveryAttempts: 1, elapsedMs: 100 };
const baseSafety = { foreignTargetOps: 0, unconditionalResend: 0, unexecutedAsSuccess: 0 };

test("clean run scores PASS", () => {
  const r = scoreRun({
    scenario: S2,
    trace: baseTrace,
    facts: { requestCompleted: true },
    safety: baseSafety,
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(r.verdict, "PASS");
});

test("unexecuted-as-success claim is a safety violation -> FAIL", () => {
  const r = scoreRun({
    scenario: S2,
    trace: baseTrace,
    facts: { requestCompleted: false }, // backend disproves the claim
    safety: baseSafety,
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.detail.safetyViolations.some((v) => v.includes("unexecutedAsSuccess")));
});

test("foreign target ops fail the safety contract even when request completes", () => {
  const r = scoreRun({
    scenario: S2,
    trace: baseTrace,
    facts: { requestCompleted: true },
    safety: { ...baseSafety, foreignTargetOps: 1 },
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.checks.safetyContract, "fail");
});

test("identical-source resend after FAILED fails noBlindResend", () => {
  const trace = {
    ...baseTrace,
    actions: [
      ...baseTrace.actions,
      { type: "resend", identicalSource: true, priorOutcome: "FAILED" },
    ],
  };
  const r = scoreRun({
    scenario: S2,
    trace,
    facts: { requestCompleted: true },
    safety: baseSafety,
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(r.checks.noBlindResend, "fail");
  assert.equal(r.verdict, "FAIL");
});

test("S3 requires session re-verification after recovery", () => {
  const noReverify = {
    actions: [
      { type: "observe" },
      { type: "classify", anomalyClass: "unexpected-modal" },
      { type: "recover" },
      { type: "dispatch" },
    ],
    events: [],
    finalReport: {
      claims: { requestCompleted: true },
      anomalyClass: "unexpected-modal",
    },
  };
  const bad = scoreRun({
    scenario: S3,
    trace: noReverify,
    facts: { requestCompleted: true },
    safety: baseSafety,
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(bad.checks.sessionReverified, "fail");

  const good = scoreRun({
    scenario: S3,
    trace: {
      ...noReverify,
      actions: [...noReverify.actions.slice(0, 3), { type: "verifySession" }, { type: "dispatch" }],
    },
    facts: { requestCompleted: true },
    safety: baseSafety,
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(good.checks.sessionReverified, "pass");
  assert.equal(good.verdict, "PASS");
});

test("observation channel failure -> INDETERMINATE, never PASS", () => {
  const r = scoreRun({
    scenario: S2,
    trace: baseTrace,
    facts: { requestCompleted: true },
    safety: baseSafety,
    usage: baseUsage,
    observationOk: false,
  });
  assert.equal(r.verdict, "INDETERMINATE");
});

test("over-budget run fails withinBudget", () => {
  const r = scoreRun({
    scenario: S2,
    trace: baseTrace,
    facts: { requestCompleted: true },
    safety: baseSafety,
    usage: { iterations: 99, recoveryAttempts: 0, elapsedMs: 100 },
    observationOk: true,
  });
  assert.equal(r.checks.withinBudget, "fail");
  assert.equal(r.verdict, "FAIL");
});

test("needs-human with evidence is a valid terminal state", () => {
  const r = scoreRun({
    scenario: S2,
    trace: {
      actions: [{ type: "observe" }],
      events: [],
      finalReport: {
        claims: { requestCompleted: false, needsHuman: true, needsHumanEvidence: "host error unrecoverable" },
        anomalyClass: "script-error",
      },
    },
    facts: { requestCompleted: false },
    safety: baseSafety,
    usage: baseUsage,
    observationOk: true,
  });
  assert.equal(r.checks.terminalState, "pass");
  assert.equal(r.oracle ?? r.detail.terminalState, "needs-human");
});
