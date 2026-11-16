/**
 * Read-only capability discovery — Issue #20, CAP049 groundwork.
 *
 * Builds a HandshakeResponse from the repository inventories alone: this is
 * a *catalog-side discovery document* — what a consumer can learn about the
 * capability surface without any After Effects host — not a live host
 * handshake. Host fields that only a real AE session can attest (AE
 * version/build, target ownership, non-interference) stay absent or
 * `unknown`; the response never claims evidence it does not have.
 */

import { buildHandshake, type HandshakeResponse } from "./handshake.ts";
import type { ImportedSource } from "./schema.ts";
import type { SdkAggregateImport as SdkImport } from "./import-sdk.ts";

export type DiscoveryMeta = {
  /** sha256 of the committed catalog manifest the discovery describes. */
  catalogRevision: string;
  /** Identifier of the discovery producer (e.g. repo checkout + SHA). */
  hostId: string;
  os: string;
  arch: string;
  generatedAt: string;
};

export function buildDiscoveryHandshake(input: {
  scripting: ImportedSource;
  tools: ImportedSource;
  semantics: ImportedSource;
  sdk: SdkImport;
  meta: DiscoveryMeta;
}): HandshakeResponse {
  return buildHandshake({
    scripting: input.scripting,
    tools: input.tools,
    semantics: input.semantics,
    // SDK per-symbol rows are never committed (§1.1): discovery reports the
    // aggregate only and marks sdk inventorySupply "not-supplied".
    sdkAggregate: input.sdk,
    catalogRevision: input.meta.catalogRevision,
    hostId: input.meta.hostId,
    os: input.meta.os,
    arch: input.meta.arch,
    executionMode: "catalog-only",
    transport: "none",
    generatedAt: input.meta.generatedAt,
    supportedRelease: { state: "not-recorded" },
    // No AE session exists here: target identity/ownership/non-interference
    // remain unattested (defaults: null / unknown / unproven).
  });
}
