/**
 * diagnostics.mjs — diagnostics record → Problems-panel model
 * (Issue #153, CAP050 slice 2; consumes #37 diagnostics).
 *
 * Converts canonical `ae-devtools.diagnostics/v1` records into a
 * vscode-free publish plan. Position honesty rules (inherited from
 * diagnostics/source-map.mjs):
 *
 *   - resolved original TS position (map status "mapped") wins —
 *     file/line/column come from the map's own data only.
 *   - otherwise the record's own source.path/line is used verbatim
 *     (it is host-reported truth, not an inference).
 *   - records with no usable position produce `range: null`; the
 *     caller publishes them without a fabricated location.
 *
 * Severity maps error→error, warning→warning, info→info (the extension
 * maps these strings onto vscode.DiagnosticSeverity).
 *
 * Collection entry points accept the SAME shapes the rest of the
 * package produces: execute/verify outcomes (scripting-adapters
 * execute.mjs), transport outcomes, and agent-loop reports
 * (agent-loop/loop.mjs diagnostics are already canonical records).
 */
import { resolveDiagnosticsSource } from "../diagnostics/source-map.mjs";
import { fromAeError, fromTransportOutcome } from "../diagnostics/collectors.mjs";
import { validateDiagnosticsRecord } from "../diagnostics/schema.mjs";
import { recordFromExecuteResult } from "../dev-loop/failure-record.mjs";

export const DIAGNOSTICS_PUBLISH_SCHEMA = "ae-devtools.vscode-diagnostics/v1";

const SEVERITY_LEVEL = Object.freeze({ error: "error", warning: "warning", info: "info" });

/**
 * Wrap resolveDiagnosticsSource: never throws for record problems;
 * returns the resolver result (status no-position/no-map/unmapped/
 * invalid-map/ambiguous/mapped) or null when the record is unusable.
 */
export function resolveRecordPosition(record, opts = {}) {
  try {
    return resolveDiagnosticsSource(record, opts);
  } catch {
    return null;
  }
}

/**
 * Normalize a resolver result into {file,line,column,excerpt} or null.
 * `mapped` requires original.file + original.line; column may be null
 * (callers render character 0 — never an invented column).
 */
export function positionFromResolution(resolved) {
  if (!resolved || resolved.status !== "mapped") return null;
  const o = resolved.original;
  if (!o || typeof o.file !== "string" || !Number.isInteger(o.line) || o.line < 1) return null;
  return {
    file: o.file,
    line: o.line,
    column: Number.isInteger(o.column) && o.column >= 0 ? o.column : null,
    excerpt: typeof o.excerpt === "string" ? o.excerpt : null,
  };
}

/**
 * Build one publish-plan item from a diagnostics record.
 *
 * @param {object} record — ae-devtools.diagnostics/v1 record
 * @param {object} [opts]
 * @param {object} [opts.sourceMapOpts] — forwarded to
 *   resolveDiagnosticsSource (jsxPath/mapDir/jsxMapPath/...)
 * @param {boolean} [opts.resolveSource=true] — set false to skip map
 *   resolution (e.g. assetKind known unmappable)
 * @returns {{severity:string, message:string, kind:string,
 *   collector:string, file:string|null, range:object|null,
 *   mappingStatus:string, record:object}}
 */
export function toDiagnosticItem(record, opts = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("toDiagnosticItem: record must be an object");
  }
  validateDiagnosticsRecord(record);

  const source = record.source ?? {};
  let mappingStatus = "not-attempted";
  let position = null;

  if (opts.resolveSource !== false && Number.isInteger(source.line) && source.line >= 1) {
    const resolved = resolveRecordPosition(record, opts.sourceMapOpts ?? {});
    mappingStatus = resolved?.status ?? "resolve-error";
    position = positionFromResolution(resolved);
  } else if (!Number.isInteger(source.line)) {
    mappingStatus = "no-position";
  }

  // Fall back to the record's own position when the map did not
  // produce an original — verbatim, never adjusted.
  if (position === null && Number.isInteger(source.line) && source.line >= 1) {
    position = {
      file: typeof source.path === "string" ? source.path : null,
      line: source.line,
      column: Number.isInteger(source.column) && source.column >= 1 ? source.column : null,
      excerpt: null,
    };
    if (mappingStatus === "not-attempted") mappingStatus = "record-position";
  }

  const range = position === null ? null : {
    file: position.file,
    // records/sourcemaps are 1-based lines; vscode ranges are 0-based.
    // column null → character 0 (position start), never invented.
    start: {
      line: position.line - 1,
      character: position.column === null ? 0 : position.column - 1,
    },
    end: {
      line: position.line - 1,
      character: position.column === null ? 0 : position.column,
    },
  };

  return {
    severity: SEVERITY_LEVEL[record.severity] ?? "error",
    message: record.message,
    kind: record.kind,
    collector: record.collector,
    file: range?.file ?? (typeof source.path === "string" ? source.path : null),
    range,
    mappingStatus,
    record,
  };
}

/**
 * Collect diagnostics records from an execute/verify outcome
 * (scripting-adapters/execute.mjs result shape). Returns an array of
 * canonical records — empty when the outcome carries no failure source.
 * Never throws on unexpected shapes; unusable inputs yield [].
 */
export function recordsFromExecuteResult(result, ctx = {}) {
  if (!result || typeof result !== "object") return [];
  try {
    // Shared failure→record mapping (dev-loop/failure-record.mjs,
    // Issue #181): adapter `status` spellings and the
    // failure-beats-COMPLETED rule are identical to the CLI evidence
    // block — the previous local check missed `status:"refused"`
    // outcomes that carry no wire `outcome` field.
    const record = recordFromExecuteResult({
      result,
      outcome: ctx.outcome,
      session: ctx.session,
      requestId: ctx.requestId ?? result.requestId,
      collectors: { fromAeError, fromTransportOutcome },
    });
    return record === null ? [] : [record];
  } catch {
    return [];
  }
}

/**
 * Collect canonical records from an agent-loop report
 * (agent-loop/loop.mjs). report.diagnostics are already
 * ae-devtools.diagnostics/v1 records; each is re-validated and
 * malformed entries are dropped, never coerced.
 */
export function recordsFromLoopReport(report) {
  const list = report?.diagnostics;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    try {
      validateDiagnosticsRecord(r);
      out.push(r);
    } catch { /* drop malformed — no coercion */ }
  }
  return out;
}

/**
 * Build the full publish plan for a batch of records.
 *
 * @returns {{schema:string, items:Array, summary:{total:number,
 *   positioned:number, unmapped:number, noPosition:number}}}
 */
export function buildPublishPlan(records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const items = [];
  const summary = { total: 0, positioned: 0, unmapped: 0, noPosition: 0 };
  for (const record of list) {
    let item;
    try {
      item = toDiagnosticItem(record, opts);
    } catch {
      continue; // invalid record — skip, never publish garbage
    }
    summary.total++;
    if (item.range !== null) summary.positioned++;
    else summary.noPosition++;
    if (item.mappingStatus === "unmapped" || item.mappingStatus === "no-map" ||
        item.mappingStatus === "invalid-map" || item.mappingStatus === "ambiguous") {
      summary.unmapped++;
    }
    items.push(item);
  }
  return { schema: DIAGNOSTICS_PUBLISH_SCHEMA, items, summary };
}

/**
 * Diff a publish plan against previously published keys.
 *
 * vscode-free publish/clear decision for the Problems panel: the caller
 * supplies `keyForItem` (extension uses the vscode Uri string), and this
 * returns the URIs to publish now plus the previously published keys that
 * are absent from the current plan. An empty plan therefore clears every
 * stale key — the plan is authoritative for the ae-devtools collection.
 */
export function diffPublishPlan(plan, previousKeys, keyForItem) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const publish = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    if (!publish.has(key)) publish.set(key, []);
    publish.get(key).push(item);
  }
  const prev = previousKeys instanceof Set ? previousKeys : new Set(previousKeys ?? []);
  const clear = [];
  for (const key of prev) {
    if (!publish.has(key)) clear.push(key);
  }
  return {
    publish: [...publish.entries()].map(([key, group]) => ({ key, items: group })),
    clear,
  };
}
