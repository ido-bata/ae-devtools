/**
 * outcomes.mjs — execute/verify result outcome normalization (Issue #181).
 *
 * Single implementation of the failure-detection vocabulary shared by
 * every dev-loop consumer (CLI diagnostics block, MCP isError,
 * VSCode Problems-panel collector). Before this module the same
 * normalization existed only inside devtools-cli/diagnostics.mjs
 * (Issue #127) and the MCP/VSCode surfaces re-implemented a weaker
 * version that missed adapter-level failures — a false-green path.
 *
 * Spellings seen in the wild:
 *   - wire results: uppercase `outcome` (FAILED/REFUSED/BLOCKED/UNKNOWN)
 *   - adapter-level refusals: lowercase `status` ("refused"/"failed")
 *     with NO wire `outcome` — the dispatch never reached the runner
 *   - adapter payload failures: wire `outcome` "COMPLETED" PLUS
 *     `status` "failed" — the failure-bearing status MUST win over the
 *     completed wire outcome
 *   - a host-reported `error` object is failure evidence even when every
 *     outcome spelling looks clean
 *
 * `outcome` is the caller-computed fallback (evidence.outcome). The
 * comparison is normalized — wire "REFUSED" and adapter "refused" are
 * the same state (Issue #127: uppercase REFUSED used to slip through).
 *
 * Fail-closed rule (Issue #196): "COMPLETED" is the ONLY success
 * spelling. Any other non-empty status/outcome spelling — including
 * ones this module does not know ("error", "cancelled", "timeout",
 * case variants) — is failure evidence and is returned verbatim
 * (normalized through wireState) rather than silently passed through.
 * The `error` field rule is unified here too: any non-nullish value
 * is failure evidence (an object, a message string, anything a host
 * chose to report); `error: null`/`undefined` is not.
 */

/** Wire outcomes that mean the dispatch did not complete cleanly. */
export const FAILURE_WIRE_STATES = new Set(["REFUSED", "FAILED", "BLOCKED", "UNKNOWN"]);

/** Normalize any outcome spelling to the wire vocabulary for severity. */
export function wireState(raw) {
  const s = String(raw ?? "").toLowerCase();
  return { refused: "REFUSED", failed: "FAILED", completed: "COMPLETED", blocked: "BLOCKED", unknown: "UNKNOWN" }[s] ?? String(raw ?? "UNKNOWN");
}

/**
 * First failure-bearing outcome across a result's spellings, normalized
 * to the wire vocabulary, or null when nothing failure-shaped exists.
 */
export function failureOutcome(result, outcome) {
  const candidates = [];
  if (result !== null && typeof result === "object") {
    candidates.push(result.status, result.outcome);
  }
  candidates.push(outcome);
  for (const c of candidates) {
    if (typeof c !== "string" || c.length === 0) continue;
    const w = wireState(c);
    if (FAILURE_WIRE_STATES.has(w)) return w;
    // Fail closed: COMPLETED is the only success spelling. Anything
    // else non-empty — known or not — is failure evidence, returned
    // verbatim so the record keeps the host's own wording.
    if (w !== "COMPLETED") return w;
  }
  if (
    result !== null && typeof result === "object" &&
    result.error !== null && result.error !== undefined
  ) {
    return "FAILED";
  }
  return null;
}

/**
 * Whether an execute/verify result deserves failure diagnostics.
 */
export function isFailureResult(result, outcome) {
  return failureOutcome(result, outcome) !== null;
}
