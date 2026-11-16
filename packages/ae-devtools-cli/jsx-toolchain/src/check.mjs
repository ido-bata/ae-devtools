/**
 * check.mjs — typecheck a script or project against the AE ambient
 * declarations (Issue #52).
 *
 * Ambient surface: `ae-api.d.ts` is GENERATED from
 * `inventories/scripting/generated/symbols.json` (656 symbols — names,
 * kinds, access; almost no signatures, so members are `any`-typed).
 * `ae-globals.d.ts` adds the hand-maintained ExtendScript extras ($,
 * File/Folder, PREFType); `scriptui.d.ts` adds the ScriptUI classes.
 * `lib` is pinned to ES5 — ExtendScript has no DOM, and the default DOM
 * lib's File/Window/Event collide with the real host globals (Issue #97).
 * Type errors in user code are real;
 * AE-API checking is name-level only — a member absent here is not
 * proof of absence in the real API.
 */
import ts from "typescript";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSources } from "./bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const AMBIENT_DTS = [
  join(HERE, "ae-api.d.ts"),
  join(HERE, "ae-globals.d.ts"),
  join(HERE, "scriptui.d.ts"),
];

const CHECK_OPTIONS = {
  noEmit: true,
  target: ts.ScriptTarget.ES5,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // ExtendScript has no DOM. The default lib (DOM + ES5) declares
  // unrelated `File`/`Window`/`Event` globals that collide with the
  // ExtendScript host objects and ScriptUI classes in our ambient
  // declarations and produced false diagnostics (Issue #97). ES5-only
  // keeps standard JS builtins typed.
  lib: ["lib.es5.d.ts"],
  strict: false, // ExtendScript has no strict-mode guarantees; don't invent them
  noImplicitAny: false,
  skipLibCheck: true,
  allowJs: true,
  checkJs: false,
};

function toDiagnostic(d) {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  let line = null;
  let column = null;
  if (d.file && d.start !== undefined) {
    const lc = d.file.getLineAndCharacterOfPosition(d.start);
    line = lc.line + 1;
    column = lc.character + 1;
  }
  return {
    severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    code: `tsc-${d.code}`,
    line,
    column,
    file: d.file ? d.file.fileName : null,
    message: msg,
  };
}

function runProgram(rootNames, { ambient = AMBIENT_DTS } = {}) {
  const program = ts.createProgram({
    rootNames: [...rootNames, ...ambient].filter((p) => existsSync(p)),
    options: CHECK_OPTIONS,
  });
  return ts.getPreEmitDiagnostics(program).map(toDiagnostic);
}

/** Typecheck one file (module resolution still applies to its imports). */
export function checkFile(inputPath, { ambient = AMBIENT_DTS } = {}) {
  const absIn = resolve(inputPath);
  const diagnostics = runProgram([absIn], { ambient });
  return {
    schema: "ae-devtools.jsx-toolchain.check/v1",
    mode: "file",
    input: absIn,
    ambient,
    ok: !diagnostics.some((d) => d.severity === "error"),
    diagnostics,
  };
}

/**
 * Typecheck a whole project: a directory of sources or a single entry
 * file (imports are resolved by the program). Multi-file is the point —
 * cross-file type errors are caught here, not per-file.
 */
export function checkProject(inputPath, { ambient = AMBIENT_DTS } = {}) {
  const absIn = resolve(inputPath);
  const isDir = statSync(absIn).isDirectory();
  const rootNames = isDir ? collectSources(absIn) : [absIn];
  const diagnostics = runProgram(rootNames, { ambient });
  return {
    schema: "ae-devtools.jsx-toolchain.check/v1",
    mode: isDir ? "project" : "entry",
    input: absIn,
    files: rootNames.length,
    ambient,
    ok: !diagnostics.some((d) => d.severity === "error"),
    diagnostics,
  };
}
