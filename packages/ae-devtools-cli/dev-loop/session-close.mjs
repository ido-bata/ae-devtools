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
 * Normalize a raw --close-timeout-ms flag value to a positive finite
 * millisecond bound (Issue #253). Single owner for the surface-layer
 * parse rule: booleans are rejected on purpose (a bare flag parses to
 * `true`, and Number(true) === 1 would turn the bound into 1ms);
 * non-finite/non-positive/unconvertible values fall back to
 * DEFAULT_CLOSE_TIMEOUT_MS — the only safe bound.
 *
 * @param {*} raw — flag value (string from argv, or a programmatic value)
 * @returns {number} millisecond bound, always finite and > 0
 */
export function parseCloseTimeoutMs(raw) {
  try {
    if (typeof raw === "number") {
      if (Number.isFinite(raw) && raw > 0) return raw;
    } else if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // Unconvertible value (Symbol, throwing valueOf) — fall through.
  }
  return DEFAULT_CLOSE_TIMEOUT_MS;
}

/**
 * @param {object|null} session — session object with an optional
 *   async close() (the shape openSession/session.mjs produce)
 * @param {object} [options]
 *   timeoutMs — bound for close(); non-finite/non-positive falls back
 *     to DEFAULT_CLOSE_TIMEOUT_MS
 * @returns {Promise<{attempted:boolean, ok:boolean|null, error:string|null,
 *   result:object|null, timedOut:boolean}>}
 *   timedOut distinguishes "close() rejected" from "close() exceeded the
 *   bound"; a timed-out close is still in flight and must not be retried.
 */
export async function closeSessionWithTimeout(session, { timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS } = {}) {
  if (session === null || typeof session !== "object" || typeof session.close !== "function") {
    return { attempted: false, ok: null, error: null, result: null, timedOut: false };
  }
  // Single parse rule (Issue #253): booleans/non-finite/non-positive
  // values fall back to the shared default — the only safe bound.
  const ms = parseCloseTimeoutMs(timeoutMs);
  let timer;
  let timedOut = false;
  try {
    const result = await Promise.race([
      session.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`session.close timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
    return { attempted: true, ok: true, error: null, result: result ?? null, timedOut: false };
  } catch (e) {
    return { attempted: true, ok: false, error: String(e?.message ?? e), result: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
