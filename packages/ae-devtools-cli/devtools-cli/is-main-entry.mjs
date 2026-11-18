/**
 * is-main-entry.mjs — shared "was I invoked directly?" check (Issue #234).
 *
 * Installed bins reach a module through npm .bin symlinks, so argv[1]
 * may be the shim path while import.meta.url is already realpath-resolved
 * by Node. Compare realpaths or the packaged bin would never start the
 * module. This logic was duplicated verbatim in mcp-server/server.mjs,
 * cep-extension/scaffold.mjs and conformance/real-run.mjs.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainEntry(moduleUrl) {
  // Required on purpose: the default would resolve to THIS module's URL,
  // so a caller that forgets the argument would silently never match and
  // the CLI would exit 0 doing nothing (Issue #248).
  if (typeof moduleUrl !== "string") {
    throw new Error("isMainEntry(moduleUrl) requires the caller's import.meta.url");
  }
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
