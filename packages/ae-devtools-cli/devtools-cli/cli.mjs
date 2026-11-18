#!/usr/bin/env node
/**
 * cli.mjs — ae-devtools developer CLI (Issue #54).
 *
 * Thin wrapper over the dev-loop core (packages/ae-devtools-cli/dev-loop/devloop.mjs).
 * This file adds NO permission path: execute/verify delegate to
 * runOperation(), which is the only dispatch path (consent scope, gates,
 * trusted runner, quarantine).
 *
 *   node cli.mjs doctor [--runs] [--ae-a8n-root <dir>]
 *   node cli.mjs discover [--domain <d>]
 *   node cli.mjs inspect <opId>
 *   node cli.mjs execute <opId> [--args '<json>'] [--confirm-destructive]
 *                 [--confirm-render] --session fake|a8n
 *                 [--ae-a8n-root <dir>] [--install-dir <dir>]
 *                 [--consent grant|deny] [--out <evidence.json>]
 *                 [--close-timeout-ms <n>]
 *   node cli.mjs verify [--read-op <opId>] [same session flags]
 *   node cli.mjs runs            — list run-guard markers (residue detection)
 *   node cli.mjs reap <runId> [--confirm] — recover a stale owned leftover
 *   node cli.mjs diagnose <record.json|marker|runId>
 *                 [--map-dir d] [--jsx p] [--jsx-map p] [--bundle-map p]
 *
 * Failure diagnostics (Issue #103): a failed/refused execute or verify
 * adds an additive `diagnostics` block to the evidence record —
 * ae-devtools.diagnostics/v1 record(s) plus sourcemap resolution via
 * the packaged diagnostics/ module. `diagnose` re-reads a stored record
 * (--out evidence file, bare diagnostics record, or surviving run
 * marker) and reports fresh resolution. Both are read-only; neither
 * adds a dispatch path.
 *
 * Sessions:
 *   fake — codec-faithful vm host (FAKE/MOCK evidence only)
 *   a8n  — owned AE session via a8n-transport (Issue #49); requires that
 *          experiment present and an ae-a8n satisfying the contract gate
 *          (a8n-transport/compat.mjs, Issue #138) — ae-a8n <=0.1.0-alpha.2
 *          does NOT, use --ae-a8n-root
 *
 * Consent: --consent grant is REQUIRED for any dispatch; default is deny.
 * This is a local policy flag, not authenticated authorization
 * (ae-a8n #97-#99 owns that).
 *
 * Cleanup contract (the reason this file was restructured):
 *   - output is written only after session cleanup has settled; no code
 *     path calls process.exit() while a session may still be open
 *   - session.close() failures are reported in the payload and on stderr,
 *     never swallowed; a failed/unconfirmed close keeps the run marker so
 *     `runs`/`reap` can find the residue
 *   - SIGINT/SIGTERM trigger the same cleanup, then exit 130/143
 *   - a killed runner leaves a marker; `reap` recovers ONLY a stale run
 *     whose recorded ownership is "owned" — attached/unknown hosts are
 *     reported, never quit (ae-a8n #108 owns durable adopt/resume)
 *
 * Exit codes: 0 ok / completed / reaped, 1 refused|failed|blocked outcome
 * or cleanup failure, 2 usage/environment error, 3 cleanup unconfirmed,
 * 130/143 interrupted by SIGINT/SIGTERM.
 */
import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discover, inspect, execute, verify, DEVLOOP_SCHEMA } from "../dev-loop/devloop.mjs";
import { openSession as openSharedSession } from "../dev-loop/session-open.mjs";
import { beginRun, markSession, endRun, listRuns, reapRun, recordRequestEvent, noteSessionProcess, processStartStamp, attachEvidence, RUNS_DIR, ATTESTATION_SOURCE } from "./session-guard.mjs";
import { buildFailureDiagnostics, failureOutcome, runDiagnose } from "./diagnostics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, "..");
const DEFAULT_CLOSE_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { flags[a.slice(2)] = argv[++i]; }
      else { flags[a.slice(2)] = true; }
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Write the JSON result. Never exits — callers decide the exit code. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function findAeInstalls() {
  const roots = ["/Applications", join(process.env.HOME ?? "", "Applications")];
  const found = [];
  for (const root of roots) {
    try {
      for (const name of readdirSync(root)) {
        if (/^Adobe After Effects \d{4}(\.app)?$/.test(name)) found.push(join(root, name));
      }
    } catch { /* root unreadable */ }
  }
  return found;
}

async function openSession(flags) {
  const kind = flags.session ?? "fake";
  // Session-kind dispatch is shared with MCP/VSCode via
  // dev-loop/session-open.mjs (Issue #183) — one implementation of the
  // fake/a8n decision, the A8N_TRANSPORT_MISSING refusal and the
  // openSliceSession call. `base.slice` is the raw slice session the
  // CLI needs for recovery attestation; it is stripped before return.
  const base = await openSharedSession(kind, {
    aeA8nRoot: typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined,
    installDir: typeof flags["install-dir"] === "string" ? flags["install-dir"] : undefined,
  });
  if (kind !== "a8n") {
    const { slice: _slice, ...session } = base;
    return session;
  }
  const s = base.slice;
  // Attest the owned target for recovery authorization: the pid and GUI
  // session must come from ae-a8n's own ownership proof (recoveryTarget),
  // never from a pid discovered by other means. Older ae-a8n builds lack
  // the accessor — the marker then records nulls and recover refuses.
  const target = typeof s.ae?.recoveryTarget === "function" ? s.ae.recoveryTarget() : null;
  // Attestation provenance: recorded ONLY from the live ae-a8n session
  // object. recoveryTarget() null (unowned/closed/unattested transport)
  // or missing ownership evidence → attestation null → recover/reap
  // refuse. The marker stays an attribution record; authority comes
  // from this ae-a8n contract trace, never from the JSON itself.
  const attestation = target === null ? null : {
    source: ATTESTATION_SOURCE,
    ownershipKind: typeof s.ownership?.kind === "string" ? s.ownership.kind : null,
    ownershipEvidence: typeof s.ownership?.evidence === "string" ? s.ownership.evidence : null,
    transportKind: typeof s.transportKind === "string" ? s.transportKind : null,
    aeA8nVersion: typeof s.aeA8nHead === "string" ? s.aeA8nHead : null,
  };
  const processEvidence = target === null ? null : {
    aePid: target.pid,
    aePidStartStamp: await processStartStamp(target.pid),
    guiSession: target.session === null || target.session === undefined
      ? null
      : { uid: target.session.uid, asid: target.session.asid ?? null },
    attestation,
  };
  const { slice: _slice, ...rest } = base;
  return {
    ...rest,
    processEvidence,
    ownership: s.ownership ?? null,
    installDir: typeof flags["install-dir"] === "string" ? flags["install-dir"] : (s.installDir ?? null),
    appPath: s.appPath ?? null,
    tracePath: s.tracePath ?? null,
    workdir: s.workdir ?? null,
  };
}

function consentProviderFor(flags) {
  const grant = flags.consent === "grant";
  return async ({ opId }) => grant
    ? { approved: true }
    : { approved: false, reason: "CLI consent not granted (pass --consent grant)" };
}

/**
 * Single-flight session cleanup shared by the normal path, error paths and
 * signal handlers. Idempotent: every caller awaits the same promise.
 * The result is ALWAYS reported — a failed close escalates the exit code
 * and keeps the run marker instead of being swallowed.
 */
function makeCleanup(state, flags) {
  return async function cleanup() {
    if (state.cleanupPromise) return state.cleanupPromise;
    state.cleanupPromise = (async () => {
      const cleanup = { attempted: false, ok: null, error: null, result: null };
      if (state.session && typeof state.session.close === "function") {
        cleanup.attempted = true;
        const timeoutMs = Number.isFinite(Number(flags["close-timeout-ms"]))
          ? Number(flags["close-timeout-ms"])
          : DEFAULT_CLOSE_TIMEOUT_MS;
        let timer;
        try {
          const result = await Promise.race([
            state.session.close(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`session.close timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
          ]);
          cleanup.ok = true;
          cleanup.result = result ?? null;
        } catch (e) {
          cleanup.ok = false;
          cleanup.error = String(e?.message ?? e);
        } finally {
          clearTimeout(timer);
        }
      }
      if (state.guard) {
        // close-failed keeps the marker so `runs`/`reap` can find residue;
        // every other outcome means no proven leftover → marker removed.
        endRun(state.guard.dir, state.guard.runId,
          cleanup.ok === false ? "close-failed" : "closed");
      }
      state.cleanedUp = true;
      return cleanup;
    })();
    return state.cleanupPromise;
  };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = pos;

const state = {
  session: null,
  guard: null,
  cleanupPromise: null,
  cleanedUp: false,
};
const cleanup = makeCleanup(state, flags);

// Signal handling: first signal starts cleanup then exits with the
// conventional 128+signo code; a second signal while cleaning exits hard.
let signalSeen = null;
function onSignal(sig) {
  if (signalSeen !== null) process.exit(sig === "SIGINT" ? 130 : 143);
  signalSeen = sig;
  cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  cleanup().finally(() => {
    emit({ schema: "ae-devtools.cli.error/v1", code: "UNHANDLED_REJECTION", message: String(reason?.message ?? reason) });
    process.exit(1);
  });
});

async function main() {
  switch (cmd) {
    case "doctor": {
      // Read-only ae-a8n probe (Issue #138): resolves the same module
      // openSliceSession would use — npm dependency or --ae-a8n-root —
      // and reports contract status without launching AE.
      let aeA8n = { resolvable: false, contractOk: false };
      try {
        const { probeAeA8n } = await import("../a8n-transport/compat.mjs");
        aeA8n = await probeAeA8n({
          aeA8nRoot: typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined,
        });
      } catch (e) {
        aeA8n = { resolvable: false, contractOk: false, error: String(e?.message ?? e) };
      }
      const runs = await listRuns({ dir: RUNS_DIR });
      emit({
        schema: "ae-devtools.cli.doctor/v1",
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        devloopSchema: DEVLOOP_SCHEMA,
        aeA8n,
        aeInstalls: findAeInstalls(),
        a8nTransportPresent: existsSync(join(EXP, "a8n-transport", "session.mjs")),
        runsDir: RUNS_DIR,
        runs: runs.map((r) => ({
          runId: r.runId, status: r.status, sessionKind: r.sessionKind,
          runnerAlive: r.runnerAlive, reapable: r.reapable,
          reapBlockReason: r.reapBlockReason ?? null,
          ownership: r.session?.ownership?.kind ?? null,
        })),
        evidenceLevel: "environment probe only — no AE was contacted",
      });
      return 0;
    }
    case "runs": {
      const runs = await listRuns({ dir: RUNS_DIR });
      emit({
        schema: "ae-devtools.cli.runs/v1",
        runsDir: RUNS_DIR,
        runs: runs.map(({ markerPath, ...r }) => r),
      });
      // Any surviving marker means a run did not close cleanly — that is
      // residue, so `runs` exits nonzero whenever the list is non-empty.
      return runs.length > 0 ? 1 : 0;
    }
    case "reap": {
      const runId = rest[0];
      if (!runId) {
        emit({ schema: "ae-devtools.cli.error/v1", code: "USAGE", message: "usage: reap <runId> [--confirm]" });
        return 2;
      }
      const verdict = await reapRun(runId, { dir: RUNS_DIR, confirm: flags.confirm === true });
      emit({ schema: "ae-devtools.cli.reap/v1", ...verdict });
      return verdict.verdict === "REAPED" || verdict.verdict === "CLEAN" ? 0 : 1;
    }
    case "diagnose": {
      const target = rest[0];
      if (!target) {
        emit({ schema: "ae-devtools.cli.error/v1", code: "USAGE", message: "usage: diagnose <record.json|marker|runId> [--map-dir d] [--jsx p] [--jsx-map p] [--bundle-map p]" });
        return 2;
      }
      // Read-only: resolves stored diagnostics records through sourcemaps.
      // No session is opened and nothing is dispatched.
      const { code, payload } = await runDiagnose(target, flags, { dir: RUNS_DIR });
      emit(payload);
      return code;
    }
    case "discover": {
      emit({ schema: DEVLOOP_SCHEMA, evidenceLevel: "registry metadata — no dispatch", ...discover({ domain: flags.domain ?? null }) });
      return 0;
    }
    case "inspect": {
      const opId = rest[0];
      if (!opId) {
        emit({ error: "usage: inspect <opId>" });
        return 2;
      }
      emit({ ...inspect(opId), evidenceLevel: "metadata only — nothing executed" });
      return 0;
    }
    case "execute":
    case "verify": {
      const opId = cmd === "execute" ? rest[0] : null;
      if (cmd === "execute" && !opId) {
        emit({ error: "usage: execute <opId> [flags]" });
        return 2;
      }
      let args = {};
      if (typeof flags.args === "string") {
        try { args = JSON.parse(flags.args); }
        catch {
          emit({ error: `--args is not valid JSON: ${flags.args}` });
          return 2;
        }
      }

      // Marker BEFORE session open: a launch that dies mid-open still
      // leaves an attributable residue record.
      const guard = await beginRun({
        dir: RUNS_DIR, sessionKind: flags.session ?? "fake",
        argv: [cmd, ...rest],
      });
      state.guard = { dir: RUNS_DIR, runId: guard.runId };

      let code = 2;
      let payload;
      try {
        state.session = await openSession(flags);
        markSession(RUNS_DIR, guard.runId, state.session);
        // Record attested process evidence when the opener could prove it.
        // Absent evidence is recorded as absent — recovery authorization
        // refuses markers without it, which is the intended fail-closed
        // state until the owned-session path supplies proof.
        noteSessionProcess(RUNS_DIR, guard.runId, state.session.processEvidence ?? {});
        const evidence = {
          schema: "ae-devtools.cli.run/v1",
          runId: guard.runId,
          command: cmd,
          opId: opId ?? null,
          requestId: null, // filled below once minted
          session: {
            kind: state.session.kind,
            evidenceLevel: state.session.evidenceLevel,
            ...state.session.meta,
            ownership: state.session.ownership?.kind ?? state.session.meta?.ownership ?? null,
          },
          at: new Date().toISOString(),
        };
        // Every dispatched request is recorded in the run marker so a
        // later recovery can prove the request actually timed out — a
        // self-declared requestId is not evidence. requestId is single-use
        // in the trusted-execution runner, so it is minted per invocation.
        const requestId = typeof flags["request-id"] === "string" && flags["request-id"].length > 0
          ? flags["request-id"]
          : `req-${guard.runId}-${opId ?? "verify"}`;
        evidence.requestId = requestId;
        recordRequestEvent(RUNS_DIR, guard.runId, {
          requestId, method: opId ?? flags["read-op"] ?? "read.projectSummary", event: "dispatched",
        });
        const shared = {
          runner: state.session.runner,
          pin: state.session.pin,
          projectIdentity: "cli-devtools",
          consentProvider: consentProviderFor(flags),
          trustedScriptOptIn: true,
          scriptProvenance: "devtools-cli",
          requestId,
        };
        const result = cmd === "execute"
          ? await execute({
              opId, args, ...shared,
              confirmDestructive: flags["confirm-destructive"] === true,
              confirmRender: flags["confirm-render"] === true,
            })
          : await verify({ ...shared, readOpId: flags["read-op"] ?? "read.projectSummary" });
        evidence.result = result;
        evidence.outcome = result.outcome ?? result.status ?? null;
        // Additive failure diagnostics (Issue #103): a unified
        // ae-devtools.diagnostics/v1 record plus sourcemap resolution.
        // Completed runs carry no block; failures always do — an
        // "unavailable" status is recorded honestly when the packaged
        // diagnostics/ module cannot be loaded (e.g. damaged install).
        // failureOutcome normalizes every spelling (wire uppercase,
        // adapter lowercase status) AND lets a failure-bearing status
        // win over a COMPLETED wire outcome (adapter ok:false payloads).
        const failState = failureOutcome(result, evidence.outcome);
        if (failState !== null) {
          evidence.diagnostics = await buildFailureDiagnostics({
            result,
            outcome: failState,
            session: state.session,
            requestId,
            mapDir: typeof flags["map-dir"] === "string" ? flags["map-dir"] : undefined,
          });
        }
        // UNKNOWN means the request may still be in flight behind a modal —
        // exactly the state GUI recovery exists for. Anything else is a
        // settled request and is not recoverable.
        recordRequestEvent(RUNS_DIR, guard.runId, {
          requestId,
          method: opId ?? flags["read-op"] ?? "read.projectSummary",
          event: evidence.outcome === "UNKNOWN" ? "timeout" : "resolved",
        });
        // The exit decision uses the SAME failure-bearing outcome as the
        // diagnostics gate — evidence.outcome alone is the wire spelling
        // and would read COMPLETED for an adapter-level failure while
        // result.status says "failed" (Issue #127).
        code = failState !== null ? 1 : 0;
        payload = { ...evidence, ...(typeof flags.out === "string" ? { evidenceFile: flags.out } : {}) };
      } catch (e) {
        payload = {
          schema: "ae-devtools.cli.error/v1",
          runId: guard.runId,
          code: e.code ?? "CLI_ERROR",
          message: String(e?.message ?? e),
        };
        code = 2;
        // Only a session that never opened is "open-failed". If openSession
        // succeeded and execute()/verify() threw, the session is still live
        // — keep the guard so cleanup() closes it and finalizes the marker.
        if (!state.session && state.guard) {
          endRun(RUNS_DIR, guard.runId, "open-failed");
          state.guard = null;
        }
      }

      // Cleanup ALWAYS settles before output/exit. A failed close is
      // reported inside the payload and escalates the exit code.
      const cleanupResult = await cleanup();
      if (payload && typeof payload === "object") {
        payload.cleanup = {
          attempted: cleanupResult.attempted,
          ok: cleanupResult.ok,
          error: cleanupResult.error,
          quit: cleanupResult.result?.quit ?? null,
        };
      }
      if (typeof flags.out === "string" && payload) {
        let wroteOut = false;
        try {
          writeFileSync(flags.out, JSON.stringify(payload, null, 2));
          wroteOut = true;
        } catch (e) {
          process.stderr.write(`warning: could not write --out ${flags.out}: ${e.message}\n`);
        }
        // Link surviving residue markers to the evidence file so
        // `diagnose <runId>` can find the stored records. Cleanly
        // closed runs have no marker — attachEvidence no-ops there.
        // Separate try: a marker-write failure is not an --out failure.
        if (wroteOut) {
          try {
            attachEvidence(RUNS_DIR, guard.runId, { file: resolve(flags.out) });
          } catch (e) {
            process.stderr.write(`warning: could not link run marker to --out ${flags.out}: ${e.message}\n`);
          }
        }
      }
      if (cleanupResult.ok === false) {
        process.stderr.write(`warning: session cleanup failed: ${cleanupResult.error}\n`);
        code = cleanupResult.attempted ? 3 : code;
      } else if (cleanupResult.attempted && cleanupResult.result && cleanupResult.result.quit === false) {
        // close() declined to quit (e.g. ownership lost mid-run). Not a
        // cleanup failure, but the residue question is real — surface it.
        process.stderr.write(`note: session close did not quit AE (${cleanupResult.result.reason ?? "no reason"})\n`);
      }
      emit(payload ?? { schema: "ae-devtools.cli.error/v1", code: "NO_RESULT" });
      return code;
    }
    default:
      process.stderr.write("usage: cli.mjs <doctor|discover|inspect|execute|verify|runs|reap|diagnose> ...\n");
      return 2;
  }
}

main()
  .then((code) => {
    // exitCode + natural drain: process.stdout must flush before exit —
    // a bare process.exit() here can truncate the JSON payload on pipes.
    // The unref'd watchdog only fires if a leaked transport handle keeps
    // the loop alive; normal runs exit as soon as the loop drains.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3_000).unref();
  })
  .catch(async (e) => {
    await cleanup();
    emit({ schema: "ae-devtools.cli.error/v1", code: e?.code ?? "CLI_ERROR", message: String(e?.message ?? e) });
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 3_000).unref();
  });
