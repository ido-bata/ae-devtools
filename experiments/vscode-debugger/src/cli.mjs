#!/usr/bin/env node
/**
 * cli.mjs — vscode-debugger lane CLI (Issue #53).
 *
 *   vscode-debugger gen --host-app-specifier aftereffects-27.0 \
 *       [--engine-name main] [--name "..."] [--project-dir .]
 *       → writes .vscode/launch.json attach configuration
 *
 *   vscode-debugger validate <launch.json>
 *       → contract-checks a launch.json; exit 1 on errors
 *
 * No AE required. Real attach is UNVERIFIED (see README).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAttachConfig, writeLaunchJson } from "./gen.mjs";
import { validateLaunchJson, hasErrors } from "./schema.mjs";

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
      // launch.json is JSONC in VS Code; strip // comments and trailing
      // commas for validation purposes.
      const text = readFileSync(resolve(file), "utf8")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      doc = JSON.parse(text);
    } catch (e) {
      out({ schema: "ae-devtools.vscode-debugger.validate/v1", file, error: `unparseable: ${e.message}` }, 2);
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
  default:
    console.error("usage: vscode-debugger <gen|validate> ...");
    process.exit(2);
}
