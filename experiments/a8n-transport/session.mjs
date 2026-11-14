/**
 * session.mjs — real-host session assembly for the a8n-transport slice
 * (Issue #49). REAL AE ONLY — this module imports `@ido-bata/ae-a8n` and
 * must never be loaded by automated tests.
 *
 * What it does, in order:
 *   1. builds a host script with `ae-a8n extension build`, declaring the
 *      `aeDevtools.trustedEval` method from ./extension.mjs — the canonical
 *      ES3 validation path, not a hand-rolled concatenation;
 *   2. launches After Effects through `AfterEffects.launch({ hostScript })`,
 *      which yields an OWNED session (attached/unknown hosts are refused by
 *      ae-a8n itself and by `ae.call`'s requireOwned);
 *   3. returns { ae, transport, runner, pin, close } where pin binds the
 *      trusted-execution consent scope to this launch instance.
 *
 * Pin identity: ae-a8n does not expose a host session id, so `sessionId`
 * and `dispatchId` are minted per launch and recorded in the evidence
 * artifact. They scope consent to "this launched instance", which is the
 * strongest identity the current ae-a8n API attests; cryptographic host
 * attestation is ae-a8n #97–#99 territory.
 *
 * Safety: the scenario this session runs is read-only against the project
 * (no comp/layer/project mutation) precisely because AE may restore the
 * user's last-opened project on launch. Mutating dispatches require a
 * separately authorized slice.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { createA8nTransport } from "./transport.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_MODULE = join(HERE, "extension.mjs");

/**
 * Resolve the ae-a8n API + CLI. Default: the pinned npm dependency.
 * `aeA8nRoot` points at a local checkout's `dist/` build instead — used to
 * exercise unreleased fixes (e.g. ae-a8n#103) before they are published;
 * the evidence record carries the root so the run is never mistaken for a
 * released-package verification.
 */
async function loadAeA8n(aeA8nRoot) {
  if (typeof aeA8nRoot === "string" && aeA8nRoot.length > 0) {
    const indexUrl = pathToFileURL(join(aeA8nRoot, "dist", "index.js")).href;
    const mod = await import(indexUrl);
    return {
      AfterEffects: mod.AfterEffects,
      cliPath: join(aeA8nRoot, "dist", "cli.js"),
      source: `local:${aeA8nRoot}`,
    };
  }
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { AfterEffects } = await import("@ido-bata/ae-a8n");
  const entry = require.resolve("@ido-bata/ae-a8n");
  return {
    AfterEffects,
    // dist/index.js and dist/cli.js are siblings.
    cliPath: join(dirname(entry), "cli.js"),
    source: "npm:@ido-bata/ae-a8n",
  };
}

/**
 * @param {object} options
 *   installDir     — forwarded to AfterEffects.launch (pin an AE install)
 *   aeA8nRoot      — local ae-a8n checkout root with a built dist/; overrides
 *                    the pinned npm dependency (recorded in evidence)
 *   callTimeoutMs  — per-dispatch ae.call budget (default 9500)
 *   deadlineMs     — runner deadline (default 10000; keep > callTimeoutMs)
 *   workdir        — scratch dir for the generated host script (default: tmp)
 */
export async function openSliceSession(options = {}) {
  const { AfterEffects, cliPath, source: aeA8nSource } = await loadAeA8n(options.aeA8nRoot);
  const workdir = options.workdir ?? mkdtempSync(join(tmpdir(), "a8n-transport-"));
  const hostScriptPath = join(workdir, "a8n-host-ext.js");
  await execFileAsync(process.execPath, [
    cliPath, "extension", "build",
    "--extension", EXTENSION_MODULE,
    "--out", hostScriptPath,
  ], { timeout: 30_000 });

  const ae = await AfterEffects.launch({
    ...(options.installDir !== undefined ? { installDir: options.installDir } : {}),
    hostScript: hostScriptPath,
  });

  const info = ae.info();
  const ownership = ae.ownership();
  if (!ownership || ownership.kind !== "owned") {
    await ae.close({ unsavedChanges: "refuse" }).catch(() => {});
    throw new Error(`slice requires an owned AE session, got ownership ${JSON.stringify(ownership)}`);
  }

  const pin = {
    sessionId: `a8n-slice-${randomUUID()}`,
    aeVersion: typeof info.version === "string" ? info.version : null,
    dispatchId: `disp-${randomUUID()}`,
  };
  const transport = createA8nTransport({
    ae,
    callTimeoutMs: options.callTimeoutMs ?? 9_500,
  });
  const runner = createJsxRunner({
    transport,
    deadlineMs: options.deadlineMs ?? 10_000,
  });

  async function close() {
    try {
      await ae.close({ unsavedChanges: "refuse" });
    } finally {
      if (options.workdir === undefined) {
        rmSync(workdir, { recursive: true, force: true });
      }
    }
  }

  return { ae, transport, runner, pin, info, ownership, close, workdir, aeA8nSource };
}
