/**
 * CAP016 — versioned capability handshake and refusal paths.
 *
 * FR-06: incompatible major versions, unknown capabilities, missing
 * permissions and wrong host state fail closed. The handshake advertises only
 * capabilities from inventories actually supplied to this host; a capability
 * missing from a source whose rows were never supplied is `unassessed`, never
 * reported as absent (issue #11 comment 6812931711).
 */

import { describe, expect, test } from "bun:test";
import { loadRepoInputs } from "../scripts/inputs.ts";
import { importSdkRows } from "../src/import-sdk.ts";
import {
  assertDispatchAllowed,
  buildHandshake,
  CONTRACT_SCHEMA,
  CONTRACT_VERSION,
  negotiate,
} from "../src/handshake.ts";
import type { CoverageAxes, ExecutionDescriptor, ImportedSource } from "../src/schema.ts";
import { makeRecord } from "./fixture.ts";

const inputs = loadRepoInputs();
const AT = "2026-11-13T00:00:00.000Z";

function serverFixture() {
  return buildHandshake({
    scripting: inputs.scripting,
    tools: inputs.tools,
    semantics: inputs.semantics,
    sdkAggregate: inputs.sdk,
    catalogRevision: "sha-fixture",
    hostId: "host-fixture",
    os: "darwin",
    arch: "arm64",
    executionMode: "local",
    transport: "file-envelope",
    generatedAt: AT,
    supportedRelease: { state: "not-recorded" },
  });
}

describe("capability advertisement follows supplied inventories", () => {
  const server = serverFixture();

  test("advertises repository-persisted capabilities and never absent SDK rows", () => {
    expect(server.schema).toBe(CONTRACT_SCHEMA);
    expect(server.contractVersion).toEqual(CONTRACT_VERSION);
    expect(server.inventorySupply).toEqual({
      scripting: "supplied",
      tools: "supplied",
      sdk: "not-supplied",
    });
    const ids = server.availableCapabilities.map((c) => c.id);
    expect(ids).toContain("ae.scripting.app.version");
    expect(ids).toContain("ae.operation.app.version-info");
    expect(ids.some((id) => id.startsWith("ae.tool."))).toBe(true);
    expect(ids.some((id) => id.startsWith("ae.sdk."))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("SDK not supplied is diagnosed as unassessed, not absent", () => {
    const diagnostic = server.diagnostics.find(
      (d) => d.code === "inventory-not-supplied" && d.source === "sdk",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.effect).toContain("unassessed");
    expect(diagnostic?.effect).toContain("not absent");
  });

  test("evidence labels never claim verified on a real host", () => {
    for (const capability of server.availableCapabilities) {
      expect(["source-reviewed", "automated-test", "unverified"]).toContain(
        capability.proofLevel,
      );
      expect(capability.proofLevel).not.toBe("verified-real-host");
    }
    expect(server.provenance.evidenceLevel.realHost).toBe("not-run");
    expect(server.diagnostics.some((d) => d.code === "no-real-host-evidence")).toBe(true);
  });

  test("an undetermined supported-release set is diagnosed", () => {
    expect(
      server.diagnostics.some((d) => d.code === "supported-release-set-not-recorded"),
    ).toBe(true);
  });
});

describe("version negotiation fails closed", () => {
  const server = serverFixture();

  test("an incompatible major version is refused", () => {
    expect(negotiate(server, { contractVersion: { major: 2, minor: 0 } })).toEqual({
      status: "refused",
      reason: "incompatible-contract-version",
      detail: expect.stringContaining("2") as unknown as string,
    });
    expect(
      negotiate(server, { contractVersion: { major: 0, minor: 9 } }).status,
    ).toBe("refused");
  });

  test("a client minor newer than the server is refused; older or equal passes", () => {
    const newerClient = negotiate(server, { contractVersion: { major: 1, minor: 1 } });
    expect(newerClient.status === "refused" && newerClient.reason).toBe(
      "unsupported-minor-version",
    );

    const newerServer = { ...server, contractVersion: { major: 1, minor: 1 } };
    expect(negotiate(newerServer, { contractVersion: { major: 1, minor: 0 } }).status).toBe(
      "compatible",
    );
    expect(negotiate(server, { contractVersion: { major: 1, minor: 0 } }).status).toBe(
      "compatible",
    );
  });

  test("a response with the wrong contract schema is refused as malformed", () => {
    const malformed = { ...server, schema: "something-else" as typeof CONTRACT_SCHEMA };
    expect(negotiate(malformed, { contractVersion: { major: 1, minor: 0 } })).toEqual({
      status: "refused",
      reason: "malformed-response",
      detail: expect.stringContaining("schema") as unknown as string,
    });
  });
});

describe("capability request refusals", () => {
  const server = serverFixture();

  test("an unknown capability in a supplied source refuses as unknown", () => {
    const result = negotiate(server, {
      contractVersion: { major: 1, minor: 0 },
      requestedCapability: "ae.scripting.app.noSuchMember",
    });
    expect(result.status === "refused" && result.reason).toBe("unknown-capability");
  });

  test("an SDK capability without supplied SDK rows refuses as unassessed, not absent", () => {
    const result = negotiate(server, {
      contractVersion: { major: 1, minor: 0 },
      requestedCapability: "ae.sdk.fx.FixtureAcquire",
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("capability-unassessed");
    expect(result.detail).toContain("not absence");
  });

  test("a missing permission refuses", () => {
    const result = negotiate(server, {
      contractVersion: { major: 1, minor: 0 },
      requestedCapability: "ae.scripting.app.version",
      requiredPermission: "write",
    });
    expect(result.status === "refused" && result.reason).toBe("missing-permission");
    const allowed = negotiate(server, {
      contractVersion: { major: 1, minor: 0 },
      requestedCapability: "ae.scripting.app.version",
      requiredPermission: "read",
    });
    expect(allowed.status).toBe("compatible");
  });
});

const EXECUTABLE_ID = "ae.scripting.app.fixtureExec";

function executableSource(): ImportedSource {
  return {
    source: "scripting",
    records: [
      makeRecord({
        id: EXECUTABLE_ID,
        kind: "scripting-symbol",
        access: "read",
        execution: {
          class: "extendscript",
          lifecycle: "AE scripting host",
          canRemoteInvoke: true,
        },
        coverage: {
          inventory: "source-reviewed",
          reachability: "reachable",
          implementation: "implemented",
          verification: "automated-fake",
          evidenceRefs: [{ kind: "automated-test", ref: "test://fixture" }],
        },
      }),
    ],
    denominator: { state: "supplied", count: 1 },
    evidenceLevel: {
      inventory: "source-reviewed",
      verification: "automated-fake",
      realHost: "not-run",
      statement: "fixture",
    },
    provenance: {},
  };
}

function executableServer(attestedOwnership: "owned" | "unknown" = "owned") {
  return buildHandshake({
    scripting: executableSource(),
    tools: { ...inputs.tools, records: [] },
    semantics: { ...inputs.semantics, records: [] },
    sdkAggregate: inputs.sdk,
    catalogRevision: "sha-fixture",
    hostId: "host-fixture",
    os: "darwin",
    arch: "arm64",
    executionMode: "local",
    transport: "file-envelope",
    generatedAt: AT,
    supportedRelease: { state: "not-recorded" },
    target: {
      identity: "fixture-host",
      ownership: attestedOwnership,
      nonInterference: "proven",
    },
  });
}

describe("handshake pass is not authorization", () => {
  const server = executableServer();

  test("attested ownership gates dispatch; caller claims cannot override it", () => {
    // Caller claim agreeing with attested evidence passes.
    expect(
      assertDispatchAllowed({
        response: server,
        capabilityId: EXECUTABLE_ID,
        permission: "read",
        ownership: "owned",
      }).status,
    ).toBe("pass");
    // Omitting the caller claim still passes on attested evidence alone.
    expect(
      assertDispatchAllowed({
        response: server,
        capabilityId: EXECUTABLE_ID,
        permission: "read",
      }).status,
    ).toBe("pass");
    // A caller claim that contradicts the attested evidence refuses.
    expect(
      assertDispatchAllowed({
        response: server,
        capabilityId: EXECUTABLE_ID,
        permission: "read",
        ownership: "explicitly-attached",
      }),
    ).toEqual({
      status: "refused",
      reason: "ownership-unproven",
      detail: expect.stringContaining("contradict") as unknown as string,
    });
  });

  test("a caller claim of owned cannot upgrade attested unknown", () => {
    const unattested = executableServer("unknown");
    const result = assertDispatchAllowed({
      response: unattested,
      capabilityId: EXECUTABLE_ID,
      permission: "read",
      ownership: "owned",
    });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("ownership-unproven");
  });

  test("a missing target block fails closed as ownership-unproven", () => {
    const noTarget = executableServer();
    const stripped = { ...noTarget, target: undefined } as unknown as typeof noTarget;
    const result = assertDispatchAllowed({
      response: stripped,
      capabilityId: EXECUTABLE_ID,
      permission: "read",
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("ownership-unproven");
  });

  test("omitting the permission class refuses as missing-permission", () => {
    const result = assertDispatchAllowed({
      response: server,
      capabilityId: EXECUTABLE_ID,
      // @ts-expect-error — deliberately omitting the now-required field
      permission: undefined,
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("missing-permission");
  });

  test("an undeclared permission refuses as missing-permission", () => {
    const result = assertDispatchAllowed({
      response: server,
      capabilityId: EXECUTABLE_ID,
      permission: "write",
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("missing-permission");
  });

  test("a malformed response refuses before any other check", () => {
    const malformed = { ...server, schema: "bogus" } as unknown as typeof server;
    const result = assertDispatchAllowed({
      response: malformed,
      capabilityId: EXECUTABLE_ID,
      permission: "read",
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("malformed-response");
  });

  test("structurally broken advertisements refuse, never throw or pass", () => {
    const brokenAds = [
      { ...server.availableCapabilities[0], verification: undefined },
      { ...server.availableCapabilities[0], execution: undefined },
      { ...server.availableCapabilities[0], permissions: "read" },
      { ...server.availableCapabilities[0], permissions: ["bogus"] },
    ];
    for (const ad of brokenAds) {
      const forged = {
        ...server,
        availableCapabilities: [ad],
      } as unknown as typeof server;
      const result = assertDispatchAllowed({
        response: forged,
        capabilityId: EXECUTABLE_ID,
        permission: "read",
        ownership: "owned",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") throw new Error("unreachable");
      expect([
        "not-implemented", "unverified", "no-execution-path", "missing-permission",
      ]).toContain(result.reason);
    }
    // A permission outside the closed enum refuses even if advertised.
    const bogusPerm = {
      ...server,
      availableCapabilities: [{
        ...server.availableCapabilities[0], permissions: ["bogus"],
      }],
    } as unknown as typeof server;
    const result = assertDispatchAllowed({
      response: bogusPerm,
      capabilityId: EXECUTABLE_ID,
      permission: "bogus" as never,
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("missing-permission");
  });

  test("dispatch against an unassessed capability refuses, never silently passes", () => {
    const result = assertDispatchAllowed({
      response: server,
      capabilityId: "ae.sdk.fx.FixtureAcquire",
      permission: "execute",
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("capability-unassessed");
  });
});

describe("executability gates fail closed (discovery is not permission)", () => {
  test("real inventory rows are advertised but refuse dispatch on every executability axis", () => {
    // Every row imported from the real inventories is source-reviewed only:
    // implementation is unknown/not-implemented, verification is not-run and
    // canRemoteInvoke is unproven. Advertisement must not imply dispatchability.
    const realServer = serverFixture();
    for (const capability of realServer.availableCapabilities) {
      const result = assertDispatchAllowed({
        response: realServer,
        capabilityId: capability.id,
        permission: capability.permissions[0] ?? "read",
        ownership: "owned",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") throw new Error("unreachable");
      expect(["not-implemented", "unverified", "no-execution-path"]).toContain(result.reason);
    }
  });

  function serverWithRecord(coverage: Partial<CoverageAxes>, execution?: ExecutionDescriptor) {
    const rec = makeRecord({
      id: "ae.scripting.app.gateProbe",
      kind: "scripting-symbol",
      access: "read",
      ...(execution ? { execution } : {}),
      coverage,
    });
    return buildHandshake({
      scripting: {
        source: "scripting",
        records: [rec],
        denominator: { state: "supplied", count: 1 },
        evidenceLevel: {
          inventory: "source-reviewed",
          verification: "not-run",
          realHost: "not-run",
          statement: "fixture",
        },
        provenance: {},
      },
      tools: { ...inputs.tools, records: [] },
      semantics: { ...inputs.semantics, records: [] },
      sdkAggregate: inputs.sdk,
      catalogRevision: "sha-fixture",
      hostId: "host-fixture",
      os: "darwin",
      arch: "arm64",
      executionMode: "local",
      transport: "file-envelope",
      generatedAt: AT,
      supportedRelease: { state: "not-recorded" },
    });
  }

  const implemented = {
    inventory: "source-reviewed" as const,
    reachability: "reachable" as const,
    implementation: "implemented" as const,
    verification: "automated-fake" as const,
    evidenceRefs: [{ kind: "automated-test" as const, ref: "test://x" }],
  };
  const invocable = {
    class: "extendscript" as const,
    lifecycle: "AE scripting host",
    canRemoteInvoke: true,
  };

  test("unimplemented rows refuse as not-implemented", () => {
    for (const implementation of ["none", "adapter-present", "unsupported", "unknown"] as const) {
      const server = serverWithRecord({ ...implemented, implementation }, invocable);
      const result = assertDispatchAllowed({
        response: server,
        capabilityId: "ae.scripting.app.gateProbe",
        permission: "read",
        ownership: "owned",
      });
      expect(result.status === "refused" && result.reason).toBe("not-implemented");
    }
  });

  test("verification=not-run refuses as unverified even when implemented", () => {
    const server = serverWithRecord({ ...implemented, verification: "not-run" }, invocable);
    const result = assertDispatchAllowed({
      response: server,
      capabilityId: "ae.scripting.app.gateProbe",
      permission: "read",
      ownership: "owned",
    });
    expect(result.status === "refused" && result.reason).toBe("unverified");
  });

  test("canRemoteInvoke null or false refuses as no-execution-path", () => {
    for (const canRemoteInvoke of [null, false] as const) {
      const server = serverWithRecord(implemented, { ...invocable, canRemoteInvoke });
      const result = assertDispatchAllowed({
        response: server,
        capabilityId: "ae.scripting.app.gateProbe",
        permission: "read",
        ownership: "owned",
      });
      expect(result.status === "refused" && result.reason).toBe("no-execution-path");
    }
  });

  test("advertisement exposes implementation and verification axes", () => {
    const server = serverWithRecord(implemented, invocable);
    const ad = server.availableCapabilities.find((c) => c.id === "ae.scripting.app.gateProbe");
    expect(ad?.implementation).toBe("implemented");
    expect(ad?.verification).toBe("automated-fake");
  });
});

describe("supplied SDK rows join the handshake", () => {
  test("with build-time SDK rows the SDK source becomes supplied and advertised", () => {
    const sdkRows = importSdkRows({
      detail: {
        release: "26.5",
        symbols: [
          {
            kind: "suite-slot",
            name: "FixtureAcquire",
            header: "FX.h",
            line: 10,
            class: "external-command",
            evidence: "suite-registration-string",
            rule: "suite+registration-string",
          },
        ],
      },
      observedAt: "2026-11-13",
    });
    const server = buildHandshake({
      scripting: inputs.scripting,
      tools: inputs.tools,
      semantics: inputs.semantics,
      sdkAggregate: inputs.sdk,
      sdkRows,
      catalogRevision: "sha-fixture",
      hostId: "host-fixture",
      os: "darwin",
      arch: "arm64",
      executionMode: "local",
      transport: "file-envelope",
      generatedAt: AT,
      supportedRelease: { state: "not-recorded" },
    });
    expect(server.inventorySupply.sdk).toBe("supplied");
    expect(server.availableCapabilities.map((c) => c.id)).toContain(
      "ae.sdk.fx.FixtureAcquire",
    );
    expect(
      server.diagnostics.some(
        (d) => d.code === "inventory-not-supplied" && d.source === "sdk",
      ),
    ).toBe(false);
    const sdkCapability = server.availableCapabilities.find(
      (c) => c.id === "ae.sdk.fx.FixtureAcquire",
    );
    expect(sdkCapability?.proofLevel).toBe("source-reviewed");
    expect(sdkCapability?.permissions).toEqual(["execute"]);
  });
});
