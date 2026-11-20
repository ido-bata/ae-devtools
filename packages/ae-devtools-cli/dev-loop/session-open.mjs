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
import { fileURLToPath, pathToFileURL } from "node:url";

import { openFakeSession } from "../devtools-cli/fake-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, "..");

/**
 * @param {"fake"|"a8n"|"a8n-attached"} kind
 * @param {object} options — { aeA8nRoot, installDir, workdir, aeVersion }
 *   forwarded to the a8n openers only; ignored for fake. `workdir` lets
 *   real-run drivers pin the generated host-script directory
 *   (conformance keeps it inside its evidence workdir so close() does
 *   not delete it). `aeVersion` is an a8n-attached-only target pin.
 *   `mutatingOps` is an a8n-attached-only op-level mutation scope
 *   (Issue #366); it is forwarded to no other session kind.
 *   `projectFile` is an a8n-attached-only open-project identity pin —
 *   the session refuses when the attached AE has a different (or no)
 *   project file open.
 * @returns {Promise<object>} session shaped
 *   { kind, evidenceLevel, runner, pin, close, meta, slice, policy } —
 *   `slice` is the raw slice-session result (a8n kinds) or null (fake);
 *   `policy` carries session-imposed dispatch limits (attached sessions
 *   are read-only, Issue #366).
 */
export async function openSession(kind = "fake", options = {}) {
  if (kind === "fake") {
    const s = openFakeSession();
    return { ...s, meta: s.meta ?? null, slice: null, policy: null, targetGuard: null };
  }
  if (kind === "a8n-attached") {
    const tdir = join(EXP, "a8n-transport", "attached-session.mjs");
    if (!existsSync(tdir)) {
      const e = new Error(
        "a8n-attached session requires packages/ae-devtools-cli/a8n-transport/attached-session.mjs (Issue #366)",
      );
      e.code = "A8N_TRANSPORT_MISSING";
      throw e;
    }
    // pathToFileURL: a bare "C:\…" path is not a valid ESM specifier on
    // Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME).
    const { openAttachedSliceSession } = await import(pathToFileURL(tdir).href);
    const s = await openAttachedSliceSession({
      aeA8nRoot: typeof options.aeA8nRoot === "string" ? options.aeA8nRoot : undefined,
      installDir: typeof options.installDir === "string" ? options.installDir : undefined,
      aeVersion: typeof options.aeVersion === "string" ? options.aeVersion : undefined,
      workdir: typeof options.workdir === "string" ? options.workdir : undefined,
      mutatingOps: Array.isArray(options.mutatingOps)
        ? options.mutatingOps.filter((v) => typeof v === "string")
        : undefined,
      projectFile: typeof options.projectFile === "string" ? options.projectFile : undefined,
      callTimeoutMs: Number.isFinite(options.callTimeoutMs) ? options.callTimeoutMs : undefined,
      deadlineMs: Number.isFinite(options.deadlineMs) ? options.deadlineMs : undefined,
    });
    return {
      kind: "a8n-attached",
      evidenceLevel: "verified on real host (attach to a running AE)",
      runner: s.runner,
      pin: s.pin,
      close: () => s.close(),
      meta: {
        aeVersion: s.info?.version ?? null,
        ownership: s.ownership?.kind ?? null,
        aeA8nHead: s.aeA8nHead ?? null,
        attached: true,
        target: s.target ?? null,
      },
      slice: s,
      policy: s.policy ?? null,
      // Attached-session target re-validation (Issue #366): invoked by
      // runOperation immediately before each mutating dispatch. Null
      // for sessions without an attested target identity.
      targetGuard: typeof s.revalidateTarget === "function" ? s.revalidateTarget : null,
    };
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
    const { openSliceSession } = await import(pathToFileURL(tdir).href);
    const s = await openSliceSession({
      aeA8nRoot: typeof options.aeA8nRoot === "string" ? options.aeA8nRoot : undefined,
      installDir: typeof options.installDir === "string" ? options.installDir : undefined,
      workdir: typeof options.workdir === "string" ? options.workdir : undefined,
      // Dispatch budgets apply to owned sessions too (Issue #383) — the
      // openers derive a compatible deadline/callTimeout pair and refuse
      // an explicitly incompatible one.
      callTimeoutMs: Number.isFinite(options.callTimeoutMs) ? options.callTimeoutMs : undefined,
      deadlineMs: Number.isFinite(options.deadlineMs) ? options.deadlineMs : undefined,
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
      policy: null,
      targetGuard: null,
    };
  }
  const e = new Error(`unknown session kind '${kind}' (fake|a8n|a8n-attached)`);
  e.code = "USAGE";
  throw e;
}
