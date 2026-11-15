#!/usr/bin/env node
/**
 * cli.mjs — recovery-orchestrator CLI (Issue #55).
 *
 *   node cli.mjs evidence --since <ISO> --out <dir> [--reports-dir d]... [--sentry-dir d]...
 *   node cli.mjs observe --pid N --session-uid U --session-asid A [--session-user NAME]
 *                        [--allow-console] [--ae-a8n-root <dir>] [--shot-dir <dir>]
 *   node cli.mjs recover --pid N --session-uid U --session-asid A --request-id R
 *                        --method M [--timeout-ms N] [--allow-console]
 *                        [--ae-a8n-root <dir>] [--shot-dir <dir>]
 *   node cli.mjs verify-exit --pid N --session-uid U --session-asid A
 *                            [--allow-console] [--ae-a8n-root <dir>]
 *                            [--evidence-dir <dir>] [--since <ISO>]
 *
 * Real-host commands construct ae-a8n's MacGuiRecovery / MacHostRecovery
 * from --ae-a8n-root (a local ae-a8n checkout with `npm run build`). They
 * are READ-ONLY for `observe`; `recover` may press a button and therefore
 * requires the ae-a8n #111 GUI lease — a held lease refuses the press.
 *
 * UNVERIFIED on real host while GUI testing is frozen; the orchestration
 * logic is covered by tests/run.mjs against fakes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectCrashEvidence,
  observeScreen,
  runTimeoutRecovery,
  verifyHostExit,
} from "./orchestrator.mjs";

const EXP = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const pos = [];
  const flags = { _: [] };
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

function fail(code, message) {
  emit({ schema: "ae-devtools.recovery-orchestrator.error/v1", code, message });
  process.exitCode = 2;
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

function pidAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Same rule as ae-a8n's defaultPidAlive: only ESRCH proves death.
    return error?.code !== "ESRCH";
  }
}

async function main() {
  const { pos, flags, multi } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;

  if (cmd === "evidence") {
    if (!flags.since || !flags.out) return fail("USAGE", "usage: evidence --since <ISO> --out <dir>");
    const manifest = collectCrashEvidence({
      since: flags.since,
      outDir: flags.out,
      reportsDirs: multi["reports-dir"].length ? multi["reports-dir"] : undefined,
      sentryDirs: multi["sentry-dir"],
    });
    emit({ schema: "ae-devtools.recovery-orchestrator.evidence/v1", ...manifest });
    return 0;
  }

  const needsA8n = ["observe", "recover", "verify-exit"].includes(cmd);
  if (!needsA8n) {
    process.stderr.write(
      "usage: cli.mjs <evidence|observe|recover|verify-exit> ...\n" +
        "  see header comment for flags\n",
    );
    return 2;
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

  if (cmd === "recover") {
    const requestId = typeof flags["request-id"] === "string" ? flags["request-id"] : `req-${Date.now()}`;
    const method = typeof flags.method === "string" ? flags.method : "unknown";
    const timeoutMs = Number.isFinite(Number(flags["timeout-ms"])) ? Number(flags["timeout-ms"]) : 30_000;
    const gui = new a8n.MacGuiRecovery({ session, pid, screenshotDir: shotDir, allowConsoleSession: allowConsole });
    const recovery = new a8n.MacHostRecovery({ session, pid: () => pid, screenshotDir: shotDir ?? "/tmp" });
    const result = await runTimeoutRecovery({ recovery, gui, requestId, method, timeoutMs, screenshotDir: shotDir });
    emit(result);
    return result.verdict === "await-original" ? 0 : 1;
  }

  if (cmd === "verify-exit") {
    const gui = new a8n.MacGuiRecovery({ session, pid, allowConsoleSession: allowConsole });
    const result = verifyHostExit({
      pid,
      pidAlive: pidAliveDefault,
      gui,
      censusFor: () => {
        // windowServerCensus needs a runner; default is execFileCensusRunner.
        return a8n.windowServerCensus(a8n.execFileCensusRunner());
      },
      evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : undefined,
      since: typeof flags.since === "string" ? flags.since : undefined,
      reportsDirs: multi["reports-dir"].length ? multi["reports-dir"] : undefined,
      sentryDirs: multi["sentry-dir"].length ? multi["sentry-dir"] : undefined,
    });
    emit(result);
    return result.verdict === "clean" ? 0 : 1;
  }

  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3_000).unref();
  })
  .catch((e) => {
    emit({ schema: "ae-devtools.recovery-orchestrator.error/v1", code: e?.code ?? "CLI_ERROR", message: String(e?.message ?? e) });
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 3_000).unref();
  });
