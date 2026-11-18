/**
 * Shared loader for the read-only inventory inputs (Issue #11).
 * All scripts build the same imports so `generate`, `gate`, `verify` and
 * `report` cannot drift apart in how they read the inventories.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importScripting, parseRealHostClaims, type RealHostClaims } from "../src/import-scripting.ts";
import {
  buildScriptingIndex,
  importSemanticOperations,
  importToolOperations,
} from "../src/import-tools.ts";
import { importSdkAggregate, type SdkAggregateImport } from "../src/import-sdk.ts";
import type { ImportedSource } from "../src/schema.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export const INPUT_PATHS = {
  scriptingSymbols: "inventories/scripting/generated/symbols.json",
  scriptingSummary: "inventories/scripting/generated/summary.json",
  scriptingLock: "inventories/scripting/sources.lock.json",
  toolsOperations: "inventories/tools/generated/operations.json",
  toolsSemantics: "inventories/tools/generated/semantics.json",
  toolsSnapshot: "inventories/tools/snapshot/tools.json",
  sdkAggregate: "inventories/sdk/generated/aggregate.json",
  sdkProvenance: "inventories/sdk/generated/provenance.json",
} as const;

function load<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as T;
}

function sha256(relativePath: string): string {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, relativePath))).digest("hex");
}

/**
 * real-host-claims.json is schema-validated and every evidence ref must
 * resolve to a committed conformance run directory containing
 * record.json (Issue #230). A claim pointing at a missing or renamed
 * run is a generation error — fail closed, never cast-and-hope.
 */
function loadRealHostClaims(): RealHostClaims | undefined {
  const path = join(REPO_ROOT, REAL_HOST_CLAIMS_PATH);
  if (!existsSync(path)) return undefined;
  const parsed = parseRealHostClaims(load(REAL_HOST_CLAIMS_PATH));
  if (!parsed.ok) {
    throw new Error(`invalid ${REAL_HOST_CLAIMS_PATH}: ${parsed.errors.join("; ")}`);
  }
  for (const [id, perOs] of Object.entries(parsed.claims.claims)) {
    for (const [os, ev] of Object.entries(perOs)) {
      const ref = ev?.ref;
      if (typeof ref !== "string") continue; // shape check already reported
      const recordPath = join(REPO_ROOT, ref, "record.json");
      if (!ref.startsWith("packages/capability-catalog/evidence/conformance/") || !existsSync(recordPath)) {
        throw new Error(
          `real-host claim '${id}'/${os} ref '${ref}' does not resolve to an evidence/conformance/<runId>/record.json`,
        );
      }
    }
  }
  return parsed.claims;
}

export type RepoInputs = {
  scripting: ImportedSource;
  tools: ImportedSource;
  semantics: ImportedSource;
  sdk: SdkAggregateImport;
  files: Record<string, string>;
};

const ADAPTER_CLAIMS_PATH = "packages/ae-devtools-cli/scripting-adapters/generated/coverage-claims.json";
const REAL_HOST_CLAIMS_PATH = "packages/capability-catalog/real-host-claims.json";

export function loadRepoInputs(): RepoInputs {
  const realHostClaims = loadRealHostClaims();
  const scripting = importScripting({
    symbols: load(INPUT_PATHS.scriptingSymbols),
    summary: load(INPUT_PATHS.scriptingSummary),
    sourcesLock: load(INPUT_PATHS.scriptingLock),
    adapterClaims: existsSync(join(REPO_ROOT, ADAPTER_CLAIMS_PATH))
      ? (load(ADAPTER_CLAIMS_PATH) as Parameters<typeof importScripting>[0]["adapterClaims"])
      : undefined,
    realHostClaims,
  });
  const operations = load<{ operations: Parameters<typeof importToolOperations>[0]["operations"]["operations"] }>(
    INPUT_PATHS.toolsOperations,
  );
  const snapshot = load<Parameters<typeof importToolOperations>[0]["snapshot"]>(
    INPUT_PATHS.toolsSnapshot,
  );
  const tools = importToolOperations({
    operations,
    snapshot,
    scriptingIndex: buildScriptingIndex(scripting.records),
  });
  const semantics = importSemanticOperations({
    semantics: load(INPUT_PATHS.toolsSemantics),
    operations,
    snapshot,
  });
  const sdk = importSdkAggregate({
    aggregate: load(INPUT_PATHS.sdkAggregate),
    provenance: load(INPUT_PATHS.sdkProvenance),
  });
  const files = Object.fromEntries(
    Object.values(INPUT_PATHS).map((path) => [path, sha256(path)]),
  ) as Record<string, string>;
  if (existsSync(join(REPO_ROOT, ADAPTER_CLAIMS_PATH))) {
    files[ADAPTER_CLAIMS_PATH] = sha256(ADAPTER_CLAIMS_PATH);
  }
  if (existsSync(join(REPO_ROOT, REAL_HOST_CLAIMS_PATH))) {
    files[REAL_HOST_CLAIMS_PATH] = sha256(REAL_HOST_CLAIMS_PATH);
  }
  return { scripting, tools, semantics, sdk, files };
}
