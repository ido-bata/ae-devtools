/**
 * dispatch-budget.mjs — shared per-call / runner-deadline resolution for
 * the a8n session openers (Issue #383).
 *
 * The runner deadline bounds the WHOLE dispatch (transport send + host
 * call + reply); callTimeoutMs bounds only the ae.call leg. When the
 * deadline is at or below the call budget, a host operation that would
 * have completed inside its budget is quarantined as UNKNOWN at the
 * deadline instead — e.g. `--call-timeout-ms 30000` alone used to leave
 * the runner on its 10s default, so a 15s host op reported UNKNOWN.
 *
 * Both openers (owned `session.mjs`, attached `attached-session.mjs`)
 * resolve through this one function so the pair can never drift between
 * session kinds. An explicitly incompatible pair (deadline <=
 * callTimeout) refuses with USAGE before any launch/attach — there is
 * no legitimate configuration where the runner must fire first.
 */

export const DEFAULT_CALL_TIMEOUT_MS = 9_500;
/** Headroom between the call budget and the runner deadline (default pair was 9500/10000). */
export const DEFAULT_DEADLINE_MARGIN_MS = 500;

/**
 * @param {object} options
 *   callTimeoutMs — per-dispatch ae.call budget; non-positive/non-finite
 *                   values fall back to the default (CLI positiveMsFlag
 *                   already filters them upstream)
 *   deadlineMs    — runner deadline; absent derives callTimeout + margin
 * @returns {{callTimeoutMs:number, deadlineMs:number}}
 * @throws {Error} code "USAGE" when an explicit deadlineMs does not
 *         exceed callTimeoutMs
 */
export function resolveDispatchBudgets({ callTimeoutMs, deadlineMs } = {}) {
  const callTimeout = Number.isFinite(callTimeoutMs) && callTimeoutMs > 0
    ? callTimeoutMs
    : DEFAULT_CALL_TIMEOUT_MS;
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs
    : callTimeout + DEFAULT_DEADLINE_MARGIN_MS;
  if (!(deadline > callTimeout)) {
    const e = new Error(
      `deadlineMs (${deadline}) must exceed callTimeoutMs (${callTimeout}): ` +
      "a runner deadline at or below the per-call budget reports UNKNOWN " +
      "for host calls that would still have completed",
    );
    e.code = "USAGE";
    throw e;
  }
  return { callTimeoutMs: callTimeout, deadlineMs: deadline };
}
