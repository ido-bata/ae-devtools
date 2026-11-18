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

export function isMainEntry(moduleUrl = import.meta.url) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
