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
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeDiagnosticsRecord } from "./schema.mjs";
import { crashEvidenceToDiagnostics } from "../recovery-orchestrator/diagnostics.mjs";
import { cepLogDir } from "../cep-extension/lifecycle.mjs";

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
    status: "implemented-fake",
    reason: "CEPHtmlEngine*.log parser works on fixture logs (fromPanelLog/collectPanelLogs); console.* routing to the host log is UNVERIFIED until the #36 panel load proof runs",
    upstream: "#36 (CAP059), #37 CAP063; real-host log verification pending",
  }),
  "native-crash": Object.freeze({
    status: "implemented-fake",
    reason: "fromCrashEvidence consumes the recovery-orchestrator crash-evidence manifest (tested .ips parse/correlate + sha256 artifactHashes); real OS crash artifacts attributable to an owned session remain unverified",
    upstream: "recovery-orchestrator collectCrashEvidence/crashEvidenceToDiagnostics; #17/#18 load proof, #21 evidence schema",
  }),
  "plugin-load-failure": Object.freeze({
    status: "pending-real-host",
    reason: "where AE reports plugin load failures (console, log file, UI-only) is unverified until the first real .plugin load attempt",
    upstream: "#17 CAP040, #18 CAP042",
  }),
  "render-failure": Object.freeze({
    status: "implemented-fake",
    reason: "fromRenderItem normalizes a synthetic rqItem.status shape; the real AE render-queue status/error strings are unverified pending #16 CAP035/036 adapters",
    upstream: "#16 (CAP035/CAP036); real-host status strings pending",
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
 * aeError shape (packages/ae-devtools-cli/trusted-execution/codec):
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

/**
 * Normalize a recovery-orchestrator crash-evidence manifest (the shape
 * `collectCrashEvidence` writes to manifest.json) into diagnostics
 * records.
 *
 * This is a thin bridge, not a second implementation: the actual
 * manifest→record mapping — correlated-report severity, sha256
 * `artifactHashes` pins, and the `evidence-incomplete` transport-outcome
 * record — lives in `recovery-orchestrator/diagnostics.mjs`
 * (`crashEvidenceToDiagnostics`), which is already tested there. Returns
 * an ARRAY: a manifest yields 0 records when nothing is proven, 1
 * `native-crash` record when reports correlate, plus optionally 1
 * `transport-outcome` warning when collection was incomplete. An empty
 * result is not a clean bill — it is simply nothing to diagnose.
 *
 * `ctx` passes session/requestId/evidence through; `evidence` defaults
 * to "fake" because manifest consumption here is fixture-level — the
 * real-host collection path (owned-session .ips artifacts) is still
 * unverified.
 */
export function fromCrashEvidence(manifest, { ctx = {} } = {}) {
  return crashEvidenceToDiagnostics(manifest, ctx);
}

// ------------------------------------------------------------ panel-log

const PANEL_LOG_NAME = /CEPHtmlEngine.*\.log$/i;

// Severity vocabulary is closed to error|warning|info. Levels below
// info (debug/verbose/trace) normalize to "info" — the log line itself
// is preserved verbatim in `message`, so no detail is lost.
const PANEL_LOG_LEVEL = /\b(FATAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|VERBOSE|TRACE)\b/i;

function panelLogSeverity(levelToken) {
  const l = levelToken.toUpperCase();
  if (l === "FATAL" || l === "ERROR" || l === "ERR") return "error";
  if (l === "WARN" || l === "WARNING") return "warning";
  return "info"; // INFO / DEBUG / VERBOSE / TRACE
}

// Leading timestamp candidate, e.g. ISO-8601. A zone designator is
// REQUIRED — a zone-less stamp would have to be interpreted as local
// time, which is a guess, so it stays absent instead.
const PANEL_LOG_TS = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/;

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse one CEPHtmlEngine*.log file's text into `panel-log` records.
 *
 * Tolerant by design: the real CEP log format is UNVERIFIED (see the
 * collector registry reason), so a line is recorded only when it
 * contains a recognizable level token; everything else is skipped and
 * counted in the returned `skipped` tally. Lines that match keep their
 * raw text as `message` — the parser never invents a position. The log
 * file's own line number is NOT reported as `source.line`: that field
 * means a position inside the panel asset, and a log-file line is not
 * one. `source.path` is the log file path when `path` is given.
 *
 * `artifactHashes` pins `{ [path]: sha256 }` of the exact bytes parsed.
 *
 * Returns `{ records, skipped }`.
 */
export function fromPanelLog(text, { path = null, artifactHash = null, ctx = {} } = {}) {
  if (typeof text !== "string") {
    throw new Error("fromPanelLog: expected log text (string)");
  }
  const records = [];
  let skipped = 0;
  // artifactHash lets file-level callers pin the sha256 of the exact
  // bytes read (utf8 decoding can alter invalid sequences); without it
  // the hash covers the text as given.
  const artifactHashes =
    typeof path === "string" && path.length > 0
      ? { [path]: typeof artifactHash === "string" && artifactHash.length > 0 ? artifactHash : sha256Text(text) }
      : undefined;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue; // blank lines are not findings
    const levelMatch = PANEL_LOG_LEVEL.exec(trimmed);
    if (!levelMatch) {
      skipped++;
      continue;
    }
    const tsMatch = PANEL_LOG_TS.exec(trimmed);
    const occurredAt =
      tsMatch && !Number.isNaN(Date.parse(tsMatch[1])) ? new Date(tsMatch[1]).toISOString() : undefined;

    records.push(
      makeDiagnosticsRecord({
        kind: "panel-log",
        severity: panelLogSeverity(levelMatch[1]),
        message: trimmed,
        source: {
          assetKind: "panel-asset",
          ...(typeof path === "string" && path.length > 0 ? { path } : {}),
        },
        ...(occurredAt ? { occurredAt } : {}),
        session: ctx.session,
        requestId: ctx.requestId,
        outcome: ctx.outcome,
        collector: "fromPanelLog",
        evidence: "fake",
        artifactHashes,
      }),
    );
  }
  return { records, skipped };
}

/**
 * Collect panel-log records from a directory of CEPHtmlEngine*.log
 * files (the `~/Library/Logs/CSXS` layout observed on macOS — see
 * cep-extension/EVIDENCE.md).
 *
 * Synchronous fs reads; scoped to the caller-supplied `logDir` (or the
 * platform default via cep-extension's `cepLogDir`). Never touches AE.
 *
 * Returns an explicit result in every case — a missing or unreadable
 * directory is reported, never silently treated as "no panel logs":
 *
 *   { dir, complete, errors, files, records, skippedLines }
 *
 * `complete` is false when the directory is missing/unreadable or any
 * matching file failed to read; `errors` lists each failure.
 */
export function collectPanelLogs({ logDir = null, platform = process.platform, home = process.env.HOME, ctx = {} } = {}) {
  const dir = logDir ?? cepLogDir({ platform, home });
  const result = { dir, complete: true, errors: [], files: [], records: [], skippedLines: 0 };
  if (typeof dir !== "string" || dir.length === 0) {
    result.complete = false;
    result.errors.push("no CEP log dir for this platform (win32/other is not modeled)");
    return result;
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    result.complete = false;
    result.errors.push(`unreadable log dir ${dir}: ${String(error?.message ?? error)}`);
    return result;
  }
  for (const name of names.sort()) {
    if (!PANEL_LOG_NAME.test(name)) continue;
    const path = join(dir, name);
    const file = { path, bytes: null, records: 0 };
    try {
      const st = statSync(path);
      file.bytes = st.size;
      const buf = readFileSync(path);
      const parsed = fromPanelLog(buf.toString("utf8"), {
        path,
        artifactHash: createHash("sha256").update(buf).digest("hex"),
        ctx,
      });
      file.records = parsed.records.length;
      result.records.push(...parsed.records);
      result.skippedLines += parsed.skipped;
    } catch (error) {
      result.complete = false;
      result.errors.push(`unreadable log file ${path}: ${String(error?.message ?? error)}`);
    }
    result.files.push(file);
  }
  return result;
}

// ------------------------------------------------------------ render-failure

/**
 * Normalize a render queue item into a `render-failure` record.
 *
 * The real AE `rqItem.status` / error surface is UNVERIFIED (registry
 * reason; pending #16 CAP035/036), so this accepts a loose synthetic
 * shape and never invents fields:
 *
 *   { status: string, error?: string, message?: string, detail?: string }
 *   or a bare status string.
 *
 * Severity: error when the status/detail matches /err|fail|abort/i,
 * warning otherwise — a stopped/unknown render state is still a finding
 * but not asserted as a hard failure. Positions stay absent: the host
 * has not been observed to report them.
 */
export function fromRenderItem(item, { ctx = {} } = {}) {
  const status =
    typeof item === "string" ? item
    : item && typeof item === "object" && typeof item.status === "string" ? item.status
    : null;
  if (status === null || status.length === 0) {
    throw new Error("fromRenderItem: expected an item with a non-empty status string");
  }
  const detail =
    item && typeof item === "object"
      ? [item.error, item.message, item.detail].find((v) => typeof v === "string" && v.length > 0)
      : undefined;
  const haystack = `${status} ${detail ?? ""}`;
  const severity = /err|fail|abort/i.test(haystack) ? "error" : "warning";

  return makeDiagnosticsRecord({
    kind: "render-failure",
    severity,
    message: detail ? `render queue item "${status}": ${detail}` : `render queue item status "${status}"`,
    source: { assetKind: "render-output" },
    session: ctx.session,
    requestId: ctx.requestId,
    outcome: status,
    collector: "fromRenderItem",
    evidence: "fake",
  });
}
