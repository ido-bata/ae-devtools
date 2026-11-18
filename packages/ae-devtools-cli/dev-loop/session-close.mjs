/**
 * session-close.mjs — bounded session close shared by every dev-loop
 * surface (Issue #196).
 *
 * Before this module the close-timeout contract existed only inside
 * devtools-cli/cli.mjs (makeCleanup, --close-timeout-ms); the MCP
 * server and the VSCode controller awaited `session.close()` with no
 * bound, so a hung transport close could pin the surface forever.
 * There is now exactly one implementation:
 *
 *   closeSessionWithTimeout(session, { timeoutMs })
 *     → { attempted, ok, error, result }
 *
 * `attempted:false` means the session had no close() — not a failure.
 * `ok:false` covers BOTH a close() rejection and the timeout; `error`
 * carries the message either way. The result is always reported —
 * callers decide how to surface it (CLI keeps the run marker, MCP/VSCode
 * log or return it); nothing is swallowed here.
 *
 * The fake session honors AE_DEVTOOLS_CLI_FAKE_CLOSE=hang|throw, so all
 * three surfaces are testable without a real host.
 */

export const DEFAULT_CLOSE_TIMEOUT_MS = 20_000;

/**
 * @param {object|null} session — session object with an optional
 *   async close() (the shape openSession/session.mjs produce)
 * @param {object} [options]
 *   timeoutMs — bound for close(); non-finite/non-positive falls back
 *     to DEFAULT_CLOSE_TIMEOUT_MS
 * @returns {Promise<{attempted:boolean, ok:boolean|null, error:string|null,
 *   result:object|null}>}
 */
export async function closeSessionWithTimeout(session, { timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS } = {}) {
  if (session === null || typeof session !== "object" || typeof session.close !== "function") {
    return { attempted: false, ok: null, error: null, result: null };
  }
  const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_CLOSE_TIMEOUT_MS;
  let timer;
  try {
    const result = await Promise.race([
      session.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`session.close timed out after ${ms}ms`)), ms);
      }),
    ]);
    return { attempted: true, ok: true, error: null, result: result ?? null };
  } catch (e) {
    return { attempted: true, ok: false, error: String(e?.message ?? e), result: null };
  } finally {
    clearTimeout(timer);
  }
}
