/**
 * Coverage report — CAP015.
 *
 * Per-source denominators with the seven FR-05 states, independent evidence
 * axes, and the three `unknown` kinds as separate fields. Percentages exist
 * only when the supported-release set is recorded (plan section 6.1) and are
 * `unknown` — never 0% or 100% — when a denominator was not supplied
 * (capability-catalog section 1.1).
 */

import { fr05State, FR05_STATES, type Fr05State } from "./evidence.ts";
import type { SdkAggregateImport } from "./import-sdk.ts";
import {
  AUTHORITY_VALUES,
  IMPLEMENTATION_AXES,
  INVENTORY_AXES,
  VERIFICATION_AXES,
  type CapabilityKind,
  type CapabilityRecord,
  type DenominatorState,
  type EvidenceLevel,
  type ImportedSource,
  type ImportedSourceName,
  type InventoryAxis,
  type ImplementationAxis,
  type SourceAuthority,
  type VerificationAxis,
} from "./schema.ts";

export const COVERAGE_GROUP_LABELS = [
  "scripting-symbols",
  "tool-operations",
  "semantic-operations",
  "sdk-symbols",
] as const;
export type CoverageGroupLabel = (typeof COVERAGE_GROUP_LABELS)[number];

/** The three flavours of unknown, never merged into a single number. */
export type UnknownBreakdown = {
  undiscovered: number;
  unclassifiable: number;
  /** Source-level marker: 1 when this group's denominator is not supplied. */
  denominatorUnsupplied: number;
};

export type GroupCounts = {
  rows: number;
  fr05: Record<Fr05State, number>;
  inventory: Record<InventoryAxis, number>;
  implementation: Record<ImplementationAxis, number>;
  verification: Record<VerificationAxis, number>;
  authority: Record<SourceAuthority, number>;
  unknownByKind: UnknownBreakdown;
};

export type GroupPercentages = {
  implemented: number | "unknown";
  automatedFakeTested: number | "unknown";
  verifiedRealHost: number | "unknown";
};

export type CoverageGroup = {
  source: ImportedSourceName;
  kind: CapabilityKind;
  label: CoverageGroupLabel;
  denominator: DenominatorState;
  counts: GroupCounts;
  evidenceLevel: EvidenceLevel;
  /** Present only when the report's coverage state is `determined`. */
  percentages?: GroupPercentages;
};

export type SupportedRelease =
  | { state: "not-recorded" }
  | { state: "recorded"; releases: string[] };

export type CoverageState =
  | { state: "undetermined"; reason: "supported-release-set-not-recorded" }
  | { state: "determined"; releases: string[] };

export type CoverageReport = {
  schema: "ae-devtools.capability-coverage-report/v1";
  generatedAt: string;
  groups: CoverageGroup[];
  sdkInput: {
    supplied: boolean;
    reason: string;
    lastReportedAggregate: SdkAggregateImport["aggregate"] | null;
  };
  supportedRelease: SupportedRelease;
  coverage: CoverageState;
};

function zeroAxis<T extends string>(axis: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of axis) counts[value] = 0;
  return counts;
}

export function summarizeGroup(input: {
  source: ImportedSourceName;
  kind: CapabilityKind;
  label: CoverageGroupLabel;
  denominator: DenominatorState;
  records: CapabilityRecord[];
  evidenceLevel: EvidenceLevel;
}): CoverageGroup {
  const counts: GroupCounts = {
    rows: input.records.length,
    fr05: zeroAxis(FR05_STATES),
    inventory: zeroAxis(INVENTORY_AXES),
    implementation: zeroAxis(IMPLEMENTATION_AXES),
    verification: zeroAxis(VERIFICATION_AXES),
    authority: zeroAxis(AUTHORITY_VALUES),
    unknownByKind: { undiscovered: 0, unclassifiable: 0, denominatorUnsupplied: 0 },
  };
  if (input.denominator.state === "not-supplied") {
    counts.unknownByKind.denominatorUnsupplied = 1;
  }
  for (const record of input.records) {
    counts.fr05[fr05State(record)] += 1;
    counts.inventory[record.coverage.inventory] += 1;
    counts.implementation[record.coverage.implementation] += 1;
    counts.verification[record.coverage.verification] += 1;
    counts.authority[record.source.authority] += 1;
    const unknownKind = record.coverage.unknownKind;
    if (unknownKind === "undiscovered") counts.unknownByKind.undiscovered += 1;
    else if (unknownKind === "unclassifiable") counts.unknownByKind.unclassifiable += 1;
    else if (unknownKind === "denominator-unsupplied") {
      counts.unknownByKind.denominatorUnsupplied += 1;
    }
  }

  return {
    source: input.source,
    kind: input.kind,
    label: input.label,
    denominator: input.denominator,
    counts,
    evidenceLevel: input.evidenceLevel,
  };
}

/** Percentages are derived from independent axes — verified comes only from real-host evidence. */
export function groupPercentages(
  group: Pick<CoverageGroup, "denominator" | "counts">,
): GroupPercentages {
  if (group.denominator.state === "not-supplied" || group.denominator.count === 0) {
    return { implemented: "unknown", automatedFakeTested: "unknown", verifiedRealHost: "unknown" };
  }
  const total = group.denominator.count;
  const implementedRows =
    group.counts.implementation.implemented + group.counts.implementation["adapter-present"];
  return {
    implemented: (implementedRows / total) * 100,
    automatedFakeTested: (group.counts.verification["automated-fake"] / total) * 100,
    verifiedRealHost: (group.counts.verification["verified-real-host"] / total) * 100,
  };
}

export function buildCoverageReport(input: {
  scripting: ImportedSource;
  tools: ImportedSource;
  semantics: ImportedSource;
  sdk: SdkAggregateImport;
  supportedRelease: SupportedRelease;
  generatedAt: string;
}): CoverageReport {
  const groups: CoverageGroup[] = [
    summarizeGroup({
      source: "scripting",
      kind: "scripting-symbol",
      label: "scripting-symbols",
      denominator: input.scripting.denominator,
      records: input.scripting.records,
      evidenceLevel: input.scripting.evidenceLevel,
    }),
    summarizeGroup({
      source: "tools",
      kind: "tool-operation",
      label: "tool-operations",
      denominator: input.tools.denominator,
      records: input.tools.records,
      evidenceLevel: input.tools.evidenceLevel,
    }),
    summarizeGroup({
      source: "tools",
      kind: "semantic-operation",
      label: "semantic-operations",
      denominator: input.semantics.denominator,
      records: input.semantics.records,
      evidenceLevel: input.semantics.evidenceLevel,
    }),
    summarizeGroup({
      source: "sdk",
      kind: "sdk-symbol",
      label: "sdk-symbols",
      denominator: input.sdk.denominator,
      records: input.sdk.records,
      evidenceLevel: input.sdk.evidenceLevel,
    }),
  ];

  const recorded = input.supportedRelease.state === "recorded";
  if (recorded) {
    for (const group of groups) group.percentages = groupPercentages(group);
  }

  const sdkReason =
    input.sdk.denominator.state === "not-supplied" ? input.sdk.denominator.reason : "";

  return {
    schema: "ae-devtools.capability-coverage-report/v1",
    generatedAt: input.generatedAt,
    groups,
    sdkInput: {
      supplied: input.sdk.denominator.state === "supplied",
      reason: sdkReason,
      lastReportedAggregate: input.sdk.aggregate ?? null,
    },
    supportedRelease: input.supportedRelease,
    coverage:
      input.supportedRelease.state === "recorded"
        ? { state: "determined", releases: input.supportedRelease.releases }
        : { state: "undetermined", reason: "supported-release-set-not-recorded" },
  };
}
