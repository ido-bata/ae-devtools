/**
 * ae-a8n-resolve tests — the shared resolver (Issue #253).
 *
 * The three consumers (session.mjs launch, compat.mjs probe,
 * recovery-orchestrator cli) all delegate root-vs-npm mechanics here;
 * these tests pin the contract they rely on: local root wins over the
 * pinned dependency, dist/index.js + dist/cli.js layout, package.json
 * version, git-HEAD provenance, and fail-closed rejection when the
 * entry is missing.
 *
 * Fixture roots are plain directories — no After Effects, no launch.
 * The npm branch resolves the real pinned @ido-bata/ae-a8n dependency
 * (declared in this package's package.json), which is import-safe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAeA8n } from "../ae-a8n-resolve.mjs";

function fixtureRoot({ withDist = true, version = "9.9.9-test" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "a8n-resolve-"));
  if (withDist) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "export const marker = 'fixture';\n");
    writeFileSync(join(root, "dist", "cli.js"), "// cli entry\n");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ae-a8n-fixture", version }));
  return root;
}

test("resolveAeA8n: local root resolves dist/index.js with provenance", async () => {
  const root = fixtureRoot();
  try {
    const r = await resolveAeA8n({ aeA8nRoot: root });
    assert.equal(r.source, `local:${root}`);
    assert.equal(r.version, "9.9.9-test");
    assert.equal(r.cliPath, join(root, "dist", "cli.js"));
    assert.equal(r.entry, join(root, "dist", "index.js"));
    assert.equal(r.mod.marker, "fixture");
    // tmpdir is not a git checkout -> head is honestly null, never guessed
    assert.equal(r.head, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAeA8n: local root inside a git checkout reports HEAD", async () => {
  const root = fixtureRoot();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const r = await resolveAeA8n({ aeA8nRoot: root });
    assert.equal(r.head, expected);
    assert.match(r.head, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAeA8n: missing dist/index.js rejects (fail closed)", async () => {
  const root = fixtureRoot({ withDist: false });
  try {
    await assert.rejects(() => resolveAeA8n({ aeA8nRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAeA8n: npm branch resolves the pinned dependency", async () => {
  const pkg = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
  const pinned = pkg.dependencies["@ido-bata/ae-a8n"];
  const r = await resolveAeA8n({});
  assert.equal(r.source, "npm:@ido-bata/ae-a8n");
  assert.equal(r.version, pinned);
  assert.equal(typeof r.AfterEffects, "function");
  assert.match(r.cliPath, /dist[\\/]cli\.js$/);
  assert.match(r.entry, /ae-a8n/);
  // npm installs attest version, not a git head
  assert.equal(r.head, pinned);
});
