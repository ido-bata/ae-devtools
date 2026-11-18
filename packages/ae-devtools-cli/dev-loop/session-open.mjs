/**
 * session-open.mjs — the single session-kind dispatch shared by every
 * dev-loop surface (Issue #183).
 *
 * Before this module, `devtools-cli/cli.mjs` and `mcp-server/session.mjs`
 * each re-implemented the same decision: kind === "fake" → openFakeSession,
 * kind === "a8n" → existence-check a8n-transport/session.mjs, dynamic-import
 * it, call openSliceSession, and map the slice session onto the common
 * {kind, evidenceLevel, runner, pin, close, meta} shape. Two copies meant
 * transport-missing handling and fallback semantics could drift per
 * surface; there is now exactly one.
 *
 * Surfaces that need transport internals (the CLI's recovery attestation
 * reads the raw slice session) receive it as `slice` — the raw
 * openSliceSession result for a8n, null for fake. `slice` is internal:
 * consumers that serialize the session (MCP tool payloads) must strip it.
 *
 * The module deliberately lives in dev-loop/ so CLI, MCP and VSCode (via
 * mcp-server/session.mjs) share it without importing each other.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openFakeSession } from "../devtools-cli/fake-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, "..");

/**
 * @param {"fake"|"a8n"} kind
 * @param {object} options — { aeA8nRoot, installDir, workdir } forwarded
 *   to the a8n opener only; ignored for fake. `workdir` lets real-run
 *   drivers pin the generated host-script directory (conformance keeps
 *   it inside its evidence workdir so close() does not delete it).
 * @returns {Promise<object>} session shaped
 *   { kind, evidenceLevel, runner, pin, close, meta, slice } — `slice`
 *   is the raw openSliceSession result (a8n) or null (fake).
 */
export async function openSession(kind = "fake", options = {}) {
  if (kind === "fake") {
    const s = openFakeSession();
    return { ...s, meta: s.meta ?? null, slice: null };
  }
  if (kind === "a8n") {
    const tdir = join(EXP, "a8n-transport", "session.mjs");
    if (!existsSync(tdir)) {
      const e = new Error(
        "a8n session requires packages/ae-devtools-cli/a8n-transport (Issue #49) — not present on this branch",
      );
      e.code = "A8N_TRANSPORT_MISSING";
      throw e;
    }
    const { openSliceSession } = await import(tdir);
    const s = await openSliceSession({
      aeA8nRoot: typeof options.aeA8nRoot === "string" ? options.aeA8nRoot : undefined,
      installDir: typeof options.installDir === "string" ? options.installDir : undefined,
      workdir: typeof options.workdir === "string" ? options.workdir : undefined,
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
      slice: s,
    };
  }
  const e = new Error(`unknown session kind '${kind}' (fake|a8n)`);
  e.code = "USAGE";
  throw e;
}
