#!/usr/bin/env node
/**
 * mcp-real-run.mjs — Issue #177 REAL-AE conformance run, MCP stdio lane.
 *
 *   node packages/ae-devtools-cli/conformance/mcp-real-run.mjs \
 *     --session a8n \
 *     --install-dir "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app" \
 *     --fixture <path-to-empty.aep-or-dir> --out <evidence.jsonl>
 *
 * Drives mcp-server/server.mjs over stdio (NDJSON) against an OWNED AE
 * session and records every frame. Same disposable-project contract as
 * conformance/real-run.mjs:
 *
 *   ae_discover → ae_verify (pre-state read-back) →
 *   ae_execute project.new (confirmDestructive) →
 *   ae_execute project.save <fixture> →
 *   ae_execute item.addComp → ae_verify (read-back shows the comp) →
 *   ae_execute item.remove (confirmDestructive) → ae_verify (empty)
 *
 * The project is saved to --fixture before any mutation, so the open
 * project IS the disposable fixture; after item.remove the project is
 * back at its saved state and session close (unsavedChanges:"refuse")
 * must quit cleanly — a refusal is recorded, never counted as pass.
 *
 * --fixture may be a directory (a Conformance-MCP-Disposable.aep is
 * created inside it) or a direct .aep path.
 *
 * Replay: the archived harness-*.mjs copies under evidence/ resolve
 * their imports (mcp-server/server.mjs, devtools-cli/*.mjs) against the
 * repository checkout — replay requires the tree at the run's recorded
 * sourceSha, not the evidence directory alone.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arg } from "../devtools-cli/argv.mjs";
import { spawnMcpStdio, withTimeout, isCleanServerShutdown } from "../devtools-cli/real-run-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");

const session = arg("--session") ?? "a8n";
const fixtureArg = arg("--fixture");
if (!fixtureArg) {
  console.error("usage: mcp-real-run.mjs --fixture <dir|file.aep> [--session a8n] [--install-dir <dir>] [--out <file>]");
  process.exit(2);
}
const fixturePath = statSync(fixtureArg, { throwIfNoEntry: false })?.isDirectory()
  ? join(fixtureArg, "Conformance-MCP-Disposable.aep")
  : fixtureArg;
mkdirSync(dirname(fixturePath), { recursive: true });

const OUT = arg("--out") ?? join(process.cwd(), `mcp-conformance-${Date.now()}.jsonl`);
const log = [];
const rec = (o) => {
  log.push({ t: new Date().toISOString(), ...o });
  writeFileSync(OUT, JSON.stringify(log, null, 2));
};

const serverArgs = ["mcp-server/server.mjs", "--session", session];
const installDir = arg("--install-dir");
if (installDir) serverArgs.push("--install-dir", installDir);

// NDJSON stdio client harness shared with mcp-server/real-run.mjs
// (Issue #197).
// A recorded `fatal` is a failed conformance run — exit nonzero so
// callers/CI cannot read it as success (same contract as
// mcp-server/real-run.mjs, Issue #234). The JSONL remains the
// verdict record either way.
let fatal = false;
const { child, send, notify, call } = spawnMcpStdio({
  scriptArgs: serverArgs,
  cwd: CLI,
  onRecord: rec,
  onStderr: (d) => rec({ stderr: d.slice(0, 800) }),
});

const COMP_NAME = "MCP Conformance Comp";
const results = {};
const recordToolResult = (tag, msg) => {
  const text = msg?.result?.content?.[0]?.text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  results[tag] = {
    isError: msg?.result?.isError === true || msg?.error !== undefined,
    outcome: parsed?.outcome ?? parsed?.status ?? null,
    session: parsed?.session ?? null,
    result: parsed?.result ?? parsed ?? null,
  };
  rec({ stepResult: tag, ...results[tag] });
};

try {
  rec({ step: "initialize", argv: serverArgs, fixturePath });
  const init = await withTimeout(
    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ae-devtools-conformance", version: "0" },
    }),
    30000,
    "init",
  );
  notify("notifications/initialized");
  rec({ step: "initialized", serverInfo: init?.result?.serverInfo ?? null });

  rec({ step: "ae_discover" });
  recordToolResult("ae_discover", await withTimeout(call("ae_discover", {}), 60000, "discover"));

  // Pre-state read-back: whatever project AE restored is observed,
  // never mutated — project.new replaces it only if it is clean. When
  // this read does not COMPLETE, the pre-mutation project identity is
  // unknown and mutation must not proceed (same fail-closed rule as
  // real-run.mjs's identity gate).
  rec({ step: "ae_verify.pre-state" });
  recordToolResult("ae_verify.pre", await withTimeout(call("ae_verify", { consent: "grant" }), 300000, "verify-pre"));
  const preRead = results["ae_verify.pre"];
  if (!preRead || preRead.isError || preRead.outcome !== "COMPLETED") {
    throw new Error(
      `pre-mutation identity read-back did not complete (isError=${preRead?.isError === true}, outcome=${preRead?.outcome ?? "missing"}); refusing to mutate`,
    );
  }

  rec({ step: "ae_execute.project.new (launches owned AE)" });
  recordToolResult("project.new", await withTimeout(
    call("ae_execute", { opId: "project.new", args: {}, consent: "grant", confirmDestructive: true }),
    300000,
    "project.new",
  ));
  // A failed project.new/project.save leaves the pre-mutation project
  // identity unverified — every later step would mutate an unknown
  // project. Fail closed before the first content mutation.
  const gateMutation = (tag) => {
    const r = results[tag];
    if (!r || r.isError || r.outcome !== "COMPLETED") {
      throw new Error(
        `${tag} did not complete (isError=${r?.isError === true}, outcome=${r?.outcome ?? "missing"}); refusing to mutate`,
      );
    }
  };
  gateMutation("project.new");

  rec({ step: "ae_execute.project.save" });
  recordToolResult("project.save", await withTimeout(
    call("ae_execute", { opId: "project.save", args: { path: fixturePath }, consent: "grant" }),
    120000,
    "project.save",
  ));
  gateMutation("project.save");

  rec({ step: "ae_execute.item.addComp" });
  recordToolResult("item.addComp", await withTimeout(
    call("ae_execute", {
      opId: "item.addComp",
      args: { name: COMP_NAME, width: 1920, height: 1080, pixelAspect: 1, duration: 5, frameRate: 30 },
      consent: "grant",
    }),
    120000,
    "addComp",
  ));

  rec({ step: "ae_verify.readback" });
  recordToolResult("ae_verify.readback", await withTimeout(call("ae_verify", { consent: "grant" }), 120000, "verify"));

  rec({ step: "ae_execute.item.remove" });
  recordToolResult("item.remove", await withTimeout(
    call("ae_execute", {
      opId: "item.remove",
      args: { name: COMP_NAME, type: "CompItem" },
      consent: "grant",
      confirmDestructive: true,
    }),
    120000,
    "item.remove",
  ));

  rec({ step: "ae_verify.final" });
  recordToolResult("ae_verify.final", await withTimeout(call("ae_verify", { consent: "grant" }), 120000, "verify-final"));

  // item.remove leaves AE's dirty flag set even though content matches
  // the saved fixture — re-save so session close can quit cleanly.
  rec({ step: "ae_execute.project.save.resave" });
  recordToolResult("project.save.resave", await withTimeout(
    call("ae_execute", { opId: "project.save", args: { path: fixturePath }, consent: "grant" }),
    120000,
    "project.save.resave",
  ));
} catch (e) {
  fatal = true;
  rec({ fatal: String(e?.message ?? e) });
} finally {
  // SIGTERM runs the server's shutdown path: session.close()
  // (unsavedChanges:"refuse") — a clean disposable project quits; a
  // refusal is recorded on stderr, never hidden. Success requires a
  // CONFIRMED exit — a still-running child after SIGKILL is a failed
  // run, not a pass.
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 15000));
  let shutdownConfirmed = child.exitCode !== null || child.signalCode !== null;
  let forcedKill = false;
  if (!shutdownConfirmed) {
    try { child.kill("SIGKILL"); forcedKill = true; } catch {}
    await new Promise((r) => setTimeout(r, 3000));
    shutdownConfirmed = child.exitCode !== null || child.signalCode !== null;
  }
  // Clean shutdown means the server's OWN shutdown path completed:
  // SIGTERM → shutdown(143) → session.close() → process.exit(143).
  // Merely stopping is not proof — an exit code of 1 (e.g. an
  // unhandled rejection during close) or death by signal means
  // session.close() never confirmed the owned AE session closed
  // (Issue #384). exitCode/signalCode are recorded either way.
  const exitCode = child.exitCode;
  const signalCode = child.signalCode;
  const cleanShutdown = isCleanServerShutdown({
    shutdownConfirmed, forcedKill, exitCode, signalCode,
  });
  rec({
    step: "server.stopped", fixturePath, shutdownConfirmed, cleanShutdown,
    forcedKill, exitCode, signalCode, results,
  });
  if (!cleanShutdown) {
    fatal = true;
    rec({
      fatal: !shutdownConfirmed
        ? "MCP server child did not exit after SIGTERM+SIGKILL"
        : forcedKill
          ? "MCP server child required SIGKILL — unclean shutdown"
          : `MCP server shutdown exit was not the clean SIGTERM path (exitCode=${exitCode} signalCode=${signalCode})`,
    });
  }

  // Verdict: a recorded isError or a non-COMPLETED outcome is a failed
  // conformance run — never a pass. Read-back lanes must also show the
  // expected disposable-project state (comp present after addComp,
  // absent after item.remove), not just a COMPLETED write outcome.
  const failures = [];
  const expectCompleted = [
    "ae_verify.pre", "project.new", "project.save", "item.addComp",
    "ae_verify.readback", "item.remove", "ae_verify.final",
    "project.save.resave",
  ];
  for (const tag of expectCompleted) {
    const r = results[tag];
    if (!r) { failures.push(`${tag}: missing result`); continue; }
    if (r.isError) failures.push(`${tag}: isError=true`);
    if (r.outcome !== "COMPLETED") failures.push(`${tag}: outcome=${r.outcome ?? "null"}`);
  }
  const discover = results.ae_discover;
  if (!discover || discover.isError) failures.push("ae_discover: missing or isError");
  const itemsOf = (tag) => {
    const r = results[tag];
    const payload = r?.result?.result ?? r?.result ?? null;
    return Array.isArray(payload?.items) ? payload.items : null;
  };
  const readbackItems = itemsOf("ae_verify.readback");
  if (readbackItems === null ||
      !readbackItems.some((i) => i && i.name === COMP_NAME)) {
    failures.push("ae_verify.readback: comp not observed in project items");
  }
  const finalItems = itemsOf("ae_verify.final");
  // The fixture was created EMPTY: a correct run must leave zero items.
  // Checking only for COMP_NAME's absence would pass a project still
  // holding unrelated leftovers (e.g. a stray "Other Comp").
  if (finalItems === null) {
    failures.push("ae_verify.final: items unreadable after item.remove");
  } else if (finalItems.length !== 0) {
    failures.push(`ae_verify.final: ${finalItems.length} item(s) remain (expected empty fixture)`);
  }
  // Verdict and exit status must share ONE failure state: an unconfirmed
  // or SIGKILL-forced shutdown recorded above is a failed run, never a
  // "pass" verdict with a nonzero exit.
  if (!cleanShutdown) failures.push("server.stopped: shutdown was not a confirmed clean exit");
  if (failures.length > 0) {
    fatal = true;
    rec({ verdict: "fail", failures });
  } else {
    rec({ verdict: "pass" });
  }
  process.exit(fatal ? 1 : 0);
}
