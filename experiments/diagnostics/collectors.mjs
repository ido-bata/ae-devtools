/**
 * collectors.mjs — diagnostics collector registry (Issue #37, CAP062–CAP063).
 *
 * Every diagnostic source kind has an explicit status. A collector that
 * cannot reach its source is `pending-real-host` or
 * `unsupported-with-reason` — never silently absent, never faked.
 *
 * Status vocabulary:
 *   implemented-fake       — normalizer works and is covered by tests;
 *                            real-host collection still unproven
 *   pending-real-host      — collection path requires an owned AE session
 *                            or an upstream capability that does not exist yet
 *   unsupported-with-reason— investigated and found unreachable; reason recorded
 *
 * Node >= 22, zero dependencies.
 */
import { makeDiagnosticsRecord } from "./schema.mjs";

export const COLLECTOR_STATUS = Object.freeze({
  "script-exception": Object.freeze({
    status: "implemented-fake",
    reason: "trusted-execution codec aeError shape is defined and tested; host-side capture path is the same ES3 codec the dispatcher already ships",
    upstream: "#14 (codec), real-host capture pending #21 matrix",
  }),
  "expression-error": Object.freeze({
    status: "pending-real-host",
    reason: "AE expression error text surface (property.error / UI-only state) is unverified; fixture A2 in specs/ae-capability-coverage/fixtures/disposable-project-animation.md already reserves the case under CAP033",
    upstream: "#16 (CAP033), real-host probe needed",
  }),
  "panel-log": Object.freeze({
    status: "pending-real-host",
    reason: "CEP console.* routing to a host log file is unverified; requires #36 panel load proof first, then log-location verification",
    upstream: "#36 (CAP059), #37 CAP063",
  }),
  "native-crash": Object.freeze({
    status: "pending-real-host",
    reason: "macOS .ips crash reports are collectible in principle, but collection must be scoped to owned-session artifacts only; parser and scoping rules pending an actual crash artifact",
    upstream: "#17/#18 load proof, #21 evidence schema",
  }),
  "plugin-load-failure": Object.freeze({
    status: "pending-real-host",
    reason: "where AE reports plugin load failures (console, log file, UI-only) is unverified until the first real .plugin load attempt",
    upstream: "#17 CAP040, #18 CAP042",
  }),
  "render-failure": Object.freeze({
    status: "pending-real-host",
    reason: "render queue item status/error surface exists in scripting (rqItem.status) but the failure-detail shape is unverified; depends on #16 CAP035/036 adapters",
    upstream: "#16 (CAP035/CAP036)",
  }),
  "transport-outcome": Object.freeze({
    status: "implemented-fake",
    reason: "probe outcome taxonomy (COMPLETED/REFUSED/FAILED/UNKNOWN/BLOCKED) is already defined and tested; normalizing it into diagnostics records needs no AE",
    upstream: "#13 outcome-model, #14 trusted-execution",
  }),
});

export function collectorStatus(kind) {
  return COLLECTOR_STATUS[kind] ?? Object.freeze({
    status: "unknown",
    reason: "no collector registered for this kind",
  });
}

/**
 * Normalize a trusted-codec `aeError` wrapper into a script-exception
 * (or caller-chosen kind) diagnostics record.
 *
 * aeError shape (experiments/trusted-execution/codec):
 *   { "aeError": { name, message, line?, file? } }
 *
 * Position fields are copied only when the host actually reported them;
 * `hostReported: true` is set because the position came from the host,
 * not from client inference.
 */
export function fromAeError(aeError, { kind = "script-exception", ctx = {} } = {}) {
  if (!aeError || typeof aeError !== "object") {
    throw new Error("fromAeError: expected an aeError object");
  }
  const inner = aeError.aeError ?? aeError;
  const { name, message, line, file } = inner;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("fromAeError: aeError.message must be a non-empty string");
  }

  const source = { assetKind: "jsx-script", hostReported: true };
  if (typeof file === "string" && file.length > 0) source.path = file;
  if (Number.isInteger(line) && line >= 1) source.line = line;

  return makeDiagnosticsRecord({
    kind,
    severity: "error",
    message: typeof name === "string" && name.length > 0 ? `${name}: ${message}` : message,
    source,
    session: ctx.session,
    requestId: ctx.requestId,
    outcome: ctx.outcome,
    collector: "fromAeError",
    evidence: "fake",
  });
}

/**
 * Normalize a transport/probe outcome into a transport-outcome record.
 *
 * Accepts the outcome object shape used by experiments/read-only-probe
 * and trusted-execution (outcome, code, detail fields are carried into
 * the message; requestId/session pin pass through).
 */
export function fromTransportOutcome(outcome, { ctx = {} } = {}) {
  if (!outcome || typeof outcome !== "object") {
    throw new Error("fromTransportOutcome: expected an outcome object");
  }
  const state = outcome.outcome ?? outcome.state;
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("fromTransportOutcome: outcome.outcome/state must be a non-empty string");
  }

  const severity =
    state === "COMPLETED" ? "info"
    : state === "REFUSED" || state === "BLOCKED" ? "warning"
    : "error"; // FAILED / UNKNOWN

  const detail = [outcome.code, outcome.detail, outcome.reason]
    .filter((v) => typeof v === "string" && v.length > 0)
    .join(" ");

  return makeDiagnosticsRecord({
    kind: "transport-outcome",
    severity,
    message: detail ? `${state}: ${detail}` : state,
    source: { assetKind: "transport" },
    session: ctx.session ?? outcome.session,
    requestId: ctx.requestId ?? outcome.requestId,
    outcome: state,
    collector: "fromTransportOutcome",
    evidence: "fake",
  });
}
