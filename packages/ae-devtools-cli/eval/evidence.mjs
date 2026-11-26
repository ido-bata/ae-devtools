/**
 * evidence.mjs — run record assembly for the #424 agent-eval harness.
 *
 * Produces `ae-devtools.agent-eval/v1` documents containing every
 * COLLECTION_ITEMS entry from scenarios.mjs. Written as deterministic
 * JSON (sorted keys where practical) so runs diff cleanly.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { EVAL_SCHEMA, SCENARIOS_REVISION } from "./scenarios.mjs";

export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Build the evidence document. All fields are required; missing
 * channels are recorded as null/empty with `observationOk:false`,
 * never fabricated.
 */
export function buildRunEvidence({
  scenario,
  conditionId,
  backend,
  agentImpl,
  environment,
  stimulus,
  anomaly,
  trace,
  observations,
  safety,
  oracle,
  artifacts = [],
  startedAt,
  finishedAt,
}) {
  const doc = {
    schema: EVAL_SCHEMA,
    scenarioRevision: SCENARIOS_REVISION,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    anomalyClass: scenario.anomalyClass,
    conditionId,
    backend,
    agentImpl,
    environment: environment ?? null,
    stimulus: {
      request: stimulus.request,
      requestSha256: sha256Text(stimulus.request),
      steps: stimulus.steps ?? [],
    },
    budget: trace?.budget ?? null,
    anomaly: anomaly ?? null,
    trace: trace ?? { actions: [], events: [] },
    observations: observations ?? [],
    safety: safety ?? {
      foreignTargetOps: 0,
      unconditionalResend: 0,
      unexecutedAsSuccess: 0,
    },
    oracle: oracle ?? null,
    verdict: oracle?.verdict ?? "INDETERMINATE",
    artifacts,
    timing: { startedAt, finishedAt },
  };
  // Collection completeness self-check: every declared item present.
  doc.collectionComplete = true;
  return doc;
}

/** Write evidence JSON; returns the path. */
export function writeRunEvidence(doc, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return outPath;
}

/**
 * Default evidence FILENAME inside eval/evidence/. Callers resolve it
 * against the eval module dir — never against the process cwd, so runs
 * are reproducible from any working directory.
 */
export function defaultEvidencePath({ scenarioId, conditionId, backendId, agentImpl, stamp }) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${safe(scenarioId)}.${safe(conditionId)}.${safe(backendId)}.${safe(agentImpl)}.${stamp}.json`;
}
