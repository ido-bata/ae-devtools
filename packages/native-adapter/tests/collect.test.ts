import { describe, expect, test } from "bun:test";
import { collectProbeResults, type CollectSupplied } from "../src/collect.ts";
import { validateProbeResult, type ProbeResult } from "../src/probe-result.ts";

const SUPPLIED: CollectSupplied = {
  plugin: {
    name: "ae-a8n-nativeprobe",
    entryPoint: "AEProbePluginEntry",
    sdkRelease: { identifier: "26.5", distribution: "macOS" },
  },
  evidence: { debugLogRef: "fixture://run-1", sessionRef: "sess-1" },
};

const REGISTRATION = [
  'op SPBasicSuite.AcquireSuite err=0 suite="SP Basic Suite" version=4',
  'op SPBasicSuite.AcquireSuite err=0 suite="SP Basic Suite" version=5',
  'op AEGP_UtilitySuite6.AEGP_RegisterWithAEGP err=0 value=42',
  'op AEGP_RegisterSuite5.AEGP_RegisterIdleHook err=0 value=7',
  'op SPBasicSuite.ReleaseSuite err=0 suite="SP Basic Suite" version=5',
].join("\n");

const PROBE_RUN = [
  "probe.start",
  "probe.reason=initial",
  "op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Utility Suite\" version=6",
  "op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Proj Suite\" version=6",
  "op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Memory Suite\" version=1",
  "op AEGP_ProjSuite6.AEGP_GetNumProjects err=0 value=1",
  "op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Item Suite\" version=9",
  "op AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion err=0 v=13.8",
  "driver.pluginInitVersion=13.8",
  "op AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion err=0 v=26.5",
  "driver.implementationVersion=26.5",
  "op AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI err=0 value=0",
  "host.suppressInteractiveUI=0",
  "op AEGP_UtilitySuite6.AEGP_HostIsActivated err=0 value=1",
  "host.isActivated=1",
  "op AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState err=0 value",
  "renderQueue.state=1",
  "op AEGP_RQItemSuite4.AEGP_GetNumRQItems err=0",
  "renderQueue.numItems=1",
  "op AEGP_RQItemSuite4.AEGP_GetRQItemByIndex err=0 i=0",
  "op AEGP_RQItemSuite4.AEGP_GetRenderState err=0 i=0",
  "rq[0].renderState=1",
  "op AEGP_RQItemSuite4.AEGP_GetStartedTime err=0 i=0",
  "rq[0].started=100/30",
  "op AEGP_RQItemSuite4.AEGP_GetElapsedTime err=0 i=0",
  "rq[0].elapsed=50/30",
  "op AEGP_RQItemSuite4.AEGP_GetLogType err=0 i=0",
  "rq[0].logType=0",
  "op AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem err=0 i=0",
  "rq[0].numOutputModules=2",
  "op AEGP_RQItemSuite4.AEGP_GetComment err=0 i=0",
  "rq[0].comment: final cut",
  "op AEGP_RQItemSuite4.AEGP_GetCompFromRQItem err=0 i=0 hasComp=1",
  "op AEGP_ProjSuite6.AEGP_GetProjectByIndex err=0 i=0",
  "op AEGP_ProjSuite6.AEGP_GetProjectName err=0",
  "project[0].name=demo",
  "op AEGP_ProjSuite6.AEGP_ProjectIsDirty err=0 value=0",
  "project[0].isDirty=0",
  "op AEGP_ProjSuite6.AEGP_GetProjectBitDepth err=0 value=16",
  "project[0].bitDepth=16",
  "op AEGP_ProjSuite6.AEGP_GetProjectPath err=0",
  "project[0].path: /tmp/demo.aep",
  "op AEGP_ProjSuite6.AEGP_GetProjectRootFolder err=0",
  "op AEGP_ItemSuite9.AEGP_GetItemName err=0",
  "project.rootFolder.name: Root",
  "op AEGP_ItemSuite9.AEGP_GetFirstProjItem err=0",
  "op AEGP_ItemSuite9.AEGP_GetItemType err=0 value=1",
  "project.items.firstType=1",
  "op AEGP_ItemSuite9.AEGP_GetItemName err=0",
  "project.items[0].name: comp1",
  "op AEGP_ItemSuite9.AEGP_GetNextProjItem err=0",
  "op AEGP_ItemSuite9.AEGP_GetNextProjItem err=0",
  "project.items.count=2",
  "app.numProjects=1",
  "probe.end",
  "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP RQ Item Suite\" version=4",
  "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Render Queue Suite\" version=1",
  "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Item Suite\" version=9",
  "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Memory Suite\" version=1",
  "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Proj Suite\" version=6",
  "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Utility Suite\" version=6",
].join("\n");

const TICK = ["probe.error: AEGP_GetNumProjects failed"].join("\n");

function expectValid(r: ProbeResult) {
  expect(validateProbeResult(r)).toEqual([]);
}

function at<T>(arr: readonly T[], i = 0): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing element at index ${i}`);
  return v;
}

describe("collectProbeResults", () => {
  test("empty log yields no executions", () => {
    expect(collectProbeResults("", SUPPLIED)).toEqual([]);
    expect(collectProbeResults("  \n\n", SUPPLIED)).toEqual([]);
  });

  test("registration + probe-run + tick segment in order", () => {
    const log = `${REGISTRATION}\n${PROBE_RUN}\n${TICK}\n`;
    const results = collectProbeResults(log, SUPPLIED);
    expect(results.map((r) => r.execution.kind)).toEqual(["registration", "probe-run", "tick"]);
    expect(results.map((r) => r.execution.ordinal)).toEqual([1, 2, 3]);
    for (const r of results) expectValid(r);

    const reg = at(results, 0);
    const run = at(results, 1);
    const tick = at(results, 2);
    expect(reg.outcome).toBe("completed");
    expect(reg.execution.bounded).toBe(true);
    expect(reg.calls).toHaveLength(5);

    expect(run.execution.reason).toBe("initial");
    expect(run.outcome).toBe("completed");
    expect(run.completeness.bounded).toBe(true);
    expect(run.completeness.recordsWellFormed).toBe(true);
    // trailing releases after probe.end belong to the run
    expect(run.calls.filter((c) => c.call === "SPBasicSuite.ReleaseSuite")).toHaveLength(6);
    expect(run.environment).toEqual({
      driverPluginInitVersion: "13.8",
      driverImplementationVersion: "26.5",
      suppressInteractiveUI: false,
      hostIsActivated: true,
    });
    expect(run.projectCount).toBe(1);
    expect(run.projects).toHaveLength(1);
    const p = run.projects[0]!;
    expect(p.name).toBe("demo");
    expect(p.path).toBe("/tmp/demo.aep");
    expect(p.isDirty).toBe(false);
    expect(p.bitDepth).toBe(16);
    expect(p.rootFolderName).toBe("Root");
    expect(p.items.count).toBe(2);
    expect(p.items.firstType).toBe(1);
    expect(p.items.names).toEqual(["comp1"]);
    expect(run.renderQueue?.state).toBe(1);
    expect(run.renderQueue?.numItems).toBe(1);
    const rq = run.renderQueue!.items[0]!;
    expect(rq.renderState).toBe(1);
    expect(rq.started).toEqual({ value: 100, scale: 30 });
    expect(rq.elapsed).toEqual({ value: 50, scale: 30 });
    expect(rq.logType).toBe(0);
    expect(rq.numOutputModules).toBe(2);
    expect(rq.comment).toBe("final cut");

    expect(tick.outcome).toBe("failed");
    expect(tick.execution.bounded).toBe(true);
    expect(tick.diagnostics).toEqual(["probe.error: AEGP_GetNumProjects failed"]);
    expect(tick.firstError?.detail).toBe("probe.error: AEGP_GetNumProjects failed");
  });

  test("op fields parse quoted suite names and k=v extras", () => {
    const log = 'op SPBasicSuite.AcquireSuite err=0 suite="AEGP Proj Suite" version=6\n';
    const reg = at(collectProbeResults(log, SUPPLIED));
    expect(reg.calls[0]!.fields).toEqual({ suite: "AEGP Proj Suite", version: "6" });
    expectValid(reg);
  });

  test("op __overflow marks recordsWellFormed=false and is kept verbatim", () => {
    const log = `probe.start\nprobe.reason=recovery\nop __overflow err=-1\nprobe.end\n`;
    const run = at(collectProbeResults(log, SUPPLIED));
    expect(run.completeness.recordsWellFormed).toBe(false);
    expect(run.diagnostics).toContain("op __overflow err=-1");
    expect(run.calls).toHaveLength(0);
    expectValid(run);
  });

  test("partial run: probe.start without probe.end", () => {
    const log = "probe.start\nprobe.reason=identity-change\nop AEGP_ProjSuite6.AEGP_GetNumProjects err=0 value=2\n";
    const run = at(collectProbeResults(log, SUPPLIED));
    expect(run.outcome).toBe("partial");
    expect(run.completeness.bounded).toBe(false);
    expect(run.firstError?.detail).toBe("probe.start observed without probe.end");
    expectValid(run);
  });

  test("registration with only failures is outcome=failed with firstError", () => {
    const log = 'op SPBasicSuite.AcquireSuite err=1 suite="X" version=1\n';
    const reg = at(collectProbeResults(log, SUPPLIED));
    expect(reg.outcome).toBe("failed");
    expect(reg.firstError).toEqual({ call: "SPBasicSuite.AcquireSuite", errorCode: 1 });
    expect(reg.completeness.operationsFailed).toEqual(["SPBasicSuite.AcquireSuite"]);
    expectValid(reg);
  });

  test("path and comment status tokens normalize; values stay absent", () => {
    const log = [
      "probe.start",
      "probe.reason=initial",
      "app.numProjects=1",
      "project[0].name=p1",
      "project[0].path: <null handle>",
      "project.rootFolder.name: lock failed",
      "project.items.count=0",
      "renderQueue.numItems=1",
      "rq[0]: get failed",
      "rq[0].comment: memory suite entries missing",
      "probe.end",
    ].join("\n");
    const run = at(collectProbeResults(log, SUPPLIED));
    const p = run.projects[0]!;
    expect(p.path).toBeUndefined();
    expect(p.pathStatus).toBe("null-handle");
    expect(p.rootFolderName).toBeUndefined();
    const it = run.renderQueue!.items[0]!;
    expect(it.getFailed).toBe(true);
    expect(it.comment).toBeUndefined();
    expect(it.commentStatus).toBe("entries-missing");
    expectValid(run);
  });

  test("multiple probe-runs and interleaved ticks keep ordinals and attribution", () => {
    const log = [
      REGISTRATION,
      "probe.start",
      "probe.reason=initial",
      "probe.end",
      "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Utility Suite\" version=6",
      "probe.error: project fingerprint failed",
      "probe.start",
      "probe.reason=recovery",
      "probe.end",
      "op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Utility Suite\" version=6",
    ].join("\n");
    const results = collectProbeResults(log, SUPPLIED);
    expect(results.map((r) => r.execution.kind)).toEqual([
      "registration",
      "probe-run",
      "tick",
      "probe-run",
    ]);
    expect(results[1]!.calls.some((c) => c.call === "SPBasicSuite.ReleaseSuite")).toBe(true);
    expect(results[3]!.calls.some((c) => c.call === "SPBasicSuite.ReleaseSuite")).toBe(true);
    expect(results[2]!.outcome).toBe("failed");
    for (const r of results) expectValid(r);
  });

  test("unrecognized lines are preserved verbatim in diagnostics", () => {
    const log = "probe.start\nprobe.reason=initial\nsome.future.line=1\nprobe.end\n";
    const run = at(collectProbeResults(log, SUPPLIED));
    expect(run.diagnostics).toContain("some.future.line=1");
    expectValid(run);
  });

  test("supplied plugin/evidence propagate; provenance declares populated sections", () => {
    const reg = at(collectProbeResults(REGISTRATION, SUPPLIED));
    expect(reg.plugin.name).toBe("ae-a8n-nativeprobe");
    expect(reg.evidence.debugLogRef).toBe("fixture://run-1");
    expect(reg.provenance.supplied).toEqual(["plugin", "evidence"]);
    expect(reg.provenance.observed).toContain("calls");
    expect(reg.provenance.observed).not.toContain("projects");
    expectValid(reg);
  });
});
