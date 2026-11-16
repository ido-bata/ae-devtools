/**
 * NativeProbe debug-log collector — Issue #81.
 *
 * Parses an AE debug-log excerpt (the `ae-a8n`/`nativeprobe` lines
 * emitted by `experiments/native-sdk/minimal-plugin/src/probe.cpp`
 * through `AEGP_WriteToDebugLog`) into `ae-devtools/native-probe-result/v1`
 * records, one per attributed execution segment, per the contract in
 * `specs/ae-capability-coverage/contracts/native-probe-result.md`.
 *
 * SCOPE: fake/mock level only. This parses TEXT — it does not contact
 * AE, does not prove any value was observed on a real host, and its
 * output is evidence-shaped input for `validateProbeResult`, nothing
 * more. `plugin.*` and `evidence.*` are SUPPLIED by the caller (build
 * manifest / session context); the collector never invents them.
 *
 * SEGMENTATION (mirrors probe.cpp's emission model):
 *   - `registration`: leading `op ` records before the first
 *     `probe.start` (the entry-point flush). Quiet idle ticks flush
 *     nothing, so `op ` lines can only reach the log via the entry
 *     flush, a probe-run flush, or a probe-run's trailing releases.
 *   - `probe-run`: `probe.start` … `probe.end`, plus every `op ` line
 *     after `probe.end` up to the next non-`op` line (the suite
 *     releases emitted at `done:` while the mode is still DIRECT).
 *   - `tick`: a maximal run of `probe.error:` / `probe.aborted:` lines.
 *     Per-tick boundaries are unobservable in the stream (the log-once
 *     guards suppress repeats), so consecutive diagnostic lines form
 *     ONE tick segment — documented, not inferred per dispatch.
 *
 * UNRECOGNIZED LINES: any line that is not `op `/marker/data grammar
 * inside an open segment is kept verbatim in `diagnostics[]` — the
 * collector never drops observed text and never fabricates fields.
 */

import {
  PROBE_RESULT_SCHEMA,
  type ProbeCallRecord,
  type ProbeCompleteness,
  type ProbeProject,
  type ProbeRenderQueue,
  type ProbeRenderQueueItem,
  type ProbeResult,
  type ProbeRunReason,
} from "./probe-result.ts";

export type CollectSupplied = {
  /** SUPPLIED — build manifest identity. */
  plugin: ProbeResult["plugin"];
  /** SUPPLIED — session context locating the raw log excerpt. */
  evidence?: ProbeResult["evidence"];
};

type LineKind = "op" | "start" | "reason" | "end" | "diag" | "data";

const MEM_HANDLE_STATUSES: Record<string, string> = {
  "<null handle>": "null-handle",
  "lock failed": "lock-failed",
  "size query failed": "size-query-failed",
  "<truncated>": "truncated",
  "memory suite entries missing": "entries-missing",
};

function classify(line: string): LineKind {
  if (line.startsWith("op ")) return "op";
  if (line === "probe.start") return "start";
  if (line.startsWith("probe.reason=")) return "reason";
  if (line === "probe.end") return "end";
  if (line.startsWith("probe.error:") || line.startsWith("probe.aborted:")) return "diag";
  return "data";
}

/** `op <Suite>.<member> err=<n>[ k=v ...]` → record, or null when malformed. */
function parseOpLine(line: string): { call: ProbeCallRecord; overflow: boolean } | null {
  const m = /^op (\S+) err=(-?\d+)(.*)$/.exec(line);
  if (!m) return null;
  const id = m[1]!;
  const errS = m[2]!;
  const rest = m[3]!;
  if (id === "__overflow") {
    return { call: { call: id, suite: "__overflow", err: Number(errS), status: "error" }, overflow: true };
  }
  const dot = id.indexOf(".");
  if (dot <= 0) return null;
  const fields: Record<string, string> = {};
  const tokenRe = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(rest)) !== null) {
    let v = tm[2]!;
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    fields[tm[1]!] = v;
  }
  const err = Number(errS);
  const call: ProbeCallRecord = {
    call: id,
    suite: id.slice(0, dot),
    err,
    status: err === 0 ? "ok" : "error",
  };
  if (Object.keys(fields).length > 0) call.fields = fields;
  return { call, overflow: false };
}

/** `<label>: <utf8|status>` mem-handle line → [label, value, statusToken?]. */
function parseMemHandleLine(line: string): { label: string; value?: string; status?: string } | null {
  const idx = line.indexOf(": ");
  if (idx <= 0) return null;
  const label = line.slice(0, idx);
  const value = line.slice(idx + 2);
  const status = MEM_HANDLE_STATUSES[value];
  if (status !== undefined) return { label, status };
  return { label, value };
}

type Exec = {
  kind: "registration" | "probe-run" | "tick";
  reason?: ProbeRunReason;
  ended: boolean; // probe.end observed
  calls: ProbeCallRecord[];
  diagnostics: string[];
  environment: ProbeResult["environment"];
  projects: Map<number, ProbeProject>;
  projectCount?: number;
  renderQueue?: ProbeRenderQueue;
  currentProject?: number;
  recordsWellFormed: boolean;
};

function newExec(kind: Exec["kind"]): Exec {
  return {
    kind,
    ended: false,
    calls: [],
    diagnostics: [],
    environment: {},
    projects: new Map(),
    recordsWellFormed: true,
  };
}

function projectFor(exec: Exec, index: number): ProbeProject {
  let p = exec.projects.get(index);
  if (!p) {
    p = { index, items: { count: 0, capped: false, names: [] } };
    exec.projects.set(index, p);
  }
  return p;
}

function rqItemFor(exec: Exec, index: number): ProbeRenderQueueItem {
  const rq = (exec.renderQueue ??= { items: [] });
  let it = rq.items.find((x) => x.index === index);
  if (!it) {
    it = { index };
    rq.items.push(it);
  }
  return it;
}

/** Dispatch a data line; returns true when the line matched known grammar. */
function applyObservedLine(exec: Exec, line: string): boolean {
  let m: RegExpExecArray | null;

  if ((m = /^driver\.pluginInitVersion=(\S+)$/.exec(line))) {
    exec.environment.driverPluginInitVersion = m[1];
    return true;
  }
  if ((m = /^driver\.implementationVersion=(\S+)$/.exec(line))) {
    exec.environment.driverImplementationVersion = m[1];
    return true;
  }
  if ((m = /^host\.suppressInteractiveUI=([01])$/.exec(line))) {
    exec.environment.suppressInteractiveUI = m[1] === "1";
    return true;
  }
  if ((m = /^host\.isActivated=([01])$/.exec(line))) {
    exec.environment.hostIsActivated = m[1] === "1";
    return true;
  }
  if ((m = /^app\.numProjects=(\d+)$/.exec(line))) {
    exec.projectCount = Number(m[1]);
    return true;
  }
  if ((m = /^project\[(\d+)\]\.name=(.*)$/.exec(line))) {
    const p = projectFor(exec, Number(m[1]));
    exec.currentProject = p.index;
    p.name = m[2];
    return true;
  }
  if ((m = /^project\[(\d+)\]\.(isDirty|bitDepth)=(-?\d+)$/.exec(line))) {
    const p = projectFor(exec, Number(m[1]));
    exec.currentProject = p.index;
    if (m[2] === "isDirty") p.isDirty = m[3] === "1";
    else p.bitDepth = Number(m[3]);
    return true;
  }
  if ((m = /^project\[(\d+)\]\.path: (.*)$/.exec(line))) {
    const p = projectFor(exec, Number(m[1]));
    exec.currentProject = p.index;
    const status = MEM_HANDLE_STATUSES[m[2]!];
    if (status !== undefined) p.pathStatus = status;
    else p.path = m[2]!;
    return true;
  }
  if (line.startsWith("project.rootFolder.name: ")) {
    const p = currentProject(exec);
    if (p) {
      const value = line.slice("project.rootFolder.name: ".length);
      const status = MEM_HANDLE_STATUSES[value];
      if (status === undefined) p.rootFolderName = value;
    }
    return true;
  }
  if ((m = /^project\.items\.firstType=(-?\d+)$/.exec(line))) {
    const p = currentProject(exec);
    if (p) p.items.firstType = Number(m[1]);
    return true;
  }
  if ((m = /^project\.items\[(\d+)\]\.name: (.*)$/.exec(line))) {
    const p = currentProject(exec);
    if (p) {
      const value = m[2]!;
      const status = MEM_HANDLE_STATUSES[value];
      if (status === undefined) p.items.names.push(value);
    }
    return true;
  }
  if ((m = /^project\.items\.count=(\d+)( \(capped\))?$/.exec(line))) {
    const p = currentProject(exec);
    if (p) {
      p.items.count = Number(m[1]);
      p.items.capped = m[2] !== undefined;
    }
    return true;
  }
  if ((m = /^renderQueue\.state=(-?\d+)$/.exec(line))) {
    (exec.renderQueue ??= { items: [] }).state = Number(m[1]);
    return true;
  }
  if ((m = /^renderQueue\.numItems=(-?\d+)$/.exec(line))) {
    (exec.renderQueue ??= { items: [] }).numItems = Number(m[1]);
    return true;
  }
  if (line.startsWith("rq[") && line.includes("]: get failed")) {
    const idx = Number(/^rq\[(\d+)\]/.exec(line)?.[1]);
    if (Number.isInteger(idx)) rqItemFor(exec, idx).getFailed = true;
    return true;
  }
  if ((m = /^rq\[(\d+)\]\.renderState=(-?\d+)$/.exec(line))) {
    rqItemFor(exec, Number(m[1])).renderState = Number(m[2]);
    return true;
  }
  if ((m = /^rq\[(\d+)\]\.(started|elapsed)=(-?\d+)\/(\d+)$/.exec(line))) {
    rqItemFor(exec, Number(m[1]))[m[2] as "started" | "elapsed"] = {
      value: Number(m[3]),
      scale: Number(m[4]),
    };
    return true;
  }
  if ((m = /^rq\[(\d+)\]\.logType=(-?\d+)$/.exec(line))) {
    rqItemFor(exec, Number(m[1])).logType = Number(m[2]);
    return true;
  }
  if ((m = /^rq\[(\d+)\]\.numOutputModules=(-?\d+)$/.exec(line))) {
    rqItemFor(exec, Number(m[1])).numOutputModules = Number(m[2]);
    return true;
  }
  if ((m = /^rq\[(\d+)\]\.comment: (.*)$/.exec(line))) {
    const it = rqItemFor(exec, Number(m[1]));
    const status = MEM_HANDLE_STATUSES[m[2]!];
    if (status !== undefined) it.commentStatus = status;
    else it.comment = m[2]!;
    return true;
  }
  return false;
}

function currentProject(exec: Exec): ProbeProject | undefined {
  return exec.currentProject !== undefined ? exec.projects.get(exec.currentProject) : undefined;
}

/** First observed failure in log order for firstError derivation. */
function firstFailure(exec: Exec): ProbeResult["firstError"] {
  for (const c of exec.calls) {
    if (c.err !== 0) return { call: c.call, errorCode: c.err };
  }
  if (exec.diagnostics.length > 0) return { detail: exec.diagnostics[0] };
  return undefined;
}

function finalize(exec: Exec, ordinal: number, supplied: CollectSupplied): ProbeResult {
  const succeeded = new Set<string>();
  const failedOnly = new Map<string, boolean>();
  for (const c of exec.calls) {
    if (c.err === 0) {
      succeeded.add(c.call);
      failedOnly.delete(c.call);
    } else if (!succeeded.has(c.call)) {
      failedOnly.set(c.call, true);
    }
  }
  const completeness: ProbeCompleteness = {
    recordsWellFormed: exec.recordsWellFormed,
    bounded: exec.kind === "probe-run" ? exec.ended : exec.kind === "registration" ? exec.calls.length > 0 : exec.diagnostics.length > 0,
    operationsEvidenced: [...succeeded].sort(),
    operationsFailed: [...failedOnly.keys()].sort(),
  };

  let outcome: ProbeResult["outcome"];
  if (exec.kind === "tick") outcome = "failed";
  else if (exec.kind === "probe-run") outcome = exec.ended ? "completed" : "partial";
  else outcome = succeeded.size > 0 ? "completed" : "failed";

  const firstError = firstFailure(exec) ??
    (outcome !== "completed"
      ? { detail: exec.kind === "probe-run" ? "probe.start observed without probe.end" : "no successful records observed" }
      : undefined);

  const observed: string[] = ["execution.kind"];
  if (exec.kind === "probe-run" && exec.reason !== undefined) observed.push("execution.reason");
  if (exec.calls.length > 0) observed.push("calls");
  if (exec.diagnostics.length > 0) observed.push("diagnostics");
  if (exec.projects.size > 0) observed.push("projects");
  if (exec.projectCount !== undefined) observed.push("projectCount");
  if (exec.renderQueue !== undefined) observed.push("renderQueue");
  if (Object.keys(exec.environment).length > 0) observed.push("environment");

  const result: ProbeResult = {
    schema: PROBE_RESULT_SCHEMA,
    provenance: {
      observed,
      derived: ["execution.ordinal", "execution.bounded", "outcome", "firstError", "completeness"],
      supplied: ["plugin", "evidence"],
    },
    plugin: supplied.plugin,
    environment: exec.environment,
    execution: {
      ordinal,
      kind: exec.kind,
      ...(exec.kind === "probe-run" && exec.reason !== undefined ? { reason: exec.reason } : {}),
      bounded: completeness.bounded,
    },
    calls: exec.calls,
    ...(exec.diagnostics.length > 0 ? { diagnostics: exec.diagnostics } : {}),
    projects: [...exec.projects.values()].sort((a, b) => a.index - b.index),
    ...(exec.projectCount !== undefined ? { projectCount: exec.projectCount } : {}),
    ...(exec.renderQueue !== undefined ? { renderQueue: exec.renderQueue } : {}),
    outcome,
    ...(firstError !== undefined ? { firstError } : {}),
    completeness,
    evidence: supplied.evidence ?? {},
  };
  return result;
}

/**
 * Collect `ProbeResult[]` from a debug-log excerpt. `supplied.plugin`
 * is required (build-manifest identity); `supplied.evidence` locates
 * the raw excerpt. Returns executions in log order with 1-based
 * ordinals. An empty/whitespace log yields `[]`.
 */
export function collectProbeResults(logText: string, supplied: CollectSupplied): ProbeResult[] {
  const lines = logText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const results: ProbeResult[] = [];
  let exec: Exec | null = null;
  let sawStart = false;

  const close = () => {
    if (exec) {
      results.push(finalize(exec, results.length + 1, supplied));
      exec = null;
    }
  };

  for (const line of lines) {
    const kind = classify(line);

    if (kind === "start") {
      close();
      sawStart = true;
      exec = newExec("probe-run");
      continue;
    }
    if (kind === "end") {
      if (exec?.kind === "probe-run") exec.ended = true;
      else {
        exec ??= newExec(sawStart ? "tick" : "registration");
        exec.diagnostics.push(line);
      }
      continue;
    }
    if (kind === "reason") {
      if (exec?.kind === "probe-run" && !exec.ended) {
        const r = line.slice("probe.reason=".length);
        if (r === "initial" || r === "identity-change" || r === "recovery") exec.reason = r;
        else exec.diagnostics.push(line);
      } else {
        exec ??= newExec(sawStart ? "tick" : "registration");
        exec.diagnostics.push(line);
      }
      continue;
    }
    if (kind === "op") {
      const parsed = parseOpLine(line);
      if (!parsed) {
        // malformed op line: verbatim diagnostic + well-formedness flag
        (exec ??= newExec(sawStart ? "tick" : "registration")).diagnostics.push(line);
        exec.recordsWellFormed = false;
        continue;
      }
      exec ??= newExec(sawStart ? "tick" : "registration");
      if (exec.kind === "tick") {
        // quiet ticks discard buffered op records — an `op ` line in a
        // tick segment violates the emission model; keep it verbatim
        // and fail well-formedness rather than fabricate call evidence.
        exec.diagnostics.push(line);
        exec.recordsWellFormed = false;
        continue;
      }
      if (parsed.overflow) {
        // `op __overflow` is a dropped-record marker, not a call — keep
        // it verbatim as a diagnostic and fail well-formedness.
        exec.diagnostics.push(line);
        exec.recordsWellFormed = false;
        continue;
      }
      exec.calls.push(parsed.call);
      continue;
    }
    if (kind === "diag") {
      if (exec === null) exec = newExec("tick");
      else if (exec.kind === "probe-run" && exec.ended) {
        // diagnostics after probe.end belong to a NEW tick, not the run
        close();
        exec = newExec("tick");
      } else if (exec.kind === "registration") {
        // a diagnostic before any probe.start ends the registration flush
        close();
        exec = newExec("tick");
      }
      exec.diagnostics.push(line);
      continue;
    }
    // data line
    if (exec !== null && applyObservedLine(exec, line)) continue;
    // unrecognized or out-of-segment data: verbatim diagnostic
    if (exec === null) exec = newExec(sawStart ? "tick" : "registration");
    exec.diagnostics.push(line);
  }
  close();
  return results;
}
