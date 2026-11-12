/**
 * Capability record schema — Issue #11 (CAP013).
 *
 * Finalized from capability-catalog §2 with the §1.1 persistence asymmetry
 * made explicit: SDK symbol rows exist only when supplied at build time by a
 * consumer holding the licensed SDK, and are never committed. Evidence axes
 * (`inventory`, `verification`) are separate fields; they are never collapsed
 * into a single claim. `null` and `unknown` mean absence of proof.
 */

export const CONTRACT_VERSION = { major: 1, minor: 0 } as const;
export type ContractVersion = { major: number; minor: number };

export const CAPABILITY_KINDS = [
  "scripting-symbol",
  "sdk-symbol",
  "tool-operation",
  "semantic-operation",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** §1.1: where the row lives. SDK rows are always build-time supplied. */
export type RowPersistence = "repository" | "build-time-supplied";

export type SourcePublisher = "adobe" | "community" | "third-party" | "local";
export type SourceAuthority = "primary" | "community-maintained" | "source-verified" | "claim-only";

export type SourceDescriptor = {
  publisher: SourcePublisher;
  uri: string;
  version: string;
  revision?: string;
  /** Original symbol spelling as written by the source. */
  symbol?: string;
  license?: string;
  observedAt: string;
  authority: SourceAuthority;
};

export type AccessClass =
  | "read"
  | "read-write"
  | "write"
  | "execute"
  | "host-callback"
  | "build-test"
  | "unknown";

export type ExecutionClass =
  | "extendscript"
  | "aegp-native"
  | "effect-native"
  | "native-io"
  | "cep"
  | "uxp"
  | "aerender"
  | "os-automation"
  | "unknown";

export type ExecutionDescriptor = {
  class: ExecutionClass;
  lifecycle: string;
  adapter?: string;
  /** `null` = unverified; never coerced to true or false. */
  canRemoteInvoke: boolean | null;
};

export type Compatibility = {
  aeBuilds?: string[];
  sdkVersions?: string[];
  os?: Array<"win32" | "darwin">;
  architectures?: string[];
  requiredPlugins?: string[];
  requiredPermissions?: string[];
};

export type Risk = {
  effect: "none" | "project-write" | "filesystem" | "host-lifecycle" | "unknown";
  trust: "read-only" | "named-operation" | "privileged-dev-code" | "native-plugin";
  undoable: boolean | null;
  retrySafety: "idempotent-proven" | "never" | "unknown";
};

/**
 * Evidence artifacts are typed so the drift gate can check that a coverage
 * claim never outruns the artifact behind it (capability-catalog §6).
 */
export type EvidenceKind = "source-doc" | "source-impl" | "automated-test" | "real-host";
export type EvidenceRef = {
  kind: EvidenceKind;
  ref: string;
  /** Required for `real-host` evidence when the record claims OS bounds. */
  platform?: "win32" | "darwin";
};

export type InventoryAxis = "discovered" | "source-reviewed" | "unverified";
export type ReachabilityAxis = "reachable" | "not-reachable" | "unknown";
export type ImplementationAxis =
  | "none"
  | "adapter-present"
  | "implemented"
  | "unsupported"
  | "unknown";
export type VerificationAxis = "not-run" | "automated-fake" | "verified-real-host";

/**
 * The three flavours of `unknown` from comment 6813348033 stay distinct and
 * are never merged into one number:
 *   undiscovered          — expected symbol not found in the source snapshot
 *   unclassifiable        — row exists but cannot be classified (#10: 552, #8: access unknown)
 *   denominator-unsupplied— SDK per-symbol rows not supplied to this environment (§1.1)
 */
export type UnknownKind = "undiscovered" | "unclassifiable" | "denominator-unsupplied";

export const UNKNOWN_KINDS: readonly UnknownKind[] = [
  "undiscovered",
  "unclassifiable",
  "denominator-unsupplied",
];

export type CoverageAxes = {
  inventory: InventoryAxis;
  reachability: ReachabilityAxis;
  implementation: ImplementationAxis;
  verification: VerificationAxis;
  /** Set only when this row's own state is `unknown`; see UnknownKind. */
  unknownKind?: UnknownKind;
  evidenceRefs: EvidenceRef[];
  unsupportedReason?: string;
  issueRefs?: string[];
};

export type LinkBasis = "semantic-grouping" | "underlying-symbol";

export type CapabilityLink = {
  to: string;
  basis: LinkBasis;
};

export type CapabilityRecord = {
  id: string;
  kind: CapabilityKind;
  persistence: RowPersistence;
  source: SourceDescriptor;
  category: string;
  access: AccessClass;
  execution: ExecutionDescriptor;
  compatibility: Compatibility;
  risk: Risk;
  coverage: CoverageAxes;
  /** Cross-source dedupe links: one underlying capability, counted once. */
  links?: CapabilityLink[];
  aliases?: string[];
};

/** Test/fixture initializer: every field optional except identity. */
export type CapabilityRecordInit = Partial<Omit<CapabilityRecord, "coverage">> & {
  id: string;
  coverage?: Partial<CoverageAxes>;
};

/** §1.1 enforcement: SDK symbol rows are never repository-persisted. */
export function persistenceForKind(kind: CapabilityKind): RowPersistence {
  return kind === "sdk-symbol" ? "build-time-supplied" : "repository";
}

export type DenominatorState =
  | { state: "supplied"; count: number }
  | { state: "not-supplied"; reason: string };

/** Input-side evidence vocabulary, preserved verbatim (issue #11 comment 6813348033). */
export type EvidenceLevel = {
  inventory: string;
  verification: string;
  realHost: string;
  statement: string;
};

export type ImportedSourceName = "scripting" | "tools" | "sdk";

export type ImportedSource = {
  source: ImportedSourceName;
  records: CapabilityRecord[];
  denominator: DenominatorState;
  evidenceLevel: EvidenceLevel;
  provenance: Record<string, unknown>;
};

/**
 * Conservative risk derived from the access class. Absence of proof stays
 * `null`/`unknown`; execution of host lifecycle actions is never "none".
 */
export function riskForAccess(access: AccessClass): Risk {
  switch (access) {
    case "read":
      return { effect: "none", trust: "read-only", undoable: null, retrySafety: "unknown" };
    case "read-write":
    case "write":
      return { effect: "project-write", trust: "named-operation", undoable: null, retrySafety: "unknown" };
    case "execute":
    case "host-callback":
      return { effect: "host-lifecycle", trust: "native-plugin", undoable: null, retrySafety: "unknown" };
    case "build-test":
      return { effect: "none", trust: "named-operation", undoable: null, retrySafety: "unknown" };
    default:
      return { effect: "unknown", trust: "named-operation", undoable: null, retrySafety: "unknown" };
  }
}
