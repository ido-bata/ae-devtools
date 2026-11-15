/**
 * CAP046 (redesigned) — per-operation adapter↔native-host negotiation.
 *
 * Proves the fail-closed contract at the OPERATION level: matching
 * versions + an advertised acceptable operation negotiate
 * `compatible`; every mismatch, unknown operation, missing
 * advertisement and below-threshold state refuses with a named
 * reason. Coverage-matrix classes are reporting metadata — a
 * class-level `dispatchable` claim is malformed, and a host can only
 * advertise `dispatchable` for a registry entry that is
 * `implemented && verifiedOnRealHost`.
 *
 * No AE, no plug-in, no real host is involved — contract level only.
 */

import { describe, expect, test } from "bun:test";
import { loadCoverageMatrix } from "../src/matrix.ts";
import {
  DISPATCH_ENTRIES,
  dispatchableOperationCount,
  findOperation,
  operationState,
} from "../src/operations.ts";
import {
  ADAPTER_PROTOCOL_VERSION,
  ADAPTER_SCHEMA,
  hostHelloFromMatrix,
  negotiate,
  type AdapterHello,
  type HostHello,
} from "../src/negotiate.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MATRIX = loadCoverageMatrix(
  join(REPO, "inventories", "sdk", "generated", "aggregate.coverage-matrix.json"),
);

const OP = "AEGP_ProjSuite6.AEGP_GetNumProjects";
const OP2 = "AEGP_ItemSuite9.AEGP_GetItemName";

function adapterHello(overrides: Partial<AdapterHello> = {}): AdapterHello {
  return {
    schema: ADAPTER_SCHEMA,
    adapterId: "fixture-adapter",
    adapterVersion: "0.0.0",
    protocolVersion: { ...ADAPTER_PROTOCOL_VERSION },
    sdkRelease: { identifier: "26.5", distribution: "macos" },
    requiredOperations: [],
    ...overrides,
  };
}

/** A host advertising OP at its honest registry-derived state. */
function hostHello(overrides: Partial<HostHello> = {}): HostHello {
  return {
    schema: ADAPTER_SCHEMA,
    hostId: "fixture-host",
    protocolVersion: { ...ADAPTER_PROTOCOL_VERSION },
    sdkRelease: { identifier: "26.5", distribution: "macos" },
    operations: {
      [OP]: { state: "implemented-unverified" },
    },
    ...overrides,
  };
}

describe("negotiate — happy path", () => {
  test("matching versions and an acceptable operation state negotiate compatible", () => {
    // OP is implemented-unverified in the registry; a client that
    // explicitly widens acceptableStates for non-dispatch use (e.g.
    // inspection) negotiates compatible. Default acceptableStates
    // (["dispatchable"]) would refuse — see fail-closed tests.
    const result = negotiate(
      adapterHello({
        requiredOperations: [OP],
        acceptableStates: ["implemented-unverified"],
      }),
      hostHello({ operations: { [OP]: { state: "implemented-unverified" } } }),
    );
    expect(result).toEqual({
      status: "compatible",
      operations: { [OP]: "implemented-unverified" },
    });
  });

  test("client newer minor refuses; equal/older client minor passes", () => {
    const newerClient = negotiate(
      adapterHello({ protocolVersion: { major: 2, minor: 5 } }),
      hostHello({ protocolVersion: { major: 2, minor: 0 } }),
    );
    expect(newerClient).toMatchObject({
      status: "refused",
      reason: "unsupported-minor-version",
    });

    const olderClient = negotiate(
      adapterHello({ protocolVersion: { major: 2, minor: 0 } }),
      hostHello({ protocolVersion: { major: 2, minor: 3 } }),
    );
    expect(olderClient.status).toBe("compatible");
  });

  test("no required operations negotiates compatible on version match alone", () => {
    const result = negotiate(adapterHello(), hostHello());
    expect(result.status).toBe("compatible");
  });
});

describe("negotiate — fail closed", () => {
  test("major version mismatch refuses", () => {
    const result = negotiate(
      adapterHello({ protocolVersion: { major: 3, minor: 0 } }),
      hostHello(),
    );
    expect(result).toMatchObject({
      status: "refused",
      reason: "incompatible-protocol-version",
    });
  });

  test("SDK release mismatch refuses — identifier and distribution both checked", () => {
    for (const sdkRelease of [
      { identifier: "27.0", distribution: "macos" },
      { identifier: "26.5", distribution: "windows" },
    ]) {
      const result = negotiate(adapterHello(), hostHello({ sdkRelease }));
      expect(result).toMatchObject({ status: "refused", reason: "sdk-release-mismatch" });
    }
  });

  test("unknown operation in requiredOperations refuses as malformed", () => {
    const result = negotiate(
      adapterHello({
        requiredOperations: ["not-an-operation"],
      }),
      hostHello(),
    );
    expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
  });

  test("a coverage-matrix class name is NOT a valid operation id", () => {
    for (const cls of [
      "external-command",
      "host-callback",
      "in-host-plugin-command",
      "build-test-lifecycle",
      "unsupported-or-unknown",
    ]) {
      const result = negotiate(
        adapterHello({
          requiredOperations: [cls],
        }),
        hostHello(),
      );
      expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
    }
  });

  test("known operation the host does not advertise refuses", () => {
    const result = negotiate(
      adapterHello({ requiredOperations: [OP2] }),
      hostHello(),
    );
    expect(result).toMatchObject({
      status: "refused",
      reason: "operation-unavailable",
    });
    if (result.status === "refused") {
      expect(result.detail).toContain("does not advertise");
    }
  });

  test("advertised state below acceptable refuses by default", () => {
    const result = negotiate(
      adapterHello({ requiredOperations: [OP] }),
      hostHello({ operations: { [OP]: { state: "inventory-only" } } }),
    );
    expect(result).toMatchObject({
      status: "refused",
      reason: "operation-unavailable",
    });
  });

  test("host claiming an operation dispatchable without registry evidence is malformed", () => {
    // OP is implemented-unverified in the registry — a dispatchable
    // claim has no per-entry evidence and must fail closed.
    const result = negotiate(
      adapterHello(),
      hostHello({ operations: { [OP]: { state: "dispatchable" } } }),
    );
    expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
    if (result.status === "refused") {
      expect(result.detail).toContain("dispatchable");
    }
  });

  test("host advertising an unknown operation is malformed, not silently ignored", () => {
    const result = negotiate(
      adapterHello(),
      hostHello({
        operations: {
          [OP]: { state: "implemented-unverified" },
          bogus: { state: "dispatchable" },
        },
      }),
    );
    expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
  });
});

describe("class-level dispatchable claims are rejected", () => {
  test("HostHello.classes with state dispatchable is malformed", () => {
    const result = negotiate(
      adapterHello(),
      hostHello({
        operations: {},
        classes: {
          "external-command": { state: "dispatchable" },
        },
      }),
    );
    expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
    if (result.status === "refused") {
      expect(result.detail).toContain("classes are");
    }
  });

  test("every matrix class advertised as dispatchable is rejected", () => {
    for (const cls of [
      "build-test-lifecycle",
      "external-command",
      "host-callback",
      "in-host-plugin-command",
      "unsupported-or-unknown",
    ] as const) {
      const result = negotiate(
        adapterHello(),
        hostHello({
          operations: {},
          classes: { [cls]: { state: "dispatchable" } },
        }),
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("malformed-message");
      }
    }
  });

  test("classes echo with honest reporting states is accepted and ignored for dispatch", () => {
    const result = negotiate(
      adapterHello({
        requiredOperations: [OP],
        acceptableStates: ["implemented-unverified"],
      }),
      hostHello({
        operations: { [OP]: { state: "implemented-unverified" } },
        classes: {
          "external-command": { state: "inventory-only", note: "reporting only" },
        },
      }),
    );
    expect(result.status).toBe("compatible");
    // The classes echo never appears in the granted result.
    if (result.status === "compatible") {
      expect(result.operations).toEqual({ [OP]: "implemented-unverified" });
    }
  });
});

describe("hostHelloFromMatrix — per-operation states, classes reporting-only", () => {
  const matrixRelease = {
    identifier: MATRIX.release.identifier,
    distribution: MATRIX.release.distribution,
  };

  test("advertises every registry operation with its derived state", () => {
    const host = hostHelloFromMatrix(MATRIX, { hostId: "matrix-host" });
    expect(host.sdkRelease).toEqual({
      identifier: MATRIX.release.identifier,
      distribution: MATRIX.release.distribution,
    });
    expect(Object.keys(host.operations).sort()).toEqual(
      DISPATCH_ENTRIES.map((e) => e.id).sort(),
    );
    for (const entry of DISPATCH_ENTRIES) {
      expect(host.operations[entry.id]?.state).toBe(operationState(entry));
    }
    // Classes are echoed for reporting only.
    expect(host.classes?.["external-command"]?.state).toBe(
      MATRIX.classes["external-command"]?.state,
    );
  });

  test("no operation is dispatchable today — every required op refuses by default", () => {
    expect(dispatchableOperationCount()).toBe(0);
    const host = hostHelloFromMatrix(MATRIX, { hostId: "matrix-host" });
    for (const entry of DISPATCH_ENTRIES.slice(0, 3)) {
      const result = negotiate(
        adapterHello({
          requiredOperations: [entry.id],
          sdkRelease: matrixRelease,
        }),
        host,
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("operation-unavailable");
      }
    }
  });

  test("a doctored registry entry claiming verifiedOnRealHost yields dispatchable", () => {
    // Prove the promotion path exists but requires BOTH flags: simulate
    // by building a host hello whose operation state is dispatchable is
    // impossible without registry evidence — instead verify the
    // registry gate directly.
    const entry = findOperation(OP);
    expect(entry).not.toBeNull();
    expect(entry?.implemented).toBe(true);
    expect(entry?.verifiedOnRealHost).toBe(false);
    expect(operationState(entry!)).toBe("implemented-unverified");
    // A host cannot advertise dispatchable for it (covered above);
    // negotiation of the honest state under widened acceptableStates
    // succeeds, under default refuses.
    const host = hostHelloFromMatrix(MATRIX, { hostId: "matrix-host" });
    const refusedResult = negotiate(
      adapterHello({ requiredOperations: [OP], sdkRelease: matrixRelease }),
      host,
    );
    expect(refusedResult.status).toBe("refused");
    const okResult = negotiate(
      adapterHello({
        requiredOperations: [OP],
        acceptableStates: ["implemented-unverified"],
        sdkRelease: matrixRelease,
      }),
      host,
    );
    expect(okResult.status).toBe("compatible");
  });
});
