/**
 * session.mjs — real-host session assembly for the a8n-transport slice
 * (Issue #49). REAL AE ONLY — `openSliceSession` resolves
 * `@ido-bata/ae-a8n` dynamically and launches After Effects. Automated
 * tests may import this module only to exercise the contract gate with
 * `--ae-a8n-root` fixture stubs (tests/compat.test.mjs); they must never
 * reach `AfterEffects.launch`.
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { createDispatchStore, defaultDispatchStoreDir } from "../trusted-execution/dispatch-store.mjs";
import { createA8nTransport } from "./transport.mjs";
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
 * Resolve the ae-a8n API + CLI — delegated to the shared resolver
 * (Issue #253): a8n-transport/session.mjs, compat.mjs's probeAeA8n and
 * recovery-orchestrator/cli.mjs previously copy-adapted the same
 * root-vs-npm / dist-layout / version-read mechanics. `aeA8nRoot`
 * points at a local checkout's `dist/` build — used to exercise
 * unreleased fixes (e.g. ae-a8n#103) before they are published; the
 * evidence record carries the root so the run is never mistaken for a
 * released-package verification.
 */

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
  const { AfterEffects, mod: aeA8nMod, cliPath, source: aeA8nSource, head: aeA8nHead } =
    await resolveAeA8n({ aeA8nRoot: options.aeA8nRoot });
  // Contract gate (Issue #138): refuse BEFORE extension build / launch when
  // the resolved ae-a8n lacks the handshake exports that post-date the
  // #103/#105 real-host fixes. ae-a8n <=0.1.0-alpha.2 fails here with an
  // actionable message instead of an obscure mid-run host error.
  const missing = missingContractExports(aeA8nMod);
  if (missing.length > 0) {
    throw aeA8nContractError({
      source: aeA8nSource,
      version: aeA8nHead,
      missing,
    });
  }
  // Behavioral gate (Issue #144): exports present is not compatibility.
  // The handshake battery verifies negotiation/refusal/ownership/dispatch
  // semantics against synthetic responses — pure functions, still before
  // extension build / launch, so a semantically wrong ae-a8n refuses here
  // instead of mid-run against real AE.
  const battery = runHandshakeContractChecks(aeA8nMod);
  if (!battery.ok) {
    throw aeA8nHandshakeError({
      source: aeA8nSource,
      version: aeA8nHead,
      failures: battery.checks.filter((c) => !c.ok),
    });
  }
  // Normalize once: an empty string (e.g. `--install-dir=`) is not a
  // usable install identity — treat it as absent for BOTH the launch
  // forward and the marker identity below (Issue #248).
  const optInstallDir =
    typeof options.installDir === "string" && options.installDir.length > 0
      ? options.installDir
      : null;
  const workdir = options.workdir ?? mkdtempSync(join(tmpdir(), "a8n-transport-"));
  // sessionRoot keeps ae-a8n's trace.jsonl + result files inside workdir so
  // launch-failure evidence survives instead of landing in an anonymous
  // mkdtemp the caller never learns about.
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
    });
  } catch (error) {
    // Preserve where the failed session's artifacts live so real-run can
    // copy the trace into the evidence file.
    if (error !== null && typeof error === "object") {
      error.sliceWorkdir = workdir;
      error.sliceSessionRoot = sessionRoot;
    }
    throw error;
  }

  // Everything after a successful launch runs inside one guard: ANY
  // failure here (info/ownership throwing, transport/runner setup,
  // the ownership refusal itself) must close the AE session — an
  // orphaned owned process has no run-guard marker because
  // openSliceSession runs before markSession (Issue #228).
  try {
    const info = ae.info();
    const ownership = ae.ownership();
    // Resolve the concrete install identity for run-guard markers
    // (Issue #219): AfterEffects.launch auto-detects the install when
    // installDir is not passed, but reap's process matching needs the
    // real paths — resolveInstall repeats the same discovery cheaply.
    // Best-effort: launch already succeeded, so a resolution failure
    // here records nulls rather than failing the session.
    let installDir = optInstallDir;
    let appPath = null;
    try {
      if (typeof aeA8nMod.resolveInstall === "function") {
        // Await + shape-check: the export is not part of
        // REQUIRED_AE_A8N_CONTRACT, so a missing/renamed/wrong-signature
        // export must degrade to nulls, never throw mid-session (Issue #248).
        const install = await aeA8nMod.resolveInstall(
          process.platform,
          installDir !== null ? { installDir } : {},
        );
        const exe = typeof install?.executable === "string" ? install.executable : null;
        if (exe !== null && exe.length > 0) {
          if (process.platform === "darwin") {
            // <bundle>.app/Contents/MacOS/<exe>
            appPath = dirname(dirname(dirname(exe)));
            // session-guard expands a non-".app" root as `${root}.app`,
            // so installDir must be the bundle path minus that suffix —
            // dirname(appPath) would name the bundle's PARENT folder and
            // the reaper's quit target would not exist (Issue #248).
            installDir = installDir ?? appPath.replace(/\.app$/, "");
          } else {
            installDir = installDir ?? dirname(exe);
          }
        }
      }
    } catch {
      // marker metadata only — see comment above
    }
    if (!ownership || ownership.kind !== "owned") {
      const refusal = new Error(
        `slice requires an owned AE session, got ownership ${JSON.stringify(ownership)}`,
      );
      // Same evidence context as a launch failure: the session DID start
      // (attached/unknown), so its trace exists and must be preserved.
      refusal.sliceWorkdir = workdir;
      refusal.sliceSessionRoot = sessionRoot;
      refusal.sliceTracePath = ae.tracePath;
      throw refusal;
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
    // Cross-instance dispatch dedup/quarantine (Issue #255): attach the
    // store to the TRANSPORT, not the runner — every createJsxRunner()
    // built on this session's transport (the session runner, the
    // conformance short-deadline runner, agent-loop runners) shares the
    // same dedup identity space. Entries are keyed by the session pin,
    // so unrelated sessions never collide. Dir: AE_DEVTOOLS_DISPATCH_
    // STORE_DIR override or the tmpdir default (survives process
    // restarts — the case this store exists for). A transport without
    // the property (fake sessions, tests) stays instance-local.
    transport.dispatchStore = createDispatchStore({
      dir: options.dispatchStoreDir ?? defaultDispatchStoreDir(),
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

    return {
      ae, transport, runner, pin, info, ownership, close, workdir, aeA8nSource,
      aeA8nHead, tracePath: ae.tracePath, sessionRoot, installDir, appPath,
      // Handshake functions from the resolved module, for live-session
      // contract evidence (real-run.mjs). Gate already proved they exist.
      negotiateCapabilities: aeA8nMod.negotiateCapabilities,
      assertDispatchAllowed: aeA8nMod.assertDispatchAllowed,
    };
  } catch (error) {
    // Close on EVERY post-launch failure — bounded (a hung transport
    // close must not pin this path forever; the bound is the shared
    // DEFAULT_CLOSE_TIMEOUT_MS from dev-loop/session-close.mjs, Issue #253), guarded (ae.close may be absent or
    // non-promise on older ae-a8n), and REPORTED: a refused close leaves
    // an owned AE process alive with no run-guard marker, so the close
    // outcome is attached to the thrown error instead of swallowed
    // (Issue #248). The original failure is still the one callers see.
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
      // Context attachment is best-effort: a frozen/non-extensible thrown
      // error must not replace the original failure with a TypeError.
      try { error.sliceWorkdir ??= workdir; } catch { /* frozen error */ }
      try { error.sliceSessionRoot ??= sessionRoot; } catch { /* frozen error */ }
      try { error.sliceTracePath ??= ae.tracePath; } catch { /* trace path is best-effort */ }
      if (closeError !== null) {
        try { error.sliceCloseError = String(closeError?.message ?? closeError); } catch { /* frozen error */ }
      }
    }
    // NOTE: on this path the auto-created workdir is intentionally left
    // for the CALLER — error.sliceWorkdir/sliceTracePath point inside it
    // and real-run.mjs copies the trace into the evidence file before
    // cleanup. Do not rmSync here.
    throw error;
  }
}
