/**
 * Native-adapter version negotiation — CAP046 (Issue #19, FR-06/FR-09),
 * redesigned so dispatchability is per concrete operation, never per
 * coverage-matrix class.
 *
 * This is the contract between an external devtools adapter and a
 * native SDK plugin/host: it negotiates the adapter↔host protocol
 * version, the SDK release the plugin was built against, and which
 * *operation entries* (see `src/operations.ts`) are actually usable.
 * It is NOT the capability-catalog handshake
 * (`packages/capability-catalog`) — that one negotiates catalog
 * capability IDs; this one negotiates the plug-in boundary itself.
 *
 * The five coverage-matrix classes are reporting metadata only. A
 * HostHello may echo them under `classes` for diagnostics, but
 * `negotiate()` never reads them for availability, and a class-level
 * `dispatchable` claim is malformed — fail closed.
 *
 * Fail-closed on every axis: malformed messages, major-version
 * mismatch, a client newer than the host, an SDK release mismatch, an
 * unknown operation id, an operation the host does not advertise, and
 * an advertised state below the client's acceptable state all refuse.
 * A host may advertise `dispatchable` for an operation only when the
 * committed registry marks that entry `implemented &&
 * verifiedOnRealHost && externalDispatchVerified` — in-AE call success
 * alone is not external-dispatch authorization; anything weaker is a
 * malformed claim. Nothing
 * here launches AE or loads a plug-in; a `compatible` result means
 * "versions and advertised per-operation availability line up", never
 * "verified on a real host".
 *
 * Normative description: specs/ae-capability-coverage/contracts/native-adapter.md
 */

import {
  MATRIX_CLASSES,
  isMatrixClass,
  type CoverageMatrix,
  type MatrixClass,
} from "./matrix.ts";
import {
  DISPATCH_ENTRIES,
  ENTRY_STATES,
  findOperation,
  isDispatchableEntry,
  operationState,
  type EntryState,
} from "./operations.ts";

/**
 * Adapter↔native-host protocol version. Independent of the
 * capability-catalog `CONTRACT_VERSION` — a catalog handshake can be
 * compatible while this negotiation refuses, and vice versa.
 */
export const ADAPTER_PROTOCOL_VERSION = { major: 2, minor: 0 } as const;
export type AdapterProtocolVersion = { major: number; minor: number };

export const ADAPTER_SCHEMA = "ae-devtools/native-adapter-handshake/v2" as const;
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
  /**
   * Concrete operation ids (`"<Suite>.<member>"`, see
   * `src/operations.ts`) the adapter intends to dispatch through.
   * Coverage-matrix class names are NOT valid operation ids.
   */
  requiredOperations: string[];
  /**
   * States the client accepts for each required operation. Defaults to
   * `["dispatchable"]` — anything weaker refuses. A client that only
   * needs build/load probing may widen this explicitly; widening is a
   * client decision, never a host claim.
   */
  acceptableStates?: EntryState[];
};

/** What the native host/plugin advertises. */
export type HostHello = {
  schema: AdapterSchema;
  hostId: string;
  protocolVersion: AdapterProtocolVersion;
  /** The SDK release this plugin/host actually runs. */
  sdkRelease: SdkReleaseRef;
  /**
   * Per-operation availability, keyed by operation id. An
   * unadvertised operation is unavailable. Every advertised id must
   * exist in the committed registry, and `dispatchable` may only be
   * claimed for a registry entry that is `implemented &&
   * verifiedOnRealHost && externalDispatchVerified`.
   */
  operations: Record<string, { state: EntryState; note?: string }>;
  /**
   * OPTIONAL reporting echo of the coverage-matrix classes. Never
   * consulted for availability; a `dispatchable` value here is
   * malformed because classes are not dispatchable.
   */
  classes?: Partial<Record<MatrixClass, { state: string; note?: string }>>;
  /** Informational; never used for compatibility decisions. */
  host?: { aeVersion?: string; os?: string; arch?: string };
};

export type RefusalReason =
  | "malformed-message"
  | "incompatible-protocol-version"
  | "unsupported-minor-version"
  | "sdk-release-mismatch"
  | "operation-unavailable";

export type NegotiationResult =
  | {
      status: "compatible";
      /** Operations that satisfied the client's acceptable states. */
      operations: Record<string, EntryState>;
    }
  | { status: "refused"; reason: RefusalReason; detail: string };

/** Strength ordering for advertised-vs-registry state comparison. */
const STATE_RANK: Record<EntryState, number> = {
  dispatchable: 3,
  "implemented-unverified": 2,
  "inventory-only": 1,
  "unsupported-or-unknown": 0,
};

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
    if (!Array.isArray(value.requiredOperations)) {
      return "adapter requiredOperations is not an array";
    }
    for (const op of value.requiredOperations) {
      if (typeof op !== "string" || findOperation(op) === null) {
        return `adapter requiredOperations contains unknown operation ${JSON.stringify(op)}`;
      }
    }
    if (value.acceptableStates !== undefined) {
      if (!Array.isArray(value.acceptableStates)) {
        return "adapter acceptableStates is not an array";
      }
      for (const state of value.acceptableStates) {
        if (typeof state !== "string" || !(ENTRY_STATES as readonly string[]).includes(state)) {
          return `adapter acceptableStates contains unknown state ${JSON.stringify(state)}`;
        }
      }
    }
  } else {
    if (typeof value.hostId !== "string" || value.hostId.length === 0) {
      return "host hostId is missing or empty";
    }
    if (!isRecord(value.operations)) {
      return "host operations is missing or not an object";
    }
    for (const [op, entry] of Object.entries(value.operations)) {
      const registryEntry = findOperation(op);
      if (registryEntry === null) {
        return `host advertises unknown operation ${JSON.stringify(op)}`;
      }
      if (
        !isRecord(entry) ||
        typeof entry.state !== "string" ||
        !(ENTRY_STATES as readonly string[]).includes(entry.state)
      ) {
        return `host operation ${op} has a missing or unknown state`;
      }
      const advertisedState = entry.state as EntryState;
      if (advertisedState === "dispatchable" && !isDispatchableEntry(registryEntry)) {
        return (
          `host claims ${op} dispatchable but the registry entry is ` +
          `implemented=${registryEntry.implemented} verifiedOnRealHost=${registryEntry.verifiedOnRealHost} ` +
          `externalDispatchVerified=${registryEntry.externalDispatchVerified === true}; ` +
          "a dispatchable claim requires per-entry implemented+verifiedOnRealHost+externalDispatchVerified evidence"
        );
      }
      // A host may downgrade (claim less than the registry supports) but
      // never upgrade: the advertised state must not outrank the state
      // the committed per-entry evidence derives.
      if (STATE_RANK[advertisedState] > STATE_RANK[operationState(registryEntry)]) {
        return (
          `host advertises ${op} as ${advertisedState} but registry evidence ` +
          `derives ${operationState(registryEntry)}; stronger-than-evidence claims are malformed`
        );
      }
    }
    if (value.classes !== undefined) {
      if (!isRecord(value.classes)) {
        return "host classes is not an object";
      }
      for (const [cls, entry] of Object.entries(value.classes)) {
        if (!isMatrixClass(cls)) {
          return `host reports unknown matrix class ${JSON.stringify(cls)}`;
        }
        // state is a free-form reporting string; only shape is checked.
        if (!isRecord(entry) || typeof entry.state !== "string" || entry.state.length === 0) {
          return `host class ${cls} has a missing or empty state`;
        }
        if (entry.state === "dispatchable") {
          return (
            `host advertises matrix class ${cls} as dispatchable; classes are ` +
            "classification/reporting metadata and can never be dispatched — per-operation evidence is required"
          );
        }
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
 * then version axes, then per-operation availability — so a refusal
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
  const granted: Record<string, EntryState> = {};
  for (const op of adapter.requiredOperations) {
    // requiredOperations was validated above; re-narrow for the type system.
    if (findOperation(op) === null) {
      return refused("malformed-message", `${JSON.stringify(op)} is not a known operation`);
    }
    const advertised = host.operations[op];
    if (advertised === undefined) {
      return refused(
        "operation-unavailable",
        `host does not advertise ${op}; an unadvertised operation is unavailable, not absent-but-supported`,
      );
    }
    if (!acceptable.includes(advertised.state)) {
      return refused(
        "operation-unavailable",
        `host advertises ${op} as ${advertised.state}, below the client's acceptable states [${acceptable.join(", ")}]`,
      );
    }
    granted[op] = advertised.state;
  }

  return { status: "compatible", operations: granted };
}

/**
 * Build a host hello from the coverage matrix plus the committed
 * operation registry. Per-operation states come from
 * `src/operations.ts` (the per-entry evidence SoT); the matrix
 * contributes only the SDK release identity and the reporting-only
 * `classes` echo. A host built this way can never claim more than the
 * registry supports — and today no entry is dispatchable, so every
 * required-operation negotiation under default `acceptableStates`
 * refuses. That is the intended fail-closed posture, not a bug.
 * `protocolVersion` defaults to the current adapter protocol; a host
 * that implements an older minor must say so explicitly.
 */
export function hostHelloFromMatrix(
  matrix: CoverageMatrix,
  input: { hostId: string; protocolVersion?: AdapterProtocolVersion; host?: HostHello["host"] },
): HostHello {
  const operations: HostHello["operations"] = {};
  for (const entry of DISPATCH_ENTRIES) {
    operations[entry.id] = {
      state: operationState(entry),
      ...(entry.note ? { note: entry.note } : {}),
    };
  }
  const classes: NonNullable<HostHello["classes"]> = {};
  for (const cls of MATRIX_CLASSES) {
    const row = matrix.classes[cls];
    if (row !== undefined) {
      classes[cls] = { state: row.state, note: row.note };
    }
  }
  return {
    schema: ADAPTER_SCHEMA,
    hostId: input.hostId,
    protocolVersion: input.protocolVersion ?? { ...ADAPTER_PROTOCOL_VERSION },
    sdkRelease: {
      identifier: matrix.release.identifier,
      distribution: matrix.release.distribution,
    },
    operations,
    classes,
    ...(input.host ? { host: input.host } : {}),
  };
}
