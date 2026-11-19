/**
 * native-channel/v1 fake E2E — Issue #267 Slice B.
 *
 * Drives one full vertical slice with BOTH peers real where it matters:
 *
 *   client file writes (this script, contract-shaped)
 *     → <root>/inbox/<id>.request.json
 *     → probe_test --channel-server (the REAL probe.cpp entry + idle
 *       hook + native_intake.cpp against FakeHost — no After Effects)
 *     → <root>/outbox/<id>.result.json + state.json heartbeat
 *     → contract validation + validateDispatchResult (native-adapter)
 *
 * This is `fake/mock only` evidence: the host is FakeHost, so nothing
 * here says anything about real AE behaviour, real-host LOAD-PROOF
 * (#223), or dispatchability. `verifiedOnRealHost` and
 * `externalDispatchVerified` stay false.
 *
 * Prerequisite: `./run_tests.sh` has built `build-test/probe_test`
 * (AE_SDK_ROOT must point at an AE SDK for the headers).
 *
 * Usage: bun test/e2e_channel.ts   (from minimal-plugin/)
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateDispatchResult } from "../../../../packages/native-adapter/src/dispatch.ts";

const HERE = import.meta.dir;
const BIN = join(HERE, "build-test", "probe_test");
const REQUEST_ID = "e2e-req-1";
const TIMEOUT_MS = 30_000;

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

if (!existsSync(BIN)) {
  console.error(`error: ${BIN} missing — run ./run_tests.sh first (needs AE_SDK_ROOT)`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "aedevtools-native-e2e-"));
try {
  for (const d of ["", "inbox", "outbox"]) {
    const p = d ? join(root, d) : root;
    mkdirSync(p, { recursive: true, mode: 0o700 });
    chmodSync(p, 0o700);
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(join(root, "channel.json"), `${JSON.stringify({ v: 1, token })}\n`, {
    mode: 0o600,
  });

  const request = {
    v: 1,
    token,
    timeoutMs: TIMEOUT_MS,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: REQUEST_ID,
      session: { sessionId: "e2e-session", aeVersion: "26.5" },
      operationId: "AEGP_ProjSuite6.AEGP_GetNumProjects",
      args: null,
      authorizationRef: "e2e-opaque",
    },
  };
  const reqPath = join(root, "inbox", `${REQUEST_ID}.request.json`);
  writeFileSync(reqPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  console.log(`channel root: ${root}`);
  console.log(`request:      ${reqPath}`);

  const run = spawnSync(BIN, ["--channel-server", root, REQUEST_ID, "20000"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  check(run.status === 0, `plug-in side delivered a result (exit ${run.status})`);
  if (run.status !== 0) {
    console.error(run.stdout, run.stderr);
    process.exit(1);
  }

  const resultPath = join(root, "outbox", `${REQUEST_ID}.result.json`);
  check(existsSync(resultPath), "outbox result file exists");
  const raw = readFileSync(resultPath, "utf-8");
  check(!raw.includes(token), "channel token never appears in the result file");

  const doc = JSON.parse(raw) as Record<string, any>;
  check(doc.v === 1, "result wrapper v=1");
  check(typeof doc.instance === "string" && doc.instance.length > 0, "instance attested");
  check(
    typeof doc.host?.plugin === "string" &&
      typeof doc.host?.pluginId === "number" &&
      typeof doc.host?.aeVersion === "string",
    "host attestation present (plugin/pluginId/aeVersion)",
  );

  const errors = validateDispatchResult(doc.result);
  check(errors.length === 0, `DispatchResult validates (${errors.join("; ") || "clean"})`);
  check(doc.result?.requestId === REQUEST_ID, "result requestId echoes the request");
  check(doc.result?.outcome === "completed", `outcome=completed (got ${doc.result?.outcome})`);
  check(
    typeof doc.result?.result?.numProjects === "number",
    `numProjects payload present (got ${JSON.stringify(doc.result?.result)})`,
  );
  check(
    Array.isArray(doc.result?.opCalls) && doc.result.opCalls.length > 0,
    "opCalls links in-host op records",
  );

  const statePath = join(root, "state.json");
  check(existsSync(statePath), "state.json heartbeat exists");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, any>;
    check(state.v === 1 && typeof state.instance === "string", "heartbeat shape v=1 + instance");
    check(
      Array.isArray(state.allowlist) &&
        state.allowlist.includes("AEGP_ProjSuite6.AEGP_GetNumProjects"),
      "heartbeat reports the intake allowlist",
    );
    check(!JSON.stringify(state).includes(token), "token absent from state.json");
  }

  console.log(failures === 0 ? "\nE2E PASS (fake/mock only)" : `\nE2E FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
