#!/usr/bin/env node
/**
 * cep-lifecycle — CLI for CEP extension install/uninstall/status/cleanup/logs.
 * Machine-level only; never launches or configures AE (Issue #36).
 *
 *   node cep-lifecycle.mjs install --source <ext-dir> [--id <id>] [--target <dir>]
 *   node cep-lifecycle.mjs uninstall --id <id> [--target <dir>]
 *   node cep-lifecycle.mjs status --id <id> [--source <dir>] [--target <dir>]
 *   node cep-lifecycle.mjs cleanup [--target <dir>]
 *   node cep-lifecycle.mjs logs [--log-dir <dir>] [--id <ext-id>]
 */
import { install, uninstall, status, cleanup, collectLogs, playerDebugModeStatus } from "./lifecycle.mjs";
import { parseArgs } from "../devtools-cli/argv.mjs";
import { isMainEntry } from "../devtools-cli/is-main-entry.mjs";

const KNOWN_FLAGS = new Set(["source", "id", "target", "log-dir"]);

/**
 * argv (after the command word) -> validated args. Exported for tests.
 * Fail-closed (Issue #248): a flag supplied without a value, an empty
 * inline value (`--target=`), an unknown flag, or a stray positional are
 * all usage errors — silently dropping them would let destructive
 * commands fall back to the real platform CEP/log directories.
 */
export function parseLifecycleArgs(argv) {
  const { pos, flags } = parseArgs(argv);
  const args = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!KNOWN_FLAGS.has(k)) {
      console.error(`unknown flag --${k}`);
      process.exit(2);
    }
    if (v === true) {
      console.error(`missing value for --${k}`);
      process.exit(2);
    }
    if (typeof v !== "string" || v.length === 0) {
      console.error(`--${k} requires a non-empty value`);
      process.exit(2);
    }
    args[k] = v;
  }
  if (pos.length > 0) {
    console.error(`unexpected argument: ${pos[0]}`);
    process.exit(2);
  }
  return args;
}

const isMain = isMainEntry(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  // Shared parser (Issue #197): the old i+=2 pairs loop could not parse
  // --flag=value or boolean flags and silently consumed the next token.
  const args = parseLifecycleArgs(rest);

  const need = (k) => { if (!args[k]) { console.error(`missing --${k}`); process.exit(2); } };

  try {
    let r;
    if (cmd === "install") { need("source"); r = await install({ sourceDir: args.source, extensionId: args.id, targetDir: args.target }); }
    else if (cmd === "uninstall") { need("id"); r = await uninstall({ extensionId: args.id, targetDir: args.target }); }
    else if (cmd === "status") { need("id"); r = await status({ extensionId: args.id, sourceDir: args.source, targetDir: args.target }); }
    else if (cmd === "cleanup") r = await cleanup({ targetDir: args.target });
    else if (cmd === "logs") r = await collectLogs({ logDir: args["log-dir"], extensionId: args.id ?? null });
    else if (cmd === "playerdebugmode") r = await playerDebugModeStatus();
    else { console.error("usage: install|uninstall|status|cleanup|logs|playerdebugmode"); process.exit(2); }
    console.log(JSON.stringify(r, null, 2));
  } catch (err) {
    console.error(`cep-lifecycle: ${err.message}`);
    process.exit(1);
  }
}
