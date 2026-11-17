/**
 * Conformance release gate — Issue #147, CAP056.
 *
 * Loads the owner-declared release scope
 * (`packages/capability-catalog/release-scope.json`), derives the claim
 * set (catalog verified-real-host rows ∪ declared claims), loads every
 * conformance evidence record under `evidence/conformance/<runId>/`,
 * and evaluates same-bytes artifact hashes against the committed
 * evidence tree.
 *
 * Trust boundary: a record is evidence only for artifacts committed
 * under its own run directory. `artifactHashes` keys are interpreted
 * relative to that directory; absolute paths, `..` segments, and
 * symlink escapes are rejected — a record cannot cite bytes outside
 * its run dir, and `record.runId` must equal the directory name so a
 * record cannot be re-homed onto a different artifact set.
 *
 * `runConformanceGate()` is shared with `scripts/verify.ts`; the CLI
 * entry prints the report and maps the verdict to an exit code.
 * Exit codes: 0 when the gate has no violations (verdict may still be
 * `no-claims` — that is reported, not hidden), 1 on scope parse errors,
 * scope violations, or claim violations.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { REPO_ROOT } from "./inputs.ts";
import {
  parseReleaseScope,
  evaluateReleaseGate,
  type LoadedConformanceRecord,
  type ReleaseGateReport,
} from "../src/release-gate.ts";
import type { CatalogManifest } from "../src/generate.ts";

const SCOPE_PATH = join(REPO_ROOT, "packages/capability-catalog/release-scope.json");
const MANIFEST_PATH = join(REPO_ROOT, "packages/capability-catalog/generated/catalog.json");
const EVIDENCE_ROOT = join(REPO_ROOT, "packages/capability-catalog/evidence/conformance");
const RECORD_FILE = "record.json";

export type ConformanceGateResult =
  | { ok: true; report: ReleaseGateReport }
  | { ok: false; fatalError: string };

/** Reject artifact paths that could escape the run directory. */
function safeArtifactPath(runDir: string, rel: string): string | null {
  if (rel.length === 0 || rel.startsWith("/") || rel.includes("\0")) return null;
  if (rel.split(/[\\/]/).includes("..")) return null;
  const candidate = resolve(runDir, rel);
  if (candidate !== runDir && !candidate.startsWith(runDir + sep)) return null;
  // Symlink escape: the real path must stay inside the real run dir.
  try {
    const realRun = realpathSync(runDir);
    const realCandidate = realpathSync(candidate);
    if (realCandidate !== realRun && !realCandidate.startsWith(realRun + sep)) return null;
  } catch {
    return null; // unreadable/missing — reported as artifact-missing downstream
  }
  return candidate;
}

function loadRecordSources(): {
  sources: LoadedConformanceRecord[];
  rejected: Array<{ runId: string; errors: string[] }>;
} {
  const sources: LoadedConformanceRecord[] = [];
  const rejected: Array<{ runId: string; errors: string[] }> = [];
  if (!existsSync(EVIDENCE_ROOT)) return { sources, rejected };

  for (const runId of readdirSync(EVIDENCE_ROOT).sort()) {
    const runDir = join(EVIDENCE_ROOT, runId);
    if (!statSync(runDir).isDirectory()) continue;
    const recordPath = join(runDir, RECORD_FILE);
    if (!existsSync(recordPath)) continue;

    let json: unknown;
    try {
      json = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch (err) {
      rejected.push({ runId, errors: [`record.json is not valid JSON: ${String(err)}`] });
      continue;
    }
    // The record must name the directory it lives in — otherwise it
    // could be re-homed onto a different artifact set.
    const claimedRunId =
      typeof json === "object" && json !== null && !Array.isArray(json)
        ? (json as Record<string, unknown>).runId
        : undefined;
    if (claimedRunId !== runId) {
      rejected.push({
        runId,
        errors: [`record.runId (${String(claimedRunId)}) does not match evidence directory '${runId}'`],
      });
      continue;
    }
    const dir = runDir;
    sources.push({
      runId,
      record: json,
      readArtifact: (rel) => {
        const p = safeArtifactPath(dir, rel);
        if (p === null) return null;
        try {
          return new Uint8Array(readFileSync(p));
        } catch {
          return null;
        }
      },
    });
  }
  return { sources, rejected };
}

export function runConformanceGate(): ConformanceGateResult {
  if (!existsSync(SCOPE_PATH)) {
    return { ok: false, fatalError: `release scope declaration missing: ${SCOPE_PATH}` };
  }
  let scopeJson: unknown;
  try {
    scopeJson = JSON.parse(readFileSync(SCOPE_PATH, "utf8"));
  } catch (err) {
    return { ok: false, fatalError: `release scope is not valid JSON: ${String(err)}` };
  }
  const scopeParsed = parseReleaseScope(scopeJson);
  if (!scopeParsed.ok) {
    return { ok: false, fatalError: `invalid release scope: ${scopeParsed.errors.join("; ")}` };
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as CatalogManifest;
  const { sources, rejected: loadRejected } = loadRecordSources();
  const report = evaluateReleaseGate({
    scope: scopeParsed.scope,
    manifest,
    recordSources: sources,
  });
  // Load-time rejections (unparseable JSON / runId mismatch) are gate
  // findings too — merge them into rejectedRecords for one report.
  report.rejectedRecords.push(...loadRejected);
  return { ok: true, report };
}

if (import.meta.main) {
  const result = runConformanceGate();
  if (!result.ok) {
    console.error(`conformance-gate: ${result.fatalError}`);
    process.exit(1);
  }
  const { report } = result;
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict === "no-claims") {
    console.error(
      "conformance-gate: verdict=no-claims — no capability claims verified-real-host; " +
        "this is NOT a conformance pass",
    );
  }
  if (!report.ok) {
    console.error(
      `conformance-gate FAILED: verdict=${report.verdict}, ` +
        `${report.scopeViolations.length} scope violation(s), ${report.violations.length} claim violation(s)`,
    );
    process.exit(1);
  }
  console.error(
    `conformance-gate green: verdict=${report.verdict}, ${report.claimsEvaluated} claim(s) evaluated`,
  );
}
