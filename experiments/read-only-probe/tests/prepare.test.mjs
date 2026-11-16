/**
 * prepare regression — the generated probe-start.jsx must be syntactically
 * valid ExtendScript. Regression for the placeholder-quoting bug where the
 * template's own quotes plus JSON.stringify's quotes produced `""...""`,
 * which made every generated dispatcher fail to parse on a real host
 * (found during the #13 real-host run attempt, 2026-11-13).
 *
 * Evidence level: automated-test (filesystem only, no AE).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const probe = join(import.meta.dirname, "..", "probe.mjs");

test("prepare generates a parseable probe-start.jsx with substituted config", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-prepare-"));
  try {
    const channel = join(root, "chan");
    const prepared = spawnSync(
      process.execPath,
      [probe, "prepare", channel, "--expect-ae", "26.5"],
      { encoding: "utf8" },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    const event = JSON.parse(prepared.stdout);
    assert.equal(event.outcome, "COMPLETED");

    const startScript = event.startScript;
    const source = readFileSync(startScript, "utf8");

    // All placeholders must be substituted exactly once each.
    assert.equal(source.includes("__PROBE_"), false, "unsubstituted placeholder remains");

    // The config lines must be single-quoted JS strings, not ""..."".
    assert.match(source, /var root = new Folder\("\/[^"]+"\);/);
    assert.match(source, /var token = "[a-f0-9]{64}";/);
    assert.match(source, /var channelId = "chan-[a-f0-9]{16}";/);
    assert.match(source, /var expectedAeVersion = "26\.5";/);
    assert.equal(source.includes('Folder(""'), false);
    assert.equal(source.includes('= """'), false);

    // The whole file must be syntactically valid JS (ES3 subset parses as JS).
    // node --check refuses unknown extensions, so check a .js copy.
    const checkPath = join(root, "check.js");
    copyFileSync(startScript, checkPath);
    const check = spawnSync(process.execPath, ["--check", checkPath], {
      encoding: "utf8",
    });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
