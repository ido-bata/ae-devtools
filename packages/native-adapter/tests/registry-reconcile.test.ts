/**
 * Registry ↔ NativeProbe reconciliation — Issue #19 audit fix.
 *
 * `src/operations.ts` claims every IMPLEMENTED entry is a call
 * `probe.cpp` actually makes. This test makes that claim mechanical
 * instead of editorial: it parses
 * `experiments/native-sdk/minimal-plugin/src/probe.cpp`, extracts
 * every `<receiver>-><member>(` call whose receiver is a known suite
 * pointer, and asserts:
 *
 *   - every probe.cpp suite call has a registry entry (missing call →
 *     test failure; e.g. AEGP_GetMemHandleSize / AEGP_RegisterIdleHook
 *     were missing before this test existed);
 *   - every registry entry with `implemented: true` is a call probe.cpp
 *     makes (registered-but-uncalled → test failure);
 *   - `implemented: false` (inventory-only) entries are NOT required to
 *     be probe calls — CAP047 cluster Issues (#63–#69) register suite
 *     surface ahead of implementation. They must still cite
 *     suite.member + header, which `assertRegistryInvariants` checks.
 *
 * Scope notes:
 * - probe.cpp AND native_intake.cpp are scanned (Issue #327: the
 *   intake path is a second implementation site). fake_host.*
 *   implements suite entries the probe does NOT call (e.g.
 *   AEGP_NewMemHandle, SPBasicSuite IsEqual) — those are host-side
 *   fixtures, not probe calls, and must NOT appear in the registry.
 * - Member accesses without a call (`if (utilP->AEGP_X)`) are not
 *   matched: the regex requires `(` after the member name.
 * - The receiver→suite map below mirrors probe.cpp's variable names;
 *   a renamed receiver fails loudly as an unmapped suite pointer.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DISPATCH_ENTRIES } from "../src/operations.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_CPP = join(
  HERE,
  "../../../experiments/native-sdk/minimal-plugin/src/probe.cpp",
);
/* Issue #327: the intake path is a second implementation site — the
   consent-gated mutating op (and every intake getter) makes real
   suite calls there. Issue #328 split native_intake.cpp into
   responsibility modules; ALL of them are scanned so registry
   `implemented` claims reconcile against the UNION of probe.cpp and
   every intake module's call sites. */
const INTAKE_SOURCES = [
  "native_intake.cpp",
  "native_support.cpp",
  "native_state.cpp",
  "native_suites.cpp",
  "native_request.cpp",
  "native_registry.cpp",
  "native_identity.cpp",
  "native_ops.cpp",
].map((f) =>
  join(HERE, `../../../experiments/native-sdk/minimal-plugin/src/${f}`),
);

/** probe.cpp local variable → SDK suite struct name (registry `suite`). */
const RECEIVER_TO_SUITE: Record<string, string> = {
  pica_basicP: "SPBasicSuite",
  s_basicP: "SPBasicSuite",
  basicP: "SPBasicSuite",
  utilP: "AEGP_UtilitySuite6",
  projP: "AEGP_ProjSuite6",
  itemP: "AEGP_ItemSuite9",
  memP: "AEGP_MemorySuite1",
  regP: "AEGP_RegisterSuite5",
  rqP: "AEGP_RenderQueueSuite1",
  rqItemP: "AEGP_RQItemSuite4",
  itemViewP: "AEGP_ItemViewSuite2",
  compP: "AEGP_CompSuite13",
  layerP: "AEGP_LayerSuite9",
};

/** Members that count as suite calls for reconciliation. */
const CALL_RE = /([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)\s*\(/g;
/**
 * The ACTUAL emitted grammar is the `OpRecordV(utilP, "<id>", ...)`
 * string literal, not the `->` call site. Extract those literals too
 * and require they are either registry ids or the `__overflow`
 * sentinel — a typo'd literal would otherwise pass reconciliation
 * while emitting an op record the registry cannot name.
 */
const OP_RECORD_RE = /OpRecordV\s*\([^,]+,\s*"([^"]+)"/g;

/** native_intake.cpp local variable → SDK suite struct name. Differs
    from probe.cpp: `rqP` there is AEGP_RQItemSuite4 (the RenderQueue
    suite pointer was renamed rqQueueP to keep the map unambiguous). */
const INTAKE_RECEIVER_TO_SUITE: Record<string, string> = {
  ...RECEIVER_TO_SUITE,
  rqP: "AEGP_RQItemSuite4",
  rqQueueP: "AEGP_RenderQueueSuite1",
};

function suiteCallIds(srcPath: string, map: Record<string, string>): Set<string> {
  const src = readFileSync(srcPath, "utf8");
  const ids = new Set<string>();
  const unmapped = new Set<string>();
  for (const m of src.matchAll(CALL_RE)) {
    const receiver = m[1]!;
    const member = m[2]!;
    const suite = map[receiver];
    if (suite === undefined) {
      unmapped.add(`${receiver}->${member}`);
      continue;
    }
    ids.add(`${suite}.${member}`);
  }
  if (unmapped.size > 0) {
    throw new Error(
      `${srcPath}: calls through unmapped receivers: ${[...unmapped].sort().join(", ")}`,
    );
  }
  return ids;
}

function probeCallIds(): Set<string> {
  const ids = suiteCallIds(PROBE_CPP, RECEIVER_TO_SUITE);
  for (const src of INTAKE_SOURCES) {
    for (const id of suiteCallIds(src, INTAKE_RECEIVER_TO_SUITE)) {
      ids.add(id);
    }
  }
  return ids;
}

describe("operations registry ↔ probe.cpp reconciliation", () => {
  const callIds = probeCallIds();
  const registryIds = new Set(DISPATCH_ENTRIES.map((e) => e.id));

  test("every suite call in probe.cpp has a registry entry", () => {
    const missing = [...callIds].filter((id) => !registryIds.has(id)).sort();
    expect(missing).toEqual([]);
  });

  test("every IMPLEMENTED registry entry is a call probe.cpp actually makes", () => {
    const phantom = [...registryIds]
      .filter((id) => !callIds.has(id))
      .filter((id) => DISPATCH_ENTRIES.find((e) => e.id === id)?.implemented === true)
      .sort();
    expect(phantom).toEqual([]);
  });

  test("inventory-only entries are never marked implemented", () => {
    for (const entry of DISPATCH_ENTRIES) {
      if (!callIds.has(entry.id)) {
        expect(entry.implemented).toBe(false);
      }
    }
  });

  test("every OpRecordV literal is a registry id or the overflow sentinel", () => {
    const src = readFileSync(PROBE_CPP, "utf8");
    const literals = new Set<string>();
    for (const m of src.matchAll(OP_RECORD_RE)) literals.add(m[1]!);
    expect(literals.size).toBeGreaterThan(0);
    for (const id of literals) {
      if (id === "__overflow") continue;
      expect(registryIds.has(id), `OpRecordV literal ${id} is not a registry id`).toBe(true);
    }
  });


  test("known-tricky members are present (regression pins)", () => {
    // These were missing/false in the pre-audit registry.
    for (const id of [
      "AEGP_MemorySuite1.AEGP_GetMemHandleSize",
      "AEGP_RegisterSuite5.AEGP_RegisterIdleHook",
      "AEGP_ProjSuite6.AEGP_GetProjectPath",
    ]) {
      expect({ id, registered: registryIds.has(id), called: callIds.has(id) })
        .toEqual({ id, registered: true, called: true });
    }
    // Members probe.cpp never calls may be registered inventory-only
    // (CAP047 clusters) but must NEVER be marked implemented.
    for (const id of [
      "AEGP_MemorySuite1.AEGP_NewMemHandle",
      "SPBasicSuite.IsEqual",
    ]) {
      const entry = DISPATCH_ENTRIES.find((e) => e.id === id);
      expect(callIds.has(id)).toBe(false);
      if (entry !== undefined) {
        expect(entry.implemented).toBe(false);
      }
    }
  });
});
