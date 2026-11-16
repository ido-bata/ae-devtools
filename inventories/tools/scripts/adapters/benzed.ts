/**
 * BenZed/after-effects adapter (node library, predecessor to the a8n bridge
 * concept; cited by ae-a8n ADR-0001).
 *
 * Surface: the public exports of index.js — execute / executeSync / create /
 * createSync / options / Command / scriptsDir. There is NO per-operation tool
 * catalogue: the library's single capability is "run a caller-supplied
 * JavaScript function inside After Effects and return its result", so the
 * operation granularity here is the API surface, not Adobe operations.
 *
 * Route (mac): create_apple_script (lib/platform-mac.js) writes an AppleScript
 * `tell application "Adobe After Effects ...app" DoScript "<compiled script>"`
 * to a temp .scpt and runs it with /usr/bin/osascript (Windows builds
 * an aerender command via lib/platform-win.js). The caller's function is
 * transpiled to ES3 by babel (lib/command.js babelify: es2015 preset plus
 * ES3 member/property-literal plugins, uglify with conditionals disabled for
 * AE's legacy JS engine), wrapped with app.beginSuppressDialogs()/try/catch,
 * executed by AE's DoScript entry point, and the return value is written by
 * the generated script to a temp result .js file which the library reads back
 * (get_results, index.js).
 *
 * Citations: definition = the `function <name>(` line in index.js; for
 * dispatch-including ones, implementation = the platform.execute call site
 * in lib/platform-mac.js. Because the RESULT semantics live in index.js's own
 * post-processing (get_results), several rows cite definition = implementation
 * = index.js at the function that defines the behaviour. Both pairs resolve in
 * their own file (review D3).
 *
 * Access: every public entry point is a dispatcher for caller-defined
 * ExtendScript — the library itself reads nothing and writes nothing to the
 * AE project; what happens inside AE is whatever function the caller passes.
 * Per review D1 these are `unknown` with a dispatcher basis, never rounded to
 * write. The two `create*` entry points only write the .jsx to disk locally
 * (no AE execution at all) — a local-filesystem write.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS, resolveSourceRoot, type ToolDef } from "../registry.ts";
import { checkCitation } from "../text.ts";
import type { Access, OperationRow } from "../types.ts";

const TOOL_ID = "BenZed/after-effects";
const DEF_FILE = "index.js";
const EXEC_IMPL_FILE = "lib/platform-mac.js";

const ROUTE_EXEC =
  "node → command toString() (babel ES3 transpile + uglify in lib/command.js) → temp AppleScript .scpt → osascript DoScript in AE (lib/platform-mac.js) → result written by the script to a temp file and read back (get_results)";
const ROUTE_CREATE =
  "node → command toString() → fs.writeFile(scriptPath) — .jsx written to disk, AE is NOT launched";

interface ExportSpec {
  /** exported function name in index.js */
  fn: string;
  args: string[];
  access: Access;
  basis: string;
  /** implementation citation when the mechanics live in platform-mac.js */
  impl?: [file: string, inThisFile: string];
  /** source pattern when the export is not declared as `function <fn>(` */
  decl?: string;
}

const EXPORTS: ExportSpec[] = [
  {
    fn: "execute",
    args: ["funcOrCommand", "...args", "options.errorHandling", "options.minify", "options.program", "options.includes"],
    access: "unknown",
    basis:
      "dispatcher: serialises the CALLER-supplied function/command to an ES3 script, suppresses AE dialogs around it, dispatches it via AppleScript DoScript (platform.execute) and parses the temp-file result — the caller's function decides read/write/execute inside AE and is not decidable at registration time",
    impl: [EXEC_IMPL_FILE, "execute: function(command)"],
  },
  {
    fn: "executeSync",
    args: ["funcOrCommand", "...args", "options.errorHandling", "options.minify", "options.program", "options.includes"],
    access: "unknown",
    basis:
      "dispatcher: synchronous form of execute — child.execSync of the same AppleScript DoScript wrapper around caller-supplied code; access depends on the caller's script and is not decidable at registration time",
    impl: [EXEC_IMPL_FILE, "executeSync : function(command)"],
  },
  {
    fn: "create",
    args: ["funcOrCommand", "scriptPath", "...args"],
    access: "write",
    basis:
      "LOCAL-ONLY write: fs.writeFile(scriptPath, command.toString()) writes the compiled .jsx to the platform's ScriptMenu/Scripts Panel directory (prepare_script_path) and resolves with the path — AE is never launched; the file becomes an AE Scripts Panel artifact the user can run",
  },
  {
    fn: "createSync",
    args: ["funcOrCommand", "scriptPath", "...args"],
    access: "write",
    basis:
      "LOCAL-ONLY write: fs.writeFileSync(scriptPath, command.toString()) — same as create, synchronous; nothing is executed in AE",
  },
  {
    fn: "AfterEffectsError",
    args: ["message"],
    access: "read",
    basis:
      "error constructor class (AfterEffectsError extends Error) used to reject a returned Error from a dispatched script — a result-unwrapping read path, no AE contact of its own",
    /** class declaration, not a function */
    decl: "class AfterEffectsError extends Error",
  },
  {
    fn: "get_results",
    args: ["command.result_file"],
    access: "read",
    basis:
      "reads the temp result .js file AE's DoScript wrapper wrote (require(jsfile)), streams its logs to stdout, unlinks the temp file and returns { logs, returned } — a local-filesystem read of the execution result",
  },
  {
    fn: "prepare_command",
    args: ["funcOrCommand", "...args"],
    access: "read",
    basis:
      "wraps a Function or Command instance into { arguments, result_file } — pure request-local object construction, no AE contact",
  },
];

/** semanticId — provisional normalization; #11 owns the final grammar. */
function semanticFor(fn: string): string {
  switch (fn) {
    case "execute":
    case "executeSync":
      return "system.run-jsx";
    case "create":
    case "createSync":
      return "system.write-script-file";
    case "get_results":
      return "system.get-results";
    case "AfterEffectsError":
      return "system.result-error";
    case "prepare_command":
      return "system.prepare-command";
    default:
      return `system.${fn.replace(/_/g, "-").toLowerCase()}`;
  }
}

function lineOfFn(src: string, pattern: string): number {
  const at = src.indexOf(pattern);
  if (at < 0) throw new Error(`${TOOL_ID}: pattern not found: ${pattern}`);
  let line = 1;
  for (let i = 0; i < at; i += 1) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/** One row per public export of index.js. */
const PUBLIC_EXPORTS: { fn: string }[] = [
  { fn: "execute" },
  { fn: "executeSync" },
  { fn: "create" },
  { fn: "createSync" },
];

export function extract(): OperationRow[] {
  const def: ToolDef | undefined = TOOL_DEFS.find((t) => t.id === TOOL_ID);
  if (!def) throw new Error(`${TOOL_ID}: not in registry`);
  const root = resolveSourceRoot(def).root;
  const src = readFileSync(join(root, DEF_FILE), "utf8");

  const rows: OperationRow[] = [];

  // The four primary exports — public surface of the library.
  for (const { fn } of PUBLIC_EXPORTS) {
    const spec = EXPORTS.find((s) => s.fn === fn);
    if (!spec) throw new Error(`${TOOL_ID}: no spec for ${fn}`);
    const definitionLine = lineOfFn(src, `function ${fn}(`);
    let implementationFile = DEF_FILE;
    let implementationLine = definitionLine;
    if (spec.impl) {
      const implSrc = readFileSync(join(root, spec.impl[0]), "utf8");
      implementationFile = spec.impl[0];
      implementationLine = lineOfFn(implSrc, spec.impl[1]);
    }

    const row: OperationRow = {
      toolId: TOOL_ID,
      name: fn,
      args: spec.args,
      access: spec.access,
      accessBasis: spec.basis,
      route: spec.impl ? ROUTE_EXEC : fn === "create" || fn === "createSync" ? ROUTE_CREATE : ROUTE_EXEC,
      semanticId: semanticFor(fn),
      status: "source-verified",
      definitionFile: DEF_FILE,
      definitionLine,
      implementationFile,
      implementationLine,
    };
    rows.push(row);
  }

  // Internal plumbing that completes every execution (result plumbing +
  // command preparation) is recorded because it is where the read-back of
  // dispatched scripts actually happens.
  for (const spec of EXPORTS) {
    if (PUBLIC_EXPORTS.some((p) => p.fn === spec.fn)) continue;
    const definitionLine = lineOfFn(src, spec.decl ?? `function ${spec.fn}(`);
    rows.push({
      toolId: TOOL_ID,
      name: spec.fn,
      args: spec.args,
      access: spec.access,
      accessBasis: spec.basis,
      route: "node → internal plumbing in index.js (no direct AE contact)",
      semanticId: semanticFor(spec.fn),
      status: "source-verified",
      definitionFile: DEF_FILE,
      definitionLine,
      implementationFile: DEF_FILE,
      implementationLine: definitionLine,
    });
  }

  for (const row of rows) {
    const a = checkCitation(root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${TOOL_ID} ${row.name}: ${a.reason}`);
    const b = checkCitation(root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${TOOL_ID} ${row.name}: ${b.reason}`);
  }
  if (rows.length === 0) throw new Error(`${TOOL_ID}: no exports parsed`);
  return rows;
}
