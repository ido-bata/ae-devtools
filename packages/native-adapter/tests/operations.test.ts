/**
 * Per-operation registry invariants — the dispatchability SoT.
 *
 * Proves: ids are unique and well-formed, implemented entries are
 * exactly the calls NativeProbe makes (enforced mechanically by
 * registry-reconcile.test.ts), derived states obey the
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

  test("implemented entries are implemented-unverified; inventory entries stay inventory-only", () => {
    expect(DISPATCH_ENTRIES.length).toBeGreaterThan(0);
    let implemented = 0;
    let inventoryOnly = 0;
    for (const entry of DISPATCH_ENTRIES) {
      expect(entry.verifiedOnRealHost).toBe(false);
      expect(isDispatchableEntry(entry)).toBe(false);
      if (entry.implemented) {
        implemented++;
        expect(operationState(entry)).toBe("implemented-unverified");
      } else {
        inventoryOnly++;
        // Non-implemented entries are either inventory-only or carry an
        // explicit FR-013 disposition (unsupported-or-unknown).
        expect(["inventory-only", "unsupported-or-unknown"]).toContain(
          operationState(entry),
        );
      }
    }
    // The NativeProbe-implemented slice must stay non-empty.
    expect(implemented).toBeGreaterThan(0);
    // Issue #63 added the project/item suite inventory.
    expect(inventoryOnly).toBeGreaterThan(0);
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
      "AEGP_MemorySuite1",
    ]) {
      expect(suites.has(suite), `missing suite ${suite}`).toBe(true);
    }
  });

  test("spot-check known probe calls exist", () => {
    for (const id of [
      "SPBasicSuite.AcquireSuite",
      "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ItemSuite9.AEGP_GetItemName",
      "AEGP_MemorySuite1.AEGP_FreeMemHandle",
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

  test("dispatchable requires all three evidence axes — in-AE success alone is not enough", () => {
    // implemented + verifiedOnRealHost proves the call works INSIDE AE;
    // it does not authorize external dispatch. Only the third axis
    // (externalDispatchVerified) completes the path.
    expect(
      operationState({ ...base, implemented: true, verifiedOnRealHost: true }),
    ).toBe("implemented-unverified");
    expect(
      operationState({
        ...base, implemented: true, verifiedOnRealHost: true,
        externalDispatchVerified: true,
      }),
    ).toBe("dispatchable");
    expect(
      operationState({ ...base, implemented: true, verifiedOnRealHost: false }),
    ).toBe("implemented-unverified");
    expect(
      operationState({ ...base, implemented: false, verifiedOnRealHost: false }),
    ).toBe("inventory-only");
    expect(
      operationState({ ...base, implemented: false, verifiedOnRealHost: true }),
    ).toBe("inventory-only");
    // externalDispatchVerified without the other two axes is rejected
    // by registry invariants, not silently honoured.
    expect(() =>
      assertRegistryInvariants([{
        ...base, implemented: true, verifiedOnRealHost: false,
        externalDispatchVerified: true,
      }]),
    ).toThrow(/external dispatch/);
  });

  test("unsupportedReason forces unsupported-or-unknown", () => {
    expect(
      operationState({ ...base, implemented: true, unsupportedReason: "no call direction" }),
    ).toBe("unsupported-or-unknown");
  });
});
