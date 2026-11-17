/**
 * evidence.test.mjs — schema drift guard for a8n-transport/evidence/*.json.
 *
 * The committed evidence artifacts are the real-host record cited by
 * EVIDENCE.md. They are immutable run records, but their SHAPE must not
 * silently drift: real-run.mjs stamps every new artifact with
 * `schema: "ae-devtools.a8n-transport.real-run/v1"` and a fixed key set.
 * This test fails when an artifact is not parseable JSON, lacks the
 * discriminator, or (for v1 records) misses producer keys — catching
 * stale/corrupt evidence instead of letting it rot unnoticed.
 *
 * Fake-level evidence only: no After Effects involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(HERE, "..", "evidence");

// Keys real-run.mjs always emits on the success path (v1). Failure-path
// artifacts legitimately differ (launchError/close shape, no pin/hostInfo
// because no session ever opened), so the check is: every v1 artifact has
// the envelope keys; artifacts with `steps` AND no `launchError` also
// carry the assertion/process-snapshot fields.
const ENVELOPE_KEYS = ["schema", "issue", "startedAt", "finishedAt"];
const SUCCESS_KEYS = [
  "pin", "aeA8nSource", "aeA8nHead", "hostInfo", "ownership",
  "hostScript", "sessionRoot", "tracePath", "assertionViolations",
  "trace", "aeProcessesAfterClose", "aeHelpersAfterClose",
  "transportSends",
];

test("every evidence artifact parses and carries the schema discriminator", () => {
  const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length > 0, "expected committed evidence artifacts");
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(EVIDENCE_DIR, f), "utf8"));
    assert.equal(typeof doc, "object");
    assert.ok(doc.schema, `${f}: missing schema discriminator`);
    assert.match(doc.schema, /^ae-devtools\.a8n-transport\.real-run\//, `${f}: bad schema`);
    assert.equal(doc.issue, 49, `${f}: unexpected issue id`);
    for (const k of ENVELOPE_KEYS.filter((k) => k !== "schema")) {
      assert.ok(doc[k] !== undefined, `${f}: missing envelope key ${k}`);
    }
  }
});

test("v1 artifacts carry the full producer key set", () => {
  const files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(EVIDENCE_DIR, f), "utf8"));
    if (doc.schema !== "ae-devtools.a8n-transport.real-run/v1") continue;
    // Launch-failure artifacts keep `steps: []` but legitimately lack the
    // success-path keys — `launchError` is their discriminator.
    if (!Array.isArray(doc.steps) || doc.launchError) continue;
    for (const k of SUCCESS_KEYS) {
      assert.ok(doc[k] !== undefined, `${f}: v1 artifact missing key ${k}`);
    }
  }
});

test("evidence files referenced from EVIDENCE.md exist", () => {
  const md = readFileSync(join(HERE, "..", "EVIDENCE.md"), "utf8");
  // EVIDENCE.md cites artifacts by bare filename inside evidence/.
  const refs = [...md.matchAll(/\b(run-[\w.-]+\.json)\b/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "EVIDENCE.md should reference evidence files");
  for (const ref of refs) {
    assert.ok(existsSync(join(EVIDENCE_DIR, ref)), `EVIDENCE.md references missing ${ref}`);
  }
});
