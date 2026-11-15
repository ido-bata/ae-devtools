#!/usr/bin/env node
/**
 * real-run.mjs — opt-in REAL-AE vertical slice for Issue #49.
 *
 *   node experiments/a8n-transport/real-run.mjs [--install-dir <dir>] [--ae-a8n-root <dir>] [--out <evidence.json>]
 *
 * Requires `@ido-bata/ae-a8n` installed (see package.json) and an After
 * Effects installation discoverable by ae-a8n. Launches an OWNED session —
 * if AE is already running the launch resolves to attached/unknown and the
 * run refuses rather than touching the user's session.
 *
 * The scenario is read-only against the project (see scenario.mjs). AE
 * itself is quit at the end via ae.close({unsavedChanges:"refuse"}); if the
 * restored project is dirty, close refuses and AE is left running — that
 * is the safe outcome, recorded in the evidence and flagged as a failed
 * run (a leftover owned host is never silently green).
 *
 * Evidence guarantees:
 *   - launch failure still writes the evidence file, including the ae-a8n
 *     sessionRoot and whatever trace.jsonl the failed launch produced;
 *   - every step's outcome AND the slice-level assertions
 *     (assertSliceOutcomes) are checked — a run that merely executed steps
 *     without proving the dev loop exits nonzero;
 *   - close failure or a surviving AE process matching the install is
 *     recorded and exits nonzero.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { assertSliceOutcomes, runVerticalSlice } from "./scenario.mjs";
import { openSliceSession } from "./session.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The main AE executable — helpers (crashpad_handler, CEPHtmlEngine,
 *  dynamiclinkmanager, TeamProjectsLocalHub) legitimately outlive it. */
const MAIN_EXE = /Contents\/MacOS\/After Effects(\s|$)/;

/**
 * Snapshot `ps` rows whose command line mentions the AE install. With no
 * --install-dir the fragment is the generic bundle directory name, which
 * matches every installed AE version — the evidence records all of them so
 * a leftover is never hidden by an over-narrow filter.
 */
async function aeProcessSnapshot(fragment) {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,args="], { timeout: 10_000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes(fragment))
      .map((line) => {
        const m = /^(\d+)\s+(.*)$/.exec(line);
        return m ? { pid: Number(m[1]), args: m[2] } : { pid: null, args: line };
      });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function errorInfo(error) {
  if (error === null || typeof error !== "object") {
    return { message: String(error) };
  }
  const info = {
    name: typeof error.name === "string" ? error.name : "Error",
    message: typeof error.message === "string" ? error.message : String(error),
  };
  if (typeof error.code === "string") info.code = error.code;
  // ae-a8n wraps driver errors; surface the innermost recognized cause name.
  let cause = error.cause;
  const chain = [];
  const seen = new Set();
  while (cause !== null && typeof cause === "object" && !seen.has(cause) && chain.length < 6) {
    seen.add(cause);
    chain.push(typeof cause.name === "string" ? cause.name : "Error");
    cause = cause.cause;
  }
  if (chain.length > 0) info.causeChain = chain;
  return info;
}

/** Copy the ae-a8n trace into the evidence object when it exists. */
function traceSnippet(tracePath, maxBytes = 64 * 1024) {
  try {
    if (typeof tracePath !== "string" || !existsSync(tracePath)) return null;
    const text = readFileSync(tracePath, "utf8");
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… [truncated]` : text;
  } catch {
    return null;
  }
}

async function main() {
  const installDir = arg("--install-dir");
  const aeA8nRoot = arg("--ae-a8n-root");
  const out = arg("--out") ?? join(HERE, "evidence", `run-${Date.now()}.json`);
  const startedAt = new Date().toISOString();
  const processFragment = installDir ?? "Adobe After Effects";

  const evidence = {
    issue: 49,
    startedAt,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    installDir: installDir ?? null,
    aeProcessesBeforeLaunch: await aeProcessSnapshot(processFragment),
    steps: [],
    close: null,
  };

  let session = null;
  try {
    session = await openSliceSession({
      ...(installDir !== undefined ? { installDir } : {}),
      ...(aeA8nRoot !== undefined ? { aeA8nRoot } : {}),
    });
  } catch (error) {
    // Launch/session failure: still write evidence. Whatever sessionRoot
    // the failed launch used is attached to the error by openSliceSession.
    evidence.launchError = errorInfo(error);
    if (error !== null && typeof error === "object") {
      evidence.sessionRoot = error.sliceSessionRoot ?? null;
      evidence.workdir = error.sliceWorkdir ?? null;
      evidence.trace = traceSnippet(
        typeof error.sliceSessionRoot === "string"
          ? join(error.sliceSessionRoot, "trace.jsonl")
          : null,
      );
    }
    // A failed launch may still have left an AE process behind (e.g. AE
    // started but readiness/ownership failed) — record it, never hide it.
    evidence.aeProcessesAfterLaunchFailure = await aeProcessSnapshot(processFragment);
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(`evidence written: ${out}`);
    console.error(`launch failed: ${evidence.launchError.message}`);
    process.exitCode = 1;
    return;
  }

  Object.assign(evidence, {
    pin: session.pin,
    aeA8nSource: session.aeA8nSource,
    aeA8nHead: session.aeA8nHead,
    hostInfo: session.info,
    ownership: session.ownership,
    hostScript: join(session.workdir, "a8n-host-ext.js"),
    sessionRoot: session.sessionRoot,
    tracePath: session.tracePath,
  });

  let sliceError = null;
  try {
    const { steps } = await runVerticalSlice({
      runner: session.runner,
      pin: session.pin,
      sendCount: session.transport.sendCount,
    });
    evidence.steps = steps;
    evidence.assertionViolations = assertSliceOutcomes(steps);
  } catch (error) {
    sliceError = error instanceof Error ? error.message : String(error);
    evidence.sliceError = sliceError;
    evidence.assertionViolations = ["slice threw before assertions could run"];
  } finally {
    // Capture the trace BEFORE close(): session.close() removes the
    // auto-created workdir (including sessionRoot/trace.jsonl).
    evidence.trace = traceSnippet(session.tracePath);
    try {
      await session.close();
      evidence.close = { quit: true };
    } catch (error) {
      evidence.close = {
        quit: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Post-close process state: a surviving process matching the install
    // means the owned host was not actually shut down — quarantine the
    // result rather than letting a green slice hide a leaked AE.
    const after = await aeProcessSnapshot(processFragment);
    evidence.aeProcessesAfterClose = after;
    const rows = Array.isArray(after) ? after : [];
    // Only the main executable counts as a leaked host: Adobe helper
    // processes (crashpad, CEPHtmlEngine, dynamiclinkmanager,
    // TeamProjectsLocalHub) are documented to linger after AE quits.
    const mainExeLeft = rows.filter((p) => MAIN_EXE.test(p.args ?? ""));
    evidence.aeHelpersAfterClose = rows.filter((p) => !MAIN_EXE.test(p.args ?? ""));
    if (evidence.close.quit !== true || mainExeLeft.length > 0) {
      evidence.sessionQuarantined = true;
      evidence.quarantineReason = evidence.close.quit !== true
        ? "close() did not confirm shutdown"
        : `main AE process(es) survived close(): ${mainExeLeft.map((p) => p.pid).join(", ")}`;
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.transportSends = session.transport.sendCount();
  }

  writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(`evidence written: ${out}`);
  for (const step of evidence.steps) {
    console.log(`${step.outcome.padEnd(18)} ${step.label}`);
  }
  if (Array.isArray(evidence.assertionViolations) && evidence.assertionViolations.length > 0) {
    console.error(`slice assertions failed:`);
    for (const v of evidence.assertionViolations) console.error(`  - ${v}`);
    process.exitCode = 1;
  }
  if (sliceError !== null) {
    console.error(`slice error: ${sliceError}`);
    process.exitCode = 1;
  }
  if (evidence.sessionQuarantined === true) {
    console.error(`session quarantined: ${evidence.quarantineReason}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`real-run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
