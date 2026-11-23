/**
 * failure-record.mjs — execute/verify result → canonical diagnostics
 * record (Issue #181).
 *
 * Single implementation of the "failed dispatch becomes an
 * ae-devtools.diagnostics/v1 record" mapping, generalized from
 * devtools-cli/diagnostics.mjs recordForFailure (Issue #103/#127) so
 * the CLI evidence block, the MCP isError path and the VSCode
 * Problems-panel collector all consume identical semantics:
 *
 *   - a host-reported `error` object becomes a script-exception via
 *     collectors.fromAeError
 *   - everything else becomes a transport-outcome record carrying the
 *     failure-bearing state from outcomes.mjs failureOutcome —
 *     normalized across wire uppercase / adapter lowercase spellings,
 *     with the failure status winning over a COMPLETED wire outcome
 *
 * The diagnostics collectors are INJECTED (`collectors`), not imported:
 * devtools-cli loads packaged diagnostics/ through a guarded dynamic
 * import so a damaged/partial install degrades to an honest
 * "unavailable" instead of breaking every CLI command at module load.
 * Callers that already import diagnostics/ statically (vscode-extension)
 * simply pass the same functions through.
 *
 * Returns null when the result carries no failure — callers that want
 * an array (VSCode collector) wrap it; callers that already know a
 * failure occurred (CLI evidence block) get the record directly.
 *
 * Evidence labeling follows the CLI rule: "fake" only for fake
 * sessions; "real-host" only when the failure was actually observed
 * through the host/transport on an owned AE session; otherwise the
 * field is absent rather than invented.
 */
import { failureOutcome } from "./outcomes.mjs";

/** Session pin → diagnostics `session` block (strings only). */
function pinSession(pin) {
  if (pin === null || typeof pin !== "object") return undefined;
  const s = {};
  for (const k of ["sessionId", "aeVersion", "dispatchId"]) {
    if (typeof pin[k] === "string") s[k] = pin[k];
  }
  return Object.keys(s).length > 0 ? s : undefined;
}

/**
 * @param {object} input
 *   result     — execute()/verify() result object (any outcome spelling)
 *   outcome    — caller-computed fallback outcome (evidence.outcome)
 *   session    — { kind, pin? } session descriptor; kind drives the
 *                evidence label, pin feeds the record's session block
 *   requestId  — dispatch request id when the caller has one
 *   supervision— optional ae-a8n supervision snapshot
 *                (dev-loop/supervision.mjs supervisionSnapshotForSession,
 *                Issue #408): attached verbatim as record.supervision so
 *                every surface reports the same phase/health/needs-human
 *                state. Additive — absent supervision changes nothing.
 *   collectors — { fromAeError, fromTransportOutcome } from
 *                diagnostics/collectors.mjs (injected, see header)
 * @returns {object|null} canonical diagnostics record, or null when
 *          the result is not failure-shaped
 */
export function recordFromExecuteResult({ result, outcome, session, requestId, supervision, collectors } = {}) {
  const state = failureOutcome(result, outcome);
  if (state === null) return null;
  if (
    collectors === null || typeof collectors !== "object" ||
    typeof collectors.fromAeError !== "function" ||
    typeof collectors.fromTransportOutcome !== "function"
  ) {
    throw new Error("recordFromExecuteResult: collectors {fromAeError, fromTransportOutcome} are required");
  }

  const ctx = {
    session: pinSession(session?.pin),
    requestId: typeof requestId === "string" ? requestId : undefined,
    outcome: typeof outcome === "string" ? outcome : undefined,
  };

  let record;
  const hostErr = result?.error;
  if (hostErr !== null && typeof hostErr === "object" && typeof hostErr.message === "string" && hostErr.message.length > 0) {
    // runner.mjs already normalized the codec aeError wrapper to inner
    // fields; fromAeError accepts either shape.
    record = collectors.fromAeError(hostErr, { ctx });
  } else {
    const adapterMsg =
      result?.adapterError?.error?.message ??
      (typeof result?.adapterError?.message === "string" ? result.adapterError.message : null) ??
      (typeof result?.adapterError === "string" ? result.adapterError : null);
    // `code` carries the machine reason exactly once (reason / wire
    // refusal code); `detail` carries the human-readable fields —
    // including the host's refusal message, which used to be dropped.
    const detail = [
      result?.detail,
      result?.refusal?.message,
      result?.unknownCategory,
      adapterMsg,
      typeof result?.error === "string" ? result.error : null,
    ].filter((v) => typeof v === "string" && v.length > 0).join(" ");
    record = collectors.fromTransportOutcome(
      {
        outcome: state,
        code: result?.reason ?? result?.refusal?.code ?? result?.code ?? null,
        detail: detail || null,
      },
      { ctx },
    );
  }

  // Additive supervision snapshot (Issue #408): the durable
  // ae-a8n.supervision/v1 state observed for this session — phase,
  // observation health and the structured needs-human request. The
  // diagnostics schema allows forward-compatible fields; consumers
  // that predate supervision simply ignore it.
  if (supervision !== null && supervision !== undefined && typeof supervision === "object") {
    record.supervision = supervision;
  }

  // Evidence label honesty: "fake" only for fake sessions; "real-host"
  // only when the failure was actually observed through the host /
  // transport on an owned AE session (a wire outcome or a host error
  // reply). A client-side refusal never reached the host, and an
  // absent/unknown session proves nothing — leave `evidence` absent
  // rather than claim an observation that did not happen.
  const hostObserved =
    (result !== null && typeof result === "object" && typeof result.outcome === "string") ||
    (result !== null && typeof result === "object" && result.error !== null && typeof result.error === "object");
  if (session?.kind === "fake") {
    record.evidence = "fake";
  } else if (session?.kind === "a8n" && hostObserved) {
    record.evidence = "real-host";
  } else {
    delete record.evidence;
  }
  return record;
}
