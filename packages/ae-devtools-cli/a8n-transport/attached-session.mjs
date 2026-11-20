/**
 * attached-session.mjs — explicit attach to an already-running After
 * Effects for the dev-loop surfaces (Issue #366).
 *
 * This is a DIFFERENT mode from openSliceSession (session.mjs), which
 * requires `ownership.kind === "owned"` for disposable conformance runs.
 * Here the target is a host the USER opened — possibly with unsaved
 * work — so the rules differ:
 *
 *   - attach is explicit: the caller chooses session kind
 *     "a8n-attached" and may pin the target with installDir/aeVersion;
 *   - the session MUST come back `attached`. If ae-a8n reports `owned`,
 *     this launch started a fresh After Effects — that is not the
 *     requested target, so the session is closed (safe: owned) and the
 *     open refuses. `unknown` refuses the same way;
 *   - extension dispatch runs under an ae-a8n `authorization` grant
 *     naming ONLY `aeDevtools.trustedEval` — the narrowest scope that
 *     lets the trusted-execution runner reach the host. `hostEnvironment`
 *     and `menuCommands` are never granted on an attached session;
 *   - the returned session carries `policy.readOnly === true`: every
 *     dev-loop surface refuses mutating ops before consent. Writes to a
 *     user's live project are a separate, later slice;
 *   - close() releases the connection only. ae-a8n never quits a host
 *     the session does not own, and this module adds no quit path.
 *
 * Target evidence: ae-a8n does not expose a host pid for attached
 * sessions, so `target` records what the session CAN attest — AE
 * version, resolved install dir, ownership evidence, and the open
 * project's file path when readable. It is evidence for the caller,
 * never authority.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { createDispatchStore, defaultDispatchStoreDir } from "../trusted-execution/dispatch-store.mjs";
import { createA8nTransport, EVAL_METHOD } from "./transport.mjs";
import { resolveAeA8n } from "./ae-a8n-resolve.mjs";
import {
  missingContractExports,
  aeA8nContractError,
  aeA8nHandshakeError,
} from "./compat.mjs";
import { runHandshakeContractChecks } from "./contract.mjs";
import { DEFAULT_CLOSE_TIMEOUT_MS } from "../dev-loop/session-close.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_MODULE = join(HERE, "extension.mjs");

/**
 * @param {object} options
 *   installDir     — pin the AE install to attach to (forwarded to launch)
 *   aeVersion      — optional expected AE version; a live version that
 *                    differs refuses the session after attach
 *   workdir        — scratch dir for the generated host script
 *   callTimeoutMs  — per-dispatch ae.call budget (default 9500)
 *   deadlineMs     — runner deadline (default 10000; keep > callTimeoutMs)
 *   aeA8nRoot      — local ae-a8n checkout root with a built dist/
 */
export async function openAttachedSliceSession(options = {}) {
  const { AfterEffects, mod: aeA8nMod, cliPath, source: aeA8nSource, head: aeA8nHead } =
    await resolveAeA8n({ aeA8nRoot: options.aeA8nRoot });
  const missing = missingContractExports(aeA8nMod);
  if (missing.length > 0) {
    throw aeA8nContractError({
      source: aeA8nSource,
      version: aeA8nHead,
      missing,
    });
  }
  const battery = runHandshakeContractChecks(aeA8nMod);
  if (!battery.ok) {
    throw aeA8nHandshakeError({
      source: aeA8nSource,
      version: aeA8nHead,
      failures: battery.checks.filter((c) => !c.ok),
    });
  }
  const optInstallDir =
    typeof options.installDir === "string" && options.installDir.length > 0
      ? options.installDir
      : null;
  const expectedVersion =
    typeof options.aeVersion === "string" && options.aeVersion.length > 0
      ? options.aeVersion
      : null;
  const workdir = options.workdir ?? mkdtempSync(join(tmpdir(), "a8n-attached-"));
  const sessionRoot = join(workdir, "a8n-session");
  const hostScriptPath = join(workdir, "a8n-host-ext.js");
  await execFileAsync(process.execPath, [
    cliPath, "extension", "build",
    "--extension", EXTENSION_MODULE,
    "--out", hostScriptPath,
  ], { timeout: 30_000 });

  let ae;
  try {
    ae = await AfterEffects.launch({
      ...(optInstallDir !== null ? { installDir: optInstallDir } : {}),
      hostScript: hostScriptPath,
      sessionRoot,
      // The narrowest grant that lets the trusted-execution runner reach
      // the host: only the caller-facing eval method. hostEnvironment and
      // menuCommands stay ungranted on a host we do not own.
      authorization: { extensionMethods: [EVAL_METHOD] },
    });
  } catch (error) {
    if (error !== null && typeof error === "object") {
      error.sliceWorkdir = workdir;
      error.sliceSessionRoot = sessionRoot;
    }
    throw error;
  }

  try {
    const info = ae.info();
    const ownership = ae.ownership();
    const liveVersion = typeof info.version === "string" ? info.version : null;

    // Resolve the concrete install identity for evidence (same
    // best-effort mechanics as session.mjs).
    let installDir = optInstallDir;
    let appPath = null;
    try {
      if (typeof aeA8nMod.resolveInstall === "function") {
        const install = await aeA8nMod.resolveInstall(
          process.platform,
          installDir !== null ? { installDir } : {},
        );
        const exe = typeof install?.executable === "string" ? install.executable : null;
        if (exe !== null && exe.length > 0) {
          if (process.platform === "darwin") {
            appPath = dirname(dirname(dirname(exe)));
            installDir = installDir ?? appPath.replace(/\.app$/, "");
          } else {
            installDir = installDir ?? dirname(exe);
          }
        }
      }
    } catch {
      // marker metadata only
    }

    const refuse = (code, message) => {
      const refusal = new Error(message);
      refusal.code = code;
      refusal.sliceWorkdir = workdir;
      refusal.sliceSessionRoot = sessionRoot;
      refusal.sliceTracePath = ae.tracePath;
      // No close here: the shared catch below performs the single
      // bounded close for every post-launch failure.
      throw refusal;
    };

    if (!ownership || ownership.kind !== "attached") {
      refuse(
        "ATTACHED_TARGET_NOT_RUNNING",
        `a8n-attached requires an already-running After Effects; ` +
          `this session reports ownership ${JSON.stringify(ownership)}. ` +
          `Use --session a8n for a disposable owned session.`,
      );
    }
    if (expectedVersion !== null && liveVersion !== expectedVersion) {
      refuse(
        "ATTACHED_TARGET_MISMATCH",
        `attached AE version ${JSON.stringify(liveVersion)} does not match ` +
          `requested ${JSON.stringify(expectedVersion)}; nothing was dispatched`,
      );
    }

    // Open-project identity, best-effort: a project that cannot be read
    // is recorded as null, never guessed.
    let project = null;
    try {
      if (typeof ae.project === "function") {
        const info = await ae.project().info();
        project = {
          file: typeof info?.file === "string" ? info.file : null,
          name: typeof info?.name === "string" ? info.name : null,
        };
      }
    } catch {
      project = null;
    }

    const pin = {
      sessionId: `a8n-attached-${randomUUID()}`,
      aeVersion: liveVersion,
      dispatchId: `disp-${randomUUID()}`,
    };
    const transport = createA8nTransport({
      ae,
      callTimeoutMs: options.callTimeoutMs ?? 9_500,
    });
    transport.dispatchStore = createDispatchStore({
      dir: options.dispatchStoreDir ?? defaultDispatchStoreDir(),
    });
    const runner = createJsxRunner({
      transport,
      deadlineMs: options.deadlineMs ?? 10_000,
    });

    const target = {
      ownership: ownership.kind,
      ownershipEvidence: typeof ownership.evidence === "string" ? ownership.evidence : null,
      aeVersion: liveVersion,
      installDir,
      appPath,
      project,
    };

    async function close() {
      try {
        // Attached hosts are never quit by ae-a8n; this releases the
        // session's connection and staged files only.
        await ae.close({ unsavedChanges: "refuse" });
      } finally {
        if (options.workdir === undefined) {
          rmSync(workdir, { recursive: true, force: true });
        }
      }
    }

    return {
      ae, transport, runner, pin, info, ownership, close, workdir,
      aeA8nSource, aeA8nHead, tracePath: ae.tracePath, sessionRoot,
      installDir, appPath, target,
      attached: true,
      // Read-only policy: dev-loop surfaces refuse mutating ops before
      // consent when this is set (dev-loop/devloop.mjs).
      policy: { readOnly: true, mode: "attached" },
      negotiateCapabilities: aeA8nMod.negotiateCapabilities,
      assertDispatchAllowed: aeA8nMod.assertDispatchAllowed,
    };
  } catch (error) {
    let closeError = null;
    try {
      if (typeof ae.close === "function") {
        const closePromise = Promise.resolve()
          .then(() => ae.close({ unsavedChanges: "refuse" }))
          .then(() => null, (e) => { closeError = e; });
        let timedOut = false;
        await Promise.race([
          closePromise,
          new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, DEFAULT_CLOSE_TIMEOUT_MS)),
        ]);
        if (timedOut) closeError = new Error(`ae.close timed out after ${DEFAULT_CLOSE_TIMEOUT_MS}ms`);
      }
    } catch (e) {
      closeError = e;
    }
    if (error !== null && typeof error === "object") {
      try { error.sliceWorkdir ??= workdir; } catch { /* frozen error */ }
      try { error.sliceSessionRoot ??= sessionRoot; } catch { /* frozen error */ }
      try { error.sliceTracePath ??= ae.tracePath; } catch { /* trace path is best-effort */ }
      if (closeError !== null) {
        try { error.sliceCloseError = String(closeError?.message ?? closeError); } catch { /* frozen error */ }
      }
    }
    throw error;
  }
}
