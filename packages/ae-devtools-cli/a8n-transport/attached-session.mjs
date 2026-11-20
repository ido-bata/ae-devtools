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
 *   - the returned session carries `policy.readOnly === true` unless the
 *     caller explicitly scoped mutating ops at open time
 *     (`options.mutatingOps`): then `policy.mutation.allowedOps` names
 *     exactly those ops and dev-loop surfaces refuse every other
 *     mutating op before consent. Ops that can destroy unsaved user
 *     work (ATTACHED_FORBIDDEN_OPS) are never grantable on an attached
 *     session, no matter what the caller asks for;
 *   - close() releases the connection only. ae-a8n never quits a host
 *     the session does not own, and this module adds no quit path.
 *
 * Target evidence: ae-a8n does not expose a host pid for attached
 * sessions, so `target` records what the session CAN attest — AE
 * version, resolved install dir, ownership evidence, and the open
 * project's file path when readable. It is evidence for the caller,
 * never authority.
 *
 * Attach pre-flight (Issue #366): launching AE only to discover there
 * is no usable target costs a full cold start plus a forced quit.
 * Before launch the opener censuses running AE processes for the
 * resolved install: no processes, or only processes fully attributed
 * to other installs, refuse as ATTACHED_TARGET_NOT_RUNNING; two or
 * more instances of the same install refuse as ambiguous
 * (ATTACHED_TARGET_AMBIGUOUS); AE processes whose image path the OS
 * would not disclose refuse as ATTACHED_TARGET_UNVERIFIED — falling
 * through could cold-start a duplicate AE. Exactly one attributed
 * match falls through to AfterEffects.launch, where ae-a8n's own
 * census + ownership check remain the authority.
 *
 * Project pin: `options.projectFile` names the project file the
 * caller expects the attached AE to have open. After attach the open
 * project's file is compared (normalized, case-folded on
 * case-insensitive filesystems); a missing or different file refuses
 * with ATTACHED_TARGET_MISMATCH before any dispatch.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { getOperation } from "../scripting-adapters/registry.mjs";
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
 * Ops an attached session must NEVER dispatch, even when the caller
 * explicitly lists them in mutatingOps. `project.close` runs
 * CloseOptions.DO_NOT_SAVE_CHANGES — on a user's live AE that silently
 * discards unsaved work, which no consent flag can make safe. The list
 * is enforced at session open AND recorded in the policy so evidence
 * shows the scope that was actually granted.
 */
export const ATTACHED_FORBIDDEN_OPS = Object.freeze(["project.close"]);

/**
 * Normalize and validate the caller's mutation scope BEFORE any AE
 * process is touched. Every entry must name a registered MUTATING op;
 * reads need no grant and unknown/typo'd ids fail fast here instead of
 * silently widening or narrowing the session's authority.
 *
 * @returns {string[]} deduplicated op ids
 */
function normalizeMutatingOps(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    const e = new Error("mutatingOps must be an array of operation ids");
    e.code = "ATTACHED_MUTATION_SCOPE";
    throw e;
  }
  const seen = new Set();
  for (const opId of raw) {
    if (typeof opId !== "string" || opId.length === 0) {
      const e = new Error(`mutatingOps entries must be non-empty strings, got ${JSON.stringify(opId)}`);
      e.code = "ATTACHED_MUTATION_SCOPE";
      throw e;
    }
    if (seen.has(opId)) continue;
    seen.add(opId);
    if (ATTACHED_FORBIDDEN_OPS.includes(opId)) {
      const e = new Error(
        `'${opId}' can never be granted on an attached session: it discards ` +
        `unsaved work or quits the host (DO_NOT_SAVE_CHANGES).`,
      );
      e.code = "ATTACHED_MUTATION_FORBIDDEN";
      throw e;
    }
    let op = null;
    try { op = getOperation(opId); } catch { op = null; }
    if (op === null) {
      const e = new Error(`mutatingOps names unknown operation '${opId}'`);
      e.code = "ATTACHED_MUTATION_SCOPE";
      throw e;
    }
    if (op.mutating !== true) {
      const e = new Error(`mutatingOps names '${opId}' which is not a mutating op — reads need no grant`);
      e.code = "ATTACHED_MUTATION_SCOPE";
      throw e;
    }
  }
  return [...seen];
}

/**
 * Normalize an executable/project path for comparison: slash-folded,
 * trailing slashes stripped, and case-folded on the filesystems AE
 * runs on (APFS default and NTFS are case-insensitive).
 */
function normalizeHostPath(p) {
  let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "darwin" || process.platform === "win32") {
    s = s.toLowerCase();
  }
  return s;
}

/** Normalize a project-file path the same way, resolving relative
 * paths and symlinks where the filesystem allows. */
function normalizeProjectFilePath(p) {
  let s = String(p).trim();
  if (s.startsWith("file://")) {
    try { s = fileURLToPath(s); } catch { /* keep raw */ }
  }
  s = resolve(s);
  try { s = realpathSync.native(s); } catch { /* keep resolved form */ }
  return normalizeHostPath(s);
}

/**
 * Census running After Effects processes for the attach pre-flight.
 *
 * Contract: resolves to an array of { pid, path } rows — one per
 * process whose image name is an After Effects executable (ANY
 * install/version; `path` is its executable path, or null when the OS
 * would not disclose it), or null when the platform has no probe or
 * the probe failed. Callers must treat null AND any row with a null
 * path as inconclusive.
 */
async function defaultHostProcessProbe() {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm="], {
      timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
    });
    const rows = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (m === null) continue;
      const path = m[2].trim();
      const base = path.split("/").pop();
      // "After Effects" is the .app executable name on every macOS
      // version; "AfterFX" covers helper naming drift. Path-less comm
      // values still match by basename and stay unattributed.
      if (base === "After Effects" || base === "AfterFX") {
        rows.push({ pid: Number(m[1]), path: path.includes("/") ? path : null });
      }
    }
    return rows;
  }
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='AfterFX.exe'\" | " +
          "ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
      ],
      { timeout: 8_000, maxBuffer: 1024 * 1024 },
    );
    const rows = [];
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.indexOf("\t");
      if (t === -1) continue;
      const pid = Number(line.slice(0, t).trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const path = line.slice(t + 1).trim();
      rows.push({ pid, path: path.length > 0 ? path : null });
    }
    return rows;
  }
  return null;
}

/**
 * @param {object} options
 *   installDir     — pin the AE install to attach to (forwarded to launch)
 *   aeVersion      — optional expected AE version; a live version that
 *                    differs refuses the session after attach
 *   workdir        — scratch dir for the generated host script
 *   callTimeoutMs  — per-dispatch ae.call budget (default 9500)
 *   deadlineMs     — runner deadline (default 10000; keep > callTimeoutMs)
 *   aeA8nRoot      — local ae-a8n checkout root with a built dist/
 *   mutatingOps    — explicit op-level mutation scope (Issue #366):
 *                    array of registered mutating opIds the caller
 *                    consents to dispatch on the attached host. Empty/
 *                    absent keeps the session read-only. Validated
 *                    before launch — a bad scope never opens AE.
 *   projectFile    — expected open-project file path; after attach the
 *                    live project's file must match (normalized) or the
 *                    session refuses with ATTACHED_TARGET_MISMATCH.
 *   hostProcessProbe — test seam for the attach pre-flight census;
 *                    defaults to the platform process scan. Injected
 *                    probes return the same {pid,path} row contract.
 */
export async function openAttachedSliceSession(options = {}) {
  const mutatingOps = normalizeMutatingOps(options.mutatingOps);
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
  const expectedProjectFile =
    typeof options.projectFile === "string" && options.projectFile.length > 0
      ? options.projectFile
      : null;
  const workdir = options.workdir ?? mkdtempSync(join(tmpdir(), "a8n-attached-"));
  const sessionRoot = join(workdir, "a8n-session");

  // Resolve the install identity BEFORE launch: the attach pre-flight
  // needs the executable path to census running hosts, and the same
  // resolution feeds target evidence after attach. A resolution
  // failure is not fatal here — launch surfaces the real error.
  let installInfo = null;
  try {
    if (typeof aeA8nMod.resolveInstall === "function") {
      installInfo = await aeA8nMod.resolveInstall(
        process.platform,
        optInstallDir !== null ? { installDir: optInstallDir } : {},
      );
    }
  } catch {
    installInfo = null;
  }

  const preflightError = (code, message) => {
    const e = new Error(message);
    e.code = code;
    e.sliceWorkdir = workdir;
    e.sliceSessionRoot = sessionRoot;
    return e;
  };

  // Attach pre-flight: refuse BEFORE any AE side effect unless the
  // census finds exactly one process attributable to the target
  // install. Anything else — none, foreign-only, ambiguous, or
  // unattributable — refuses here; only a single match falls through
  // to launch, where ae-a8n's own census + ownership check decide.
  if (
    installInfo !== null &&
    typeof installInfo.executable === "string" &&
    installInfo.executable.length > 0
  ) {
    const probe = typeof options.hostProcessProbe === "function"
      ? options.hostProcessProbe
      : defaultHostProcessProbe;
    let rows = null;
    try {
      rows = await probe(installInfo);
    } catch {
      rows = null;
    }
    if (Array.isArray(rows)) {
      const exe = normalizeHostPath(installInfo.executable);
      const exact = rows.filter(
        (r) => typeof r?.path === "string" && r.path.length > 0 && normalizeHostPath(r.path) === exe,
      );
      const unattributed = rows.some((r) => typeof r?.path !== "string" || r.path.length === 0);
      if (rows.length === 0) {
        throw preflightError(
          "ATTACHED_TARGET_NOT_RUNNING",
          `a8n-attached found no running After Effects process for install ` +
            `${installInfo.executable}; start AE first or use --session a8n ` +
            `for a disposable owned session. No AE process was launched.`,
        );
      }
      if (exact.length >= 2) {
        throw preflightError(
          "ATTACHED_TARGET_AMBIGUOUS",
          `${exact.length} After Effects processes match install ` +
            `${installInfo.executable}; the attach target is ambiguous. ` +
            `Close extra instances or pin a single target.`,
        );
      }
      if (exact.length === 0) {
        if (unattributed) {
          // AE processes exist but none could be attributed to this
          // install (e.g. another user session / elevation hides the
          // image path). We cannot prove there is no usable target, and
          // falling through would cold-start a duplicate AE — refuse.
          throw preflightError(
            "ATTACHED_TARGET_UNVERIFIED",
            `After Effects processes are running but none could be ` +
              `attributed to install ${installInfo.executable} (process ` +
              `image path undisclosed). Refusing to launch a duplicate; ` +
              `run from the same user session as After Effects or close ` +
              `the other instances.`,
          );
        }
        // Every running AE process is fully attributed to a DIFFERENT
        // install — this install has no running target.
        throw preflightError(
          "ATTACHED_TARGET_NOT_RUNNING",
          `a8n-attached found After Effects processes but none match ` +
            `install ${installInfo.executable}; start that AE first or ` +
            `use --session a8n for a disposable owned session. No AE ` +
            `process was launched.`,
        );
      }
      // exact === 1: the target install has exactly one running
      // process — fall through to launch, where ae-a8n attaches to it
      // (a `-r` launcher can also transiently share the install path on
      // Windows, so ownership stays the final authority).
    }
  }

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
    // best-effort mechanics as session.mjs). installInfo was already
    // resolved before launch for the pre-flight census.
    let installDir = optInstallDir;
    let appPath = null;
    try {
      const exe = typeof installInfo?.executable === "string" ? installInfo.executable : null;
      if (exe !== null && exe.length > 0) {
        if (process.platform === "darwin") {
          appPath = dirname(dirname(dirname(exe)));
          installDir = installDir ?? appPath.replace(/\.app$/, "");
        } else {
          installDir = installDir ?? dirname(exe);
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
        // ae.project() is async and resolves to a Project handle;
        // .info() is a second call on that handle — awaiting the
        // outer promise alone reads nothing.
        const handle = await ae.project();
        const info = await handle.info();
        project = {
          file: typeof info?.file === "string" ? info.file : null,
          name: typeof info?.name === "string" ? info.name : null,
        };
      }
    } catch {
      project = null;
    }

    // Project pin: when the caller named the project file they expect
    // open, the attached host must actually have THAT project open —
    // "some AE answered" is not proof the target is the intended one.
    // A null/unreadable project file can never satisfy a pin.
    if (expectedProjectFile !== null) {
      const actualFile =
        project !== null && typeof project.file === "string" && project.file.length > 0
          ? project.file
          : null;
      const matched =
        actualFile !== null &&
        normalizeProjectFilePath(actualFile) === normalizeProjectFilePath(expectedProjectFile);
      if (!matched) {
        refuse(
          "ATTACHED_TARGET_MISMATCH",
          `attached project's file ${JSON.stringify(actualFile)} does not match ` +
            `requested project ${JSON.stringify(expectedProjectFile)}; ` +
            `nothing was dispatched`,
        );
      }
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
      projectFile: expectedProjectFile,
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
      // Dispatch policy: read-only unless the caller scoped mutating ops
      // at open time. dev-loop surfaces refuse anything outside
      // mutation.allowedOps before consent (dev-loop/devloop.mjs); the
      // scope is part of the returned session so every surface's
      // evidence records exactly what was granted.
      policy: mutatingOps.length === 0
        ? { readOnly: true, mode: "attached" }
        : {
            readOnly: false,
            mode: "attached",
            mutation: { allowedOps: mutatingOps },
          },
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
