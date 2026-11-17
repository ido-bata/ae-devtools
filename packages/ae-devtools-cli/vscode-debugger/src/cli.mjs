#!/usr/bin/env node
/**
 * cli.mjs — vscode-debugger lane CLI (Issue #53).
 *
 *   vscode-debugger gen --host-app-specifier aftereffects-27.0 \
 *       [--engine-name main] [--name "..."] [--project-dir .]
 *       → writes .vscode/launch.json attach configuration
 *
 *   vscode-debugger validate <launch.json>
 *       → contract-checks a launch.json (JSONC tolerated); exit 1 on errors
 *
 *   vscode-debugger preflight [--host-app-specifier aftereffects-27.0]
 *       [--owned-pid <pid>]
 *       → attach precondition checks: installed-app plausibility,
 *         running-instance count, owned-session attestation. Never
 *         claims debug completion — real attach stays UNVERIFIED.
 *
 * No AE launch/GUI required. Real attach is UNVERIFIED (see README).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAttachConfig, writeLaunchJson } from "./gen.mjs";
import { validateLaunchJson, hasErrors } from "./schema.mjs";
import { parseJsonc, printParseErrorCode } from "./jsonc.mjs";
import { runPreflight } from "./preflight.mjs";

const [cmd, ...args] = process.argv.slice(2);

function arg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

switch (cmd) {
  case "gen": {
    const spec = arg("--host-app-specifier");
    if (!spec) {
      console.error("gen requires --host-app-specifier (e.g. aftereffects-27.0)");
      process.exit(2);
    }
    try {
      const config = buildAttachConfig({
        hostAppSpecifier: spec,
        engineName: arg("--engine-name") ?? "main",
        name: arg("--name") ?? undefined,
        hiddenTypes: arg("--hidden-types") ? arg("--hidden-types").split(",") : undefined,
      });
      const projectDir = arg("--project-dir") ?? process.cwd();
      const r = writeLaunchJson(projectDir, config);
      out({
        schema: "ae-devtools.vscode-debugger.gen/v1",
        path: r.path,
        merged: r.merged,
        config,
        diagnostics: r.diagnostics,
        note: "request is attach-only by design; real attach is UNVERIFIED pending an owned-session host run",
      }, 0);
    } catch (e) {
      out({ schema: "ae-devtools.vscode-debugger.gen/v1", error: String(e.message ?? e) }, 2);
    }
    break;
  }
  case "validate": {
    const file = args.find((a) => !a.startsWith("-"));
    if (!file) { console.error("validate requires a launch.json path"); process.exit(2); }
    let doc;
    try {
      // launch.json is JSONC: parse with a real JSONC tokenizer —
      // comments and trailing commas are legal, `//` inside strings is
      // not a comment. Regex stripping would corrupt string values.
      const text = readFileSync(resolve(file), "utf8");
      const { value, errors } = parseJsonc(text);
      if (errors.length > 0) {
        out({
          schema: "ae-devtools.vscode-debugger.validate/v1",
          file,
          error: `unparseable: ${errors.slice(0, 5).map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join("; ")}`,
        }, 2);
        break;
      }
      doc = value;
    } catch (e) {
      out({ schema: "ae-devtools.vscode-debugger.validate/v1", file, error: `unreadable: ${e.message}` }, 2);
      break;
    }
    const diagnostics = validateLaunchJson(doc);
    out({
      schema: "ae-devtools.vscode-debugger.validate/v1",
      file,
      ok: !hasErrors(diagnostics),
      diagnostics,
    }, hasErrors(diagnostics) ? 1 : 0);
    break;
  }
  case "preflight": {
    const spec = arg("--host-app-specifier");
    const pidRaw = arg("--owned-pid");
    const ownedPid = pidRaw == null ? null : Number(pidRaw);
    if (pidRaw != null && (!Number.isInteger(ownedPid) || ownedPid <= 0)) {
      out({ schema: "ae-devtools.vscode-debugger.preflight/v1", error: `--owned-pid must be a positive integer, got ${JSON.stringify(pidRaw)}` }, 2);
      break;
    }
    try {
      const r = runPreflight({ specifier: spec, ownedPid });
      out(r, r.attachAttemptable ? 0 : 1);
    } catch (e) {
      out({ schema: "ae-devtools.vscode-debugger.preflight/v1", error: String(e.message ?? e) }, 2);
    }
    break;
  }
  default:
    console.error("usage: vscode-debugger <gen|validate|preflight> ...");
    process.exit(2);
}
