#!/usr/bin/env node
/**
 * cli.mjs — recovery-orchestrator CLI (Issue #55).
 *
 *   node cli.mjs evidence --since <ISO> --out <dir>
 *        [--pid N] [--proc-name NAME] [--app-version V] [--proc-path P]
 *        [--run-id ID] [--reports-dir d]... [--sentry-dir d]...
 *
 *   node cli.mjs observe --pid N --session-uid U --session-asid A
 *        [--session-user NAME] [--allow-console]
 *        [--ae-a8n-root <dir>] [--shot-dir <dir>]
 *
 *   node cli.mjs recover --run-id <id> --request-id R --method M
 *        [--timeout-ms N] [--ae-a8n-root <dir>] [--shot-dir <dir>]
 *
 *   node cli.mjs verify-exit --pid N --session-uid U --session-asid A
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
 *                   and whose request's LATEST recorded event is
 *                   "timeout". Self-declared flags cannot substitute.
 *                   The ae-a8n #111 lease serializes on top.
 *   verify-exit   — read-only verification. The WindowServer census runs
 *                   INSIDE the confirmed target session via ae-a8n's
 *                   censusRunnerInSession; uid AND asid must both be
 *                   confirmed AND the target pid must be attributed to
 *                   that session via lsappinfo, else UNKNOWN.
 *
 * UNVERIFIED on real host while GUI testing is frozen; the orchestration
 * logic is covered by tests/run.mjs against fakes.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeRecovery,
  collectCrashEvidence,
  loadRunMarker,
  observeScreen,
  runTimeoutRecovery,
  verifyHostExit,
} from "./orchestrator.mjs";
import { RUNS_DIR } from "../devtools-cli/session-guard.mjs";

const EXP = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const multi = { "reports-dir": [], "sentry-dir": [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = a.slice(2, eq >= 0 ? eq : undefined);
      const val = eq >= 0 ? a.slice(eq + 1) : (i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : true);
      if (key in multi) multi[key].push(val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags, multi };
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(code, message, extra = {}) {
  emit({ schema: "ae-devtools.recovery-orchestrator.error/v1", code, message, ...extra });
  return 2;
}

async function loadA8n(root) {
  const entry = root ? join(root, "dist", "index.js") : null;
  if (!entry || !existsSync(entry)) {
    const e = new Error(
      "ae-a8n recovery surface requires --ae-a8n-root pointing at a built ae-a8n checkout " +
        "(needs #109/#111 exports; npm package does not ship them yet)",
    );
    e.code = "AE_A8N_SURFACE_MISSING";
    throw e;
  }
  return import(entry);
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
 * Confirm the claimed GUI session AND the target pid's attribution to it.
 *
 * Three independent facts must all hold, or the session is unconfirmed
 * and every downstream channel degrades to UNKNOWN:
 *   1. `readGuiSession(uid)` resolves a live session with a non-null asid
 *   2. the claimed asid equals the live asid (both must be known — a
 *      missing asid on either side is not a match)
 *   3. `listAppInstances` attributes `pid` to that same uid+asid — the
 *      process must be a registered app instance OF that session, not
 *      merely alive somewhere
 */
function confirmSession(a8n, flags, pid) {
  const uid = Number(flags["session-uid"]);
  const asid = flags["session-asid"] === undefined ? null : Number(flags["session-asid"]);
  if (!Number.isFinite(uid)) return { confirmed: false, reason: "--session-uid missing or invalid" };
  if (asid === null || !Number.isFinite(asid)) {
    return { confirmed: false, reason: "--session-asid is required — a session without asid cannot be confirmed" };
  }
  let live;
  try {
    live = a8n.readGuiSession(uid);
  } catch (error) {
    return { confirmed: false, reason: `readGuiSession failed: ${String(error?.message ?? error)}` };
  }
  if (live === null) {
    return { confirmed: false, reason: `no GUI session found for uid ${uid}` };
  }
  if (live.asid === null) {
    return { confirmed: false, reason: `uid ${uid} GUI session has no asid — cannot confirm session identity` };
  }
  if (live.asid !== asid) {
    return { confirmed: false, reason: `claimed asid ${asid} but uid ${uid} GUI session is asid ${live.asid}` };
  }
  // Attribute the target pid to this session via lsappinfo.
  let instances;
  try {
    instances = a8n.listAppInstances();
  } catch {
    instances = null;
  }
  if (!Array.isArray(instances)) {
    return { confirmed: false, reason: "lsappinfo attribution unavailable — pid session membership unproven" };
  }
  const mine = instances.filter((i) => i && i.pid === pid);
  if (mine.length === 0) {
    return { confirmed: false, reason: `pid ${pid} is not a registered app instance — session membership unproven` };
  }
  const inSession = mine.some((i) => i.uid === uid && i.asid === asid);
  if (!inSession) {
    return {
      confirmed: false,
      reason: `pid ${pid} is attributed to uid/asid ${mine[0]?.uid}/${mine[0]?.asid}, not the claimed ${uid}/${asid}`,
    };
  }
  return { confirmed: true, session: live };
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
  const { pos, flags, multi } = parseArgs(process.argv.slice(2));
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
      "usage: cli.mjs <evidence|observe|recover|verify-exit> ...\n" +
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

    const a8n = await loadA8n(typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined);
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
    emit(result);
    return result.verdict === "await-original" ? 0 : 1;
  }

  const a8n = await loadA8n(typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined);
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
        ? { uid: sessionCheck.session.uid, asid: sessionCheck.session.asid ?? null, confirmed: true }
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
