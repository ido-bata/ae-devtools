/**
 * Importer for the #9 scripting inventory (public, community-maintained
 * reference). Rows are repository-persisted; evidence stays source-doc level.
 */

import { scriptingId } from "./ids.ts";
import {
  AUTHORITY_VALUES,
  INVENTORY_AXES,
  VERIFICATION_AXES,
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
  const authority = requireAxis<SourceAuthority>(row.authority, AUTHORITY_VALUES, "row authority");
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

export type AdapterClaims = {
  /** catalogId (ae.scripting.Owner.member) -> claiming op ids */
  claims: Record<string, { ops: string[]; evidence: string }>;
};

/**
 * Real-host evidence claims (Issue #177): catalogId -> per-OS evidence
 * binding. Each entry asserts `coverage.verification:
 * "verified-real-host"` for the named OS and attaches a `real-host`
 * evidenceRef — the drift gate's promotion checks then require that
 * ref for every claimed platform. Claims are only as strong as the
 * conformance record the ref points at; the generator does not verify
 * the record itself (that is the conformance gate's job).
 */
export type RealHostClaims = {
  claims: Record<
    string,
    Partial<Record<"win32" | "darwin", { ref: string }>>
  >;
};

const REAL_HOST_CLAIMS_SCHEMA = "ae-devtools.real-host-claims/v1" as const;
const REAL_HOST_OS = ["win32", "darwin"] as const;

/**
 * Structural validation of real-host-claims.json (Issue #230). The file
 * was previously cast, never parsed: a malformed schema or a ref that
 * points nowhere would silently shape catalog promotions. Shape errors
 * are returned, never thrown — the caller decides fatal vs skip.
 * Ref EXISTENCE (the evidence/conformance/<runId> dir) is a filesystem
 * concern and is checked by the loading script, not here.
 */
export function parseRealHostClaims(
  json: unknown,
): { ok: true; claims: RealHostClaims } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const bad = (msg: string) => errors.push(msg);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, errors: ["real-host claims is not an object"] };
  }
  const j = json as Record<string, unknown>;
  if (j.schema !== REAL_HOST_CLAIMS_SCHEMA) {
    bad(`schema must be ${REAL_HOST_CLAIMS_SCHEMA}`);
  }
  if (typeof j.claims !== "object" || j.claims === null || Array.isArray(j.claims)) {
    bad("claims must be an object mapping capabilityId -> per-OS evidence");
  } else {
    for (const [id, perOs] of Object.entries(j.claims as Record<string, unknown>)) {
      if (id.length === 0) bad("claims contains an empty capability id");
      if (typeof perOs !== "object" || perOs === null || Array.isArray(perOs)) {
        bad(`claims['${id}'] must be an object keyed by os`);
        continue;
      }
      for (const [os, ev] of Object.entries(perOs as Record<string, unknown>)) {
        if (!REAL_HOST_OS.includes(os as (typeof REAL_HOST_OS)[number])) {
          bad(`claims['${id}'] oss '${os}' must be win32 | darwin`);
          continue;
        }
        const ref = (ev as Record<string, unknown> | null)?.ref;
        if (typeof ref !== "string" || ref.length === 0) {
          bad(`claims['${id}'].${os}.ref must be a non-empty string`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, claims: j as unknown as RealHostClaims };
}

export function importScripting(input: {
  symbols: ScriptingSymbolsFile;
  summary: ScriptingSummaryFile;
  sourcesLock: SourcesLockFile;
  /** Optional adapter coverage claims (Issue #15/#16). When present,
   *  claimed members are marked adapter-present + automated-fake —
   *  never verified-real-host. */
  adapterClaims?: AdapterClaims;
  /** Optional real-host evidence claims (Issue #177). When present,
   *  named members are promoted to verified-real-host for the claimed
   *  OS cells with a real-host evidenceRef. Applied AFTER adapterClaims
   *  so a row can carry both the fake-level adapter ref and the
   *  real-host ref. */
  realHostClaims?: RealHostClaims;
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
  // Adapter coverage claims (Issue #15/#16): a registry op claiming a
  // member upgrades it to adapter-present + automated-fake. This is a
  // fake-level claim only — verification never becomes verified-real-host
  // and implementation never becomes "implemented" (that axis is for
  // catalog-native capabilities).
  if (input.adapterClaims) {
    for (const record of records) {
      const claim = input.adapterClaims.claims[record.id];
      if (!claim) continue;
      record.coverage.implementation = "adapter-present";
      record.coverage.verification = "automated-fake";
      record.coverage.evidenceRefs.push({
        kind: "automated-test",
        ref: `packages/ae-devtools-cli/scripting-adapters (${claim.ops.join(", ")})`,
      });
    }
  }
  // Real-host evidence claims (Issue #177): promote named members to
  // verified-real-host per claimed OS cell. Fail closed on unknown ids
  // and unsupported OS keys — a claim that cannot bind to a catalog row
  // is a generation error, never silently dropped.
  if (input.realHostClaims) {
    const OS_ORDER = ["win32", "darwin"] as const;
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const [id, perOs] of Object.entries(input.realHostClaims.claims)) {
      const record = byId.get(id);
      if (!record) {
        throw new Error(`real-host claim names unknown capability id: ${id}`);
      }
      const claimedOs: Array<"win32" | "darwin"> = [];
      for (const [os, ev] of Object.entries(perOs)) {
        if (os !== "win32" && os !== "darwin") {
          throw new Error(`real-host claim for ${id}: unsupported os '${os}'`);
        }
        if (!ev || typeof ev.ref !== "string" || ev.ref.length === 0) {
          throw new Error(`real-host claim for ${id}/${os}: evidence ref is required`);
        }
        claimedOs.push(os);
        record.coverage.evidenceRefs.push({
          kind: "real-host",
          ref: ev.ref,
          platform: os,
        });
      }
      if (claimedOs.length === 0) {
        throw new Error(`real-host claim for ${id}: no OS cells declared`);
      }
      record.compatibility.os = [
        ...new Set([...(record.compatibility.os ?? []), ...claimedOs]),
      ].sort((a, b) => OS_ORDER.indexOf(a) - OS_ORDER.indexOf(b));
      record.coverage.verification = "verified-real-host";
    }
  }

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
