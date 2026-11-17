/**
 * contract tests — ae-a8n handshake behavioral battery (Issue #144).
 *
 * Two layers, both automated-test level:
 *   1. The battery itself, against stub module namespaces — proves the
 *      checks distinguish canonical semantics from lookalike exports.
 *   2. probeAeA8n / openSliceSession against fixture roots whose dist/
 *      re-exports tests/fixtures/handshake-ok.mjs (contract-conformant)
 *      or a semantics-violating stub.
 *
 * Opt-in real-module layer: set AE_A8N_ROOT to an ae-a8n checkout with a
 * built dist/ to run the battery against the actual implementation —
 * still no AE launch (the handshake functions are pure). Skipped otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  runHandshakeContractChecks,
  HANDSHAKE_CONTRACT_CHECK_IDS,
} from "../contract.mjs";
import { probeAeA8n } from "../compat.mjs";
import { openSliceSession } from "../session.mjs";
import * as okModule from "./fixtures/handshake-ok.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OK_FIXTURE_URL = pathToFileURL(join(HERE, "fixtures", "handshake-ok.mjs")).href;

function fixtureRoot(indexJs) {
  const root = mkdtempSync(join(tmpdir(), "a8n-contract-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), indexJs);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "ae-a8n-fixture", version: "0.0.0-test" }),
  );
  return root;
}

const ROOT_OK = `export * from ${JSON.stringify(OK_FIXTURE_URL)};\n`;

/** Exports the right names but violates the semantics on purpose. */
const ROOT_SEMANTIC_BAD = `
export function AfterEffects() {}
export function negotiateCapabilities() { return { status: "compatible" }; }
export function assertDispatchAllowed() { return { status: "pass" }; }
`;

/* ------------------------------------------------------------------ */
/* Battery vs stub namespaces                                          */
/* ------------------------------------------------------------------ */

test("battery: contract-conformant stub passes every check", () => {
  const result = runHandshakeContractChecks(okModule);
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.equal(result.checks.length, HANDSHAKE_CONTRACT_CHECK_IDS.length);
});

test("battery: always-compatible negotiate is caught", () => {
  const mod = {
    ...okModule,
    negotiateCapabilities: () => ({ status: "compatible" }),
  };
  const result = runHandshakeContractChecks(mod);
  assert.equal(result.ok, false);
  const failed = result.checks.filter((c) => !c.ok).map((c) => c.id);
  // Every refusal-expectation check must fail; the pure-compatible ones pass.
  for (const id of [
    "negotiation.incompatible-major",
    "negotiation.unsupported-minor",
    "negotiation.malformed-schema",
    "negotiation.unknown-capability",
    "negotiation.capability-unassessed",
    "negotiation.missing-permission",
  ]) {
    assert.ok(failed.includes(id), `expected ${id} to fail`);
  }
});

test("battery: always-pass dispatch gate is caught", () => {
  const mod = {
    ...okModule,
    assertDispatchAllowed: () => ({ status: "pass" }),
  };
  const result = runHandshakeContractChecks(mod);
  assert.equal(result.ok, false);
  const failed = result.checks.filter((c) => !c.ok).map((c) => c.id);
  for (const id of [
    "dispatch.refuse-unknown-ownership",
    "dispatch.refuse-unverified",
    "dispatch.refuse-not-implemented",
    "dispatch.refuse-no-execution-path",
    "dispatch.refuse-missing-permission",
    "dispatch.refuse-unknown-capability",
    "dispatch.refuse-unassessed",
    "dispatch.refuse-malformed",
  ]) {
    assert.ok(failed.includes(id), `expected ${id} to fail`);
  }
});

test("battery: missing functions report violations, never throw", () => {
  const result = runHandshakeContractChecks({ AfterEffects: function () {} });
  assert.equal(result.ok, false);
  assert.ok(result.checks.every((c) => !c.ok));
});

test("battery: throwing implementation is recorded as violation", () => {
  const result = runHandshakeContractChecks({
    negotiateCapabilities: () => { throw new Error("boom"); },
    assertDispatchAllowed: () => ({ status: "refused", reason: "malformed-response" }),
  });
  assert.equal(result.ok, false);
  const threw = result.checks.find((c) => c.id === "negotiation.compatible");
  assert.match(threw.detail, /boom/);
});

/* ------------------------------------------------------------------ */
/* probeAeA8n / openSliceSession against fixture roots                 */
/* ------------------------------------------------------------------ */

test("probeAeA8n: conformant stub root -> contractOk with checks", async () => {
  const root = fixtureRoot(ROOT_OK);
  try {
    const probe = await probeAeA8n({ aeA8nRoot: root });
    assert.equal(probe.resolvable, true);
    assert.equal(probe.contractOk, true);
    assert.deepEqual(probe.missing, []);
    assert.ok(Array.isArray(probe.checks));
    assert.ok(probe.checks.every((c) => c.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeAeA8n: exports-present-but-wrong-semantics -> contractOk false", async () => {
  const root = fixtureRoot(ROOT_SEMANTIC_BAD);
  try {
    const probe = await probeAeA8n({ aeA8nRoot: root });
    assert.equal(probe.resolvable, true);
    assert.equal(probe.contractOk, false);
    assert.deepEqual(probe.missing, []); // exports exist — behavior is wrong
    assert.ok(probe.checks.some((c) => !c.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSliceSession: wrong-semantics root refuses BEFORE extension build / launch", async () => {
  const root = fixtureRoot(ROOT_SEMANTIC_BAD);
  try {
    // No dist/cli.js in the fixture: reaching extension build or launch
    // would fail differently. The behavioral gate must fire first.
    await assert.rejects(
      openSliceSession({ aeA8nRoot: root, workdir: mkdtempSync(join(tmpdir(), "a8n-wd-")) }),
      (e) => e.code === "AE_A8N_CONTRACT_INCOMPATIBLE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSliceSession: conformant stub root passes the behavioral gate", async () => {
  const root = fixtureRoot(ROOT_OK);
  try {
    await assert.rejects(
      openSliceSession({ aeA8nRoot: root, workdir: mkdtempSync(join(tmpdir(), "a8n-wd-")) }),
      (e) => e.code !== "AE_A8N_CONTRACT_INCOMPATIBLE" && e.code !== "AE_A8N_CONTRACT_UNSUPPORTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Opt-in: real ae-a8n module (no AE launch — pure functions only)     */
/* ------------------------------------------------------------------ */

const AE_A8N_ROOT = process.env.AE_A8N_ROOT;

test(
  "battery: real ae-a8n dist honors the handshake contract",
  { skip: typeof AE_A8N_ROOT !== "string" || AE_A8N_ROOT.length === 0
      ? "AE_A8N_ROOT not set — real-module check skipped" : false },
  async () => {
    const mod = await import(pathToFileURL(join(AE_A8N_ROOT, "dist", "index.js")).href);
    const result = runHandshakeContractChecks(mod);
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 2));
  },
);
