/*
 * loop.mjs — the fake-level agent development loop (Issue #38, CAP065).
 *
 *   run JSX -> on script error, normalize a diagnostic record with the
 *   host-reported source position -> ask the injected `fixer` for a
 *   corrected source -> rerun -> on success, rerun once more as a
 *   regression check.
 *
 * Evidence level: fake/mock only. The "host" is experiments/agent-loop/
 * fake-host.mjs (a Node vm sandbox), the "fixer" is injected — in
 * tests it is a deterministic stand-in for an agent. This proves the
 * LOOP mechanics and diagnostic plumbing, not real AE behavior, real
 * ExtendScript semantics, consent, or transport. Those stay gated on
 * PR #42 (trusted runner) and an owned AE session.
 *
 * Diagnostic records intentionally mirror the experiments/diagnostics
 * schema (Issue #37, PR #41) field names — kind/severity/location —
 * but are produced here without importing that branch so this
 * experiment stands alone on release-0-1-0.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWriteResult } from "../trusted-execution/outcomes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const codecSource = readFileSync(
  join(here, "..", "trusted-execution", "codec", "trusted-codec.js"),
  "utf8",
);

export function loadCodec() {
  const ctx = vm.createContext({
    Object, Array, String, Number, Boolean, Date, RegExp,
    isFinite, parseInt, parseFloat, Error, Math,
  });
  vm.runInContext("var JSON = undefined;", ctx);
  return vm.runInContext(`${codecSource}\nTrustedCodec`, ctx, { filename: "trusted-codec.js" });
}

let requestCounter = 0;
function nextRequestId(prefix = "loop") {
  requestCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestCounter}`;
}

/* Normalize a host error into a diagnostics-shaped record. Positions
 * come ONLY from host-reported fields — never inferred. */
export function toDiagnostic(reply, requestId) {
  const err = reply && reply.error;
  if (!err) return null;
  return {
    schema: "diagnostics/v1",
    kind: "script-exception",
    severity: "error",
    source: { assetKind: "jsx-script", requestId },
    message: String(err.message || ""),
    location:
      err.line != null || err.file != null
        ? { line: err.line ?? null, file: err.file ?? null, origin: "host-reported" }
        : null,
    hostError: { name: err.name ?? null },
  };
}

/*
 * dispatchOnce: encode -> transport.send -> parse reply -> classify.
 * Exactly one send; no retry inside this function.
 */
async function dispatchOnce({ source, transport, codec, requestId }) {
  const requestText = codec.stringify({
    v: 1,
    kind: "extendscript.eval",
    requestId,
    source,
  });
  let replyText;
  try {
    replyText = await transport.send(requestText);
  } catch {
    replyText = null; // indistinguishable from no reply -> UNKNOWN
  }
  let reply = null;
  if (typeof replyText === "string") {
    try {
      reply = codec.parse(replyText);
    } catch {
      reply = null;
    }
  }
  // Reply identity: must echo our requestId, else unattributable.
  const identityOk =
    reply != null && reply.requestId != null && reply.requestId === requestId;
  const classified = classifyWriteResult({
    dispatched: true,
    reply: identityOk ? reply : null,
    deadlineExceeded: false,
  });
  if (!identityOk && reply != null) {
    return { ...classified, outcome: "UNKNOWN", unknownCategory: "REQUEST_ID_MISMATCH" };
  }
  return classified;
}

/**
 * runDevLoop({source, transport, fixer, codec?, maxFixes?})
 *
 * fixer(diagnostic, source, attempt) -> corrected source string, or
 * null to give up. Returns a report; never throws for script errors.
 */
export async function runDevLoop({
  source,
  transport,
  fixer,
  codec = loadCodec(),
  maxFixes = 3,
}) {
  const report = {
    iterations: [],
    diagnostics: [],
    finalSource: source,
    outcome: null,
  };
  let current = source;

  for (let attempt = 0; attempt <= maxFixes; attempt += 1) {
    const requestId = nextRequestId();
    const classified = await dispatchOnce({ source: current, transport, codec, requestId });
    const entry = {
      attempt,
      requestId,
      outcome: classified.outcome,
      result: classified.result ?? null,
      error: classified.error ?? null,
    };
    report.iterations.push(entry);

    if (classified.outcome === "COMPLETED") {
      report.outcome = "COMPLETED";
      report.finalSource = current;
      return report;
    }
    if (classified.outcome !== "FAILED") {
      // REFUSED/BLOCKED/UNKNOWN: stop, never silently retry.
      report.outcome = classified.outcome;
      return report;
    }

    const diag = toDiagnostic(classified, requestId);
    if (diag) report.diagnostics.push(diag);
    if (!fixer) {
      report.outcome = "FAILED";
      return report;
    }
    const fixed = await fixer(diag, current, attempt);
    if (typeof fixed !== "string" || fixed === current) {
      report.outcome = "FAILED";
      report.finalSource = current;
      return report;
    }
    current = fixed;
    report.finalSource = current;
  }

  report.outcome = "FAILED"; // exhausted fix budget
  return report;
}

/*
 * regressionCheck: rerun the final source once more and require
 * COMPLETED — proves the fix did not depend on transient state.
 */
export async function regressionCheck({ source, transport, codec = loadCodec() }) {
  const classified = await dispatchOnce({
    source,
    transport,
    codec,
    requestId: nextRequestId("regression"),
  });
  return { ok: classified.outcome === "COMPLETED", outcome: classified.outcome };
}
