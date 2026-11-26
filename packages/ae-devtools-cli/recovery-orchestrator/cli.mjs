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
 * Supervision (Issue #408): observe/recover/verify-exit accept
 * --session-root <dir> naming the ae-a8n session directory that holds
 * the durable `ae-a8n.supervision/v1` state (supervision.json +
 * monitor.lease.json). `recover` also derives it from the run marker's
 * recorded workdir when the flag is absent. The report is consumed
 * read-only — this CLI never starts a monitor and never presses a
 * dialog; a monitor-lost/degraded/needs-human state escalates the
 * verdict instead of being read as healthy.
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
import { resolveAeA8n } from "../a8n-transport/ae-a8n-resolve.mjs";
import { supervisionReport } from "../a8n-transport/supervision.mjs";
import {
  RUNS_DIR,
  RUN_ID_RE,
  pidAlive,
  pidLiveness,
  processStartStampSync,
} from "../devtools-cli/session-guard.mjs";
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
  }
  // Shared resolver (Issue #253): same root-vs-npm mechanics as
  // a8n-transport/session.mjs and compat.mjs's probe — this lane keeps
  // only its own per-command export-surface gate on top.
  const { mod } = await resolveAeA8n({ aeA8nRoot: root });
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

/**
 * Confirm the claimed GUI session and the target pid's attribution via
 * ae-a8n's live surfaces. Delegates to orchestrator.confirmGuiSession;
 * the pid probe is the shared session-guard pidLiveness tri-state
 * (Issue #423: alive/dead/unknown stay distinct — "unknown" refuses
 * instead of being recorded as dead). pidAlive stays injected for the
 * legacy boolean contract; ae-a8n's own defaultPidAlive (ESRCH-only
 * death) stays inside ae-a8n's lease inspection below.
 */
function confirmSession(a8n, flags, pid) {
  const uid = Number(flags["session-uid"]);
  const asid = flags["session-asid"] === undefined ? null : Number(flags["session-asid"]);
  return confirmGuiSession({
    deps: {
      readGuiSession: (u) => a8n.readGuiSession(u),
      listAppInstances: () => a8n.listAppInstances(),
      pidLiveness,
      pidAlive,
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
      pidAlive: typeof a8n.defaultPidAlive === "function" ? a8n.defaultPidAlive : pidAlive,
      pidStartedAt: typeof a8n.defaultPidStartedAt === "function" ? a8n.defaultPidStartedAt : processStartStampSync,
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

/**
 * Resolve the ae-a8n session directory holding durable supervision
 * state (Issue #408). Explicit --session-root wins; `recover` falls
 * back to the run marker's recorded workdir (session.mjs lays the
 * session root out as <workdir>/a8n-session). Returns null when no
 * directory can be proven — supervision then reads as absent, never
 * as healthy.
 */
function supervisionDirFor(flags, marker = null) {
  if (typeof flags["session-root"] === "string" && flags["session-root"].length > 0) {
    return flags["session-root"];
  }
  const workdir = marker?.session?.workdir;
  if (typeof workdir === "string" && workdir.length > 0) {
    return join(workdir, "a8n-session");
  }
  return null;
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
      probes: { pidLiveness, pidAlive, pidStartStamp: processStartStampSync },
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
    // Durable supervision state for this run's session (Issue #408):
    // read before AND after the attempt inside runTimeoutRecovery; the
    // report can only escalate the verdict (needs-human → quarantined,
    // monitor-lost → unknown), never downgrade it.
    const supDir = supervisionDirFor(flags, loaded.marker);
    const readSupervision = supDir === null ? null : () => supervisionReport(supDir);

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
      readSupervision,
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
    // Additive supervision snapshot when --session-root names the
    // session dir (Issue #408); absent otherwise — never fabricated.
    const supDir = supervisionDirFor(flags);
    emit({
      schema: "ae-devtools.recovery-orchestrator.observe/v1",
      ...state,
      ...(supDir !== null ? { supervision: supervisionReport(supDir) } : {}),
    });
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
    const supDir = supervisionDirFor(flags);
    const result = verifyHostExit({
      pid,
      pidAlive,
      pidLiveness,
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
      // Durable supervision report when --session-root names the session
      // dir (Issue #408): recorded on the result and gating "clean" —
      // monitor-lost/degraded is never a clean bill.
      supervision: supDir !== null ? supervisionReport(supDir) : null,
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
