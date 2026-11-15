/**
 * NativeProbe result contract — shape + provenance validation.
 *
 * Proves `validateProbeResult` accepts well-formed results mirroring
 * the ACTUAL debug-log grammar probe.cpp emits (op records,
 * probe.start/reason/end, probe.error/probe.aborted diagnostics,
 * driver/host/app/project data lines) and rejects malformed input,
 * status/err contradictions, impossible execution shapes, and
 * provenance entries outside the observed/derived/supplied vocabulary.
 *
 * This is contract level: nothing here asserts the values were
 * observed on a real host.
 */

import { describe, expect, test } from "bun:test";
import {
  PROBE_RESULT_SCHEMA,
  validateProbeResult,
  type ProbeResult,
} from "../src/probe-result.ts";

function validProvenance(): ProbeResult["provenance"] {
  return {
    observed: ["environment", "execution.kind", "execution.reason", "calls", "projects"],
    derived: ["execution.ordinal", "execution.bounded", "outcome", "firstError", "completeness"],
    supplied: ["plugin", "evidence"],
  };
}

function validResult(): ProbeResult {
  return {
    schema: PROBE_RESULT_SCHEMA,
    provenance: validProvenance(),
    plugin: {
      name: "ae-a8n NativeProbe",
      entryPoint: "AEProbePluginEntry",
      sdkRelease: { identifier: "26.5", distribution: "macOS" },
    },
    environment: {
      driverPluginInitVersion: "13.29",
      driverImplementationVersion: "26.5.3",
      suppressInteractiveUI: false,
      hostIsActivated: true,
    },
    execution: { ordinal: 2, kind: "probe-run", reason: "initial", bounded: true },
    calls: [
      {
        call: "SPBasicSuite.AcquireSuite", suite: "SPBasicSuite", err: 0, status: "ok",
        fields: { suite: "AEGP Proj Suite", version: "9" },
      },
      {
        call: "AEGP_ProjSuite6.AEGP_GetNumProjects", suite: "AEGP_ProjSuite6",
        err: 0, status: "ok", fields: { value: "1" },
      },
      {
        call: "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", suite: "AEGP_ProjSuite6",
        err: -1, status: "error",
      },
    ],
    diagnostics: ["AEGP_GetProjectByIndex(0) failed"],
    projects: [
      {
        index: 0,
        name: "probe.aep",
        isDirty: false,
        bitDepth: 8,
        path: "/Users/example/probe.aep",
        rootFolderName: "Root",
        items: { count: 3, capped: false, firstType: 1, names: ["Comp 1", "日本語レイヤー", "Solid 1"] },
      },
    ],
    outcome: "partial",
    firstError: { call: "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", errorCode: -1 },
    completeness: {
      recordsWellFormed: true,
      bounded: true,
      operationsEvidenced: [
        "AEGP_ProjSuite6.AEGP_GetNumProjects",
        "SPBasicSuite.AcquireSuite",
      ],
      operationsFailed: ["AEGP_ProjSuite6.AEGP_GetProjectBitDepth"],
    },
    evidence: {
      aeVersion: "26.5.3",
      os: "macOS",
      arch: "arm64",
      debugLogRef: "probe-run-001.log",
      sessionRef: "ae-session-2026-01-01",
    },
  };
}

describe("validateProbeResult", () => {
  test("accepts a well-formed probe-run result", () => {
    expect(validateProbeResult(validResult())).toEqual([]);
  });

  test("accepts registration and tick executions", () => {
    const reg = validResult();
    reg.execution = { ordinal: 1, kind: "registration", bounded: true };
    delete reg.execution.reason;
    reg.calls = [
      { call: "SPBasicSuite.AcquireSuite", suite: "SPBasicSuite", err: 0, status: "ok",
        fields: { suite: "AEGP Utility Suite", version: "13" } },
      { call: "AEGP_RegisterSuite5.AEGP_RegisterIdleHook", suite: "AEGP_RegisterSuite5",
        err: 0, status: "ok", fields: { value: "7" } },
    ];
    reg.projects = [];
    reg.environment = {};
    reg.outcome = "completed";
    delete reg.firstError;
    delete reg.diagnostics;
    reg.completeness.operationsEvidenced = [
      "AEGP_RegisterSuite5.AEGP_RegisterIdleHook",
      "SPBasicSuite.AcquireSuite",
    ];
    reg.completeness.operationsFailed = [];
    expect(validateProbeResult(reg)).toEqual([]);

    const tick = validResult();
    tick.execution = { ordinal: 3, kind: "tick", bounded: true };
    delete tick.execution.reason;
    tick.calls = [];
    tick.outcome = "failed";
    tick.firstError = { detail: "probe.error: AEGP_GetNumProjects failed" };
    tick.completeness.operationsEvidenced = [];
    tick.completeness.operationsFailed = [];
    expect(validateProbeResult(tick)).toEqual([]);
  });

  test("rejects wrong schema", () => {
    const bad = { ...validResult(), schema: "other/v9" };
    expect(validateProbeResult(bad).join(" ")).toContain("schema");
  });

  test("rejects non-object", () => {
    expect(validateProbeResult("nope")).toEqual(["result is not an object"]);
    expect(validateProbeResult(null)).toEqual(["result is not an object"]);
  });

  test("rejects missing provenance", () => {
    const bad = validResult();
    // @ts-expect-error deliberate malformed input
    delete bad.provenance;
    expect(validateProbeResult(bad).join(" ")).toContain("provenance");
  });

  test("rejects provenance paths outside the vocabulary", () => {
    const bad = validResult();
    bad.provenance.observed.push("plugin.name" as never);
    expect(validateProbeResult(bad).join(" ")).toContain("provenance.observed");
  });

  test("rejects the same field claimed by two provenance classes", () => {
    const bad = validResult();
    bad.provenance.derived.push("calls" as never);
    expect(validateProbeResult(bad).join(" ")).toContain("disjoint");
  });

  test("rejects reason on a non-probe-run execution", () => {
    const bad = validResult();
    bad.execution = { ordinal: 1, kind: "registration", reason: "initial", bounded: true };
    expect(validateProbeResult(bad).join(" ")).toContain("execution.reason");
  });

  test("rejects unknown reason value", () => {
    const bad = validResult();
    // @ts-expect-error deliberate malformed input
    bad.execution.reason = "sometimes";
    expect(validateProbeResult(bad).join(" ")).toContain("execution.reason");
  });

  test("rejects call status contradicting err", () => {
    const bad = validResult();
    bad.calls[2] = { call: "x.y", suite: "x", err: 0, status: "error" };
    expect(validateProbeResult(bad).join(" ")).toContain("contradicts err");
  });

  test("rejects call without numeric err", () => {
    const bad = validResult();
    // @ts-expect-error deliberate malformed input
    bad.calls[0] = { call: "x.y", suite: "x", status: "ok" };
    expect(validateProbeResult(bad).join(" ")).toContain("calls[0]");
  });

  test("rejects non-completed outcome without firstError", () => {
    const bad = validResult();
    delete bad.firstError;
    expect(validateProbeResult(bad).join(" ")).toContain("firstError");
  });

  test("rejects malformed completeness", () => {
    const bad = validResult();
    // @ts-expect-error deliberate malformed input
    bad.completeness.operationsEvidenced = "not-an-array";
    expect(validateProbeResult(bad).join(" ")).toContain("completeness");
  });

  test("rejects negative item count and non-array names", () => {
    const bad = validResult();
    bad.projects[0]!.items.count = -1;
    expect(validateProbeResult(bad).join(" ")).toContain("projects[0]");
    const bad2 = validResult();
    // @ts-expect-error deliberate malformed input
    bad2.projects[0]!.items.names = "not-an-array";
    expect(validateProbeResult(bad2).join(" ")).toContain("projects[0]");
  });

  test("accepts UTF-8 normalized names incl. non-ASCII and project path", () => {
    const r = validResult();
    expect(validateProbeResult(r)).toEqual([]);
    expect(r.projects[0]!.items.names).toContain("日本語レイヤー");
    expect(r.projects[0]!.path).toBe("/Users/example/probe.aep");
  });
});
