#!/usr/bin/env node
/**
 * cep-lifecycle — CLI for CEP extension install/uninstall/status/cleanup/logs.
 * Machine-level only; never launches or configures AE (Issue #36).
 *
 *   node cep-lifecycle.mjs install --source <ext-dir> [--id <id>] [--target <dir>]
 *   node cep-lifecycle.mjs uninstall --id <id> [--target <dir>]
 *   node cep-lifecycle.mjs status --id <id> [--source <dir>] [--target <dir>]
 *   node cep-lifecycle.mjs cleanup [--target <dir>]
 *   node cep-lifecycle.mjs logs [--log-dir <dir>]
 */
import { install, uninstall, status, cleanup, collectLogs } from "./lifecycle.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];

const need = (k) => { if (!args[k]) { console.error(`missing --${k}`); process.exit(2); } };

try {
  let r;
  if (cmd === "install") { need("source"); r = await install({ sourceDir: args.source, extensionId: args.id, targetDir: args.target }); }
  else if (cmd === "uninstall") { need("id"); r = await uninstall({ extensionId: args.id, targetDir: args.target }); }
  else if (cmd === "status") { need("id"); r = await status({ extensionId: args.id, sourceDir: args.source, targetDir: args.target }); }
  else if (cmd === "cleanup") r = await cleanup({ targetDir: args.target });
  else if (cmd === "logs") r = await collectLogs({ logDir: args["log-dir"] });
  else { console.error("usage: install|uninstall|status|cleanup|logs"); process.exit(2); }
  console.log(JSON.stringify(r, null, 2));
} catch (err) {
  console.error(`cep-lifecycle: ${err.message}`);
  process.exit(1);
}
