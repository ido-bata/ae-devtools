/**
 * CI verification: (1) committed manifest is byte-identical to a fresh build
 * from the current inventories, (2) the drift gate reports no violations.
 * Exit non-zero on either failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadRepoInputs } from "./inputs.ts";
import { buildCatalog, serializeCatalog, type CatalogManifest } from "../src/generate.ts";
import { runDriftGate } from "../src/drift.ts";
import { generateDomainCoverage } from "./domain-coverage.ts";
import { runConformanceGate } from "./conformance-gate.ts";

const manifestPath = join(REPO_ROOT, "packages/capability-catalog/generated/catalog.json");
const inputs = loadRepoInputs();
const fresh = serializeCatalog(buildCatalog(inputs));
const committed = readFileSync(manifestPath, "utf8");

if (fresh !== committed) {
  console.error("STALE: committed catalog.json differs from a fresh build of the inventories");
  process.exit(1);
}
console.error("manifest byte-identical to a fresh build");

const manifest = JSON.parse(committed) as CatalogManifest;
const result = runDriftGate({ manifest, imports: inputs });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error(`gate FAILED: ${result.violations.length} violation(s)`);
  process.exit(1);
}
console.error("gate green (SDK verdict stays 'unknown' without supplied SDK rows)");

// Domain coverage report freshness — enforced whenever EITHER side of
// the pair exists (Issue #230): deleting specs/.../domains/ while a
// committed report remains must fail, not silently skip the check.
const domainsDir = join(REPO_ROOT, "specs/ae-capability-coverage/domains");
const domainReportPath = join(REPO_ROOT, "packages/capability-catalog/generated/domain-coverage.json");
if (existsSync(domainReportPath) && !existsSync(domainsDir)) {
  console.error("STALE: generated/domain-coverage.json exists but specs/ae-capability-coverage/domains/ is missing");
  process.exit(1);
}
if (existsSync(domainsDir)) {
  const freshDomain = generateDomainCoverage();
  const committedDomain = existsSync(domainReportPath) ? readFileSync(domainReportPath, "utf8") : "";
  if (freshDomain !== committedDomain) {
    console.error("STALE: committed domain-coverage.json differs from a fresh build");
    process.exit(1);
  }
  console.error("domain-coverage report byte-identical to a fresh build");
}

// Conformance release gate (Issue #147, CAP056): derives the claim set
// from release-scope.json ∪ catalog verified-real-host rows and demands
// same-bytes evidence per claim. `no-claims` is reported honestly — it
// is not a conformance pass and must not be read as one.
const gate = runConformanceGate();
if (!gate.ok) {
  console.error(`conformance gate FAILED: ${gate.fatalError}`);
  process.exit(1);
}
console.log(JSON.stringify(gate.report, null, 2));
if (!gate.report.ok) {
  console.error(
    `conformance gate FAILED: verdict=${gate.report.verdict}, ` +
      `${gate.report.scopeViolations.length} scope violation(s), ${gate.report.violations.length} claim violation(s)`,
  );
  process.exit(1);
}
console.error(`conformance gate: verdict=${gate.report.verdict}, ${gate.report.claimsEvaluated} claim(s) evaluated`);
