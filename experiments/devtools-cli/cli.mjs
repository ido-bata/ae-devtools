#!/usr/bin/env node
/**
 * cli.mjs — ae-devtools developer CLI (Issue #54).
 *
 * Thin wrapper over the dev-loop core (experiments/dev-loop/devloop.mjs).
 * This file adds NO permission path: execute/verify delegate to
 * runOperation(), which is the only dispatch path (consent scope, gates,
 * trusted runner, quarantine).
 *
 *   node cli.mjs doctor
 *   node cli.mjs discover [--domain <d>]
 *   node cli.mjs inspect <opId>
 *   node cli.mjs execute <opId> [--args '<json>'] [--confirm-destructive]
 *                 [--confirm-render] --session fake|a8n
 *                 [--ae-a8n-root <dir>] [--install-dir <dir>]
 *                 [--consent grant|deny] [--out <evidence.json>]
 *   node cli.mjs verify [--read-op <opId>] [same session flags]
 *
 * Sessions:
 *   fake — codec-faithful vm host (FAKE/MOCK evidence only)
 *   a8n  — owned AE session via a8n-transport (Issue #49); requires that
 *          experiment present and --ae-a8n-root for unreleased builds
 *
 * Consent: --consent grant is REQUIRED for any dispatch; default is deny.
 * This is a local policy flag, not authenticated authorization
 * (ae-a8n #97-#99 owns that).
 *
 * Exit codes: 0 ok / completed, 1 refused|failed|blocked outcome or
 * diagnostics, 2 usage/environment error.
 */
import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discover, inspect, execute, verify, DEVLOOP_SCHEMA } from "../dev-loop/devloop.mjs";
import { openFakeSession } from "./fake-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, "..");

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

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
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
  if (kind === "fake") return openFakeSession();
  if (kind === "a8n") {
    const tdir = join(EXP, "a8n-transport", "session.mjs");
    if (!existsSync(tdir)) {
      const e = new Error("a8n session requires experiments/a8n-transport (Issue #49) — not present on this branch");
      e.code = "A8N_TRANSPORT_MISSING";
      throw e;
    }
    const { openSliceSession } = await import(tdir);
    const s = await openSliceSession({
      aeA8nRoot: typeof flags["ae-a8n-root"] === "string" ? flags["ae-a8n-root"] : undefined,
      installDir: typeof flags["install-dir"] === "string" ? flags["install-dir"] : undefined,
    });
    return {
      kind: "a8n",
      evidenceLevel: "verified on real host (macOS)",
      runner: s.runner,
      pin: s.pin,
      close: () => s.close(),
      meta: { aeVersion: s.info?.version ?? null, ownership: s.ownership?.kind ?? null, aeA8nHead: s.aeA8nHead ?? null },
    };
  }
  const e = new Error(`unknown --session '${kind}' (fake|a8n)`);
  e.code = "USAGE";
  throw e;
}

function consentProviderFor(flags) {
  const grant = flags.consent === "grant";
  return async ({ opId }) => grant
    ? { approved: true }
    : { approved: false, reason: "CLI consent not granted (pass --consent grant)" };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = pos;

switch (cmd) {
  case "doctor": {
    let aeA8n = { resolvable: false };
    try {
      const entry = import.meta.resolve?.("@ido-bata/ae-a8n") ?? null;
      aeA8n = { resolvable: entry !== null, entry };
    } catch { /* not resolvable from here */ }
    out({
      schema: "ae-devtools.cli.doctor/v1",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      devloopSchema: DEVLOOP_SCHEMA,
      aeA8n,
      aeInstalls: findAeInstalls(),
      a8nTransportPresent: existsSync(join(EXP, "a8n-transport", "session.mjs")),
      evidenceLevel: "environment probe only — no AE was contacted",
    });
    break;
  }
  case "discover": {
    out({ schema: DEVLOOP_SCHEMA, evidenceLevel: "registry metadata — no dispatch", ...discover({ domain: flags.domain ?? null }) });
    break;
  }
  case "inspect": {
    const opId = rest[0];
    if (!opId) out({ error: "usage: inspect <opId>" }, 2);
    out({ ...inspect(opId), evidenceLevel: "metadata only — nothing executed" });
    break;
  }
  case "execute":
  case "verify": {
    const opId = cmd === "execute" ? rest[0] : null;
    if (cmd === "execute" && !opId) out({ error: "usage: execute <opId> [flags]" }, 2);
    let args = {};
    if (typeof flags.args === "string") {
      try { args = JSON.parse(flags.args); }
      catch { out({ error: `--args is not valid JSON: ${flags.args}` }, 2); }
    }
    let session;
    try { session = await openSession(flags); }
    catch (e) {
      out({ schema: "ae-devtools.cli.error/v1", code: e.code ?? "SESSION_OPEN_FAILED", message: e.message }, 2);
    }
    const evidence = {
      schema: "ae-devtools.cli.run/v1",
      command: cmd,
      opId: opId ?? null,
      session: { kind: session.kind, evidenceLevel: session.evidenceLevel, ...session.meta },
      at: new Date().toISOString(),
    };
    try {
      const shared = {
        runner: session.runner,
        pin: session.pin,
        projectIdentity: "cli-devtools",
        consentProvider: consentProviderFor(flags),
        trustedScriptOptIn: true,
        scriptProvenance: "devtools-cli",
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
      const bad = ["refused", "failed", "BLOCKED", "UNKNOWN"].includes(evidence.outcome);
      if (typeof flags.out === "string") writeFileSync(flags.out, JSON.stringify(evidence, null, 2));
      out({ ...evidence, ...(typeof flags.out === "string" ? { evidenceFile: flags.out } : {}) }, bad ? 1 : 0);
    } finally {
      await session.close().catch(() => {});
    }
    break;
  }
  default:
    console.error("usage: cli.mjs <doctor|discover|inspect|execute|verify> ...");
    process.exit(2);
}
