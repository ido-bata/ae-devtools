/**
 * driver.mjs — agent slot + scenario orchestration for the #424 harness.
 *
 * Agent contract (Stage 0):
 *   agent.run(ctx) -> { actions?, finalReport?, ... }
 *
 * `ctx` is the ONLY surface an agent sees. It wraps the backend so every
 * call is recorded into the trace and safety-audited:
 *
 *   ctx.request                — the stimulus text (normal request)
 *   ctx.steps                  — required normal-request steps
 *   ctx.budgetLeft()           — {iterations, recoveryAttempts, msLeft}
 *   ctx.openSession()          — backend.openSession  (recorded)
 *   ctx.ensureSession()        — backend.ensureSession (recorded)
 *   ctx.dispatch(source)       — script dispatch       (recorded,
 *                                identical-source resend after a
 *                                non-COMPLETED outcome is audited)
 *   ctx.readCompSummary()      — read probe            (recorded)
 *   ctx.readProjectSummary()   — read probe            (recorded)
 *   ctx.observe()              — host observation      (recorded)
 *   ctx.verifySession()        — post-recovery liveness (recorded)
 *   ctx.recover({method,target})— recovery attempt     (recorded;
 *                                target!=="owned" is a safety audit)
 *   ctx.classify(anomalyClass) — record classification (trace action)
 *   ctx.finish(report)         — set finalReport; agent MUST call
 *                                exactly once before returning
 *   ctx.iteration()            — consume one iteration of budget
 *
 * Agents are pluggable so later conditions (real coding agents under
 * baseline / std-recovery / guidance-skill) drop in without touching
 * scenarios, oracle or evidence. The `naive` and `reference` agents
 * shipped here are HARNESS SELF-CHECKS, not evaluation subjects.
 */

import { BUDGET } from "./scenarios.mjs";

/**
 * Build the mediated context for one scenario run.
 * @param {object} args
 *   scenario, backend, trace, usage, startedAt
 */
export function createAgentContext({ scenario, backend, trace, usage, startedAt }) {
  const record = (type, data = {}) => {
    trace.actions.push({ type, at: new Date().toISOString(), ...data });
  };
  const event = (data = {}) => {
    trace.events.push({ at: new Date().toISOString(), ...data });
  };

  const ctx = {
    request: scenario.stimulus.request,
    steps: scenario.stimulus.steps ?? [],
    anomalyClass: scenario.anomalyClass, // visible: agents may classify
    budgetLeft() {
      const elapsed = Date.now() - startedAt;
      return {
        iterationsLeft: BUDGET.maxAgentIterations - usage.iterations,
        recoveryAttemptsLeft: BUDGET.maxRecoveryAttempts - usage.recoveryAttempts,
        msLeft: BUDGET.wallClockLimitMs - elapsed,
      };
    },
    iteration() {
      usage.iterations += 1;
      if (usage.iterations > BUDGET.maxAgentIterations) {
        const e = new Error("iteration budget exhausted");
        e.code = "BUDGET_EXCEEDED";
        throw e;
      }
    },
    async _call(kind, fn, data = {}) {
      this.iteration();
      // Semantic action type = the surface call name so the oracle can
      // find observe/classify/recover/verifySession actions directly.
      record(kind, { name: kind });
      try {
        const result = await fn();
        const summary = summarize(result);
        // An anomaly "surfaced" when the surface reports a blocking or
        // failed outcome — the oracle's `detected` check may use this
        // even if the agent never explicitly observed.
        if (
          summary.outcome === "FAILED" ||
          summary.outcome === "BLOCKED" ||
          summary.outcome === "UNKNOWN" ||
          ["startup-crash-repair", "unexpected-modal", "script-error", "no-session"].includes(
            summary.classification,
          )
        ) {
          summary.anomaly = true;
        }
        event({ kind, ...summary });
        return result;
      } catch (e) {
        event({ kind, error: String(e && e.message ? e.message : e), anomaly: true });
        throw e;
      }
    },
    openSession() {
      return ctx._call("openSession", () => backend.openSession());
    },
    ensureSession() {
      return ctx._call("ensureSession", () => backend.ensureSession());
    },
    async dispatch(source, opts = {}) {
      return ctx._call("dispatch", () => backend.dispatchScript(source, opts), {
        sourceSha256: undefined, // hashed inside backend audit
      });
    },
    readCompSummary() {
      return ctx._call("readCompSummary", () => backend.readCompSummary());
    },
    readProjectSummary() {
      return ctx._call("readProjectSummary", () => backend.readCompSummary());
    },
    observe() {
      return ctx._call("observe", () => backend.observe());
    },
    verifySession() {
      return ctx._call("verifySession", () => backend.verifySession());
    },
    recover(opts = {}) {
      usage.recoveryAttempts += 1;
      record("recover", { method: opts.method ?? null, target: opts.target ?? "owned" });
      if ((opts.target ?? "owned") !== "owned") {
        // Surface-level guard: non-owned recovery is never executed.
        event({ kind: "recover", refused: "non-owned target" });
        return Promise.resolve({ ok: false, classification: "refused" });
      }
      return ctx._call("recover", () => backend.recover(opts));
    },
    classify(anomalyClass, extra = {}) {
      record("classify", { anomalyClass, ...extra });
    },
    resend(requestId) {
      // Explicit resend path: the backend's identical-source audit
      // decides whether this was unconditional. Agents SHOULD NOT use
      // this; it exists so misuse is observable, not silent.
      record("resend", { requestId });
      return Promise.resolve({ ok: false, classification: "resend-not-supported", requestId });
    },
    facts() {
      return backend.facts();
    },
    markRequestCompleted() {
      backend.markRequestCompleted();
    },
    finish(report = {}) {
      trace.finalReport = {
        claims: report.claims ?? {},
        anomalyClass: report.anomalyClass ?? null,
        summary: report.summary ?? "",
        finishedAt: new Date().toISOString(),
      };
    },
  };
  return ctx;
}

function summarize(result) {
  if (result === null || result === undefined) return {};
  if (typeof result !== "object") return { value: result };
  const out = {};
  for (const k of ["ok", "outcome", "classification", "sessionLive", "modal", "modalBlocked", "crashRepair"]) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  if (result.anomaly === true) out.anomaly = true;
  return out;
}

/* ------------------------------------------------------------------ */
/* Scripted agents — harness self-checks only                          */
/* ------------------------------------------------------------------ */

/**
 * naive — performs the normal request once, top to bottom, and stops
 * at the first failure. Reports truthfully. This approximates an agent
 * with no recovery guidance; it is NOT a model baseline.
 */
export async function naiveAgent(ctx) {
  const steps = ctx.steps;
  let last = null;
  try {
    for (const step of steps) {
      if (ctx.budgetLeft().iterationsLeft <= 0) break;
      if (step === "session.open" || step === "session.ensure") {
        last = await (step === "session.open" ? ctx.openSession() : ctx.ensureSession());
        if (last && last.ok === false) break;
      } else if (step === "project.openOrNew" || step === "project.ensure") {
        // Fake backend marks projectOpen inside openSession; nothing to do.
        continue;
      } else if (step === "script.dispatch") {
        const { s2FixtureSource } = await import("./backends.mjs");
        last = await ctx.dispatch(s2FixtureSource());
        if (last && last.outcome !== "COMPLETED") break;
      } else if (step === "read.result" || step === "read.compSummary" || step === "read.projectSummary") {
        last = await ctx.readCompSummary();
        if (last && last.outcome && last.outcome !== "COMPLETED") break;
      }
    }
  } catch {
    // budget or backend error — report what we have
  }
  const obs = await ctx.observe().catch(() => null);
  const completed =
    last !== null &&
    (last.ok === true || last.outcome === "COMPLETED") &&
    obs !== null && obs.modal !== true;
  if (completed === true) ctx.markRequestCompleted();
  ctx.finish({
    claims: {
      requestCompleted: completed === true,
      needsHuman: false,
    },
    anomalyClass: null,
    summary: completed
      ? "request completed"
      : `stopped at outcome=${last?.outcome ?? last?.classification ?? "unknown"}`,
  });
  return { ok: true };
}

/**
 * reference — a scripted RECOVERY-CAPABLE agent used to prove the
 * harness can reach PASS and to smoke-test oracle/evidence plumbing.
 * It uses only generic recovery surface calls; it is a self-check,
 * not an evaluation subject and not a model.
 */
export async function referenceAgent(ctx) {
  const steps = ctx.steps;
  const scriptSource = async () => {
    if (ctx.steps.includes("script.dispatch")) {
      const { s2FixtureSource } = await import("./backends.mjs");
      return s2FixtureSource();
    }
    return "String(app.project.numItems)";
  };

  // 1. session open with ONE standard relaunch on crash-repair
  let open = await ctx.openSession();
  if (open && open.ok === false && open.classification === "startup-crash-repair") {
    ctx.classify("startup-crash-repair");
    await ctx.recover({ method: "session.relaunch", target: "owned" });
    open = await ctx.openSession();
  }
  if (open && open.ok === false) {
    ctx.finish({
      claims: { requestCompleted: false, needsHuman: true, needsHumanEvidence: `open failed: ${open.classification}` },
      anomalyClass: open.classification ?? null,
      summary: "needs human after failed relaunch",
    });
    return { ok: true };
  }

  // 2. run request steps; handle modal + script error generically
  let dispatchedOk = true;
  for (const step of steps) {
    if (ctx.budgetLeft().iterationsLeft <= 0) break;
    if (step === "session.open" || step === "session.ensure") continue; // done
    if (step === "project.openOrNew" || step === "project.ensure") continue;
    if (step === "script.dispatch") {
      const r = await ctx.dispatch(await scriptSource());
      if (r.outcome === "BLOCKED" || r.classification === "unexpected-modal") {
        ctx.classify("unexpected-modal");
        await ctx.recover({ method: "modal.dismiss", target: "owned" });
        await ctx.verifySession();
        const r2 = await ctx.dispatch(await scriptSource());
        dispatchedOk = r2.outcome === "COMPLETED";
      } else if (r.outcome !== "COMPLETED") {
        ctx.classify("script-error");
        // Diagnose: the fixture's bug is a missing null guard. The
        // reference fix is scenario-agnostic — wrap the dereference.
        const fixed = (await scriptSource()).replace(
          "for (var j = 1; j <= comp.numLayers; j++)",
          "if (comp !== null) { for (var j = 1; j <= comp.numLayers; j++)",
        ).replace(
          "return JSON.stringify(names);",
          "return JSON.stringify(names); }",
        );
        const r2 = await ctx.dispatch(fixed);
        dispatchedOk = r2.outcome === "COMPLETED";
      }
    }
    if (step === "read.result" || step === "read.compSummary" || step === "read.projectSummary") {
      let rr = await ctx.readCompSummary();
      if (rr.outcome === "BLOCKED" || rr.classification === "unexpected-modal") {
        ctx.classify("unexpected-modal");
        await ctx.recover({ method: "modal.dismiss", target: "owned" });
        await ctx.verifySession();
        rr = await ctx.readCompSummary();
      }
      if (rr.outcome && rr.outcome !== "COMPLETED") dispatchedOk = false;
    }
  }

  const obs = await ctx.observe().catch(() => null);
  const completed = dispatchedOk === true && obs?.modal !== true;
  if (completed === true) ctx.markRequestCompleted();
  ctx.finish({
    claims: {
      requestCompleted: completed === true,
      needsHuman: false,
    },
    anomalyClass: null,
    summary: completed ? "request completed after recovery" : "request incomplete",
  });
  return { ok: true };
}

export const SCRIPTED_AGENTS = Object.freeze({
  naive: naiveAgent,
  reference: referenceAgent,
});
