/**
 * Per-operation registry invariants — the dispatchability SoT.
 *
 * Proves: ids are unique and well-formed, every entry corresponds to a
 * call NativeProbe actually makes, derived states obey the
 * implemented+verifiedOnRealHost ⇒ dispatchable rule, and the honest
 * count of dispatchable operations today is zero.
 */

import { describe, expect, test } from "bun:test";
import {
  DISPATCH_ENTRIES,
  assertRegistryInvariants,
  dispatchableOperationCount,
  findOperation,
  isDispatchableEntry,
  operationState,
  type OperationEntry,
} from "../src/operations.ts";

describe("DISPATCH_ENTRIES registry", () => {
  test("invariants hold (unique ids, Suite.member shape, no state override)", () => {
    expect(() => assertRegistryInvariants()).not.toThrow();
  });

  test("every entry is implemented-unverified: built, never real-host verified", () => {
    expect(DISPATCH_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of DISPATCH_ENTRIES) {
      expect(entry.implemented).toBe(true);
      expect(entry.verifiedOnRealHost).toBe(false);
      expect(operationState(entry)).toBe("implemented-unverified");
      expect(isDispatchableEntry(entry)).toBe(false);
    }
  });

  test("zero dispatchable operations today — fail closed by design", () => {
    expect(dispatchableOperationCount()).toBe(0);
  });

  test("entries map to the suites NativeProbe acquires", () => {
    const suites = new Set(DISPATCH_ENTRIES.map((e) => e.suite));
    for (const suite of [
      "SPBasicSuite",
      "AEGP_UtilitySuite6",
      "AEGP_ProjSuite6",
      "AEGP_ItemSuite9",
      "AEGPMemorySuite1",
    ]) {
      expect(suites.has(suite), `missing suite ${suite}`).toBe(true);
    }
  });

  test("spot-check known probe calls exist", () => {
    for (const id of [
      "SPBasicSuite.AcquireSuite",
      "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ItemSuite9.AEGP_GetItemName",
      "AEGPMemorySuite1.AEGP_FreeMemHandle",
      "AEGP_UtilitySuite6.AEGP_WriteToDebugLog",
    ]) {
      expect(findOperation(id), id).not.toBeNull();
    }
    expect(findOperation("AEGP_ProjSuite6.AEGP_SetProjectName")).toBeNull();
  });
});

describe("operationState derivation", () => {
  const base: OperationEntry = {
    id: "FakeSuite.FakeCall",
    suite: "FakeSuite",
    member: "FakeCall",
    sourceHeader: "Fake.h",
    matrixClass: "external-command",
    implemented: false,
    verifiedOnRealHost: false,
  };

  test("implemented+verifiedOnRealHost is the only dispatchable path", () => {
    expect(operationState({ ...base, implemented: true, verifiedOnRealHost: true })).toBe("dispatchable");
    expect(operationState({ ...base, implemented: true, verifiedOnRealHost: false })).toBe("implemented-unverified");
    expect(operationState({ ...base, implemented: false, verifiedOnRealHost: false })).toBe("inventory-only");
    expect(operationState({ ...base, implemented: false, verifiedOnRealHost: true })).toBe("inventory-only");
  });

  test("unsupportedReason forces unsupported-or-unknown", () => {
    expect(
      operationState({ ...base, implemented: true, unsupportedReason: "no call direction" }),
    ).toBe("unsupported-or-unknown");
  });
});
