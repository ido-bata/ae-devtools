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

  /* Refused path end-to-end (Issue #271): a registry operation outside
     NATIVE_INTAKE_OPERATIONS must come back as a contract-valid
     `refused`/`OPERATION_NOT_DISPATCHABLE` result — parsed from the
     actual emitted bytes, not substring-matched. */
  const REFUSED_ID = "e2e-req-2";
  const refusedRequest = {
    v: 1,
    token,
    timeoutMs: TIMEOUT_MS,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: REFUSED_ID,
      session: { sessionId: "e2e-session", aeVersion: "26.5" },
      operationId: "AEGP_ProjSuite6.AEGP_GetProjectName",
      args: null,
      authorizationRef: "e2e-opaque",
    },
  };
  writeFileSync(join(root, "inbox", `${REFUSED_ID}.request.json`), `${JSON.stringify(refusedRequest)}\n`, {
    mode: 0o600,
  });
  const run2 = spawnSync(BIN, ["--channel-server", root, REFUSED_ID, "20000"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  check(run2.status === 0, `refused request delivered a result (exit ${run2.status})`);
  if (run2.status === 0) {
    const refusedPath = join(root, "outbox", `${REFUSED_ID}.result.json`);
    const refusedRaw = readFileSync(refusedPath, "utf-8");
    check(!refusedRaw.includes(token), "token absent from refused result");
    const refusedDoc = JSON.parse(refusedRaw) as Record<string, any>;
    const refusedErrors = validateDispatchResult(refusedDoc.result);
    check(
      refusedErrors.length === 0,
      `refused DispatchResult validates (${refusedErrors.join("; ") || "clean"})`,
    );
    check(
      refusedDoc.result?.outcome === "refused" &&
        refusedDoc.result?.refusalCode === "OPERATION_NOT_DISPATCHABLE",
      `outcome=refused OPERATION_NOT_DISPATCHABLE (got ${refusedDoc.result?.outcome}/${refusedDoc.result?.refusalCode})`,
    );
  }

  /* Issue #270 Stage 1: the first arg-bearing read-only op.
     AEGP_ItemSuite9.AEGP_GetTypeName takes {"itemType": <int 1..4>} —
     the defined non-NONE AEGP_ItemType span. */
  const TN_ID = "e2e-req-3";
  const tnRequest = {
    v: 1,
    token,
    timeoutMs: TIMEOUT_MS,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: TN_ID,
      session: { sessionId: "e2e-session", aeVersion: "26.5" },
      operationId: "AEGP_ItemSuite9.AEGP_GetTypeName",
      args: { itemType: 2 },
      authorizationRef: "e2e-opaque",
    },
  };
  writeFileSync(join(root, "inbox", `${TN_ID}.request.json`), `${JSON.stringify(tnRequest)}\n`, {
    mode: 0o600,
  });
  const run3 = spawnSync(BIN, ["--channel-server", root, TN_ID, "20000"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  check(run3.status === 0, `arg-bearing request delivered a result (exit ${run3.status})`);
  if (run3.status === 0) {
    const tnPath = join(root, "outbox", `${TN_ID}.result.json`);
    const tnRaw = readFileSync(tnPath, "utf-8");
    check(!tnRaw.includes(token), "token absent from arg-bearing result");
    const tnDoc = JSON.parse(tnRaw) as Record<string, any>;
    const tnErrors = validateDispatchResult(tnDoc.result);
    check(
      tnErrors.length === 0,
      `arg-bearing DispatchResult validates (${tnErrors.join("; ") || "clean"})`,
    );
    check(
      tnDoc.result?.outcome === "completed" &&
        typeof tnDoc.result?.result?.typeName === "string" &&
        tnDoc.result.result.typeName.length > 0,
      `GetTypeName completed with typeName (got ${JSON.stringify(tnDoc.result?.result)})`,
    );
    check(
      Array.isArray(tnDoc.result?.opCalls) &&
        tnDoc.result.opCalls.includes("AEGP_ItemSuite9.AEGP_GetTypeName"),
      "opCalls links the GetTypeName op record",
    );
  }

  /* Negative: unpermitted args (NONE=0) refuse MALFORMED_REQUEST before
     any AEGP call — contract-valid refused result, no opCalls. */
  const BAD_ID = "e2e-req-4";
  const badRequest = {
    v: 1,
    token,
    timeoutMs: TIMEOUT_MS,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: BAD_ID,
      session: { sessionId: "e2e-session", aeVersion: "26.5" },
      operationId: "AEGP_ItemSuite9.AEGP_GetTypeName",
      args: { itemType: 0 },
      authorizationRef: "e2e-opaque",
    },
  };
  writeFileSync(join(root, "inbox", `${BAD_ID}.request.json`), `${JSON.stringify(badRequest)}\n`, {
    mode: 0o600,
  });
  const run4 = spawnSync(BIN, ["--channel-server", root, BAD_ID, "20000"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  check(run4.status === 0, `bad-args request delivered a result (exit ${run4.status})`);
  if (run4.status === 0) {
    const badDoc = JSON.parse(
      readFileSync(join(root, "outbox", `${BAD_ID}.result.json`), "utf-8"),
    ) as Record<string, any>;
    const badErrors = validateDispatchResult(badDoc.result);
    check(
      badErrors.length === 0,
      `bad-args DispatchResult validates (${badErrors.join("; ") || "clean"})`,
    );
    check(
      badDoc.result?.outcome === "refused" &&
        badDoc.result?.refusalCode === "MALFORMED_REQUEST" &&
        badDoc.result?.opCalls === undefined,
      `bad args refused MALFORMED_REQUEST pre-dispatch (got ${badDoc.result?.outcome}/${badDoc.result?.refusalCode})`,
    );
  }

  /* Issue #270 Stage 3: aeRef identity resolution end-to-end. The
     descriptor {"aeRef":{type,name,path}} is shape-validated client-
     side conceptually, resolved host-side through the SDK suites, and
     verified against live item state — external JSON never becomes a
     host handle. The channel-server fixture provides one project with
     items "Plate" (index 0) and "Café" (index 1). */
  const IN_ID = "e2e-req-5";
  const inRequest = {
    v: 1,
    token,
    timeoutMs: TIMEOUT_MS,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: IN_ID,
      session: { sessionId: "e2e-session", aeVersion: "26.5" },
      operationId: "AEGP_ItemSuite9.AEGP_GetItemName",
      args: {
        projectIndex: 0,
        item: { aeRef: { type: "comp", name: "Café", path: [1] } },
      },
      authorizationRef: "e2e-opaque",
    },
  };
  writeFileSync(join(root, "inbox", `${IN_ID}.request.json`), `${JSON.stringify(inRequest)}\n`, {
    mode: 0o600,
  });
  const run5 = spawnSync(BIN, ["--channel-server", root, IN_ID, "20000", "with-items"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  check(run5.status === 0, `aeRef request delivered a result (exit ${run5.status})`);
  if (run5.status === 0) {
    const inDoc = JSON.parse(
      readFileSync(join(root, "outbox", `${IN_ID}.result.json`), "utf-8"),
    ) as Record<string, any>;
    const inErrors = validateDispatchResult(inDoc.result);
    check(
      inErrors.length === 0,
      `aeRef DispatchResult validates (${inErrors.join("; ") || "clean"})`,
    );
    check(
      inDoc.result?.outcome === "completed" && inDoc.result?.result?.name === "Café",
      `GetItemName resolved descriptor → name (got ${JSON.stringify(inDoc.result?.result)})`,
    );
    check(
      Array.isArray(inDoc.result?.opCalls) &&
        inDoc.result.opCalls.includes("AEGP_ItemSuite9.AEGP_GetItemName"),
      "opCalls links the resolve+op records",
    );
  }

  /* Negative: a well-formed descriptor that no longer matches live
     state refuses STALE_REFERENCE — never re-resolved, never executed. */
  const STALE_ID = "e2e-req-6";
  const staleRequest = {
    v: 1,
    token,
    timeoutMs: TIMEOUT_MS,
    request: {
      schema: "ae-devtools/native-dispatch/v1",
      requestId: STALE_ID,
      session: { sessionId: "e2e-session", aeVersion: "26.5" },
      operationId: "AEGP_ItemSuite9.AEGP_GetItemName",
      args: {
        projectIndex: 0,
        item: { aeRef: { type: "comp", name: "Renamed", path: [0] } },
      },
      authorizationRef: "e2e-opaque",
    },
  };
  writeFileSync(join(root, "inbox", `${STALE_ID}.request.json`), `${JSON.stringify(staleRequest)}\n`, {
    mode: 0o600,
  });
  const run6 = spawnSync(BIN, ["--channel-server", root, STALE_ID, "20000", "with-items"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  check(run6.status === 0, `stale-descriptor request delivered a result (exit ${run6.status})`);
  if (run6.status === 0) {
    const staleDoc = JSON.parse(
      readFileSync(join(root, "outbox", `${STALE_ID}.result.json`), "utf-8"),
    ) as Record<string, any>;
    const staleErrors = validateDispatchResult(staleDoc.result);
    check(
      staleErrors.length === 0,
      `stale DispatchResult validates (${staleErrors.join("; ") || "clean"})`,
    );
    check(
      staleDoc.result?.outcome === "refused" &&
        staleDoc.result?.refusalCode === "STALE_REFERENCE",
      `name mismatch refused STALE_REFERENCE (got ${staleDoc.result?.outcome}/${staleDoc.result?.refusalCode})`,
    );
  }

  console.log(failures === 0 ? "\nE2E PASS (fake/mock only)" : `\nE2E FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
