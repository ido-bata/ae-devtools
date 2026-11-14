#!/usr/bin/env node
/**
 * real-run.mjs — opt-in REAL-AE vertical slice for Issue #49.
 *
 *   node experiments/a8n-transport/real-run.mjs [--install-dir <dir>] [--out <evidence.json>]
 *
 * Requires `@ido-bata/ae-a8n` installed (see package.json) and an After
 * Effects installation discoverable by ae-a8n. Launches an OWNED session —
 * if AE is already running the launch resolves to attached/unknown and the
 * run refuses rather than touching the user's session.
 *
 * The scenario is read-only against the project (see scenario.mjs). AE
 * itself is quit at the end via ae.close({unsavedChanges:"refuse"}); if the
 * restored project is dirty, close refuses and AE is left running — that
 * is the safe outcome, recorded in the evidence.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runVerticalSlice } from "./scenario.mjs";
import { openSliceSession } from "./session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const installDir = arg("--install-dir");
  const aeA8nRoot = arg("--ae-a8n-root");
  const out = arg("--out") ?? join(HERE, "evidence", `run-${Date.now()}.json`);
  const startedAt = new Date().toISOString();

  const session = await openSliceSession({
    ...(installDir !== undefined ? { installDir } : {}),
    ...(aeA8nRoot !== undefined ? { aeA8nRoot } : {}),
  });
  const evidence = {
    issue: 49,
    startedAt,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    pin: session.pin,
    aeA8nSource: session.aeA8nSource,
    hostInfo: session.info,
    ownership: session.ownership,
    hostScript: join(session.workdir, "a8n-host-ext.js"),
    steps: [],
    close: null,
  };

  let sliceError = null;
  try {
    const { steps } = await runVerticalSlice({
      runner: session.runner,
      pin: session.pin,
      sendCount: session.transport.sendCount,
    });
    evidence.steps = steps;
  } catch (error) {
    sliceError = error instanceof Error ? error.message : String(error);
    evidence.sliceError = sliceError;
  } finally {
    try {
      await session.close();
      evidence.close = { quit: true };
    } catch (error) {
      evidence.close = {
        quit: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.transportSends = session.transport.sendCount();
  }

  writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(`evidence written: ${out}`);
  for (const step of evidence.steps) {
    console.log(`${step.outcome.padEnd(18)} ${step.label}`);
  }
  if (sliceError !== null) {
    console.error(`slice error: ${sliceError}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`real-run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
