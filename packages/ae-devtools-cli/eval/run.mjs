#!/usr/bin/env node
/**
 * run.mjs — #424 agent-eval harness entry point.
 *
 *   node eval/run.mjs --scenario S2-script-error \
 *     --condition baseline --backend fake --agent naive \
 *     [--out <path>] [--install-dir <AE.app>] [--workdir <dir>]
 *
 * Runs ONE scenario under ONE condition against ONE backend, records
 * the full evidence document (ae-devtools.agent-eval/v1) and prints
 * the verdict. Library use:
 *
 *   import { runScenario } from "./run.mjs";
 *   const { evidence, outPath } = await runScenario({...});
 *
 * Conditions baseline/std-recovery/guidance-skill select the AGENT
 * configuration slot. Stage 0 ships scripted self-check agents only
 * (`naive`, `reference`); real agent drivers register later without
 * changing scenarios/oracle/evidence.
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { arg, hasFlag } from "../devtools-cli/argv.mjs";
import { isMainEntry } from "../devtools-cli/is-main-entry.mjs";
import { getScenario, isCondition, BUDGET } from "./scenarios.mjs";
import { createBackend } from "./backends.mjs";
import { createAgentContext, SCRIPTED_AGENTS } from "./driver.mjs";
import { scoreRun } from "./oracle.mjs";
import { buildRunEvidence, writeRunEvidence, defaultEvidencePath } from "./evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: HERE, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Run one scenario end-to-end and return the evidence document.
 *
 * @param {object} opts
 *   scenarioId   — e.g. "S2-script-error" (required)
 *   conditionId  — baseline | std-recovery | guidance-skill (required)
 *   backendId    — "fake" | "a8n" (default "fake")
 *   agentImpl    — key into SCRIPTED_AGENTS or a function (default "naive")
 *   installDir   — AE install dir (a8n backend only)
 *   workdir      — backend workdir (a8n backend only)
 *   outPath      — evidence output path (default eval/evidence/...)
 *   evidenceDir  — repo-relative evidence dir override
 */
export async function runScenario({
  scenarioId,
  conditionId,
  backendId = "fake",
  agentImpl = "naive",
  installDir,
  workdir,
  outPath,
  evidenceDir,
} = {}) {
  const scenario = getScenario(scenarioId);
  if (!isCondition(conditionId)) {
    throw new Error(`unknown condition: ${conditionId}`);
  }
  const agentFn =
    typeof agentImpl === "function" ? agentImpl : SCRIPTED_AGENTS[agentImpl];
  if (typeof agentFn !== "function") {
    throw new Error(
      `unknown agent impl: ${agentImpl} (available: ${Object.keys(SCRIPTED_AGENTS).join(", ")})`,
    );
  }

  const startedAt = new Date();
  const trace = { actions: [], events: [], budget: { ...BUDGET } };
  const usage = { iterations: 0, recoveryAttempts: 0, elapsedMs: 0 };
  let backend = null;
  let observationOk = true;
  let safety = null;
  let facts = null;
  let oracle = null;
  let anomaly = null;

  try {
    backend = await createBackend({ scenario, backendId, installDir, workdir });
    const environment = backend.environment();
    anomaly = await backend.prepare();

    const ctx = createAgentContext({
      scenario,
      backend,
      trace,
      usage,
      startedAt: startedAt.getTime(),
    });

    try {
      await agentFn(ctx);
    } catch (e) {
      // Agent crash is evidence, not a harness failure.
      trace.events.push({
        at: new Date().toISOString(),
        kind: "agent-error",
        error: String(e && e.message ? e.message : e),
      });
      if (!trace.finalReport) {
        ctx.finish({
          claims: { requestCompleted: false, needsHuman: false },
          anomalyClass: null,
          summary: `agent error: ${e && e.message ? e.message : e}`,
        });
      }
    }

    facts = backend.facts();
    const audit = backend.safetyAudit();
    safety = {
      foreignTargetOps: audit.foreignTargetOps ?? 0,
      unconditionalResend: audit.unconditionalResend ?? 0,
      unexecutedAsSuccess: audit.unexecutedAsSuccess ?? 0,
      recoveryAttempts: audit.recoveryAttempts ?? usage.recoveryAttempts,
      events: audit.events ?? [],
      resends: audit.resends ?? [],
    };
    observationOk = backend.state?.observationOk !== false;

    usage.elapsedMs = Date.now() - startedAt.getTime();
    usage.iterations = Math.min(usage.iterations, BUDGET.maxAgentIterations + 1);

    oracle = scoreRun({
      scenario,
      trace,
      facts,
      safety,
      usage,
      observationOk,
    });

    const finishedAt = new Date();
    const evidence = buildRunEvidence({
      scenario,
      conditionId,
      backend: { id: backendId, environment },
      agentImpl: typeof agentImpl === "function" ? agentImpl.name || "custom" : agentImpl,
      environment: { ...environment, gitHead: gitHead() },
      stimulus: scenario.stimulus,
      anomaly,
      trace,
      observations: trace.events,
      safety,
      oracle,
      artifacts: [],
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });
    evidence.usage = usage;

    const stamp = finishedAt.toISOString().replace(/[:.]/g, "-");
    const fileName = defaultEvidencePath({
      scenarioId: scenario.id,
      conditionId,
      backendId,
      agentImpl: evidence.agentImpl,
      stamp,
    });
    const finalOut =
      outPath ??
      (evidenceDir ? join(evidenceDir, fileName) : join(HERE, "evidence", fileName));
    const absOut = isAbsolute(finalOut) ? finalOut : resolve(HERE, finalOut);
    mkdirSync(dirname(absOut), { recursive: true });
    writeRunEvidence(evidence, absOut);
    return { evidence, outPath: absOut };
  } finally {
    if (backend && typeof backend.close === "function") {
      try {
        await backend.close();
      } catch {
        // close failure is recorded by the backend itself; never mask
        // the run result.
      }
    }
  }
}

async function main() {
  const scenarioId = arg("--scenario");
  const conditionId = arg("--condition") ?? "baseline";
  const backendId = arg("--backend") ?? "fake";
  const agentImpl = arg("--agent") ?? "naive";
  const outPath = arg("--out");
  const installDir = arg("--install-dir");
  const workdir = arg("--workdir");

  if (!scenarioId || hasFlag("--help") || hasFlag("-h")) {
    console.log(`usage: node eval/run.mjs --scenario <id> --condition <id> [--backend fake|a8n] [--agent naive|reference] [--out path] [--install-dir dir] [--workdir dir]
scenarios: S1-startup-crash-repair, S2-script-error, S3-unexpected-modal
conditions: baseline, std-recovery, guidance-skill`);
    process.exit(scenarioId ? 0 : 2);
  }

  const { evidence, outPath: written } = await runScenario({
    scenarioId,
    conditionId,
    backendId,
    agentImpl,
    installDir,
    workdir,
    outPath,
  });
  console.log(`verdict=${evidence.verdict} scenario=${scenarioId} condition=${conditionId} backend=${backendId} agent=${agentImpl}`);
  console.log(`evidence=${written}`);
  if (evidence.oracle?.detail?.failedChecks?.length) {
    console.log(`failedChecks=${evidence.oracle.detail.failedChecks.join(",")}`);
  }
  process.exit(evidence.verdict === "PASS" ? 0 : 1);
}

if (isMainEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(`agent-eval: ${e && e.message ? e.message : e}`);
    process.exit(2);
  });
}
