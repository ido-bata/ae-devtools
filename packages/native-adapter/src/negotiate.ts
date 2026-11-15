/**
 * Native-adapter version negotiation — CAP046 (Issue #19, FR-06/FR-09).
 *
 * This is the contract between an external devtools adapter and a
 * native SDK plugin/host: it negotiates the adapter↔host protocol
 * version, the SDK release the plugin was built against, and which
 * coverage-matrix suite families are actually usable. It is NOT the
 * capability-catalog handshake (`packages/capability-catalog`) — that
 * one negotiates catalog capability IDs; this one negotiates the
 * plug-in boundary itself.
 *
 * Fail-closed on every axis: malformed messages, major-version
 * mismatch, a client newer than the host, an SDK release mismatch, an
 * unknown suite family, and a family the host does not advertise or
 * advertises below the client's acceptable state all refuse. Nothing
 * here launches AE or loads a plug-in; a `compatible` result means
 * "versions and advertised availability line up", never "verified on
 * a real host".
 *
 * Normative description: specs/ae-capability-coverage/contracts/native-adapter.md
 */

import {
  FAMILY_STATES,
  advertiseFamiliesFromMatrix,
  isSuiteFamily,
  type CoverageMatrix,
  type FamilyState,
  type SuiteFamily,
} from "./matrix.ts";

/**
 * Adapter↔native-host protocol version. Independent of the
 * capability-catalog `CONTRACT_VERSION` — a catalog handshake can be
 * compatible while this negotiation refuses, and vice versa.
 */
export const ADAPTER_PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export type AdapterProtocolVersion = { major: number; minor: number };

export const ADAPTER_SCHEMA = "ae-devtools/native-adapter-handshake/v1" as const;
export type AdapterSchema = typeof ADAPTER_SCHEMA;

/** SDK release identity, e.g. `{ identifier: "26.5", distribution: "macos" }`. */
export type SdkReleaseRef = {
  identifier: string;
  distribution: string;
};

/** What the adapter requires of the native side. */
export type AdapterHello = {
  schema: AdapterSchema;
  adapterId: string;
  /** Informational semver string; not part of compatibility math. */
  adapterVersion: string;
  protocolVersion: AdapterProtocolVersion;
  /** The SDK release the adapter was built/tested against. Must match exactly. */
  sdkRelease: SdkReleaseRef;
  /** Suite families the adapter intends to dispatch through. */
  requiredFamilies: SuiteFamily[];
  /**
   * States the client accepts for each required family. Defaults to
   * `["dispatchable"]` — anything weaker refuses. A client that only
   * needs build/load probing may widen this explicitly (e.g. accept
   * `"build-probe-only"` for `build-test-lifecycle`); widening is a
   * client decision, never a host claim.
   */
  acceptableStates?: FamilyState[];
};

/** What the native host/plugin advertises. */
export type HostHello = {
  schema: AdapterSchema;
  hostId: string;
  protocolVersion: AdapterProtocolVersion;
  /** The SDK release this plugin/host actually runs. */
  sdkRelease: SdkReleaseRef;
  /** Per-family availability. An unadvertised family is unavailable. */
  families: Partial<Record<SuiteFamily, { state: FamilyState; note?: string }>>;
  /** Informational; never used for compatibility decisions. */
  host?: { aeVersion?: string; os?: string; arch?: string };
};

export type RefusalReason =
  | "malformed-message"
  | "incompatible-protocol-version"
  | "unsupported-minor-version"
  | "sdk-release-mismatch"
  | "unknown-suite-family"
  | "suite-family-unavailable";

export type NegotiationResult =
  | {
      status: "compatible";
      /** Families that satisfied the client's acceptable states. */
      families: Partial<Record<SuiteFamily, FamilyState>>;
    }
  | { status: "refused"; reason: RefusalReason; detail: string };

function refused(reason: RefusalReason, detail: string): NegotiationResult {
  return { status: "refused", reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is AdapterProtocolVersion {
  return (
    isRecord(value) &&
    typeof value.major === "number" &&
    typeof value.minor === "number"
  );
}

function isReleaseRef(value: unknown): value is SdkReleaseRef {
  return (
    isRecord(value) &&
    typeof value.identifier === "string" &&
    value.identifier.length > 0 &&
    typeof value.distribution === "string" &&
    value.distribution.length > 0
  );
}

function validateHello(value: unknown, side: "adapter" | "host"): string | null {
  if (!isRecord(value)) return `${side} hello is not an object`;
  if (value.schema !== ADAPTER_SCHEMA) {
    return `${side} schema ${JSON.stringify(value.schema)} is not ${ADAPTER_SCHEMA}`;
  }
  if (!isVersion(value.protocolVersion)) {
    return `${side} protocolVersion is missing or malformed`;
  }
  if (!isReleaseRef(value.sdkRelease)) {
    return `${side} sdkRelease is missing or malformed`;
  }
  if (side === "adapter") {
    if (typeof value.adapterId !== "string" || value.adapterId.length === 0) {
      return "adapter adapterId is missing or empty";
    }
    if (!Array.isArray(value.requiredFamilies)) {
      return "adapter requiredFamilies is not an array";
    }
    for (const family of value.requiredFamilies) {
      if (typeof family !== "string" || !isSuiteFamily(family)) {
        return `adapter requiredFamilies contains unknown suite family ${JSON.stringify(family)}`;
      }
    }
    if (value.acceptableStates !== undefined) {
      if (!Array.isArray(value.acceptableStates)) {
        return "adapter acceptableStates is not an array";
      }
      for (const state of value.acceptableStates) {
        if (typeof state !== "string" || !(FAMILY_STATES as readonly string[]).includes(state)) {
          return `adapter acceptableStates contains unknown state ${JSON.stringify(state)}`;
        }
      }
    }
  } else {
    if (typeof value.hostId !== "string" || value.hostId.length === 0) {
      return "host hostId is missing or empty";
    }
    if (!isRecord(value.families)) {
      return "host families is missing or not an object";
    }
    for (const [family, entry] of Object.entries(value.families)) {
      if (!isSuiteFamily(family)) {
        return `host advertises unknown suite family ${JSON.stringify(family)}`;
      }
      if (
        !isRecord(entry) ||
        typeof entry.state !== "string" ||
        !(FAMILY_STATES as readonly string[]).includes(entry.state)
      ) {
        return `host family ${family} has a missing or unknown state`;
      }
    }
  }
  return null;
}

function sameRelease(a: SdkReleaseRef, b: SdkReleaseRef): boolean {
  return a.identifier === b.identifier && a.distribution === b.distribution;
}

/**
 * Negotiate an adapter hello against a host hello. Pure function: no
 * I/O, no AE, no plug-in. Order of checks is deliberate — shape first,
 * then version axes, then per-family availability — so a refusal
 * reason always names the earliest failing gate.
 */
export function negotiate(
  adapter: AdapterHello,
  host: HostHello,
): NegotiationResult {
  const adapterError = validateHello(adapter, "adapter");
  if (adapterError !== null) return refused("malformed-message", adapterError);
  const hostError = validateHello(host, "host");
  if (hostError !== null) return refused("malformed-message", hostError);

  const client = adapter.protocolVersion;
  const server = host.protocolVersion;
  if (client.major !== server.major) {
    return refused(
      "incompatible-protocol-version",
      `adapter protocol major ${client.major} is incompatible with host major ${server.major}`,
    );
  }
  if (client.minor > server.minor) {
    return refused(
      "unsupported-minor-version",
      `adapter protocol minor ${client.minor} is newer than host minor ${server.minor}`,
    );
  }
  if (!sameRelease(adapter.sdkRelease, host.sdkRelease)) {
    return refused(
      "sdk-release-mismatch",
      `adapter requires SDK ${adapter.sdkRelease.identifier}/${adapter.sdkRelease.distribution} but host runs ${host.sdkRelease.identifier}/${host.sdkRelease.distribution}`,
    );
  }

  const acceptable = adapter.acceptableStates ?? ["dispatchable"];
  const granted: Partial<Record<SuiteFamily, FamilyState>> = {};
  for (const family of adapter.requiredFamilies) {
    // requiredFamilies was validated above; re-narrow for the type system.
    if (!isSuiteFamily(family)) {
      return refused("unknown-suite-family", `${JSON.stringify(family)} is not a known suite family`);
    }
    const advertised = host.families[family];
    if (advertised === undefined) {
      return refused(
        "suite-family-unavailable",
        `host does not advertise ${family}; an unadvertised family is unavailable, not absent-but-supported`,
      );
    }
    if (!acceptable.includes(advertised.state)) {
      return refused(
        "suite-family-unavailable",
        `host advertises ${family} as ${advertised.state}, below the client's acceptable states [${acceptable.join(", ")}]`,
      );
    }
    granted[family] = advertised.state;
  }

  return { status: "compatible", families: granted };
}

/**
 * Build a host hello from the coverage matrix. The advertised SDK
 * release and per-family states come straight from the matrix, so a
 * host built this way can never claim more than the inventory supports.
 * `protocolVersion` defaults to the current adapter protocol; a host
 * that implements an older minor must say so explicitly.
 */
export function hostHelloFromMatrix(
  matrix: CoverageMatrix,
  input: { hostId: string; protocolVersion?: AdapterProtocolVersion; host?: HostHello["host"] },
): HostHello {
  const families = advertiseFamiliesFromMatrix(matrix);
  const advertised: HostHello["families"] = {};
  for (const [family, entry] of Object.entries(families)) {
    advertised[family as SuiteFamily] = { state: entry.state, note: entry.note };
  }
  return {
    schema: ADAPTER_SCHEMA,
    hostId: input.hostId,
    protocolVersion: input.protocolVersion ?? { ...ADAPTER_PROTOCOL_VERSION },
    sdkRelease: {
      identifier: matrix.release.identifier,
      distribution: matrix.release.distribution,
    },
    families: advertised,
    ...(input.host ? { host: input.host } : {}),
  };
}
