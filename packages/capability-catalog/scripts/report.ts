/**
 * Prints the coverage report for the current inventories.
 * Percentages appear only with `--release <id>` (supported-release set
 * recorded by the owner); without it the report stays `undetermined`.
 */

import { loadRepoInputs } from "./inputs.ts";
import { buildCoverageReport } from "../src/coverage.ts";

const inputs = loadRepoInputs();
const releaseIndex = process.argv.indexOf("--release");
const release = releaseIndex >= 0 ? process.argv[releaseIndex + 1] : undefined;

const report = buildCoverageReport({
  ...inputs,
  supportedRelease:
    release !== undefined ? { state: "recorded", releases: [release] } : { state: "not-recorded" },
  generatedAt: new Date().toISOString(),
});
console.log(JSON.stringify(report, null, 2));
