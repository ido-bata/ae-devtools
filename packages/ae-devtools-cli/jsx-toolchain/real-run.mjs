#!/usr/bin/env node
/**
 * real-run.mjs — opt-in REAL-AE verification for Issue #52.
 *
 * Requires the a8n-transport slice (Issue #49) present at
 * ../a8n-transport/ and a local ae-a8n build with the #103+#105 fixes:
 *
 *   node packages/ae-devtools-cli/jsx-toolchain/real-run.mjs \
 *     --ae-a8n-root /path/to/ae-a8n-checkout [--install-dir <dir>] [--out evidence.json]
 *
 * What it proves on an OWNED macOS AE session:
 *   1. a TS fixture builds to ES3 JSX + sourcemap (toolchain, in-process)
 *   2. the built artifact dispatches through the trustedEval transport and
 *      COMPLETES, with its $.global write observable by a second dispatch
 *   3. a second fixture with a deliberate runtime fault FAILs; the host
 *      error line is mapped through the sourcemap back to the TS source
 *      line — the "error -> source position" half of the dev loop
 *
 * The session is owned-only; attached/unknown launches refuse before any
 * dispatch. AE is closed with unsavedChanges:"refuse" afterwards.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFile } from "./src/build.mjs";
import { lookup } from "./src/sourcemap.mjs";
import { arg } from "../devtools-cli/argv.mjs";
import { createEvalDispatch } from "../devtools-cli/real-run-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const TRANSPORT_DIR = join(HERE, "..", "a8n-transport");
const TRUSTED_DIR = join(HERE, "..", "trusted-execution");
if (!existsSync(join(TRANSPORT_DIR, "session.mjs")) || !existsSync(join(TRUSTED_DIR, "permissions.mjs"))) {
  console.error("a8n-transport (Issue #49 / PR #50) and trusted-execution (Issue #14 / PR #42) are required; not all present on this branch.");
  process.exit(2);
}
const { openSliceSession } = await import(join(TRANSPORT_DIR, "session.mjs"));

const OPERATION_ID = "op.a8n-transport.eval";
const PROJECT_IDENTITY = "jsx-toolchain-real-run";

const outPath = arg("--out") ?? join(HERE, "evidence", `run-${Date.now()}.json`);
const evidence = {
  schema: "ae-devtools.jsx-toolchain.real-run/v1",
  issue: 52,
  startedAt: new Date().toISOString(),
  steps: [],
};

function step(name, data) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  console.log(`${data.ok === false ? "FAIL" : "ok"} ${name}`);
}

let session;
// Eval dispatch goes through the shared wrapper (Issue #197): the
// consent scope and the runner.runScript args shape are hashed
// together inside runner.mjs — rebuilding them per call site is how
// they silently drift.
let dispatch;
try {
  session = await openSliceSession({
    aeA8nRoot: arg("--ae-a8n-root"),
    installDir: arg("--install-dir"),
  });
  dispatch = createEvalDispatch({
    runner: session.runner,
    pin: session.pin,
    projectIdentity: PROJECT_IDENTITY,
    operationId: OPERATION_ID,
    scriptProvenance: "jsx-toolchain-real-run",
  });
  step("session.launch", {
    ok: true,
    aeVersion: session.info?.version ?? null,
    ownership: session.ownership?.kind ?? null,
    aeA8nSource: session.aeA8nSource,
    aeA8nHead: session.aeA8nHead,
  });

  // --- step 1: build ok.ts -> dispatch -> COMPLETED + $.global write ---
  const okBuild = buildFile(join(FIXTURES, "ok.ts"));
  step("build.ok", { ok: okBuild.status === "ok", status: okBuild.status, jsxBytes: okBuild.output?.length ?? 0 });
  if (okBuild.status !== "ok") throw new Error(`build failed: ${okBuild.status}`);

  const run1 = await dispatch(okBuild.output, `tc-ok-${Date.now()}`);
  step("dispatch.ok", { ok: run1.outcome === "COMPLETED", outcome: run1.outcome, detail: run1.error?.message ?? null });

  const run2 = await dispatch('"" + $.global.__toolchainProbe', `tc-read-${Date.now()}`);
  step("verify.global-write", {
    ok: run2.outcome === "COMPLETED" && typeof run2.result === "string" && run2.result.includes("hello ae"),
    observed: run2.result ?? null,
    outcome: run2.outcome,
  });

  // --- step 2: runtime fault -> FAILED -> sourcemap -> TS line ---
  const badBuild = buildFile(join(FIXTURES, "runtime-error.ts"));
  step("build.runtime-error", { ok: badBuild.status === "ok", status: badBuild.status });
  if (badBuild.status !== "ok") throw new Error(`build failed: ${badBuild.status}`);

  const run3 = await dispatch(badBuild.output, `tc-bad-${Date.now()}`);
  const hostLine = run3.error?.line ?? null;
  // ExtendScript reports a line but no column; column 0 can precede the
  // first mapping segment, so query past the line end — every segment on
  // a generated line here maps to the same source line.
  const mapped = hostLine != null ? lookup(badBuild.map, hostLine, 1e9) : null;
  step("dispatch.runtime-error", {
    ok: run3.outcome === "FAILED",
    outcome: run3.outcome,
    hostError: run3.error?.message ?? null,
    hostErrorName: run3.error?.name ?? null,
    hostLine,
  });
  step("sourcemap.to-source", {
    ok: mapped != null && mapped.line === 3 && /runtime-error\.ts$/.test(mapped.source ?? ""),
    mapped,
  });

  // --- step 3: unknown-problem loop — a runtime-generated fault is
  // diagnosed via host error + sourcemap, fixed, rebuilt, re-dispatched,
  // and verified. The fault is NOT a canned fixture: the undeclared
  // identifier name is minted per run so the diagnosis path (host error
  // -> sourcemap -> source line) does the work, not a lookup table.
  const badId = `__tcMystery_${Date.now().toString(36)}`;
  const mysteryTs = [
    "// generated per-run; the fault below is intentional but unnamed ahead of time",
    "function mystery(): void {",
    `  var missing = ${badId};`,
    "  $.global.__toolchainMystery = missing;",
    "}",
    "mystery();",
    "",
  ].join("\n");
  const mysteryPath = join(session.workdir, "mystery.ts");
  writeFileSync(mysteryPath, mysteryTs);

  const mBuild = buildFile(mysteryPath);
  step("mystery.build", { ok: mBuild.status === "ok", status: mBuild.status });
  const mRun = await dispatch(mBuild.output, `tc-mystery-${Date.now()}`);
  const mLine = mRun.error?.line ?? null;
  const mMapped = mLine != null ? lookup(mBuild.map, mLine, 1e9) : null;
  const diagnosed =
    mRun.outcome === "FAILED" &&
    typeof mRun.error?.message === "string" &&
    mRun.error.message.includes(badId) &&
    mMapped != null && mMapped.line === 3;
  step("mystery.detect+diagnose", {
    ok: diagnosed,
    outcome: mRun.outcome,
    hostErrorName: mRun.error?.name ?? null,
    hostLine: mLine,
    mapped: mMapped ? { source: mMapped.source, line: mMapped.line } : null,
  });

  // Fix: declare the identifier, rebuild, re-dispatch, verify the write.
  const fixedTs = mysteryTs.replace(`var missing = ${badId};`, `var ${badId} = "fixed"; var missing = ${badId};`);
  writeFileSync(mysteryPath, fixedTs);
  const fBuild = buildFile(mysteryPath);
  const fRun = await dispatch(fBuild.output, `tc-fixed-${Date.now()}`);
  step("mystery.fix+rerun", { ok: fRun.outcome === "COMPLETED", outcome: fRun.outcome });

  const vRun = await dispatch('"" + $.global.__toolchainMystery', `tc-verify-${Date.now()}`);
  step("mystery.verify", {
    ok: vRun.outcome === "COMPLETED" && vRun.result === "fixed",
    observed: vRun.result ?? null,
    outcome: vRun.outcome,
  });

  evidence.ok = evidence.steps.every((s) => s.ok !== false);
} catch (error) {
  evidence.ok = false;
  evidence.fatal = { name: error?.name ?? "Error", message: error?.message ?? String(error) };
  step("fatal", { ok: false, message: evidence.fatal.message });
} finally {
  if (session) {
    try {
      await session.close();
      step("session.close", { ok: true });
    } catch (error) {
      step("session.close", { ok: false, message: error?.message ?? String(error) });
      evidence.ok = false;
    }
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${outPath}`);
}
process.exit(evidence.ok ? 0 : 1);
