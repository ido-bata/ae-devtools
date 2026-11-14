/**
 * outcomes.mjs — CAP028 groundwork (Issue #14): write-path outcome
 * taxonomy and classification helpers.
 *
 * Extends the probe outcome model (experiments/read-only-probe/
 * outcome-model.md) with write-specific cases from design note §4, and
 * maps wire outcomes onto the catalog contract §5 vocabulary
 * (not-sent / refused / completed / failed / unknown).
 *
 * Evidence level: automated-test / fake only.
 */

/** Wire outcomes (probe spelling, uppercase). */
export const OUTCOMES = ["COMPLETED", "REFUSED", "FAILED", "UNKNOWN", "BLOCKED"];

/** Map wire outcome → catalog contract §5 outcome. */
export const CONTRACT_OUTCOME = {
  COMPLETED: "completed",
  REFUSED: "refused",
  FAILED: "failed",
  UNKNOWN: "unknown",
  BLOCKED: "not-sent",
};

export function toContractOutcome(outcome) {
  const mapped = CONTRACT_OUTCOME[outcome];
  if (mapped === undefined) {
    throw new Error(`unknown wire outcome ${JSON.stringify(outcome)}`);
  }
  return mapped;
}

/**
 * Classify a write dispatch result.
 *
 * @param {object} input
 *   dispatched        — was the request possibly dispatched? (boolean)
 *   reply             — host reply object or null
 *   deadlineExceeded  — poll deadline hit before an attributable reply
 *   hostBusyEvidence  — attributable in-host attestation that AE was
 *                       busy/modal AND that this request was proven not
 *                       dispatched:
 *                       { source: "ae-host" | "os-signal",
 *                         provedNonDispatch: true, detail?: string }
 *                       A bare boolean or client-side inference ("AE
 *                       seems busy") is NOT accepted — per the probe
 *                       outcome model, indistinguishable-from-outside
 *                       busy is UNKNOWN. Only an in-host typed signal or
 *                       an OS-visible attributable signal qualifies.
 *   partialMutation   — host admits the mutation may be partial
 * @returns outcome object per outcome-model.md §2 shape, extended with
 *   `mayHaveMutated` for write paths.
 */
export function classifyWriteResult(input = {}) {
  const { dispatched, reply, deadlineExceeded, hostBusyEvidence, partialMutation } = input;

  // Host-busy is REFUSED only on attributable host evidence: the attester
  // must be inside AE or an OS-observable signal, and must prove this
  // request was not dispatched. Anything weaker stays UNKNOWN.
  const busyProven =
    hostBusyEvidence !== null &&
    typeof hostBusyEvidence === "object" &&
    (hostBusyEvidence.source === "ae-host" || hostBusyEvidence.source === "os-signal") &&
    hostBusyEvidence.provedNonDispatch === true;

  // 1. Environment/client-side guard: nothing was sent.
  if (!dispatched) {
    return {
      outcome: "BLOCKED",
      blocker: { code: "NOT_SENT", message: "dispatch guard stopped the request before send" },
      requestState: "NOT_SENT",
      mayHaveMutated: false,
    };
  }

  // 2. Host replied.
  if (reply != null) {
    if (reply.ok === true) {
      return {
        outcome: "COMPLETED",
        requestState: "ACKED",
        mayHaveMutated: true, // a completed write did mutate (by definition)
        result: reply.result ?? null,
      };
    }
    if (reply.refusal != null) {
      return {
        outcome: "REFUSED",
        refusal: reply.refusal,
        requestState: "ACKED",
        mayHaveMutated: false,
        result: null,
      };
    }
    if (reply.error != null) {
      return {
        outcome: "FAILED",
        error: reply.error,
        requestState: "ACKED",
        mayHaveMutated: partialMutation === true,
        result: null,
      };
    }
    // Unparseable/shape-less reply: cannot attribute → UNKNOWN.
    return {
      outcome: "UNKNOWN",
      unknownCategory: "UNATTRIBUTABLE_REPLY",
      requestState: "SENT_NOT_ACKNOWLEDGED",
      mayHaveMutated: true,
      result: null,
    };
  }

  // 3. No reply.
  if (deadlineExceeded) {
    // AE UI busy / modal is UNKNOWN unless the HOST said so — from outside,
    // busy and dead-dispatcher are indistinguishable (probe rule, binding).
    if (busyProven) {
      return {
        outcome: "REFUSED",
        refusal: {
          code: "HOST_BUSY",
          message: "host reported busy/modal before execution",
          ...(typeof hostBusyEvidence.detail === "string"
            ? { detail: hostBusyEvidence.detail }
            : {}),
        },
        requestState: "ACKED",
        mayHaveMutated: false,
        result: null,
      };
    }
    return {
      outcome: "UNKNOWN",
      unknownCategory: "NO_REPLY_BEFORE_DEADLINE",
      requestState: "SENT_NOT_ACKNOWLEDGED",
      mayHaveMutated: true,
      result: null,
      note: "request may have been dispatched; do not resend; reconcile manually",
    };
  }

  return {
    outcome: "UNKNOWN",
    unknownCategory: "NO_REPLY_BEFORE_DEADLINE",
    requestState: "SENT_NOT_ACKNOWLEDGED",
    mayHaveMutated: true,
    result: null,
  };
}

/**
 * Undo is a separate named operation (design §4): its failure is FAILED and
 * is never folded into the original operation's success. This helper
 * produces the trace record for an undo attempt; callers must not merge it
 * into the mutation's outcome.
 */
export function undoTraceRecord({ operationId, undoResult }) {
  return {
    kind: "undo",
    operationId,
    outcome: undoResult?.outcome ?? "UNKNOWN",
    mayHaveMutated: undoResult?.mayHaveMutated ?? null,
    foldedInto: null, // explicit: never merged into the original op
  };
}
