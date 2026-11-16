/**
 * Capability manifest generation — CAP013/CAP014 output artifact.
 *
 * The manifest is the repository-persisted half of capability-catalog section
 * 1.1: scripting, tool and semantic rows only. SDK symbol rows must never
 * appear here — `buildCatalog` refuses them — because a reader must not be
 * able to reconstruct an SDK symbol list from this repository alone.
 */

import {
  CONTRACT_VERSION,
  type CapabilityRecord,
  type ContractVersion,
  type EvidenceLevel,
  type ImportedSource,
} from "./schema.ts";
import type { SdkAggregateImport } from "./import-sdk.ts";

/** path -> sha256 of each read-only inventory input the manifest was built from. */
export type InputHashes = Record<string, string>;

export type CatalogManifest = {
  schema: "ae-devtools.capability-catalog/v1";
  contractVersion: ContractVersion;
  generatedFrom: Array<{ path: string; sha256: string }>;
  /** Repository-persisted rows only, sorted by id. Never contains ae.sdk.* rows. */
  records: CapabilityRecord[];
  sdk: {
    persistence: "aggregate-only";
    release: { identifier: string; distribution: string };
    redistribution: { committedContent: string };
    totals: { symbols: number; unknown: number; byClass: Record<string, number> };
    denominatorCaveats: string[];
    evidenceLevel: EvidenceLevel;
    provenance: { archiveSha256: string | null; combinedSha256?: string };
  };
};

function byId(a: CapabilityRecord, b: CapabilityRecord): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function buildCatalog(input: {
  scripting: ImportedSource;
  tools: ImportedSource;
  semantics: ImportedSource;
  sdk: SdkAggregateImport;
  files: InputHashes;
}): CatalogManifest {
  const records = [
    ...input.scripting.records,
    ...input.tools.records,
    ...input.semantics.records,
  ];

  const seen = new Set<string>();
  for (const record of records) {
    if (record.persistence !== "repository") {
      throw new Error(`refusing to commit a non-repository row: ${record.id}`);
    }
    if (record.kind === "sdk-symbol" || record.id.startsWith("ae.sdk.")) {
      throw new Error(`refusing to commit an SDK symbol row: ${record.id}`);
    }
    if (seen.has(record.id)) throw new Error(`duplicate capability id: ${record.id}`);
    seen.add(record.id);
  }
  records.sort(byId);

  const generatedFrom = Object.entries(input.files)
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schema: "ae-devtools.capability-catalog/v1",
    contractVersion: CONTRACT_VERSION,
    generatedFrom,
    records,
    sdk: {
      persistence: "aggregate-only",
      release: input.sdk.aggregate.release,
      redistribution: input.sdk.aggregate.redistribution,
      totals: input.sdk.aggregate.totals,
      denominatorCaveats: input.sdk.aggregate.denominatorCaveats,
      evidenceLevel: input.sdk.aggregate.evidenceLevel,
      provenance: {
        archiveSha256: input.sdk.provenance.acquisition.archiveSha256,
        combinedSha256: input.sdk.provenance.corpus?.combinedSha256,
      },
    },
  };
}

/** Byte-stable serialization: fixed key order via object literals, sorted records. */
export function serializeCatalog(manifest: CatalogManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
