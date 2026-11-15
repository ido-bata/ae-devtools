/**
 * check.mjs — typecheck a script against the AE ambient declarations
 * (Issue #52).
 *
 * The ambient surface (`ae-globals.d.ts`) is PARTIAL: it is generated
 * from `inventories/scripting` symbol rows for the most common entry
 * points, with member signatures absent (the inventory records symbols,
 * not signatures — see that inventory's schemaNote). Type errors in user
 * code are real; AE-API typo detection is limited to declared members.
 */
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const AMBIENT_DTS = join(HERE, "ae-globals.d.ts");

export function checkFile(inputPath, { ambientPath = AMBIENT_DTS } = {}) {
  const absIn = resolve(inputPath);
  const program = ts.createProgram({
    rootNames: [absIn, ambientPath].filter((p) => existsSync(p)),
    options: {
      noEmit: true,
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.None,
      strict: false, // ExtendScript has no strict-mode guarantees; don't invent them
      noImplicitAny: false,
      skipLibCheck: true,
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    schema: "ae-devtools.jsx-toolchain.check/v1",
    input: absIn,
    ambient: ambientPath,
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      let line = null;
      if (d.file && d.start !== undefined) {
        line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
      }
      return {
        severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
        code: `tsc-${d.code}`,
        line,
        file: d.file ? d.file.fileName : null,
        message: msg,
      };
    }),
  };
}
