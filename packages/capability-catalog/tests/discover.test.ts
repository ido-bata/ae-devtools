/**
 * Discovery document tests — CAP049 groundwork: the catalog-side handshake
 * must advertise only supplied inventories, keep unattested host/target
 * fields honest, and surface the same diagnostics a live handshake would.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { loadRepoInputs } from "../scripts/inputs.ts";
import { buildDiscoveryHandshake } from "../src/discover.ts";

const inputs = loadRepoInputs();

function discovery() {
  return buildDiscoveryHandshake({
    scripting: inputs.scripting,
    tools: inputs.tools,
    semantics: inputs.semantics,
    sdk: inputs.sdk,
    meta: {
      catalogRevision: "catalog.json@sha256:test",
      hostId: "ae-devtools-repo@test",
      os: "test-os",
      arch: "test-arch",
      generatedAt: "2026-11-14T00:00:00.000Z",
    },
  });
}

test("discovery response carries the handshake schema and contract version", () => {
  const res = discovery();
  assert.equal(res.schema, "ae-devtools.capability-handshake/v1");
  assert.deepEqual(res.contractVersion, { major: 1, minor: 0 });
  assert.equal(res.hostId, "ae-devtools-repo@test");
  assert.equal(res.host.executionMode, "catalog-only");
  assert.equal(res.host.transport, "none");
});

test("discovery never claims an AE host it does not have", () => {
  const res = discovery();
  assert.equal(res.host.ae, undefined);
  assert.equal(res.target.identity, null);
  assert.equal(res.target.ownership, "unknown");
  assert.equal(res.target.nonInterference, "unproven");
});

test("inventory supply reflects what was actually loaded", () => {
  const res = discovery();
  assert.equal(res.inventorySupply.scripting, "supplied");
  assert.equal(res.inventorySupply.tools, "supplied");
  // SDK per-symbol rows are never committed: sdk stays not-supplied even
  // though the aggregate import succeeded.
  assert.equal(res.inventorySupply.sdk, "not-supplied");
});

test("diagnostics surface unsupplied SDK inventory and unrecorded release set", () => {
  const res = discovery();
  const codes = res.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("inventory-not-supplied"));
  assert.ok(codes.includes("supported-release-set-not-recorded"));
  assert.ok(codes.includes("no-real-host-evidence"));
});

test("available capabilities are advertised with honest proof levels", () => {
  const res = discovery();
  assert.ok(res.availableCapabilities.length > 0);
  for (const cap of res.availableCapabilities) {
    assert.ok(
      ["verified-real-host", "automated-test", "source-reviewed", "unverified"].includes(cap.proofLevel),
      `unexpected proofLevel ${cap.proofLevel} on ${cap.id}`,
    );
    // Nothing in the repository holds real-host proof today.
    assert.notEqual(cap.proofLevel, "verified-real-host");
  }
  const ids = res.availableCapabilities.map((c) => c.id);
  assert.deepEqual(ids, [...ids].sort());
});
