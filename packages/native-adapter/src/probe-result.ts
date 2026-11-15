/**
 * NativeProbe result / diagnostics / evidence contract — Issue #19.
 *
 * Schema `ae-devtools/native-probe-result/v1`: the structured result
 * an adapter would collect from the NativeProbe plug-in
 * (`experiments/native-sdk/minimal-plugin/src/probe.cpp`) after an
 * authorized real-host load. This revision reconciles the schema with
 * the ACTUAL debug-log grammar emitted by probe.cpp (post-#17 audit):
 *
 *   op <Suite>.<member> err=<A_Err> [k=v ...]
 *   probe.start / probe.reason=<initial|identity-change|recovery> / probe.end
 *   probe.error: <msg> / probe.aborted: <msg>
 *   driver.* / host.* / app.numProjects / project[i].* / project.items.*
 *
 * OBSERVED vs DERIVED vs SUPPLIED — the contract's core rule:
 *
 *   - `calls[]`, `environment`, `projects`, `diagnostics`,
 *     `execution.kind`, `execution.reason` are OBSERVED: each value
 *     must trace to a specific debug-log line (the `op ` record or the
 *     `key=value` / labelled line). A field with no emitting line is
 *     absent, never inferred.
 *   - `execution.ordinal`, `execution.bounded`, `outcome`,
 *     `firstError`, `completeness.*` are DERIVED: computed by the
 *     collector from observed lines; they carry no independent
 *     evidence.
 *   - `plugin.*` and `evidence.*` are SUPPLIED: the debug log does not
 *     emit plug-in name/entry-point/SDK release or host OS/arch; the
 *     collector must source them from the build manifest and session
 *     context and mark them as such via `provenance`.
 *
 * VERIFICATION STATUS: **UNVERIFIED**. This is a contract for a future
 * collector; no real dispatch exists, the debug-log transport from AE
 * to the adapter is undesigned, and nothing here means native dispatch
 * is implemented. `validateProbeResult` checks shape and provenance
 * bookkeeping only — it cannot assert that any value was observed on a
 * real host.
 *
 * Normative description (emission grammar, completeness definition,
 * per-operation evidence, promotion criteria):
 * specs/ae-capability-coverage/contracts/native-probe-result.md
 */

export const PROBE_RESULT_SCHEMA = "ae-devtools/native-probe-result/v1" as const;

/** Why a probe run fired — observed verbatim from `probe.reason=`. */
export type ProbeRunReason = "initial" | "identity-change" | "recovery";

/**
 * One `op ` debug-log record. `call` uses the registry id format
 * `"<Suite>.<member>"` and MUST equal a `DISPATCH_ENTRIES` id — the
 * op-record grammar and the registry share one identity space.
 */
export type ProbeCallRecord = {
  /** `"<Suite>.<member>"`, e.g. `"AEGP_ProjSuite6.AEGP_GetNumProjects"`. */
  call: string;
  suite: string;
  /** Raw `A_Err`/`SPErr` code observed in the record; 0 = success. */
  err: number;
  /** Derived convenience: `err === 0`. */
  status: "ok" | "error";
  /**
   * Extra `k=v` tokens observed after `err=` on the same line, verbatim:
   * `suite`, `version` (Acquire/ReleaseSuite), `value` (scalar results),
   * `v` (`M.m` driver versions), `i` (project/item index).
   */
  fields?: Record<string, string>;
};

/**
 * Execution identity. The debug log is a stream of attributed
 * segments; the collector assigns `ordinal` per segment within one
 * `evidence.debugLogRef` session and classifies `kind`:
 *
 *   - `registration`: the plug-in-entry flush — AcquireSuite x2,
 *     RegisterWithAEGP, RegisterIdleHook, ReleaseSuite. No probe.*
 *     markers exist for this segment; its boundary is the collector's
 *     attribution of the entry-phase op records.
 *   - `probe-run`: a `probe.start` … `probe.end` window plus the
 *     trailing suite-release op records emitted after `probe.end`.
 *   - `tick`: a diagnostics-only segment (`probe.error:` /
 *     `probe.aborted:`) emitted by an idle dispatch that never reached
 *     `probe.start`; its buffered op records were discarded by design
 *     and are NOT evidence of the failed calls.
 */
export type ProbeExecution = {
  /** Collector-assigned 1-based ordinal within the log session. */
  ordinal: number;
  kind: "registration" | "probe-run" | "tick";
  /** Observed `probe.reason=` value; `probe-run` only, absent otherwise. */
  reason?: ProbeRunReason;
  /**
   * Derived: the segment has observable boundaries — `probe-run`:
   * start+end pair present; `registration`: ≥1 op record attributed;
   * `tick`: ≥1 diagnostic line attributed.
   */
  bounded: boolean;
};

export type ProbeProject = {
  index: number;
  name?: string;
  isDirty?: boolean;
  bitDepth?: number;
  /**
   * UTF-8 project path from `project[i].path: <utf8>`; empty string
   * for untitled projects. LOCAL PATHS REACH THE DEBUG LOG — redact
   * before sharing evidence.
   */
  path?: string;
  /**
   * Observed path-read status when the value line was not a plain
   * string: `null-handle` | `lock-failed` | `size-query-failed` |
   * `truncated` | `entries-missing`. Absent when `path` holds a value.
   */
  pathStatus?: string;
  rootFolderName?: string;
  items: {
    count: number;
    /** True when iteration hit MAX_ITEMS_SCANNED (4096). */
    capped: boolean;
    firstType?: number;
    /** UTF-8 normalized item names (probe.cpp caps at 8). */
    names: string[];
  };
};

/**
 * Collector-computed completeness — the promotion-relevant summary.
 * Every flag is DERIVED from observed lines; none is itself evidence.
 */
export type ProbeCompleteness = {
  /**
   * Every `op ` record in the segment parsed cleanly: no `op __overflow`
   * marker, no malformed lines, `err=` always numeric.
   */
  recordsWellFormed: boolean;
  /** Segment boundaries observed (see `execution.bounded`). */
  bounded: boolean;
  /**
   * Sorted unique `call` ids that have ≥1 record with `err === 0` in
   * this execution — the per-operation real-host evidence set.
   */
  operationsEvidenced: string[];
  /**
   * Sorted unique `call` ids observed with `err !== 0` only (called but
   * never succeeded in this execution).
   */
  operationsFailed: string[];
};

/** Which provenance class each populated section belongs to. */
export type ProbeProvenance = {
  /** Values parsed verbatim from debug-log lines. */
  observed: string[];
  /** Values computed by the collector from observed lines. */
  derived: string[];
  /** Values supplied from build manifest / session context (not in the log). */
  supplied: string[];
};

export type ProbeResult = {
  schema: typeof PROBE_RESULT_SCHEMA;
  provenance: ProbeProvenance;
  /** SUPPLIED — not emitted by the debug log; source: build manifest. */
  plugin: {
    name: string;
    entryPoint: string;
    sdkRelease: { identifier: string; distribution: string };
  };
  /** OBSERVED — `driver.*` / `host.*` lines (err==0 getters only). */
  environment: {
    driverPluginInitVersion?: string;
    driverImplementationVersion?: string;
    suppressInteractiveUI?: boolean;
    hostIsActivated?: boolean;
  };
  execution: ProbeExecution;
  /** OBSERVED — `op ` records attributed to this execution, in log order. */
  calls: ProbeCallRecord[];
  /** OBSERVED — verbatim diagnostic lines (`probe.error:`, `probe.aborted:`, `AEGP_* err=`). */
  diagnostics?: string[];
  /** OBSERVED — `app.numProjects` + `project[i].*` lines. */
  projects: ProbeProject[];
  /** DERIVED — see contract doc for per-kind rules. */
  outcome: "completed" | "failed" | "partial";
  /** DERIVED — first observed failure in log order. */
  firstError?: { call?: string; errorCode?: number; detail?: string };
  completeness: ProbeCompleteness;
  /** SUPPLIED — session context; `debugLogRef` locates the raw excerpt. */
  evidence: {
    aeVersion?: string;
    os?: string;
    arch?: string;
    debugLogRef?: string;
    sessionRef?: string;
  };
};

/**
 * Provenance vocabulary — the ONLY field paths each class may claim.
 * The doc's emission-surface table is the normative mapping; this list
 * is its machine-readable form. `validateProbeResult` rejects any
 * provenance entry outside these sets and any section claimed by more
 * than one class.
 */
export const PROVENANCE_OBSERVED = [
  "environment",
  "execution.kind",
  "execution.reason",
  "calls",
  "diagnostics",
  "projects",
] as const;
export const PROVENANCE_DERIVED = [
  "execution.ordinal",
  "execution.bounded",
  "outcome",
  "firstError",
  "completeness",
] as const;
export const PROVENANCE_SUPPLIED = [
  "plugin",
  "evidence",
] as const;

const OBSERVED_SET = new Set<string>(PROVENANCE_OBSERVED);
const DERIVED_SET = new Set<string>(PROVENANCE_DERIVED);
const SUPPLIED_SET = new Set<string>(PROVENANCE_SUPPLIED);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

/**
 * Validate an untrusted value as a `ProbeResult`. Returns the list of
 * problems; an empty list means structurally valid. This validates
 * SHAPE and provenance bookkeeping only — it does not verify truth,
 * real-host observation, or that `completeness` flags were computed
 * correctly.
 */
export function validateProbeResult(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["result is not an object"];
  if (value.schema !== PROBE_RESULT_SCHEMA) {
    errors.push(`schema ${JSON.stringify(value.schema)} is not ${PROBE_RESULT_SCHEMA}`);
  }

  // provenance: required, disjoint, vocabulary-bound.
  if (!isRecord(value.provenance) ||
      !isStringArray(value.provenance.observed) ||
      !isStringArray(value.provenance.derived) ||
      !isStringArray(value.provenance.supplied)) {
    errors.push("provenance.observed/derived/supplied must be string arrays");
  } else {
    const all: string[] = [
      ...value.provenance.observed,
      ...value.provenance.derived,
      ...value.provenance.supplied,
    ];
    if (new Set(all).size !== all.length) {
      errors.push("provenance classes must be disjoint (duplicate field path)");
    }
    for (const p of value.provenance.observed) {
      if (!OBSERVED_SET.has(p)) errors.push(`provenance.observed has unknown path ${JSON.stringify(p)}`);
    }
    for (const p of value.provenance.derived) {
      if (!DERIVED_SET.has(p)) errors.push(`provenance.derived has unknown path ${JSON.stringify(p)}`);
    }
    for (const p of value.provenance.supplied) {
      if (!SUPPLIED_SET.has(p)) errors.push(`provenance.supplied has unknown path ${JSON.stringify(p)}`);
    }
    // Populated sections must be declared: an observed `calls` array
    // with "calls" missing from provenance.observed is exactly the
    // observed/inferred confusion this contract exists to prevent.
    const declared = new Set(all);
    const populated: Array<[string, boolean]> = [
      ["environment", isRecord(value.environment) && Object.keys(value.environment).length > 0],
      ["execution.kind", isRecord(value.execution)],
      ["execution.reason", isRecord(value.execution) && value.execution.reason !== undefined],
      ["calls", Array.isArray(value.calls) && value.calls.length > 0],
      ["diagnostics", Array.isArray(value.diagnostics) && value.diagnostics.length > 0],
      ["projects", Array.isArray(value.projects) && value.projects.length > 0],
      ["execution.ordinal", isRecord(value.execution)],
      ["execution.bounded", isRecord(value.execution)],
      ["outcome", typeof value.outcome === "string"],
      ["firstError", value.firstError !== undefined],
      ["completeness", isRecord(value.completeness)],
      ["plugin", isRecord(value.plugin)],
      ["evidence", isRecord(value.evidence)],
    ];
    for (const [path, present] of populated) {
      if (present && !declared.has(path)) {
        errors.push(`populated section ${JSON.stringify(path)} is not declared in provenance`);
      }
    }
  }

  if (!isRecord(value.plugin) || !isNonEmptyString(value.plugin.name) ||
      !isNonEmptyString(value.plugin.entryPoint) ||
      !isRecord(value.plugin.sdkRelease) ||
      !isNonEmptyString(value.plugin.sdkRelease.identifier) ||
      !isNonEmptyString(value.plugin.sdkRelease.distribution)) {
    errors.push("plugin identity/sdkRelease is missing or malformed");
  }
  if (!isRecord(value.environment)) {
    errors.push("environment is missing or not an object");
  } else {
    const env = value.environment;
    if (env.driverPluginInitVersion !== undefined && !isString(env.driverPluginInitVersion)) {
      errors.push("environment.driverPluginInitVersion must be a string");
    }
    if (env.driverImplementationVersion !== undefined && !isString(env.driverImplementationVersion)) {
      errors.push("environment.driverImplementationVersion must be a string");
    }
    if (env.suppressInteractiveUI !== undefined && typeof env.suppressInteractiveUI !== "boolean") {
      errors.push("environment.suppressInteractiveUI must be a boolean");
    }
    if (env.hostIsActivated !== undefined && typeof env.hostIsActivated !== "boolean") {
      errors.push("environment.hostIsActivated must be a boolean");
    }
  }

  if (!isRecord(value.execution) ||
      typeof value.execution.ordinal !== "number" || value.execution.ordinal < 1 ||
      (value.execution.kind !== "registration" &&
       value.execution.kind !== "probe-run" &&
       value.execution.kind !== "tick") ||
      typeof value.execution.bounded !== "boolean") {
    errors.push("execution {ordinal>=1, kind, bounded} is missing or malformed");
  } else if (value.execution.reason !== undefined &&
             (value.execution.kind !== "probe-run" ||
              (value.execution.reason !== "initial" &&
               value.execution.reason !== "identity-change" &&
               value.execution.reason !== "recovery"))) {
    errors.push("execution.reason is only valid on probe-run with a known value");
  }

  if (!Array.isArray(value.calls)) {
    errors.push("calls is not an array");
  } else {
    for (const [i, c] of value.calls.entries()) {
      if (!isRecord(c) || !isNonEmptyString(c.call) || !isNonEmptyString(c.suite) ||
          typeof c.err !== "number" ||
          (c.status !== "ok" && c.status !== "error")) {
        errors.push(`calls[${i}] is malformed (call/suite/err/status required)`);
        continue;
      }
      if (c.status !== (c.err === 0 ? "ok" : "error")) {
        errors.push(`calls[${i}] status contradicts err (${c.status} vs err=${c.err})`);
      }
      if (c.fields !== undefined &&
          (!isRecord(c.fields) || !Object.values(c.fields).every(isString))) {
        errors.push(`calls[${i}].fields must be a string-valued record`);
      }
    }
  }

  if (value.diagnostics !== undefined && !isStringArray(value.diagnostics)) {
    errors.push("diagnostics must be a string array when present");
  }

  if (!Array.isArray(value.projects)) {
    errors.push("projects is not an array");
  } else {
    for (const [i, p] of value.projects.entries()) {
      if (!isRecord(p) || typeof p.index !== "number" || !isRecord(p.items) ||
          typeof p.items.count !== "number" || p.items.count < 0 ||
          typeof p.items.capped !== "boolean" ||
          !Array.isArray(p.items.names) ||
          !p.items.names.every(isUtf8StringSafe)) {
        errors.push(`projects[${i}] is malformed (items.count/capped/names required; names must be UTF-8 strings)`);
      } else {
        if (p.path !== undefined && !isString(p.path)) {
          errors.push(`projects[${i}].path must be a string when present`);
        }
        if (p.pathStatus !== undefined && !isString(p.pathStatus)) {
          errors.push(`projects[${i}].pathStatus must be a string when present`);
        }
      }
    }
  }

  if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "partial") {
    errors.push("outcome must be completed | failed | partial");
  }
  if (value.firstError !== undefined &&
      (!isRecord(value.firstError) ||
       (value.firstError.call !== undefined && !isString(value.firstError.call)) ||
       (value.firstError.errorCode !== undefined && typeof value.firstError.errorCode !== "number") ||
       (value.firstError.detail !== undefined && !isString(value.firstError.detail)))) {
    errors.push("firstError must be {call?, errorCode?, detail?} with typed fields");
  }
  if (value.firstError === undefined &&
      (value.outcome === "failed" || value.outcome === "partial")) {
    errors.push(`${value.outcome} outcome requires firstError`);
  }

  if (!isRecord(value.completeness) ||
      typeof value.completeness.recordsWellFormed !== "boolean" ||
      typeof value.completeness.bounded !== "boolean" ||
      !isStringArray(value.completeness.operationsEvidenced) ||
      !isStringArray(value.completeness.operationsFailed)) {
    errors.push("completeness {recordsWellFormed, bounded, operationsEvidenced, operationsFailed} is missing or malformed");
  }

  if (!isRecord(value.evidence)) {
    errors.push("evidence is missing or not an object");
  } else {
    for (const k of ["aeVersion", "os", "arch", "debugLogRef", "sessionRef"] as const) {
      if (value.evidence[k] !== undefined && !isString(value.evidence[k])) {
        errors.push(`evidence.${k} must be a string when present`);
      }
    }
  }

  return errors;
}

function isUtf8StringSafe(v: unknown): v is string {
  return typeof v === "string";
}
