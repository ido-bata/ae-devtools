/**
 * NativeProbe result / diagnostics / evidence contract — Issue #19.
 *
 * Schema `ae-devtools/native-probe-result/v1`: the structured result an
 * adapter would collect from the NativeProbe plug-in
 * (`experiments/native-sdk/minimal-plugin/src/probe.cpp`) after an
 * authorized real-host load. Field names mirror what `probe.cpp`
 * actually emits through `AEGP_WriteToDebugLog` (subsystem `ae-a8n`,
 * event `nativeprobe`): `probe.start`/`probe.end` markers,
 * `driver.*`/`host.*` environment lines, `app.numProjects`,
 * `project[i].*` metadata, `project.rootFolder.name`, and
 * `project.items[*]` enumeration with UTF-16→UTF-8 normalized names.
 *
 * VERIFICATION STATUS: **UNVERIFIED**. This is a contract for a future
 * collector; no real dispatch exists, the debug-log transport from AE
 * to the adapter is undesigned, and nothing here means native dispatch
 * is implemented. `validateProbeResult` checks shape only — it cannot
 * and does not assert that any of these values were ever observed on a
 * real host.
 *
 * Normative description:
 * specs/ae-capability-coverage/contracts/native-probe-result.md
 */

export const PROBE_RESULT_SCHEMA = "ae-devtools/native-probe-result/v1" as const;

/** Outcome of one AEGP call, mirroring probe.cpp's per-call logging. */
export type ProbeCallOutcome = {
  /** Dotted call path, e.g. `"AEGP_ProjSuite6.AEGP_GetNumProjects"`. */
  call: string;
  suite: string;
  status: "ok" | "error" | "skipped";
  /** Raw `A_Err` numeric code when status is `error`. */
  errorCode?: number;
  /** Optional scalar result (counts, booleans, enum ints). */
  value?: number | boolean | string;
};

/** Status of acquiring one suite through `SPBasicSuite::AcquireSuite`. */
export type SuiteAcquisition = {
  suite: string;
  /** Registration string, e.g. `"AEGP Proj Suite"`. */
  registration: string;
  versionRequested: number;
  status: "acquired" | "failed";
  /** `A_Err`-style code or 0 when acquired. */
  errorCode?: number;
};

export type ProbeProject = {
  index: number;
  name?: string;
  isDirty?: boolean;
  bitDepth?: number;
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

export type ProbeResult = {
  schema: typeof PROBE_RESULT_SCHEMA;
  /** Identity of the plug-in that produced the result. */
  plugin: {
    name: string;
    entryPoint: string;
    sdkRelease: { identifier: string; distribution: string };
  };
  /** Host environment lines probe.cpp queries (all optional getters). */
  environment: {
    driverPluginInitVersion?: string;
    driverImplementationVersion?: string;
    suppressInteractiveUI?: boolean;
    hostIsActivated?: boolean;
  };
  /** Per-suite acquisition results, in acquisition order. */
  suiteAcquisition: SuiteAcquisition[];
  /** Per-call outcomes for every AEGP/SPBasicSuite call made. */
  calls: ProbeCallOutcome[];
  /** `probe.start`/`probe.end` debug-log markers were both observed. */
  markers: { probeStart: boolean; probeEnd: boolean };
  projects: ProbeProject[];
  /** Aggregate outcome across the probe run. */
  outcome: "completed" | "failed" | "partial";
  /** First error encountered, when outcome is not `completed`. */
  firstError?: { call: string; errorCode: number };
  /** Evidence pointers (debug-log excerpt path, AE version, OS, arch). */
  evidence: {
    aeVersion?: string;
    os?: string;
    arch?: string;
    debugLogRef?: string;
  };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isUtf8String(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Validate an untrusted value as a `ProbeResult`. Returns the list of
 * problems; an empty list means structurally valid. This validates
 * SHAPE ONLY — it does not verify truth, provenance, or real-host
 * observation.
 */
export function validateProbeResult(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["result is not an object"];
  if (value.schema !== PROBE_RESULT_SCHEMA) {
    errors.push(`schema ${JSON.stringify(value.schema)} is not ${PROBE_RESULT_SCHEMA}`);
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
  }
  if (!Array.isArray(value.suiteAcquisition)) {
    errors.push("suiteAcquisition is not an array");
  } else {
    for (const [i, s] of value.suiteAcquisition.entries()) {
      if (!isRecord(s) || !isNonEmptyString(s.suite) ||
          !isNonEmptyString(s.registration) ||
          typeof s.versionRequested !== "number" ||
          (s.status !== "acquired" && s.status !== "failed")) {
        errors.push(`suiteAcquisition[${i}] is malformed`);
      }
    }
  }
  if (!Array.isArray(value.calls)) {
    errors.push("calls is not an array");
  } else {
    for (const [i, c] of value.calls.entries()) {
      if (!isRecord(c) || !isNonEmptyString(c.call) || !isNonEmptyString(c.suite) ||
          (c.status !== "ok" && c.status !== "error" && c.status !== "skipped")) {
        errors.push(`calls[${i}] is malformed`);
        continue;
      }
      if (c.status === "error" && typeof c.errorCode !== "number") {
        errors.push(`calls[${i}] is error but has no numeric errorCode`);
      }
    }
  }
  if (!isRecord(value.markers) ||
      typeof value.markers.probeStart !== "boolean" ||
      typeof value.markers.probeEnd !== "boolean") {
    errors.push("markers.probeStart/probeEnd must both be booleans");
  } else if (value.markers.probeEnd && !value.markers.probeStart) {
    errors.push("probeEnd observed without probeStart — impossible ordering");
  }
  if (!Array.isArray(value.projects)) {
    errors.push("projects is not an array");
  } else {
    for (const [i, p] of value.projects.entries()) {
      if (!isRecord(p) || typeof p.index !== "number" || !isRecord(p.items) ||
          typeof p.items.count !== "number" || p.items.count < 0 ||
          typeof p.items.capped !== "boolean" ||
          !Array.isArray(p.items.names) ||
          !p.items.names.every(isUtf8String)) {
        errors.push(`projects[${i}] is malformed (items.count/capped/names required; names must be UTF-8 strings)`);
      }
    }
  }
  if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "partial") {
    errors.push("outcome must be completed | failed | partial");
  }
  if (value.outcome !== "completed" && value.firstError === undefined) {
    errors.push("non-completed outcome requires firstError");
  }
  if (value.firstError !== undefined &&
      (!isRecord(value.firstError) || !isNonEmptyString(value.firstError.call) ||
       typeof value.firstError.errorCode !== "number")) {
    errors.push("firstError must be {call: string, errorCode: number}");
  }
  if (value.evidence !== undefined && !isRecord(value.evidence)) {
    errors.push("evidence must be an object when present");
  }
  return errors;
}
