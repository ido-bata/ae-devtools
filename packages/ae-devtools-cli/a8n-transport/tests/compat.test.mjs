/**
 * compat tests — ae-a8n contract gate (Issue #138).
 *
 * Everything here is automated-test level: `aeA8nRoot` points at fixture
 * directories whose dist/index.js is a stub, so the real `@ido-bata/ae-a8n`
 * package and After Effects are never touched. The npm-resolution branch
 * of probeAeA8n is environment-dependent and intentionally not asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  missingContractExports,
  aeA8nContractError,
  probeAeA8n,
  REQUIRED_AE_A8N_CONTRACT,
} from "../compat.mjs";
import { openSliceSession } from "../session.mjs";

function fixtureRoot(exportsBlock) {
  const root = mkdtempSync(join(tmpdir(), "a8n-compat-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), exportsBlock);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "ae-a8n-fixture", version: "0.0.0-test" }),
  );
  return root;
}

// Contract-conformant stub: re-exports the shared fixture so the export
// probe AND the Issue #144 behavioral battery both pass. Empty function
// stubs no longer satisfy contractOk — exports alone are not compatibility.
const STUB_OK = `export * from ${JSON.stringify(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "handshake-ok.mjs")).href,
)};\n`;
const STUB_OLD = `
export function AfterEffects() {}
`;

test("missingContractExports: full contract -> empty", () => {
  const mod = {
    AfterEffects: function () {},
    negotiateCapabilities: function () {},
    assertDispatchAllowed: function () {},
  };
  assert.deepEqual(missingContractExports(mod), []);
});

test("missingContractExports: published-alpha.2 shape -> all handshake exports missing", () => {
  const mod = { AfterEffects: function () {} };
  const missing = missingContractExports(mod);
  assert.deepEqual(missing.sort(), ["assertDispatchAllowed", "negotiateCapabilities"]);
});

test("missingContractExports: null module -> every requirement missing", () => {
  assert.deepEqual(
    missingContractExports(null).sort(),
    Object.keys(REQUIRED_AE_A8N_CONTRACT).sort(),
  );
});

test("aeA8nContractError: stable code + remediation mentions --ae-a8n-root", () => {
  const e = aeA8nContractError({
    source: "npm:@ido-bata/ae-a8n",
    version: "0.1.0-alpha.2",
    missing: ["negotiateCapabilities"],
  });
  assert.equal(e.code, "AE_A8N_CONTRACT_UNSUPPORTED");
  assert.match(e.message, /--ae-a8n-root/);
  assert.match(e.message, /0\.1\.0-alpha\.2/);
});

test("probeAeA8n: local root with full contract -> contractOk", async () => {
  const root = fixtureRoot(STUB_OK);
  try {
    const probe = await probeAeA8n({ aeA8nRoot: root });
    assert.equal(probe.resolvable, true);
    assert.equal(probe.contractOk, true);
    assert.deepEqual(probe.missing, []);
    assert.equal(probe.version, "0.0.0-test");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeAeA8n: local root with stale contract -> contractOk false, no throw", async () => {
  const root = fixtureRoot(STUB_OLD);
  try {
    const probe = await probeAeA8n({ aeA8nRoot: root });
    assert.equal(probe.resolvable, true);
    assert.equal(probe.contractOk, false);
    assert.ok(probe.missing.includes("negotiateCapabilities"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeAeA8n: missing dist -> resolvable false, still structured", async () => {
  const root = mkdtempSync(join(tmpdir(), "a8n-compat-empty-"));
  try {
    const probe = await probeAeA8n({ aeA8nRoot: root });
    assert.equal(probe.resolvable, false);
    assert.equal(probe.contractOk, false);
    assert.ok(typeof probe.error === "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSliceSession: stale-contract root refuses BEFORE extension build / launch", async () => {
  const root = fixtureRoot(STUB_OLD);
  try {
    // The fixture has no dist/cli.js, so reaching `extension build` or
    // AfterEffects.launch would surface a different error. The contract
    // gate must fire first.
    await assert.rejects(
      openSliceSession({ aeA8nRoot: root, workdir: mkdtempSync(join(tmpdir(), "a8n-wd-")) }),
      (e) => e.code === "AE_A8N_CONTRACT_UNSUPPORTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSliceSession: contract-satisfying root passes the gate (fails later at cliPath)", async () => {
  const root = fixtureRoot(STUB_OK);
  try {
    await assert.rejects(
      openSliceSession({ aeA8nRoot: root, workdir: mkdtempSync(join(tmpdir(), "a8n-wd-")) }),
      (e) => e.code !== "AE_A8N_CONTRACT_UNSUPPORTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
