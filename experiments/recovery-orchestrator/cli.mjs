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
 *   node cli.mjs recover --run-proof <proof.json> --request-id R --method M
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
 *   recover       — GUI mutation. REQUIRES --run-proof: a JSON record
 *                   binding aePid + GUI session + the timed-out request
 *                   being recovered + ownerId. pid/requestId/method flags
 *                   alone can never reach a press; every claim must match
 *                   the proof. The ae-a8n #111 lease is still required on
 *                   top — proof authorizes, lease serializes.
 *   verify-exit   — read-only verification. The WindowServer census runs
 *                   INSIDE the confirmed target session via ae-a8n's
 *                   censusRunnerInSession; if uid/asid cannot be confirmed
 *                   the census channel is unavailable → verdict unknown.
 *
 * UNVERIFIED on real host while GUI testing is frozen; the orchestration
 * logic is covered by tests/run.mjs against fakes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectCrashEvidence,
  loadRunProof,
  observeScreen,
  runTimeoutRecovery,
  verifyHostExit,
  verifyRunProof,
} from "./orchestrator.mjs";

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

/**
 * Confirm the claimed GUI session against the live system. Returns
 * `{ confirmed: true, session }` or `{ confirmed: false, reason }`.
 * The census is only trusted when this passes — an unverifiable session
 * means the census cannot be proven to be the target's.
 */
function confirmSession(a8n, flags) {
  const uid = Number(flags["session-uid"]);
  const asid = flags["session-asid"] === undefined ? null : Number(flags["session-asid"]);
  if (!Number.isFinite(uid)) return { confirmed: false, reason: "--session-uid missing or invalid" };
  let live;
  try {
    live = a8n.readGuiSession(uid);
  } catch (error) {
    return { confirmed: false, reason: `readGuiSession failed: ${String(error?.message ?? error)}` };
  }
  if (live === null) {
    return { confirmed: false, reason: `no GUI session found for uid ${uid}` };
  }
  if (asid !== null && live.asid !== null && live.asid !== asid) {
    return { confirmed: false, reason: `claimed asid ${asid} but uid ${uid} GUI session is asid ${live.asid}` };
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
    return manifest.counts.copyErrors > 0 ? 1 : 0;
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
    if (typeof flags["run-proof"] !== "string") {
      return fail(
        "RUN_PROOF_REQUIRED",
        "recover requires --run-proof <file>: a run proof binding aePid + GUI session + the timed-out request. " +
          "Self-declared --pid/--request-id/--method cannot authorize a GUI mutation.",
      );
    }
    const loaded = loadRunProof(flags["run-proof"]);
    if (!loaded.ok) return fail("RUN_PROOF_INVALID", loaded.reason);
    const requestId = typeof flags["request-id"] === "string" ? flags["request-id"] : null;
    const method = typeof flags.method === "string" ? flags.method : null;
    if (!requestId || !method) {
      return fail("USAGE", "recover requires --request-id and --method matching a timed-out request in the run proof");
    }
    // The claim's session/pid come from the PROOF, not from flags — flags
    // can only contradict it.
    const claim = {
      pid: loaded.proof.aePid,
      session: loaded.proof.session,
      requestId,
      method,
    };
    const check = verifyRunProof(loaded.proof, claim);
    if (!check.ok) return fail("RUN_PROOF_MISMATCH", check.reason);
    // Contradictory flags are rejected rather than ignored.
    if (flags.pid !== undefined && Number(flags.pid) !== loaded.proof.aePid) {
      return fail("RUN_PROOF_MISMATCH", `--pid ${flags.pid} contradicts run proof aePid ${loaded.proof.aePid}`);
    }
    if (flags["session-uid"] !== undefined && Number(flags["session-uid"]) !== loaded.proof.session.uid) {
      return fail("RUN_PROOF_MISMATCH", "--session-uid contradicts the run proof session");
    }

    const a8n = await loadA8n(typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined);
    const session = {
      uid: loaded.proof.session.uid,
      asid: loaded.proof.session.asid ?? null,
      username: a8n.readUsername(loaded.proof.session.uid),
      kind: "Aqua",
    };
    const pid = loaded.proof.aePid;
    const allowConsole = flags["allow-console"] === true;
    const shotDir = typeof flags["shot-dir"] === "string" ? flags["shot-dir"] : undefined;
    const timeoutMs = Number.isFinite(Number(flags["timeout-ms"])) ? Number(flags["timeout-ms"]) : 30_000;

    const gui = new a8n.MacGuiRecovery({ session, pid, screenshotDir: shotDir, allowConsoleSession: allowConsole });
    const recovery = new a8n.MacHostRecovery({
      session,
      pid: () => pid,
      screenshotDir: shotDir ?? "/tmp",
      ownerId: loaded.proof.ownerId,
    });
    const result = await runTimeoutRecovery({
      recovery, gui, requestId, method, timeoutMs,
      ownerId: loaded.proof.ownerId,
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
    const sessionCheck = confirmSession(a8n, flags);
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
