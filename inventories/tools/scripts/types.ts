/**
 * Shared types for the AE control tool parity inventory (CAP001-CAP004).
 *
 * Provisional: the capability-ID grammar and final catalog schema are owned by
 * ae-devtools#11. Nothing here freezes either; `semanticId` values are marked
 * provisional in the generated output.
 */

/** Side-effect class of an operation, per capability-catalog §2 (+ unknown). */
export type Access = "read" | "write" | "execute" | "host-callback" | "build-test" | "unknown";

/**
 * Evidence status of a row.
 * - source-verified: the tool's source was read and the row cites file+line that resolve.
 * - claimed/unverifiable: only a claim (README, marketing, closed source) backs the row.
 */
export type RowStatus = "source-verified" | "claimed/unverifiable";

export interface ToolRecord {
  /** Stable local id, "owner/repo". */
  id: string;
  repoUrl: string;
  /** Coarse tool kind, for filtering. */
  kind: "mcp-server" | "cep-extension" | "library" | "automation-runtime" | "experiment";
  /** Exact commit the inventory was taken at (pinned by the extractor). */
  commit: string;
  /** License as recorded from the repository, including known mismatches. */
  license: string;
  /** Where the license observation came from (file + first line / package field). */
  licenseEvidence: string;
  /** ISO date the source was last read/verified for this inventory. */
  observedAt: string;
  status: RowStatus;
  /**
   * Root used to resolve definitionFile/implementationFile, relative to the
   * inventory package (informational; the extractor resolves it to an absolute
   * path at run time).
   */
  sourceRoot: string;
  /** Extractor adapter that produced this tool's rows. */
  extraction: string;
  notes?: string;
}

export interface OperationRow {
  toolId: string;
  /** The tool's own operation name (verbatim from its source). */
  name: string;
  /** Declared input parameter names; [] when the source declares none. */
  args: string[];
  access: Access;
  /** Evidence for `access`: what the implementation actually does. */
  accessBasis: string;
  /** Host execution route from the tool surface down to After Effects. */
  route: string;
  /** Provisional normalized semantic operation id (owned by #11 later). */
  semanticId: string;
  status: RowStatus;
  /** File (tool-repo-relative) that DECLARES the operation. Same file as definitionLine. */
  definitionFile: string;
  /** 1-based line in definitionFile where the operation is declared. */
  definitionLine: number;
  /** File (tool-repo-relative) that IMPLEMENTS the operation's behaviour. */
  implementationFile: string;
  /** 1-based line in implementationFile where the behaviour starts. */
  implementationLine: number;
  /** Extra evidence notes (behaviour details, caveats). */
  note?: string;
}

/** CAP001 discovery record (search conditions + procedure). */
export interface DiscoveryRecord {
  id: string;
  purpose: string;
  searchTerms: string[];
  searchedAt: string;
  scope: string;
  selectionCriteria: string;
  outOfScope: string[];
  sources: string[];
}

/** CAP004 refresh procedure steps (re-runnable). */
export interface RefreshStep {
  step: number;
  action: string;
  command?: string;
}

export interface GeneratedBundle {
  discovery: { discovery: DiscoveryRecord; refreshProcedure: RefreshStep[] };
  tools: { tools: ToolRecord[]; generatedAt: string; counts: Record<string, number> };
  operations: { operations: OperationRow[]; counts: AccessCounts };
  semantics: SemanticBundle;
}

export interface AccessCounts {
  total: number;
  read: number;
  write: number;
  execute: number;
  "host-callback": number;
  "build-test": number;
  unknown: number;
}

export interface SemanticOpMeta {
  label: string;
  adobeOperation: string;
}

export interface SemanticOp {
  id: string;
  provisional: true;
  label: string;
  /**
   * The single underlying Adobe operation/API surface reached through this
   * semantic id. Several wrappers over one API are recorded once here.
   */
  adobeOperation: string;
  /** Tool ids that implement it (any of them). */
  tools: string[];
}

export interface GapRow {
  semanticId: string;
  provisional: true;
  label: string;
  /** Implemented by ae-a8n (host dispatch table / public API). */
  inAeA8n: boolean;
  /** Implemented by ae-devtools experiments/runtime-bridge. */
  inAeDevtools: boolean;
  /** Competitor tool ids implementing it (excluding ae-a8n / ae-devtools). */
  competitors: string[];
  /** True when a competitor reaches an Adobe operation neither consumer covers. */
  gap: boolean;
}

export interface SemanticBundle {
  provisional: true;
  note: string;
  semanticOps: SemanticOp[];
  gapMatrix: GapRow[];
}
