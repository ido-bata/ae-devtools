/**
 * Shared loader for the read-only inventory inputs (Issue #11).
 * All scripts build the same imports so `generate`, `gate`, `verify` and
 * `report` cannot drift apart in how they read the inventories.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importScripting } from "../src/import-scripting.ts";
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

export type RepoInputs = {
  scripting: ImportedSource;
  tools: ImportedSource;
  semantics: ImportedSource;
  sdk: SdkAggregateImport;
  files: Record<string, string>;
};

export function loadRepoInputs(): RepoInputs {
  const scripting = importScripting({
    symbols: load(INPUT_PATHS.scriptingSymbols),
    summary: load(INPUT_PATHS.scriptingSummary),
    sourcesLock: load(INPUT_PATHS.scriptingLock),
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
  );
  return { scripting, tools, semantics, sdk, files };
}
