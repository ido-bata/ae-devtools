/**
 * Importer for the #8 tool inventory: source-verified wrapper operations plus
 * their normalized semantic operations. Tool rows are their own denominator
 * (capability-catalog §1 rule 2) and are linked — never counted — against the
 * Adobe API universe.
 */

import { semanticOperationId, toolOperationId } from "./ids.ts";
import {
  riskForAccess,
  type AccessClass,
  type CapabilityLink,
  type CapabilityRecord,
  type ExecutionDescriptor,
  type ImportedSource,
} from "./schema.ts";

type OperationRow = {
  toolId: string;
  name: string;
  access: string;
  accessBasis?: string;
  route?: string;
  semanticId: string;
  status: string;
  definitionFile?: string;
  definitionLine?: number;
  implementationFile?: string;
  implementationLine?: number;
};

export type ToolsOperationsFile = { operations: OperationRow[] };
export type ToolsSnapshotFile = {
  observedAt?: string;
  tools: Array<{
    id: string;
    repoUrl?: string;
    commit?: string;
    license?: string;
    observedAt?: string;
  }>;
};
export type SemanticsFile = {
  semanticOps: Array<{ id: string; label?: string; adobeOperation?: string }>;
};

const ACCESS_CLASSES: readonly AccessClass[] = [
  "read",
  "read-write",
  "write",
  "execute",
  "host-callback",
  "build-test",
  "unknown",
];

/** Arbitrary-script entry points are privileged dev code, never named ops (FR-07). */
const PRIVILEGED_SCRIPT_OPS = new Set(["run-script", "execute", "executeSync"]);

function requireAccess(value: string): AccessClass {
  if (!(ACCESS_CLASSES as readonly string[]).includes(value)) {
    throw new Error(`unmapped tool access: ${JSON.stringify(value)}`);
  }
  return value as AccessClass;
}

function executionFromRoute(route: string | undefined): ExecutionDescriptor {
  const r = route ?? "";
  if (/ExtendScript|evalScript|\bES3\b/.test(r)) {
    return { class: "extendscript", lifecycle: "AE scripting host", canRemoteInvoke: null };
  }
  if (/aerender/i.test(r)) return { class: "aerender", lifecycle: "render CLI", canRemoteInvoke: null };
  if (/osascript|AppleScript/i.test(r)) {
    return { class: "os-automation", lifecycle: "OS automation", canRemoteInvoke: null };
  }
  if (/UXP/i.test(r)) return { class: "uxp", lifecycle: "UXP", canRemoteInvoke: null };
  return { class: "unknown", lifecycle: "unknown", canRemoteInvoke: null };
}

/** Backtick references in accessBasis that resolve to a known scripting symbol. */
function resolveUnderlying(
  accessBasis: string | undefined,
  index: Map<string, string>,
): string[] {
  if (!accessBasis) return [];
  const resolved = new Set<string>();
  for (const match of accessBasis.matchAll(/`([^`]+)`/g)) {
    const raw = match[1] ?? "";
    const candidate = raw
      .replace(/\(.*$/, "")
      .replace(/\.\.\..*$/, "")
      .replace(/\s*=.*$/, "")
      .replace(/^\./, "")
      .replace(/[()'"]/g, "");
    if (!/^[A-Za-z0-9_$.]+$/.test(candidate) || !candidate.includes(".")) continue;
    const direct = index.get(candidate);
    if (direct) {
      resolved.add(direct);
      continue;
    }
    const parts = candidate.split(".");
    if (parts.length > 2) {
      const suffix = index.get(parts.slice(-2).join("."));
      if (suffix) resolved.add(suffix);
    }
  }
  return [...resolved];
}

function toolRecord(
  row: OperationRow,
  toolMeta: Map<string, ToolsSnapshotFile["tools"][number]>,
  observedAt: string,
  scriptingIndex: Map<string, string> | undefined,
): CapabilityRecord {
  const id = toolOperationId(row.toolId, row.name);
  const meta = toolMeta.get(row.toolId);
  const commit = meta?.commit ?? "unresolved";
  const access = requireAccess(row.access);
  const sourceVerified = row.status === "source-verified";

  const links: CapabilityLink[] = [
    { to: semanticOperationId(row.semanticId), basis: "semantic-grouping" },
  ];
  for (const target of resolveUnderlying(row.accessBasis, scriptingIndex ?? new Map())) {
    if (!links.some((link) => link.to === target)) {
      links.push({ to: target, basis: "underlying-symbol" });
    }
  }

  let risk = riskForAccess(access);
  if (PRIVILEGED_SCRIPT_OPS.has(row.name)) {
    risk = { ...risk, trust: "privileged-dev-code" };
  }

  const evidenceSite =
    row.definitionFile ?? row.implementationFile ?? "unresolved";
  const evidenceLine = row.definitionLine ?? row.implementationLine ?? 0;

  return {
    id,
    kind: "tool-operation",
    persistence: "repository",
    source: {
      publisher: row.toolId.startsWith("ido-bata/") ? "local" : "third-party",
      uri: meta?.repoUrl ?? `https://github.com/${row.toolId}`,
      version: "unresolved",
      revision: meta?.commit,
      symbol: row.name,
      license: meta?.license,
      observedAt: meta?.observedAt ?? observedAt,
      authority: sourceVerified ? "source-verified" : "claim-only",
    },
    category: row.semanticId.split(".")[0] ?? "unknown",
    access,
    execution: executionFromRoute(row.route),
    compatibility: {},
    risk,
    coverage: {
      inventory: sourceVerified ? "source-reviewed" : "discovered",
      reachability: sourceVerified ? "reachable" : "unknown",
      implementation: sourceVerified ? "implemented" : "unknown",
      verification: "not-run",
      ...(access === "unknown" ? { unknownKind: "unclassifiable" as const } : {}),
      evidenceRefs: [
        {
          kind: sourceVerified ? "source-impl" : "source-doc",
          ref: `${row.toolId}@${commit}#${evidenceSite}:${evidenceLine}`,
        },
      ],
    },
    links,
  };
}

export function importToolOperations(input: {
  operations: ToolsOperationsFile;
  snapshot: ToolsSnapshotFile;
  scriptingIndex?: Map<string, string>;
}): ImportedSource {
  const observedAt = input.snapshot.observedAt;
  if (!observedAt) throw new Error("tools snapshot observedAt is required");
  const toolMeta = new Map(input.snapshot.tools.map((t) => [t.id, t]));

  const seen = new Set<string>();
  const records = input.operations.operations.map((row) => {
    const record = toolRecord(row, toolMeta, observedAt, input.scriptingIndex);
    if (seen.has(record.id)) throw new Error(`duplicate capability id: ${record.id}`);
    seen.add(record.id);
    return record;
  });
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    source: "tools",
    records,
    denominator: { state: "supplied", count: records.length },
    evidenceLevel: {
      inventory: "source-reviewed",
      verification: "not-run",
      realHost: "not-run",
      statement:
        "Operations were extracted from pinned tool source (file + line). No After Effects process was started; no symbol was executed. Derived from the #8 README evidence note and per-row status source-verified.",
    },
    provenance: {
      operationsFile: "inventories/tools/generated/operations.json",
      snapshotFile: "inventories/tools/snapshot/tools.json",
    },
  };
}

function unionAccess(wrappers: OperationRow[]): AccessClass {
  const known = new Set(
    wrappers.map((w) => w.access).filter((a) => a !== "unknown") as AccessClass[],
  );
  if (known.size === 0) return "unknown";
  if (known.has("execute")) return "execute";
  if (known.has("read") && known.has("write")) return "read-write";
  if (known.has("read-write")) return "read-write";
  return [...known][0] ?? "unknown";
}

function unionExecution(wrappers: OperationRow[]): ExecutionDescriptor {
  const distinct = new Map<string, ExecutionDescriptor>();
  for (const w of wrappers) {
    const exec = executionFromRoute(w.route);
    distinct.set(exec.class, exec);
  }
  if (distinct.size === 1) return [...distinct.values()][0] ?? { class: "unknown", lifecycle: "unknown", canRemoteInvoke: null };
  return { class: "unknown", lifecycle: "unknown", canRemoteInvoke: null };
}

export function importSemanticOperations(input: {
  semantics: SemanticsFile;
  operations: ToolsOperationsFile;
  snapshot: ToolsSnapshotFile;
}): ImportedSource {
  const observedAt = input.snapshot.observedAt;
  if (!observedAt) throw new Error("tools snapshot observedAt is required");

  const wrappersBySemantic = new Map<string, OperationRow[]>();
  for (const row of input.operations.operations) {
    const list = wrappersBySemantic.get(row.semanticId) ?? [];
    list.push(row);
    wrappersBySemantic.set(row.semanticId, list);
  }

  const seen = new Set<string>();
  const records = input.semantics.semanticOps.map((op): CapabilityRecord => {
    const id = semanticOperationId(op.id);
    if (seen.has(id)) throw new Error(`duplicate capability id: ${id}`);
    seen.add(id);
    const wrappers = wrappersBySemantic.get(op.id) ?? [];
    const access = unionAccess(wrappers);
    return {
      id,
      kind: "semantic-operation",
      persistence: "repository",
      source: {
        publisher: "local",
        uri: "inventories/tools/generated/semantics.json",
        version: "unresolved",
        symbol: op.id,
        observedAt,
        authority: "claim-only",
      },
      category: op.id.split(".")[0] ?? "unknown",
      access,
      execution: unionExecution(wrappers),
      compatibility: {},
      risk: riskForAccess(access),
      coverage: {
        inventory: "source-reviewed",
        reachability: "unknown",
        implementation: "unknown",
        verification: "not-run",
        evidenceRefs: [
          { kind: "source-doc", ref: `inventories/tools/generated/semantics.json#${op.id}` },
        ],
      },
      links: wrappers.map((w) => ({
        to: toolOperationId(w.toolId, w.name),
        basis: "semantic-grouping" as const,
      })),
    };
  });
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    source: "tools",
    records,
    denominator: { state: "supplied", count: records.length },
    evidenceLevel: {
      inventory: "source-reviewed",
      verification: "not-run",
      realHost: "not-run",
      statement:
        "Semantic operations are a local normalization of source-verified tool rows (claim-only grouping). No After Effects process was started; no symbol was executed.",
    },
    provenance: {
      semanticsFile: "inventories/tools/generated/semantics.json",
      operationsFile: "inventories/tools/generated/operations.json",
    },
  };
}

/** Symbol spelling → canonical capability id, for cross-source underlying links. */
export function buildScriptingIndex(scriptingRecords: CapabilityRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of scriptingRecords) {
    if (record.source.symbol) index.set(record.source.symbol, record.id);
  }
  return index;
}
