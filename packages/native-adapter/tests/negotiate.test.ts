/**
 * CAP046 — adapter↔native-host version negotiation.
 *
 * Proves the fail-closed contract: matching versions + advertised
 * acceptable families negotiate `compatible`; every mismatch, unknown
 * and below-threshold state refuses with a named reason. No AE, no
 * plug-in, no real host is involved — this is contract-level only.
 */

import { describe, expect, test } from "bun:test";
import { loadCoverageMatrix, SUITE_FAMILIES } from "../src/matrix.ts";
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

function adapterHello(overrides: Partial<AdapterHello> = {}): AdapterHello {
  return {
    schema: ADAPTER_SCHEMA,
    adapterId: "fixture-adapter",
    adapterVersion: "0.0.0",
    protocolVersion: { ...ADAPTER_PROTOCOL_VERSION },
    sdkRelease: { identifier: "26.5", distribution: "macos" },
    requiredFamilies: [],
    ...overrides,
  };
}

/** A host that legitimately advertises one dispatchable family. */
function hostHello(overrides: Partial<HostHello> = {}): HostHello {
  return {
    schema: ADAPTER_SCHEMA,
    hostId: "fixture-host",
    protocolVersion: { ...ADAPTER_PROTOCOL_VERSION },
    sdkRelease: { identifier: "26.5", distribution: "macos" },
    families: {
      "external-command": { state: "dispatchable" },
    },
    ...overrides,
  };
}

describe("negotiate — happy path", () => {
  test("matching versions and a dispatchable family negotiate compatible", () => {
    const result = negotiate(
      adapterHello({ requiredFamilies: ["external-command"] }),
      hostHello(),
    );
    expect(result).toEqual({
      status: "compatible",
      families: { "external-command": "dispatchable" },
    });
  });

  test("an older host minor still satisfies a newer client minor? no — client newer refuses; equal and older client minors pass", () => {
    const newerClient = negotiate(
      adapterHello({ protocolVersion: { major: 1, minor: 5 } }),
      hostHello({ protocolVersion: { major: 1, minor: 0 } }),
    );
    expect(newerClient.status).toBe("refused");
    if (newerClient.status === "refused") {
      expect(newerClient.reason).toBe("unsupported-minor-version");
    }

    const olderClient = negotiate(
      adapterHello({ protocolVersion: { major: 1, minor: 0 } }),
      hostHello({ protocolVersion: { major: 1, minor: 3 } }),
    );
    expect(olderClient.status).toBe("compatible");
  });

  test("no required families negotiates compatible on version match alone", () => {
    const result = negotiate(adapterHello(), hostHello());
    expect(result.status).toBe("compatible");
  });
});

describe("negotiate — fail closed", () => {
  test("major version mismatch refuses", () => {
    const result = negotiate(
      adapterHello({ protocolVersion: { major: 2, minor: 0 } }),
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

  test("unknown suite family in requiredFamilies refuses", () => {
    const result = negotiate(
      adapterHello({
        // @ts-expect-error — deliberately invalid input must fail closed, not throw
        requiredFamilies: ["not-a-family"],
      }),
      hostHello(),
    );
    expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
  });

  test("known family the host does not advertise refuses", () => {
    const result = negotiate(
      adapterHello({ requiredFamilies: ["host-callback"] }),
      hostHello(),
    );
    expect(result).toMatchObject({
      status: "refused",
      reason: "suite-family-unavailable",
    });
    if (result.status === "refused") {
      expect(result.detail).toContain("does not advertise");
    }
  });

  test("advertised state below acceptable refuses by default", () => {
    const result = negotiate(
      adapterHello({ requiredFamilies: ["external-command"] }),
      hostHello({
        families: { "external-command": { state: "inventory-only" } },
      }),
    );
    expect(result).toMatchObject({
      status: "refused",
      reason: "suite-family-unavailable",
    });
  });

  test("client may widen acceptableStates explicitly for non-dispatch use", () => {
    const result = negotiate(
      adapterHello({
        requiredFamilies: ["build-test-lifecycle"],
        acceptableStates: ["build-probe-only"],
      }),
      hostHello({
        families: { "build-test-lifecycle": { state: "build-probe-only" } },
      }),
    );
    expect(result).toEqual({
      status: "compatible",
      families: { "build-test-lifecycle": "build-probe-only" },
    });
  });

  test("malformed messages refuse on either side", () => {
    expect(
      negotiate({ garbage: true } as unknown as AdapterHello, hostHello()),
    ).toMatchObject({ status: "refused", reason: "malformed-message" });
    expect(
      negotiate(adapterHello(), { schema: "wrong" } as unknown as HostHello),
    ).toMatchObject({ status: "refused", reason: "malformed-message" });
  });

  test("host advertising an unknown family is malformed, not silently ignored", () => {
    const result = negotiate(
      adapterHello(),
      hostHello({
        families: {
          "external-command": { state: "dispatchable" },
          // @ts-expect-error — unknown family key must fail closed
          bogus: { state: "dispatchable" },
        },
      }),
    );
    expect(result).toMatchObject({ status: "refused", reason: "malformed-message" });
  });
});

describe("hostHelloFromMatrix — status derived, never conflated", () => {
  const matrixRelease = {
    identifier: MATRIX.release.identifier,
    distribution: MATRIX.release.distribution,
  };

  test("every advertised family state comes from the coverage matrix", () => {
    const host = hostHelloFromMatrix(MATRIX, { hostId: "matrix-host" });
    expect(host.sdkRelease).toEqual({
      identifier: MATRIX.release.identifier,
      distribution: MATRIX.release.distribution,
    });
    for (const family of SUITE_FAMILIES) {
      const advertised = host.families[family];
      expect(advertised).toBeDefined();
      // The real matrix marks nothing implemented/verified, so no family
      // may advertise dispatchable.
      expect(advertised?.state).not.toBe("dispatchable");
      expect(advertised?.state as string | undefined).toBe(MATRIX.classes[family]?.state);
    }
  });

  test("a matrix-derived host refuses every required family today (fail closed)", () => {
    const host = hostHelloFromMatrix(MATRIX, { hostId: "matrix-host" });
    for (const family of SUITE_FAMILIES) {
      const result = negotiate(
        adapterHello({ requiredFamilies: [family], sdkRelease: matrixRelease }),
        host,
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("suite-family-unavailable");
      }
    }
  });

  test("a doctored matrix claiming implemented+verified yields dispatchable", () => {
    const doctored = JSON.parse(JSON.stringify(MATRIX)) as typeof MATRIX;
    doctored.classes["external-command"] = {
      ...doctored.classes["external-command"]!,
      implemented: true,
      verifiedOnRealHost: true,
    };
    const host = hostHelloFromMatrix(doctored, { hostId: "doctored" });
    expect(host.families["external-command"]?.state).toBe("dispatchable");
    const result = negotiate(
      adapterHello({ requiredFamilies: ["external-command"], sdkRelease: matrixRelease }),
      host,
    );
    expect(result.status).toBe("compatible");
  });
});
