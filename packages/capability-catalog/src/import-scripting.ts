/**
 * Importer for the #9 scripting inventory (public, community-maintained
 * reference). Rows are repository-persisted; evidence stays source-doc level.
 */

import { scriptingId } from "./ids.ts";
import {
  riskForAccess,
  type AccessClass,
  type CapabilityRecord,
  type EvidenceLevel,
  type ImportedSource,
  type InventoryAxis,
  type SourceAuthority,
  type SourcePublisher,
  type VerificationAxis,
} from "./schema.ts";

type ScriptingSymbolRow = {
  id: string;
  kind: string;
  owner: string;
  member: string;
  sourceKey: string;
  sourceTier: string;
  publisher: string;
  authority: string;
  url: string;
  anchor: string | null;
  versionAdded: string | null;
  access: string | null;
  status: string;
  notes: string[] | null;
};

export type ScriptingSymbolsFile = { symbols: ScriptingSymbolRow[] };
export type ScriptingSummaryFile = {
  evidenceLevel: EvidenceLevel;
  sourceTiers?: Record<string, unknown>;
  denominators?: { scriptingMembers?: number };
};
export type SourcesLockFile = {
  sources: Array<{ key: string; revision: string; fetchedAt: string }>;
};

const ACCESS_MAP: Record<string, AccessClass> = {
  read: "read",
  "read-write": "read-write",
  write: "write",
};

const INVENTORY_AXES: readonly InventoryAxis[] = ["discovered", "source-reviewed", "unverified"];
const VERIFICATION_AXES: readonly VerificationAxis[] = ["not-run", "automated-fake", "verified-real-host"];
const AUTHORITIES: readonly SourceAuthority[] = ["primary", "community-maintained", "source-verified", "claim-only"];

function requireAxis<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`unmapped ${what}: ${JSON.stringify(value)}`);
  }
  return value as T;
}

function publisherForTier(sourceTier: string): SourcePublisher {
  if (sourceTier === "adobe-official") return "adobe";
  if (sourceTier === "community-reference") return "community";
  return "third-party";
}

function requireAccess(value: string | null): AccessClass {
  if (value === null) return "unknown";
  const mapped = ACCESS_MAP[value];
  if (mapped === undefined) throw new Error(`unmapped scripting access: ${JSON.stringify(value)}`);
  return mapped;
}

function scriptingRecord(
  row: ScriptingSymbolRow,
  lockByKey: Map<string, { revision: string; fetchedAt: string }>,
  inventory: InventoryAxis,
  verification: VerificationAxis,
): CapabilityRecord {
  if (!row.id.startsWith("provisional.")) {
    throw new Error(`unexpected scripting id shape: ${row.id}`);
  }
  const id = scriptingId(row.owner, row.member);
  if (id !== row.id.slice("provisional.".length)) {
    throw new Error(`scripting id drift between owner/member and id: ${row.id}`);
  }
  const access = requireAccess(row.access);
  const authority = requireAxis<SourceAuthority>(row.authority, AUTHORITIES, "row authority");
  const lock = lockByKey.get(row.sourceKey);
  const domain = row.notes?.find((note) => note.startsWith("domain="))?.slice("domain=".length) ?? "unknown";

  return {
    id,
    kind: "scripting-symbol",
    persistence: "repository",
    source: {
      publisher: publisherForTier(row.sourceTier),
      uri: row.url,
      version: "unresolved",
      revision: lock?.revision,
      symbol: `${row.owner}.${row.member}`,
      observedAt: lock?.fetchedAt ?? "unresolved",
      authority,
    },
    category: domain,
    access,
    execution: { class: "extendscript", lifecycle: "AE scripting host", canRemoteInvoke: null },
    compatibility: {},
    risk: riskForAccess(access),
    coverage: {
      inventory,
      reachability: "unknown",
      implementation: "unknown",
      verification,
      evidenceRefs: [{ kind: "source-doc", ref: row.anchor ? `${row.url}#${row.anchor}` : row.url }],
    },
  };
}

export function importScripting(input: {
  symbols: ScriptingSymbolsFile;
  summary: ScriptingSummaryFile;
  sourcesLock: SourcesLockFile;
}): ImportedSource {
  const lockByKey = new Map(input.sourcesLock.sources.map((s) => [s.key, s]));
  const level = input.summary.evidenceLevel;
  const inventory = requireAxis<InventoryAxis>(level.inventory, INVENTORY_AXES, "summary evidenceLevel.inventory");
  const verification = requireAxis<VerificationAxis>(level.verification, VERIFICATION_AXES, "summary evidenceLevel.verification");

  const seen = new Set<string>();
  const records = input.symbols.symbols.map((row) => {
    const record = scriptingRecord(row, lockByKey, inventory, verification);
    if (seen.has(record.id)) throw new Error(`duplicate capability id: ${record.id}`);
    seen.add(record.id);
    return record;
  });
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    source: "scripting",
    records,
    denominator: { state: "supplied", count: input.symbols.symbols.length },
    evidenceLevel: level,
    provenance: {
      symbolsFile: "inventories/scripting/generated/symbols.json",
      summaryFile: "inventories/scripting/generated/summary.json",
      sourceLock: "inventories/scripting/sources.lock.json",
    },
  };
}
