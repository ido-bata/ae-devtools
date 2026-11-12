/**
 * Importer for the #10 SDK inventory.
 *
 * Two distinct inputs (capability-catalog §1.1):
 *   - the committed aggregate + provenance: provenance only, NO rows, and the
 *     row denominator stays `not-supplied` — a reported historical total is
 *     not a live per-symbol denominator;
 *   - locally supplied per-symbol rows (licensed SDK, build time only):
 *     real records with `persistence: "build-time-supplied"`, never committed.
 */

import { sdkSymbolId } from "./ids.ts";
import {
  persistenceForKind,
  type AccessClass,
  type CapabilityRecord,
  type EvidenceLevel,
  type ImportedSource,
} from "./schema.ts";

type AggregateFile = {
  redistribution: { committedContent?: string; headersNotice?: string; licenseFileInPackage?: boolean; detailContent?: string };
  release: { identifier: string; distribution: string; headersRoot?: string };
  coverageSemantics?: Record<string, unknown>;
  evidenceLevel: EvidenceLevel;
  totals: { symbols: number; unknown: number; byClass: Record<string, number> };
  denominatorCaveats: string[];
};

type ProvenanceFile = {
  acquisition: { archiveSha256: string | null };
  license?: Record<string, unknown>;
  corpus?: Record<string, unknown>;
};

export type SdkAggregateImport = Omit<ImportedSource, "provenance"> & {
  supplied: false;
  aggregate: {
    release: { identifier: string; distribution: string };
    redistribution: { committedContent: string };
    coverageSemantics?: Record<string, unknown>;
    totals: { symbols: number; unknown: number; byClass: Record<string, number> };
    denominatorCaveats: string[];
    evidenceLevel: EvidenceLevel;
  };
  provenance: ProvenanceFile;
};

type SdkDetailRow = {
  kind: string;
  name: string;
  header: string;
  line: number;
  class: string;
  evidence: string;
  rule: string;
  unknownReason?: string;
  deprecatedHeader?: boolean;
};

export type SdkDetailFile = { release?: string; symbols: SdkDetailRow[] };

const CLASS_ACCESS: Record<string, AccessClass> = {
  "external-command": "execute",
  "in-host-plugin-command": "execute",
  "host-callback": "host-callback",
  "build-test-lifecycle": "build-test",
  "unsupported-or-unknown": "unknown",
};

const CLASS_LIFECYCLE: Record<string, string> = {
  "external-command": "suite acquisition (client-invoked)",
  "in-host-plugin-command": "plug-in dispatch (host-invoked)",
  "host-callback": "host-owned callback (FR-09: no generic remote invocation)",
  "build-test-lifecycle": "plug-in registration/version declaration",
  "unsupported-or-unknown": "unknown",
};

export function importSdkAggregate(input: {
  aggregate: AggregateFile;
  provenance: ProvenanceFile;
}): SdkAggregateImport {
  const a = input.aggregate;
  return {
    source: "sdk",
    records: [],
    denominator: {
      state: "not-supplied",
      reason:
        "SDK per-symbol rows are build-time supplied only (capability-catalog §1.1); no licensed SDK rows were supplied to this environment.",
    },
    evidenceLevel: a.evidenceLevel,
    supplied: false,
    aggregate: {
      release: { identifier: a.release.identifier, distribution: a.release.distribution },
      redistribution: { committedContent: a.redistribution.committedContent ?? "" },
      coverageSemantics: a.coverageSemantics,
      totals: { symbols: a.totals.symbols, unknown: a.totals.unknown, byClass: a.totals.byClass },
      denominatorCaveats: a.denominatorCaveats,
      evidenceLevel: a.evidenceLevel,
    },
    provenance: input.provenance,
  };
}

export function importSdkRows(input: {
  detail: SdkDetailFile;
  observedAt: string;
}): CapabilityRecord[] {
  const seen = new Set<string>();
  const records = input.detail.symbols.map((row): CapabilityRecord => {
    const id = sdkSymbolId(row.header, row.name);
    if (seen.has(id)) throw new Error(`duplicate capability id: ${id}`);
    seen.add(id);
    const access = CLASS_ACCESS[row.class];
    if (access === undefined) throw new Error(`unmapped sdk class: ${JSON.stringify(row.class)}`);
    const unclassifiable = row.class === "unsupported-or-unknown";
    return {
      id,
      kind: "sdk-symbol",
      persistence: persistenceForKind("sdk-symbol"),
      source: {
        publisher: "adobe",
        uri: `header://${row.header}`,
        version: input.detail.release ?? "unresolved",
        symbol: row.name,
        license: "no-grant-found",
        observedAt: input.observedAt,
        authority: "primary",
      },
      category: row.class,
      access,
      execution: {
        class: "unknown",
        lifecycle: CLASS_LIFECYCLE[row.class] ?? "unknown",
        canRemoteInvoke: row.class === "host-callback" ? false : null,
      },
      compatibility: input.detail.release ? { sdkVersions: [input.detail.release] } : {},
      risk: { effect: "unknown", trust: "native-plugin", undoable: null, retrySafety: "unknown" },
      coverage: {
        inventory: "source-reviewed",
        reachability: "unknown",
        implementation: "unknown",
        verification: "not-run",
        ...(unclassifiable ? { unknownKind: "unclassifiable" as const } : {}),
        evidenceRefs: [{ kind: "source-doc", ref: `header://${row.header}:${row.line}` }],
      },
    };
  });
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return records;
}
