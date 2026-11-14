/**
 * `bun run discover` — emit the catalog-side capability discovery document
 * (Issue #20, CAP049 groundwork) as JSON on stdout.
 *
 * This is read-only: it reads the committed inventories and catalog
 * manifest and prints a HandshakeResponse. It does not contact After
 * Effects, does not attest host/target fields, and its output must not be
 * mistaken for a live host handshake — `executionMode` is `catalog-only`
 * and `transport` is `none`.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadRepoInputs } from "./inputs.ts";
import { buildDiscoveryHandshake } from "../src/discover.ts";

const inputs = loadRepoInputs();
const catalogBytes = readFileSync(
  join(REPO_ROOT, "packages/capability-catalog/generated/catalog.json"),
);
const catalogRevision = `catalog.json@sha256:${createHash("sha256").update(catalogBytes).digest("hex")}`;

let gitSha = "unknown";
try {
  gitSha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
} catch {
  // Discovery still works outside a git checkout; the SHA is provenance only.
}

const response = buildDiscoveryHandshake({
  scripting: inputs.scripting,
  tools: inputs.tools,
  semantics: inputs.semantics,
  sdk: inputs.sdk,
  meta: {
    catalogRevision,
    hostId: `ae-devtools-repo@${gitSha}`,
    os: process.platform,
    arch: process.arch,
    generatedAt: new Date().toISOString(),
  },
});

process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
