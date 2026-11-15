/**
 * run.mjs — devtools-cli tests (Issue #54). Fake level only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.mjs");
let passed = 0;

function run(args) {
  try {
    return { code: 0, body: JSON.parse(execFileSync("node", [CLI, ...args], { encoding: "utf8" })) };
  } catch (e) {
    // nonzero exit still prints the JSON result on stdout
    return { code: e.status ?? 1, body: JSON.parse(e.stdout?.toString() ?? "{}") };
  }
}
function t(name, fn) {
  try { fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

t("doctor reports environment without contacting AE", () => {
  const r = run(["doctor"]).body;
  assert.equal(r.schema, "ae-devtools.cli.doctor/v1");
  assert.ok(Array.isArray(r.aeInstalls));
  assert.equal(typeof r.a8nTransportPresent, "boolean");
});

t("discover lists registry ops, honest evidence", () => {
  const r = run(["discover"]).body;
  assert.equal(r.operationCount, 20);
  assert.equal(r.evidence.realHostVerified, 0);
});

t("inspect returns metadata without executing", () => {
  const r = run(["inspect", "item.addComp"]).body;
  assert.equal(r.status, "ok");
  assert.equal(r.evidenceLevel, "metadata only — nothing executed");
  assert.equal(run(["inspect", "no.such"]).body.status, "unknown-operation");
});

t("execute on fake session completes and verify reads back", () => {
  const ex = run(["execute", "project.new", "--session", "fake", "--consent", "grant", "--confirm-destructive"]).body;
  assert.equal(ex.outcome, "COMPLETED");
  assert.equal(ex.session.kind, "fake");
  assert.equal(ex.session.evidenceLevel, "fake/mock only");
  const v = run(["verify", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(v.outcome, "COMPLETED");
});

t("execute refuses without --consent grant (default deny)", () => {
  const r = run(["execute", "project.new", "--session", "fake", "--confirm-destructive"]).body;
  assert.equal(r.outcome, "refused");
});

t("execute refuses destructive op without --confirm-destructive", () => {
  const r = run(["execute", "project.new", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "refused");
  assert.match(JSON.stringify(r.result), /DESTRUCTIVE|refused/);
});

t("execute reports unknown op", () => {
  const r = run(["execute", "no.such.op", "--session", "fake", "--consent", "grant"]).body;
  assert.equal(r.outcome, "refused");
  assert.equal(r.result.reason, "UNKNOWN_OPERATION");
});

t("verify refuses mutating read-op", () => {
  const r = run(["verify", "--session", "fake", "--consent", "grant", "--read-op", "item.addComp"]).body;
  assert.equal(r.result.reason, "VERIFY_REQUIRES_READ_OP");
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
