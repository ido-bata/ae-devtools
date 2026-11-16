#!/usr/bin/env node
/**
 * devkit.mjs — external-project entry point for the CEP extension
 * devkit (Issue #36). Zero dependencies, Node >= 22, no AE, no network.
 *
 *   node devkit.mjs scaffold <scaffold args...>
 *       Forwards to scaffold.mjs verbatim:
 *         --id <reverse-dns.id> --out <dir>
 *         [--title <text>] [--version <ver>] [--host <range>]
 *         [--csxs <ver>] [--force]
 *
 *   node devkit.mjs validate <ext-dir>
 *       Static checks on an extension project dir (see validate.mjs).
 *       Prints a JSON report on stdout; exit 0 = no failed checks,
 *       1 = failed checks, 2 = usage/io error.
 *
 * Both commands are fake-level evidence only: nothing here loads the
 * extension into After Effects. Real load proof stays gated behind
 * LOAD-PROOF.md and an owned AE session.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExtension } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "scaffold") {
  if (rest.length === 0) {
    console.error("usage: node devkit.mjs scaffold --id <id> --out <dir> [--title ..] [--version ..] [--host ..] [--csxs ..] [--force]");
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [join(HERE, "scaffold.mjs"), ...rest], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
} else if (cmd === "validate") {
  const dir = rest[0];
  if (!dir || rest.length !== 1) {
    console.error("usage: node devkit.mjs validate <ext-dir>");
    process.exit(2);
  }
  try {
    const report = await validateExtension(dir);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`devkit validate: ${err.message}`);
    process.exit(2);
  }
} else {
  console.error(
    "usage: node devkit.mjs scaffold <scaffold args...> | validate <ext-dir>"
  );
  process.exit(2);
}
