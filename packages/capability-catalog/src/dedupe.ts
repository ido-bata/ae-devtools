/**
 * Cross-source dedupe — CAP014.
 *
 * capability-catalog §1: denominators are reported per source; semantic
 * duplicates are LINKED, never counted twice as Adobe APIs. The universe counts
 * each underlying Adobe symbol once, whichever source(s) evidence it. Tool
 * wrappers without a resolvable underlying symbol stay in the tool parity
 * denominator only — an unlinked wrapper never invents an Adobe API entry.
 */

import type { CapabilityRecord } from "./schema.ts";

export type UniverseCounts = {
  /** Tool rows with at least one resolved underlying-symbol link. */
  toolLinked: number;
  /** Resolved (per-row unique) symbols already present in the universe. */
  toolLinkedAlreadyCounted: number;
  /** Resolved symbols contributed to the universe by tool rows. */
  toolLinkedNew: number;
  /** Tool rows with no resolvable underlying symbol (parity denominator only). */
  unlinkedToolRows: number;
};

export type CapabilityUniverse = {
  /** Sorted unique underlying Adobe symbols across all supplied sources. */
  adobeApiSymbols: string[];
  /** Separate denominators: wrapper rows vs distinct semantic operations. */
  toolParity: { wrapperRows: number; distinctSemanticOps: number };
  counts: UniverseCounts;
};

export function buildCapabilityUniverse(input: {
  scripting: CapabilityRecord[];
  tools: CapabilityRecord[];
  semantics: CapabilityRecord[];
  sdkRows?: CapabilityRecord[];
}): CapabilityUniverse {
  const sdkRows = input.sdkRows ?? [];
  const symbols = new Set<string>();
  for (const record of input.scripting) {
    if (record.source.symbol) symbols.add(record.source.symbol);
  }
  for (const record of sdkRows) {
    if (record.source.symbol) symbols.add(record.source.symbol);
  }

  const byId = new Map<string, CapabilityRecord>();
  for (const record of [...input.scripting, ...sdkRows, ...input.tools, ...input.semantics]) {
    byId.set(record.id, record);
  }

  const counts: UniverseCounts = {
    toolLinked: 0,
    toolLinkedAlreadyCounted: 0,
    toolLinkedNew: 0,
    unlinkedToolRows: 0,
  };

  for (const tool of input.tools) {
    const targets = new Set<string>();
    for (const link of tool.links ?? []) {
      if (link.basis !== "underlying-symbol") continue;
      const symbol = byId.get(link.to)?.source.symbol;
      if (symbol) targets.add(symbol);
    }
    if (targets.size === 0) {
      counts.unlinkedToolRows += 1;
      continue;
    }
    counts.toolLinked += 1;
    for (const symbol of targets) {
      if (symbols.has(symbol)) {
        counts.toolLinkedAlreadyCounted += 1;
      } else {
        symbols.add(symbol);
        counts.toolLinkedNew += 1;
      }
    }
  }

  return {
    adobeApiSymbols: [...symbols].sort(),
    toolParity: {
      wrapperRows: input.tools.length,
      distinctSemanticOps: input.semantics.length,
    },
    counts,
  };
}
