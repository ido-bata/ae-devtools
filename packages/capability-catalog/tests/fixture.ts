/**
 * Shared record factory for tests. Test-only: production importers build
 * records from inventory inputs, never through this helper.
 */

import type { CapabilityRecord, CapabilityRecordInit } from "../src/schema.ts";

export function makeRecord(init: CapabilityRecordInit): CapabilityRecord {
  const base: CapabilityRecord = {
    id: init.id,
    kind: init.kind ?? "scripting-symbol",
    persistence: init.persistence ?? "repository",
    source: init.source ?? {
      publisher: "community",
      uri: "https://example.invalid/reference",
      version: "unresolved",
      observedAt: "2026-11-12",
      authority: "community-maintained",
    },
    category: init.category ?? "application",
    access: init.access ?? "unknown",
    execution: init.execution ?? {
      class: "extendscript",
      lifecycle: "AE scripting host",
      canRemoteInvoke: null,
    },
    compatibility: init.compatibility ?? {},
    risk: init.risk ?? {
      effect: "unknown",
      trust: "read-only",
      undoable: null,
      retrySafety: "unknown",
    },
    coverage: {
      inventory: "unverified",
      reachability: "unknown",
      implementation: "unknown",
      verification: "not-run",
      evidenceRefs: [],
      ...(init.coverage ?? {}),
    },
  };
  if (init.links !== undefined) base.links = init.links;
  if (init.aliases !== undefined) base.aliases = init.aliases;
  return base;
}
