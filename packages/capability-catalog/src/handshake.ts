/**
 * Versioned capability handshake — CAP016 (FR-06, capability-catalog §4).
 *
 * The handshake advertises only capabilities whose inventory rows were
 * actually supplied to this host. A source that was never supplied is
 * reported as `unassessed` in diagnostics and refuses requested capabilities
 * as `capability-unassessed` — repository absence is never reported as
 * capability absence (issue #11 comment 6812931711, §1.1 asymmetry).
 *
 * A compatible handshake is not authorization: `assertDispatchAllowed`
 * re-checks ownership, permission and assessment per dispatch, mirroring
 * contract §4 client behavior 3.
 */

import {
  CONTRACT_VERSION,
  type AccessClass,
  type CapabilityRecord,
  type ContractVersion,
  type ImplementationAxis,
  type ImportedSource,
  type VerificationAxis,
} from "./schema.ts";
import type { SdkAggregateImport } from "./import-sdk.ts";
import { parseCapabilityId, type IdNamespace } from "./ids.ts";

export { CONTRACT_VERSION };
export const CONTRACT_SCHEMA = "ae-devtools.capability-handshake/v1" as const;
export type ContractSchema = typeof CONTRACT_SCHEMA;

export type ProofLevel =
  | "verified-real-host"
  | "automated-test"
  | "source-reviewed"
  | "unverified";

export const PERMISSION_VALUES = [
  "read",
  "write",
  "execute",
  "build-test",
  "host-callback",
] as const;
export type Permission = (typeof PERMISSION_VALUES)[number];

const ACCESS_PERMISSIONS: Record<AccessClass, Permission[]> = {
  read: ["read"],
  "read-write": ["read", "write"],
  write: ["write"],
  execute: ["execute"],
  // FR-09: host callbacks have no generic remote invocation path; they are
  // advertised under their own permission so a client cannot confuse them
  // with an executable suite command.
  "host-callback": ["host-callback"],
  "build-test": ["build-test"],
  unknown: [],
};

export type CapabilityAdvertisement = {
  id: string;
  kind: CapabilityRecord["kind"];
  persistence: CapabilityRecord["persistence"];
  permissions: Permission[];
  proofLevel: ProofLevel;
  compatibility: CapabilityRecord["compatibility"];
  execution: CapabilityRecord["execution"];
  /**
   * Executability axes, exposed so a client can distinguish discovery from
   * dispatchability (contract §4 rule 3). `assertDispatchAllowed` refuses
   * anything that is not `implemented` + verified beyond `not-run` +
   * `canRemoteInvoke === true`; advertisement alone never authorizes.
   */
  implementation: ImplementationAxis;
  verification: VerificationAxis;
};

export type HandshakeDiagnostic = {
  code: string;
  source?: "scripting" | "tools" | "sdk";
  effect: string;
};

export type OwnershipEvidence = "owned" | "explicitly-attached" | "unknown";
export type NonInterferenceEvidence = "proven" | "by-construction" | "unproven";

export type HandshakeTarget = {
  identity: string | null;
  ownership: OwnershipEvidence;
  nonInterference: NonInterferenceEvidence;
};

export type SupportedRelease =
  | { state: "recorded"; releases: string[] }
  | { state: "not-recorded" };

export type HandshakeResponse = {
  schema: ContractSchema;
  contractVersion: ContractVersion;
  catalogRevision: string;
  hostId: string;
  host: {
    ae?: { version?: string; build?: string; scriptingVersion?: string };
    os: string;
    arch: string;
    executionMode: string;
    transport: string;
  };
  target: HandshakeTarget;
  inventorySupply: { scripting: SupplyState; tools: SupplyState; sdk: SupplyState };
  availableCapabilities: CapabilityAdvertisement[];
  diagnostics: HandshakeDiagnostic[];
  provenance: {
    catalogRevision: string;
    hostId: string;
    generatedAt: string;
    evidenceLevel: {
      inventory: string;
      verification: string;
      realHost: string;
      statement: string;
    };
    sources: Record<string, unknown>;
  };
};

type SupplyState = "supplied" | "not-supplied";

function proofLevelFor(record: CapabilityRecord): ProofLevel {
  const verification: VerificationAxis = record.coverage.verification;
  if (verification === "verified-real-host") return "verified-real-host";
  if (verification === "automated-fake") return "automated-test";
  if (record.coverage.inventory === "source-reviewed") return "source-reviewed";
  return "unverified";
}

function advertise(record: CapabilityRecord): CapabilityAdvertisement {
  return {
    id: record.id,
    kind: record.kind,
    persistence: record.persistence,
    permissions: ACCESS_PERMISSIONS[record.access],
    proofLevel: proofLevelFor(record),
    compatibility: record.compatibility,
    execution: record.execution,
    implementation: record.coverage.implementation,
    verification: record.coverage.verification,
  };
}

const NAMESPACE_SUPPLY: Record<IdNamespace, "scripting" | "tools" | "sdk"> = {
  scripting: "scripting",
  sdk: "sdk",
  tool: "tools",
  operation: "tools",
};

export function buildHandshake(input: {
  scripting: ImportedSource;
  tools: ImportedSource;
  semantics: ImportedSource;
  sdkAggregate: SdkAggregateImport;
  sdkRows?: CapabilityRecord[];
  catalogRevision: string;
  hostId: string;
  os: string;
  arch: string;
  executionMode: string;
  transport: string;
  ae?: { version?: string; build?: string; scriptingVersion?: string };
  generatedAt: string;
  supportedRelease: SupportedRelease;
  target?: Partial<HandshakeTarget>;
}): HandshakeResponse {
  const sdkRows = input.sdkRows ?? [];
  const sdkSupplied = input.sdkRows !== undefined;
  const inventorySupply = {
    scripting: input.scripting.records.length > 0 ? ("supplied" as const) : ("not-supplied" as const),
    tools:
      input.tools.records.length + input.semantics.records.length > 0
        ? ("supplied" as const)
        : ("not-supplied" as const),
    sdk: sdkSupplied ? ("supplied" as const) : ("not-supplied" as const),
  };

  const records = [
    ...input.scripting.records,
    ...input.tools.records,
    ...input.semantics.records,
    ...sdkRows,
  ];
  const seen = new Set<string>();
  const availableCapabilities: CapabilityAdvertisement[] = [];
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new Error(`duplicate capability id across supplied inventories: ${record.id}`);
    }
    seen.add(record.id);
    availableCapabilities.push(advertise(record));
  }
  availableCapabilities.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const diagnostics: HandshakeDiagnostic[] = [];
  for (const source of ["scripting", "tools", "sdk"] as const) {
    if (inventorySupply[source] !== "supplied") {
      diagnostics.push({
        code: "inventory-not-supplied",
        source,
        effect:
          source === "sdk"
            ? "SDK per-symbol rows were not supplied to this host; SDK capabilities are unassessed — missing rows are not absent capability (capability-catalog §1.1)."
            : `${source} inventory rows were not supplied to this host; ${source} capabilities are unassessed — missing rows are not absent capability.`,
      });
    }
  }
  const anyRealHost = availableCapabilities.some((c) => c.proofLevel === "verified-real-host");
  if (!anyRealHost) {
    diagnostics.push({
      code: "no-real-host-evidence",
      effect:
        "no advertised capability holds verified-real-host proof; fake and source-reviewed evidence never promote a capability to real-host verified.",
    });
  }
  if (input.supportedRelease.state === "not-recorded") {
    diagnostics.push({
      code: "supported-release-set-not-recorded",
      effect:
        "the supported AE release set is not recorded (plan §6.1); coverage percentages stay unknown rather than 0% or 100%.",
    });
  }

  const anyAutomated = availableCapabilities.some((c) => c.proofLevel === "automated-test");

  return {
    schema: CONTRACT_SCHEMA,
    contractVersion: { ...CONTRACT_VERSION },
    catalogRevision: input.catalogRevision,
    hostId: input.hostId,
    host: {
      ...(input.ae ? { ae: input.ae } : {}),
      os: input.os,
      arch: input.arch,
      executionMode: input.executionMode,
      transport: input.transport,
    },
    target: {
      identity: input.target?.identity ?? null,
      ownership: input.target?.ownership ?? "unknown",
      nonInterference: input.target?.nonInterference ?? "unproven",
    },
    inventorySupply,
    availableCapabilities,
    diagnostics,
    provenance: {
      catalogRevision: input.catalogRevision,
      hostId: input.hostId,
      generatedAt: input.generatedAt,
      evidenceLevel: {
        inventory: "source-reviewed",
        verification: anyAutomated ? "automated-fake" : "not-run",
        realHost: anyRealHost ? "verified-real-host" : "not-run",
        statement:
          "handshake proof levels reflect supplied inventory rows only; repository absence of a row is unassessed, never absent.",
      },
      sources: {
        scripting: {
          evidenceLevel: input.scripting.evidenceLevel,
          denominator: input.scripting.denominator,
        },
        tools: {
          evidenceLevel: input.tools.evidenceLevel,
          denominator: input.tools.denominator,
        },
        sdk: {
          supplied: sdkSupplied,
          aggregateTotals: input.sdkAggregate.aggregate.totals,
          denominatorCaveats: input.sdkAggregate.aggregate.denominatorCaveats,
          evidenceLevel: input.sdkAggregate.evidenceLevel,
        },
      },
    },
  };
}

export type RefusalReason =
  | "malformed-response"
  | "incompatible-contract-version"
  | "unsupported-minor-version"
  | "unknown-capability"
  | "capability-unassessed"
  | "missing-permission"
  | "ownership-unproven"
  | "not-implemented"
  | "unverified"
  | "no-execution-path";

export type NegotiationRequest = {
  contractVersion: ContractVersion;
  requestedCapability?: string;
  requiredPermission?: Permission;
};

export type NegotiationResult =
  | { status: "compatible" }
  | { status: "refused"; reason: RefusalReason; detail: string };

function refused(reason: RefusalReason, detail: string): NegotiationResult {
  return { status: "refused", reason, detail };
}

function lookupCapability(
  response: HandshakeResponse,
  id: string,
): { kind: "found"; capability: CapabilityAdvertisement } | { kind: "unassessed" } | { kind: "unknown" } {
  const capability = response.availableCapabilities.find((c) => c.id === id);
  if (capability !== undefined) return { kind: "found", capability };
  const parsed = parseCapabilityId(id);
  if (parsed === null) return { kind: "unknown" };
  const supplyKey = NAMESPACE_SUPPLY[parsed.namespace];
  return response.inventorySupply[supplyKey] === "supplied" ? { kind: "unknown" } : { kind: "unassessed" };
}

export function negotiate(
  response: HandshakeResponse,
  request: NegotiationRequest,
): NegotiationResult {
  if (response.schema !== CONTRACT_SCHEMA) {
    return refused(
      "malformed-response",
      `handshake schema ${JSON.stringify(response.schema)} is not ${CONTRACT_SCHEMA}`,
    );
  }
  const client = request.contractVersion;
  const server = response.contractVersion;
  if (client.major !== server.major) {
    return refused(
      "incompatible-contract-version",
      `client contract major ${client.major} is incompatible with server major ${server.major}`,
    );
  }
  if (client.minor > server.minor) {
    return refused(
      "unsupported-minor-version",
      `client contract minor ${client.minor} is newer than server minor ${server.minor}`,
    );
  }
  if (request.requestedCapability !== undefined) {
    const lookup = lookupCapability(response, request.requestedCapability);
    if (lookup.kind === "unassessed") {
      return refused(
        "capability-unassessed",
        `capability ${request.requestedCapability} belongs to an inventory not supplied to this host; unassessed is not absence`,
      );
    }
    if (lookup.kind === "unknown") {
      return refused("unknown-capability", `capability ${request.requestedCapability} is not advertised`);
    }
    if (
      request.requiredPermission !== undefined &&
      !lookup.capability.permissions.includes(request.requiredPermission)
    ) {
      return refused(
        "missing-permission",
        `capability ${lookup.capability.id} does not declare permission ${request.requiredPermission}`,
      );
    }
  }
  return { status: "compatible" };
}

export type DispatchCheck = {
  response: HandshakeResponse;
  capabilityId: string;
  /**
   * The permission class this dispatch exercises. Required: a dispatch that
   * does not declare its permission class cannot be authorized — omitting it
   * refuses `missing-permission` (fail closed, never skipped).
   */
  permission: Permission;
  /**
   * Optional caller-side ownership observation (e.g. from a session probe).
   * It is a *claim*, never the authority: authorization uses the ownership
   * attested in `response.target`. A claim that contradicts the attested
   * evidence refuses `ownership-unproven`; a claim of `owned` cannot upgrade
   * an attested `unknown`.
   */
  ownership?: OwnershipEvidence;
};

export type DispatchResult =
  | { status: "pass" }
  | { status: "refused"; reason: RefusalReason; detail: string };

/**
 * Per-dispatch gate (contract §4 rule 3): a compatible handshake is not
 * authorization. This is the *authorization* half of the boundary —
 * `negotiate` is only metadata preflight (schema/version/capability
 * existence/declared permission). Here, in order: the response must be a
 * well-formed handshake, the capability must pass the executability gates,
 * the dispatch must declare a permission the capability advertises, and
 * ownership must be proven by the handshake's own `target` evidence —
 * caller-supplied claims can corroborate but never override it.
 */
export function assertDispatchAllowed(check: DispatchCheck): DispatchResult {
  if (
    check.response?.schema !== CONTRACT_SCHEMA ||
    !Array.isArray(check.response?.availableCapabilities)
  ) {
    return {
      status: "refused",
      reason: "malformed-response",
      detail: "dispatch authorization requires a well-formed handshake response",
    };
  }
  const lookup = lookupCapability(check.response, check.capabilityId);
  if (lookup.kind === "unassessed") {
    return {
      status: "refused",
      reason: "capability-unassessed",
      detail: `capability ${check.capabilityId} is unassessed: its inventory was not supplied to this host; unassessed is not absence`,
    };
  }
  if (lookup.kind === "unknown") {
    return {
      status: "refused",
      reason: "unknown-capability",
      detail: `capability ${check.capabilityId} is not advertised by this host`,
    };
  }
  const capability = lookup.capability;
  // Fail-closed executability gates: discovery is not permission. A row that
  // exists in a supplied inventory but is unimplemented, unverified or has
  // no proven remote execution path must never reach dispatch.
  if (capability.implementation !== "implemented") {
    return {
      status: "refused",
      reason: "not-implemented",
      detail: `capability ${capability.id} has implementation=${capability.implementation}; only "implemented" rows may dispatch`,
    };
  }
  if (capability.verification === "not-run") {
    return {
      status: "refused",
      reason: "unverified",
      detail: `capability ${capability.id} has verification=not-run; no behavioral proof exists for this host`,
    };
  }
  if (capability.execution.canRemoteInvoke !== true) {
    return {
      status: "refused",
      reason: "no-execution-path",
      detail: `capability ${capability.id} has canRemoteInvoke=${JSON.stringify(capability.execution.canRemoteInvoke)}; no proven remote execution path`,
    };
  }
  if (check.permission === undefined || !capability.permissions.includes(check.permission)) {
    return {
      status: "refused",
      reason: "missing-permission",
      detail:
        check.permission === undefined
          ? `dispatch for ${capability.id} declared no permission class; every dispatch must name the permission it exercises`
          : `capability ${capability.id} does not declare permission ${check.permission}`,
    };
  }
  // Ownership authority is the handshake's attested target evidence, not
  // the caller's say-so. A caller claim that contradicts it is refused;
  // absent server evidence stays `unknown` and fails closed.
  const attested = check.response.target?.ownership ?? "unknown";
  if (check.ownership !== undefined && check.ownership !== attested) {
    return {
      status: "refused",
      reason: "ownership-unproven",
      detail: `caller claims ownership=${check.ownership} but the handshake attests ${attested}; contradictory evidence is not proof`,
    };
  }
  if (attested !== "owned" && attested !== "explicitly-attached") {
    return {
      status: "refused",
      reason: "ownership-unproven",
      detail: `target ownership is ${attested}; dispatch requires ownership proven by the handshake target evidence for this host/session`,
    };
  }
  return { status: "pass" };
}
