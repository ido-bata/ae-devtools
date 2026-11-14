/**
 * Drift gate — CAP015.
 *
 * Fails when a source snapshot gains a symbol without a catalog row, when the
 * manifest holds a row the source dropped, when a coverage claim outruns its
 * evidence, or when a report publishes numbers it may not publish. The SDK
 * source reports `unknown` unless SDK-derived rows were actually supplied —
 * a report without them may never claim "no drift" (capability-catalog
 * section 1.1, issue #11 comment 6812931711).
 */

import { promotionViolations } from "./evidence.ts";
import type { CoverageReport } from "./coverage.ts";
import type { CatalogManifest } from "./generate.ts";
import type { CapabilityRecord, ImportedSource, ImportedSourceName } from "./schema.ts";

export type ViolationCode =
  | "unregistered-symbol"
  | "stale-catalog-row"
  | "unjustified-promotion"
  | "unsupported-without-reason"
  | "windows-unverified"
  | "platform-unverified"
  | "unjustified-no-drift-claim"
  | "denominator-coerced"
  | "coverage-published-while-undetermined";

export type DriftViolation = {
  code: ViolationCode;
  id?: string;
  source?: string;
  detail: string;
};

export type SourceVerdict = {
  source: ImportedSourceName;
  verdict: "clean" | "drift" | "unknown";
  reason: string;
};

export type DriftResult = {
  ok: boolean;
  violations: DriftViolation[];
  verdicts: SourceVerdict[];
};

function manifestIdsFor(records: CapabilityRecord[], kind: (id: string) => boolean): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (kind(record.id)) ids.add(record.id);
  }
  return ids;
}

function diffRegistration(
  source: ImportedSourceName,
  fresh: Set<string>,
  baseline: Set<string>,
  violations: DriftViolation[],
): SourceVerdict {
  let unregistered = 0;
  for (const id of [...fresh].sort()) {
    if (!baseline.has(id)) {
      unregistered += 1;
      violations.push({
        code: "unregistered-symbol",
        source,
        id,
        detail: `${source} snapshot has a symbol with no catalog row`,
      });
    }
  }
  let stale = 0;
  for (const id of [...baseline].sort()) {
    if (!fresh.has(id)) {
      stale += 1;
      violations.push({
        code: "stale-catalog-row",
        source,
        id,
        detail: `catalog row has no matching ${source} snapshot symbol`,
      });
    }
  }
  if (unregistered === 0 && stale === 0) {
    return { source, verdict: "clean", reason: "manifest matches source snapshot" };
  }
  return {
    source,
    verdict: "drift",
    reason: `${unregistered} unregistered, ${stale} stale rows`,
  };
}

/** SDK drift can only be evaluated when SDK-derived rows are supplied. */
export function compareSdkRows(
  baseline: CapabilityRecord[],
  current: CapabilityRecord[],
): { added: string[]; removed: string[] } {
  const base = new Set(baseline.map((r) => r.id));
  const cur = new Set(current.map((r) => r.id));
  return {
    added: [...cur].filter((id) => !base.has(id)).sort(),
    removed: [...base].filter((id) => !cur.has(id)).sort(),
  };
}

function sdkVerdict(
  sdk: ImportedSource,
  sdkRows: CapabilityRecord[] | undefined,
  sdkBaselineRows: CapabilityRecord[] | undefined,
): SourceVerdict {
  if (sdkRows === undefined) {
    const reason =
      sdk.denominator.state === "not-supplied"
        ? sdk.denominator.reason
        : "SDK rows supplied but drift requires a comparison input";
    return { source: "sdk", verdict: "unknown", reason };
  }
  if (sdkBaselineRows === undefined) {
    return {
      source: "sdk",
      verdict: "unknown",
      reason: "SDK rows supplied but no baseline exists to compare against (§1.1: no committed SDK baseline)",
    };
  }
  const diff = compareSdkRows(sdkBaselineRows, sdkRows);
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return { source: "sdk", verdict: "clean", reason: "supplied SDK rows match the supplied baseline" };
  }
  return {
    source: "sdk",
    verdict: "drift",
    reason: `${diff.added.length} added, ${diff.removed.length} removed SDK symbols`,
  };
}

function checkClaimedReport(report: CoverageReport, violations: DriftViolation[]): void {
  if (report.coverage.state === "undetermined") {
    for (const group of report.groups) {
      if (group.percentages !== undefined) {
        violations.push({
          code: "coverage-published-while-undetermined",
          source: group.source,
          detail: `group ${group.label} publishes percentages while the supported-release set is not recorded`,
        });
      }
    }
  }
  for (const group of report.groups) {
    if (group.denominator.state !== "not-supplied" || group.percentages === undefined) continue;
    for (const [axis, value] of Object.entries(group.percentages)) {
      if (typeof value === "number") {
        violations.push({
          code: "denominator-coerced",
          source: group.source,
          detail: `group ${group.label} publishes numeric ${axis}=${value} without a supplied denominator`,
        });
      }
    }
  }
}

export function runDriftGate(input: {
  manifest: CatalogManifest;
  imports: {
    scripting: ImportedSource;
    tools: ImportedSource;
    semantics: ImportedSource;
    sdk: ImportedSource;
  };
  sdkRows?: CapabilityRecord[];
  sdkBaselineRows?: CapabilityRecord[];
  claimedVerdicts?: SourceVerdict[];
  claimedReport?: CoverageReport;
}): DriftResult {
  const violations: DriftViolation[] = [];

  // Claim integrity of the published manifest itself (CAP015 / acceptance #1).
  for (const record of input.manifest.records) {
    for (const violation of promotionViolations(record)) {
      violations.push({ code: violation.code, id: violation.id, detail: violation.detail });
    }
  }

  const manifestScripting = manifestIdsFor(input.manifest.records, (id) =>
    id.startsWith("ae.scripting."),
  );
  const manifestTools = manifestIdsFor(
    input.manifest.records,
    (id) => id.startsWith("ae.tool.") || id.startsWith("ae.operation."),
  );

  const freshScripting = new Set(input.imports.scripting.records.map((r) => r.id));
  const freshTools = new Set([
    ...input.imports.tools.records.map((r) => r.id),
    ...input.imports.semantics.records.map((r) => r.id),
  ]);

  const verdicts: SourceVerdict[] = [
    diffRegistration("scripting", freshScripting, manifestScripting, violations),
    diffRegistration("tools", freshTools, manifestTools, violations),
    sdkVerdict(input.imports.sdk, input.sdkRows, input.sdkBaselineRows),
  ];

  for (const claimed of input.claimedVerdicts ?? []) {
    const actual = verdicts.find((v) => v.source === claimed.source);
    if (claimed.verdict === "clean" && actual && actual.verdict !== "clean") {
      violations.push({
        code: "unjustified-no-drift-claim",
        source: claimed.source,
        detail: `claimed clean for ${claimed.source} but gate verdict is ${actual.verdict}: ${actual.reason}`,
      });
    }
  }

  if (input.claimedReport) checkClaimedReport(input.claimedReport, violations);

  return { ok: violations.length === 0, violations, verdicts };
}
