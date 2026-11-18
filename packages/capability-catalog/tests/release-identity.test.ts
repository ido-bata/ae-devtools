import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../scripts/inputs.ts";
import { RELEASE_SCOPE_SCHEMA } from "../src/release-gate.ts";

// Release identity consistency (Issue #208): release-scope.json declares
// which release this tree describes; it must not drift from the version
// of the published artifact it scopes. A mismatch means the gate report,
// coverage state, and package metadata describe different releases.
describe("release identity", () => {
  test("release-scope.release matches the ae-devtools-cli package version", () => {
    const scope = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/capability-catalog/release-scope.json"), "utf8"),
    ) as { schema: string; release: string };
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/ae-devtools-cli/package.json"), "utf8"),
    ) as { name: string; version: string };

    expect(scope.schema).toBe(RELEASE_SCOPE_SCHEMA);
    expect(pkg.name).toBe("@ido-bata/ae-devtools-cli");
    expect(scope.release).toBe(pkg.version);
  });
});
