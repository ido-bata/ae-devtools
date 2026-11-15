/**
 * NativeProbe result contract — shape validation only.
 *
 * Proves `validateProbeResult` accepts a well-formed result mirroring
 * what probe.cpp emits and rejects malformed input. This is contract
 * level: nothing here asserts the values were observed on a real host.
 */

import { describe, expect, test } from "bun:test";
import {
  PROBE_RESULT_SCHEMA,
  validateProbeResult,
  type ProbeResult,
} from "../src/probe-result.ts";

function validResult(): ProbeResult {
  return {
    schema: PROBE_RESULT_SCHEMA,
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
    suiteAcquisition: [
      { suite: "AEGP_UtilitySuite6", registration: "AEGP Utility Suite", versionRequested: 13, status: "acquired" },
      { suite: "AEGP_ProjSuite6", registration: "AEGP Proj Suite", versionRequested: 9, status: "acquired" },
      { suite: "AEGP_ItemSuite9", registration: "AEGP Item Suite", versionRequested: 14, status: "acquired" },
      { suite: "AEGPMemorySuite1", registration: "AEGP Memory Suite", versionRequested: 1, status: "acquired" },
    ],
    calls: [
      { call: "AEGP_ProjSuite6.AEGP_GetNumProjects", suite: "AEGP_ProjSuite6", status: "ok", value: 1 },
      { call: "AEGP_ItemSuite9.AEGP_GetItemName", suite: "AEGP_ItemSuite9", status: "ok", value: "Comp 1" },
      { call: "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", suite: "AEGP_ProjSuite6", status: "error", errorCode: -1 },
    ],
    markers: { probeStart: true, probeEnd: true },
    projects: [
      {
        index: 0,
        name: "probe.aep",
        isDirty: false,
        bitDepth: 8,
        rootFolderName: "Root",
        items: { count: 3, capped: false, firstType: 1, names: ["Comp 1", "日本語レイヤー", "Solid 1"] },
      },
    ],
    outcome: "partial",
    firstError: { call: "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", errorCode: -1 },
    evidence: { aeVersion: "26.5.3", os: "macOS", arch: "arm64", debugLogRef: "probe-run-001.log" },
  };
}

describe("validateProbeResult", () => {
  test("accepts a well-formed result", () => {
    expect(validateProbeResult(validResult())).toEqual([]);
  });

  test("rejects wrong schema", () => {
    const bad = { ...validResult(), schema: "other/v9" };
    expect(validateProbeResult(bad).join(" ")).toContain("schema");
  });

  test("rejects non-object", () => {
    expect(validateProbeResult("nope")).toEqual(["result is not an object"]);
    expect(validateProbeResult(null)).toEqual(["result is not an object"]);
  });

  test("rejects probeEnd without probeStart (impossible ordering)", () => {
    const bad = validResult();
    bad.markers = { probeStart: false, probeEnd: true };
    expect(validateProbeResult(bad).join(" ")).toContain("impossible ordering");
  });

  test("rejects error call without numeric errorCode", () => {
    const bad = validResult();
    bad.calls[2] = { call: "x.y", suite: "x", status: "error" };
    expect(validateProbeResult(bad).join(" ")).toContain("errorCode");
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

  test("rejects non-completed outcome without firstError", () => {
    const bad = validResult();
    delete bad.firstError;
    expect(validateProbeResult(bad).join(" ")).toContain("firstError");
  });

  test("accepts UTF-8 normalized names incl. non-ASCII", () => {
    const r = validResult();
    expect(validateProbeResult(r)).toEqual([]);
    expect(r.projects[0]!.items.names).toContain("日本語レイヤー");
  });
});
