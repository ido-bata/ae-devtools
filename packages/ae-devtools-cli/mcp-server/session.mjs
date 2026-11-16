/**
 * session.mjs — session wiring for the MCP server (Issue #20).
 *
 * Reuses the SAME session openers as the devtools CLI — nothing is
 * copied:
 *   fake — codec-faithful vm host via devtools-cli/fake-session.mjs
 *          (FAKE/MOCK evidence only; proves wiring, never AE behavior)
 *   a8n  — owned AE session via a8n-transport/session.mjs openSliceSession
 *          (Issue #49 path; "verified on real host" evidence only when
 *          that session actually ran)
 *
 * The MCP layer adds NO session type and NO permission path of its own.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openFakeSession } from "../devtools-cli/fake-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, "..");

/**
 * @param {"fake"|"a8n"} kind
 * @param {object} options — { aeA8nRoot, installDir } forwarded to the
 *   a8n opener only; ignored for fake.
 * @returns {Promise<{kind:string, evidenceLevel:string, runner:object,
 *   pin:object, close:function, meta?:object}>}
 */
export async function openSession(kind = "fake", options = {}) {
  if (kind === "fake") return openFakeSession();
  if (kind === "a8n") {
    const tdir = join(EXP, "a8n-transport", "session.mjs");
    if (!existsSync(tdir)) {
      const e = new Error("a8n session requires packages/ae-devtools-cli/a8n-transport (Issue #49) — not present on this branch");
      e.code = "A8N_TRANSPORT_MISSING";
      throw e;
    }
    const { openSliceSession } = await import(tdir);
    const s = await openSliceSession({
      aeA8nRoot: typeof options.aeA8nRoot === "string" ? options.aeA8nRoot : undefined,
      installDir: typeof options.installDir === "string" ? options.installDir : undefined,
    });
    return {
      kind: "a8n",
      evidenceLevel: "verified on real host (macOS)",
      runner: s.runner,
      pin: s.pin,
      close: () => s.close(),
      meta: {
        aeVersion: s.info?.version ?? null,
        ownership: s.ownership?.kind ?? null,
        aeA8nHead: s.aeA8nHead ?? null,
      },
    };
  }
  const e = new Error(`unknown session kind '${kind}' (fake|a8n)`);
  e.code = "USAGE";
  throw e;
}
