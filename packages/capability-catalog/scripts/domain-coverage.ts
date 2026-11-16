/**
 * Domain coverage report — projects the catalog manifest onto the domain
 * definitions in `specs/ae-capability-coverage/domains/` (Issue #15/#16
 * groundwork, CAP032). Writes `generated/domain-coverage.json`.
 *
 * Deterministic: sorted domains, sorted members, sorted generatedFrom.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadRepoInputs } from "./inputs.ts";
import { buildCatalog } from "../src/generate.ts";
import {
  buildDomainCoverageReport,
  serializeDomainCoverageReport,
  type DomainDefinition,
} from "../src/domain-coverage.ts";

const DOMAINS_DIR = join(REPO_ROOT, "specs/ae-capability-coverage/domains");
const OUT_PATH = join(REPO_ROOT, "packages/capability-catalog/generated/domain-coverage.json");

function loadDomains(): { definitions: DomainDefinition[]; files: { path: string; sha256: string }[] } {
  const definitions: DomainDefinition[] = [];
  const files: { path: string; sha256: string }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(DOMAINS_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const rel = `specs/ae-capability-coverage/domains/${name}`;
    const bytes = readFileSync(join(REPO_ROOT, rel));
    definitions.push(JSON.parse(bytes.toString("utf8")) as DomainDefinition);
    files.push({
      path: rel,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { definitions, files };
}

export function generateDomainCoverage(): string {
  const inputs = loadRepoInputs();
  const manifest = buildCatalog(inputs);
  const { definitions, files } = loadDomains();
  const report = buildDomainCoverageReport({
    records: manifest.records,
    domains: definitions,
    generatedFrom: [
      ...Object.entries(inputs.files).map(([path, sha256]) => ({ path, sha256 })),
      ...files,
    ],
  });
  return serializeDomainCoverageReport(report);
}

if (import.meta.main) {
  const serialized = generateDomainCoverage();
  writeFileSync(OUT_PATH, serialized);
  const parsed = JSON.parse(serialized);
  console.error(
    `domain-coverage: ${parsed.domains.length} domain(s), ` +
      parsed.domains.map((d: { domain: string; memberCount: number }) => `${d.domain}=${d.memberCount}`).join(", "),
  );
}
