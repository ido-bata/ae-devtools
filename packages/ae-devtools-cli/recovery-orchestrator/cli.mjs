#!/usr/bin/env node
/**
 * cli.mjs — recovery-orchestrator CLI (Issue #55), shipped as the
 * `ae-devtools-recover` bin of @ido-bata/ae-devtools-cli (Issue #111).
 *
 *   ae-devtools-recover evidence --since <ISO> --out <dir>
 *        [--pid N] [--proc-name NAME] [--app-version V] [--proc-path P]
 *        [--run-id ID] [--reports-dir d]... [--sentry-dir d]...
 *
 *   ae-devtools-recover observe --pid N --session-uid U --session-asid A
 *        [--session-user NAME] [--allow-console]
 *        [--ae-a8n-root <dir>] [--shot-dir <dir>]
 *
 *   ae-devtools-recover recover --run-id <id> --request-id R --method M
 *        [--timeout-ms N] [--ae-a8n-root <dir>] [--shot-dir <dir>]
 *
 *   ae-devtools-recover verify-exit --pid N --session-uid U --session-asid A
 *        [--expectation exit|crash] [--evidence-dir <dir>] [--since <ISO>]
 *        [--reports-dir d]... [--sentry-dir d]...
 *        [--ae-a8n-root <dir>]
 *
 * Authorization model:
 *
 *   observe       — read-only. Needs only a resolvable GUI session. Never
 *                   takes the ae-a8n mutation lease.
 *   recover       — GUI mutation. REQUIRES --run-id naming a LIVE
 *                   devtools-cli run marker (ae-devtools.cli.run-guard/v1)
 *                   whose owning runner is alive, whose session is owned,
 *                   whose recorded process evidence (aePid + start stamp +
 *                   guiSession uid/asid) still matches the live processes,
 *                   whose session.process carries ae-a8n ownership
 *                   ATTESTATION provenance (the marker is attribution,
 *                   not authority), and whose request's LATEST recorded
 *                   event is "timeout". Self-declared flags cannot
 *                   substitute. The ae-a8n #111 lease serializes on top.
 *   verify-exit   — read-only verification. The WindowServer census runs
 *                   INSIDE the confirmed target session via ae-a8n's
 *                   censusRunnerInSession; uid AND asid must both be
 *                   confirmed. Pid attribution via lsappinfo applies only
 *                   to LIVE pids — a dead pid (the expected verify-exit
 *                   state) is recorded as pidAttribution "dead", not as
 *                   unconfirmed, since lsappinfo cannot list it.
 *
 * UNVERIFIED on real host while GUI testing is frozen; the orchestration
 * logic is covered by tests/run.mjs against fakes.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  authorizeRecovery,
  collectCrashEvidence,
  confirmGuiSession,
  loadRunMarker,
  observeScreen,
  runTimeoutRecovery,
  verifyHostExit,
} from "./orchestrator.mjs";
import { RUNS_DIR, RUN_ID_RE } from "../devtools-cli/session-guard.mjs";
import { parseArgs } from "../devtools-cli/argv.mjs";

// --reports-dir/--sentry-dir are repeatable (Issue #197 shared parser).
const MULTI_FLAGS = ["reports-dir", "sentry-dir"];

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(code, message, extra = {}) {
  emit({ schema: "ae-devtools.recovery-orchestrator.error/v1", code, message, ...extra });
  return 2;
}

/**
 * Exports each subcommand needs from the ae-a8n surface, checked after the
 * module resolves — for BOTH `--ae-a8n-root` builds and the pinned
 * `@ido-bata/ae-a8n` dependency. A build missing a required export fails
 * loudly with AE_A8N_SURFACE_MISSING instead of silently degrading to
 * `unavailable`/`unknown` mid-command.
 *
 *   observe       — session claim + GUI observation only; still requires
 *                   the session surfaces so a session that cannot be
 *                   resolved is refused up front, not mid-observation.
 *   verify-exit   — session confirmation + session-scoped WindowServer
 *                   census; no GUI mutation surface needed.
 *   recover       — the full surface: GUI observation, host recovery and
 *                   the lease/pid probes guiLeaseState() reports.
 */
const A8N_REQUIRED_EXPORTS = {
  observe: [
    "MacGuiRecovery",
    "readUsername",
    "readGuiSession",
    "listAppInstances",
    "assessGuiObservation",
    "acquireGuiLease",
    "inspectGuiLease",
    "reapGuiLease",
  ],
  "verify-exit": [
    "readUsername",
    "readGuiSession",
    "listAppInstances",
    "censusRunnerInSession",
    "windowServerCensus",
  ],
  recover: [
    "MacGuiRecovery",
    "MacHostRecovery",
    "readUsername",
    "readGuiSession",
    "listAppInstances",
    "assessGuiObservation",
    "acquireGuiLease",
    "inspectGuiLease",
    "reapGuiLease",
    "guiLeasePaths",
    "defaultGuiLeaseRoot",
    "defaultPidAlive",
    "defaultPidStartedAt",
  ],
};

function assertA8nSurface(mod, command) {
  const required = A8N_REQUIRED_EXPORTS[command] ?? [];
  const missing = required.filter((name) => {
    const v = mod[name];
    // `typeof null === "object"` — a null export must not pass (Issue #234).
    return v == null || (typeof v !== "function" && typeof v !== "object");
  });
  if (missing.length > 0) {
    const e = new Error(
      `ae-a8n build is missing exports required by '${command}': ${missing.join(", ")} — ` +
        "pass --ae-a8n-root pointing at a compatible ae-a8n build " +
        "(the pinned @ido-bata/ae-a8n dependency ships the #109/#111 exports since 0.2.0)",
    );
    e.code = "AE_A8N_SURFACE_MISSING";
    throw e;
  }
  return mod;
}

async function loadA8n(root, command) {
  if (root) {
    const entry = join(root, "dist", "index.js");
    if (!existsSync(entry)) {
      const e = new Error(
        "ae-a8n recovery surface requires --ae-a8n-root pointing at a built ae-a8n checkout " +
          "(or the pinned @ido-bata/ae-a8n dependency, which ships the #109/#111 exports since 0.2.0)",
      );
      e.code = "AE_A8N_SURFACE_MISSING";
      throw e;
    }
    return assertA8nSurface(await import(entry), command);
  }
  const mod = await import("@ido-bata/ae-a8n");
  return assertA8nSurface(mod, command);
}

function sessionFromFlags(a8n, flags) {
  const uid = Number(flags["session-uid"]);
  const asid = flags["session-asid"] === undefined ? null : Number(flags["session-asid"]);
  if (!Number.isFinite(uid)) throw new Error("--session-uid is required");
  return {
    uid,
    asid,
    username: typeof flags["session-user"] === "string" ? flags["session-user"] : a8n.readUsername(uid),
    kind: "Aqua",
  };
}

/** ps lstart stamp for PID-reuse detection; null when unreadable. */
function pidStartStamp(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/**
 * Confirm the claimed GUI session and the target pid's attribution via
 * ae-a8n's live surfaces. Delegates to orchestrator.confirmGuiSession;
 * the pid-alive probe is pidAliveDefault so dead pids take the
 * "dead — lsappinfo cannot list it" path instead of never confirming.
 */
function confirmSession(a8n, flags, pid) {
  const uid = Number(flags["session-uid"]);
  const asid = flags["session-asid"] === undefined ? null : Number(flags["session-asid"]);
  return confirmGuiSession({
    deps: {
      readGuiSession: (u) => a8n.readGuiSession(u),
      listAppInstances: () => a8n.listAppInstances(),
      pidAlive: pidAliveDefault,
    },
    uid, asid, pid,
  });
}

/**
 * Read the ae-a8n GUI lease state for a session — evidence only. The
 * lease itself is acquired inside MacHostRecovery.attempt; this records
 * what the canonical contract said BEFORE the attempt so a refusal is
 * attributable. Returns null when the ae-a8n build lacks the lease
 * surface.
 */
function guiLeaseState(a8n, session) {
  try {
    if (
      typeof a8n.inspectGuiLease !== "function" ||
      typeof a8n.guiLeasePaths !== "function" ||
      typeof a8n.defaultGuiLeaseRoot !== "function"
    ) {
      return { available: false, reason: "ae-a8n build does not export the GUI lease surface" };
    }
    const { dir } = a8n.guiLeasePaths(a8n.defaultGuiLeaseRoot());
    // Same naming as ae-a8n's gui-lease.ts: gui-<uid>-<asid|none>.json.
    const leasePath = join(dir, `gui-${session.uid}-${session.asid ?? "none"}.json`);
    const state = a8n.inspectGuiLease(leasePath, {
      pidAlive: typeof a8n.defaultPidAlive === "function" ? a8n.defaultPidAlive : pidAliveDefault,
      pidStartedAt: typeof a8n.defaultPidStartedAt === "function" ? a8n.defaultPidStartedAt : pidStartStamp,
    });
    return {
      available: true,
      state: state.state,
      holder: state.record === null ? null : {
        ownerId: state.record.ownerId,
        pid: state.record.pid,
        acquiredAt: state.record.acquiredAt,
        purpose: state.record.purpose ?? null,
      },
    };
  } catch (error) {
    return { available: false, reason: `lease inspection failed: ${String(error?.message ?? error)}` };
  }
}

function pidAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Same rule as ae-a8n's defaultPidAlive: only ESRCH proves death.
    return error?.code !== "ESRCH";
  }
}

function targetFromFlags(flags) {
  const target = {};
  if (Number.isFinite(Number(flags.pid))) target.pid = Number(flags.pid);
  if (typeof flags["proc-name"] === "string") target.procName = flags["proc-name"];
  if (typeof flags["app-name"] === "string") target.appName = flags["app-name"];
  if (typeof flags["app-version"] === "string") target.appVersion = flags["app-version"];
  if (typeof flags["proc-path"] === "string") target.procPath = flags["proc-path"];
  if (typeof flags["proc-launch"] === "string") target.procLaunch = flags["proc-launch"];
  if (typeof flags["run-id"] === "string") target.runId = flags["run-id"];
  return target;
}

async function main() {
  const { pos, flags, multi } = parseArgs(process.argv.slice(2), { multi: MULTI_FLAGS });
  const [cmd] = pos;

  if (cmd === "evidence") {
    if (!flags.since || !flags.out) return fail("USAGE", "usage: evidence --since <ISO> --out <dir>");
    const manifest = collectCrashEvidence({
      since: flags.since,
      outDir: flags.out,
      target: targetFromFlags(flags),
      reportsDirs: multi["reports-dir"].length ? multi["reports-dir"] : undefined,
      sentryDirs: multi["sentry-dir"],
    });
    emit({ schema: "ae-devtools.recovery-orchestrator.evidence/v1", ...manifest });
    // Incomplete collection (unreadable source dir, copy failure) is a
    // failed evidence run — exit nonzero so callers cannot mistake a
    // partial sweep for a complete one.
    return manifest.complete === false || manifest.counts.copyErrors > 0 ? 1 : 0;
  }

  const needsA8n = ["observe", "recover", "verify-exit"].includes(cmd);
  if (!needsA8n) {
    process.stderr.write(
      "usage: ae-devtools-recover <evidence|observe|recover|verify-exit> ...\n" +
        "  see header comment for flags\n",
    );
    return 2;
  }

  // ---- recover: authorize BEFORE loading any GUI surface ---------------
  if (cmd === "recover") {
    if (typeof flags["run-id"] !== "string") {
      return fail(
        "RUN_ID_REQUIRED",
        "recover requires --run-id <id> naming a live devtools-cli run marker. " +
          "Self-declared --pid/--request-id/--method cannot authorize a GUI mutation.",
      );
    }
    const requestId = typeof flags["request-id"] === "string" ? flags["request-id"] : null;
    const method = typeof flags.method === "string" ? flags.method : null;
    if (!requestId || !method) {
      return fail("USAGE", "recover requires --request-id and --method matching a timed-out request recorded in the run marker");
    }
    // run-id names a marker file inside runsDir — only canonical
    // run-* ids may resolve there (Issue #227 path-traversal guard).
    if (!RUN_ID_RE.test(flags["run-id"])) {
      return fail("RUN_MARKER_INVALID", `run-id must match run-* marker naming: ${flags["run-id"]}`);
    }
    const runsDir = typeof flags["runs-dir"] === "string" ? flags["runs-dir"] : RUNS_DIR;
    const markerFile = join(runsDir, `${flags["run-id"]}.json`);
    const loaded = loadRunMarker(markerFile);
    if (!loaded.ok) return fail("RUN_MARKER_INVALID", loaded.reason);
    const auth = authorizeRecovery({
      marker: loaded.marker,
      requestId,
      method,
      probes: { pidAlive: pidAliveDefault, pidStartStamp },
    });
    if (!auth.ok) return fail("RECOVERY_REFUSED", auth.reason, { runId: flags["run-id"] });

    const a8n = await loadA8n(typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined, "recover");
    // Cross-check the recorded GUI session against live attribution before
    // constructing any GUI object: the marker's claim must match what
    // lsappinfo says about the AE pid right now.
    const sessionCheck = confirmSession(
      a8n,
      {
        "session-uid": auth.guiSession.uid,
        "session-asid": auth.guiSession.asid ?? undefined,
      },
      auth.aePid,
    );
    if (!sessionCheck.confirmed) {
      return fail("SESSION_UNCONFIRMED", sessionCheck.reason, { runId: auth.runId });
    }
    const session = {
      uid: auth.guiSession.uid,
      asid: auth.guiSession.asid ?? null,
      username: a8n.readUsername(auth.guiSession.uid),
      kind: "Aqua",
    };
    const pid = auth.aePid;
    const allowConsole = flags["allow-console"] === true;
    const shotDir = typeof flags["shot-dir"] === "string" ? flags["shot-dir"] : undefined;
    const timeoutMs = Number.isFinite(Number(flags["timeout-ms"])) ? Number(flags["timeout-ms"]) : 30_000;

    const gui = new a8n.MacGuiRecovery({ session, pid, screenshotDir: shotDir, allowConsoleSession: allowConsole });
    const recovery = new a8n.MacHostRecovery({
      session,
      pid: () => pid,
      screenshotDir: shotDir ?? "/tmp",
      ownerId: auth.ownerId,
    });
    const result = await runTimeoutRecovery({
      recovery, gui, requestId, method, timeoutMs,
      ownerId: auth.ownerId,
      screenshotDir: shotDir,
    });
    // Evidence, not authorization: the ae-a8n GUI lease state before the
    // attempt. MacHostRecovery.attempt acquires the lease itself; this
    // records what the canonical contract said so a lease refusal is
    // attributable to a named holder.
    result.guiLease = guiLeaseState(a8n, session);
    emit(result);
    return result.verdict === "await-original" ? 0 : 1;
  }

  const a8n = await loadA8n(typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined, cmd);
  const pid = Number(flags.pid);
  if (!Number.isFinite(pid)) return fail("USAGE", "--pid is required");
  const session = sessionFromFlags(a8n, flags);
  const allowConsole = flags["allow-console"] === true;
  const shotDir = typeof flags["shot-dir"] === "string" ? flags["shot-dir"] : undefined;

  if (cmd === "observe") {
    const gui = new a8n.MacGuiRecovery({ session, pid, screenshotDir: shotDir, allowConsoleSession: allowConsole });
    const state = observeScreen({ gui, screenshotDir: shotDir, requestId: "observe" });
    emit({ schema: "ae-devtools.recovery-orchestrator.observe/v1", ...state });
    return state.ok ? 0 : 1;
  }

  if (cmd === "verify-exit") {
    // Confirm the GUI session before trusting any census: uid + asid must
    // resolve to a live session, or the census channel is unavailable.
    const sessionCheck = confirmSession(a8n, flags, pid);
    let census = null;
    if (sessionCheck.confirmed) {
      try {
        const runner = a8n.censusRunnerInSession(sessionCheck.session);
        census = a8n.windowServerCensus(runner);
      } catch (error) {
        census = { available: false, reason: `session-scoped census failed: ${String(error?.message ?? error)}` };
      }
    }
    const expectation = flags.expectation === "crash" ? "crash" : "exit";
    const result = verifyHostExit({
      pid,
      pidAlive: pidAliveDefault,
      census,
      session: sessionCheck.confirmed
        ? {
            uid: sessionCheck.session.uid,
            asid: sessionCheck.session.asid ?? null,
            confirmed: true,
            pidAttribution: sessionCheck.pidAttribution ?? null,
          }
        : { uid: Number(flags["session-uid"]), asid: flags["session-asid"] === undefined ? null : Number(flags["session-asid"]), confirmed: false, reason: sessionCheck.reason },
      evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
      target: targetFromFlags(flags),
      expectation,
      since: typeof flags.since === "string" ? flags.since : null,
      reportsDirs: multi["reports-dir"].length ? multi["reports-dir"] : undefined,
      sentryDirs: multi["sentry-dir"].length ? multi["sentry-dir"] : undefined,
    });
    emit(result);
    return result.verdict === "clean" || result.verdict === "crash-verified" ? 0 : 1;
  }

  return 2;
}

main()
  .then((code) => {
    process.exitCode = typeof code === "number" ? code : 2;
    setTimeout(() => process.exit(process.exitCode), 3_000).unref();
  })
  .catch((e) => {
    emit({ schema: "ae-devtools.recovery-orchestrator.error/v1", code: e?.code ?? "CLI_ERROR", message: String(e?.message ?? e) });
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 3_000).unref();
  });
