/**
 * transport.mjs — ae-a8n owned-session transport for the trusted-execution
 * runner (Issue #49).
 *
 * Implements the runner's injected `{ send(requestText) -> Promise<string|null> }`
 * contract on top of `AfterEffects.call` from `@ido-bata/ae-a8n`. The host
 * side is the statically declared `aeDevtools.trustedEval` extension method
 * (see extension.mjs); this module never sees ExtendScript beyond the
 * envelope's `source` field, and never bypasses ae-a8n's ownership check —
 * `ae.call` refuses non-owned sessions before anything is sent.
 *
 * Reply mapping (trusted-codec envelope in, trusted-codec envelope out):
 *   host ok:true            -> { requestId, ok:true,  result }
 *   host evalError          -> { requestId, error:{aeError} }   (FAILED)
 *   delivery unconfirmed    -> null                            (UNKNOWN —
 *                              timeout, unreadable result, launcher
 *                              failure; the script may still run in AE)
 *   ae-a8n proved not sent  -> { requestId, refusal }          (REFUSED —
 *                              ownership/pin/method guards refused before
 *                              dispatch, or the launcher proved the Apple
 *                              Event was denied)
 *   host-reported error     -> { requestId, error:{aeError} }   (FAILED)
 *   unparseable request     -> null                            (UNKNOWN)
 *   host result missing or
 *   echoing a different
 *   requestId               -> null                            (UNKNOWN —
 *                              the response cannot be attributed to this
 *                              request, so it must not complete it)
 *
 * Pin check: when the request envelope carries `pin.aeVersion`, the live
 * `ae.info().version` must match BEFORE `ae.call` is invoked; a mismatch is
 * answered with a `SESSION_PIN_MISMATCH` refusal and nothing is dispatched.
 * `sessionId`/`dispatchId` are client-side consent-scope values — ae-a8n
 * does not expose a host session id, so they bind to the launch instance
 * that created this transport (see session.mjs), not to a host attestation.
 *
 * Evidence level: the transport itself is dependency-free and fully covered
 * by fake-`ae` tests; real-AE behavior is proven only by real-run.mjs.
 */
import { loadTrustedCodec } from "../trusted-execution/runner.mjs";

export const EVAL_METHOD = "aeDevtools.trustedEval";

/**
 * ae-a8n error names that prove the request never reached the host. ae-a8n
 * wraps every driver error in `AfterEffectsError` (see `contextualise`), so
 * the meaningful name sits on a `cause` — these are matched anywhere in the
 * cause chain, not just on the thrown error itself.
 */
const PROVED_NOT_SENT = new Set([
  "ScriptNotSentError",
  "HostNotOwnedError",
  "HostQuarantinedError",
  "ExtensionMethodNotFoundError",
  "EntityNotFoundError",
  "UnsavedChangesError",
  "PropertyHasNoValueError",
  "ParameterValueError",
  "MacSessionError",
  "UnsupportedScriptPathError",
  "HostUnavailableError",
]);

/**
 * ae-a8n error names that mean the request may or may not have run inside
 * AE — delivery could not be confirmed either way, so the runner must see
 * UNKNOWN (quarantined, never resent), never FAILED or REFUSED.
 */
const UNVERIFIED_DELIVERY = new Set([
  "TimeoutError",
  "ProtocolError",
  "ScriptInvocationError",
]);

/** osascript stderr proving the Apple Event itself was denied (-1743). */
const EVENT_NOT_PERMITTED = /-1743\b/;

function* causeChain(error) {
  const seen = new Set();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current) && seen.size < 10) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

/**
 * True for ae-a8n's `HostError` — the host script ran and reported a
 * failure. Its `name` is the AE-side error name (e.g. "ReferenceError"),
 * so it is detected structurally: HostError always carries `line`,
 * `aeError` and `kind` fields, which transport/driver errors do not.
 */
function isHostError(link) {
  return link !== null && typeof link === "object" &&
    "line" in link && "aeError" in link && "kind" in link;
}

function errorName(error) {
  return error !== null && typeof error === "object" && typeof error.name === "string"
    ? error.name
    : "Error";
}

function errorMessage(error) {
  if (error !== null && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/**
 * Build a codec-valid aeError payload: `line` is only included when it is a
 * finite number and `file` only when it is a non-empty string — the codec
 * rejects null placeholders.
 */
function aeErrorPayload({ name, message, line, file }) {
  const payload = {
    name: typeof name === "string" && name.length > 0 ? name : "Error",
    message: typeof message === "string" ? message : String(message ?? ""),
  };
  if (typeof line === "number" && isFinite(line)) {
    payload.line = line;
  }
  if (typeof file === "string" && file.length > 0) {
    payload.file = file;
  }
  return payload;
}

/**
 * @param {object} deps
 *   ae             — object with `call(name, params, options)` and `info()`
 *                     (an AfterEffects instance or a test fake)
 *   method         — extension method name (default EVAL_METHOD)
 *   callTimeoutMs  — per-call budget forwarded to ae.call; should be a few
 *                     hundred ms BELOW the runner deadline so a real AE
 *                     timeout surfaces as UNKNOWN before the runner's own
 *                     deadline fires
 *   checkPin       — verify envelope pin.aeVersion against ae.info() (default true)
 */
export function createA8nTransport({ ae, method, callTimeoutMs, checkPin } = {}) {
  if (!ae || typeof ae.call !== "function") {
    throw new Error("createA8nTransport: ae.call is required");
  }
  const codec = loadTrustedCodec();
  const evalMethod = typeof method === "string" && method.length > 0 ? method : EVAL_METHOD;
  const timeoutMs = typeof callTimeoutMs === "number" && callTimeoutMs > 0 ? callTimeoutMs : 9_500;
  const pinCheck = checkPin !== false;
  let sends = 0;

  function reply(requestId, body) {
    return codec.stringify({ requestId, ...body });
  }

  async function send(requestText) {
    sends += 1;
    let envelope = null;
    try {
      envelope = codec.parse(requestText);
    } catch {
      return null;
    }
    if (envelope === null || typeof envelope !== "object" ||
        typeof envelope.requestId !== "string" || envelope.requestId.length === 0) {
      return null;
    }
    const requestId = envelope.requestId;
    const source = typeof envelope.source === "string" ? envelope.source : null;
    if (source === null) {
      return reply(requestId, {
        error: { aeError: { name: "TransportError", message: "envelope has no string source" } },
      });
    }

    if (pinCheck && envelope.pin !== null && typeof envelope.pin === "object" &&
        typeof envelope.pin.aeVersion === "string" && envelope.pin.aeVersion.length > 0) {
      let liveVersion = null;
      try {
        const info = typeof ae.info === "function" ? ae.info() : null;
        if (info !== null && typeof info === "object" && typeof info.version === "string") {
          liveVersion = info.version;
        }
      } catch {
        liveVersion = null;
      }
      if (liveVersion !== null && liveVersion !== envelope.pin.aeVersion) {
        return reply(requestId, {
          refusal: {
            code: "SESSION_PIN_MISMATCH",
            message: `pin aeVersion ${envelope.pin.aeVersion} does not match live ${liveVersion}; nothing was dispatched`,
          },
        });
      }
    }

    let hostResult;
    try {
      hostResult = await ae.call(evalMethod, { source, requestId }, { timeoutMs });
    } catch (error) {
      // ae-a8n's contextualise wraps transport errors in AfterEffectsError,
      // so classify on the whole cause chain: the innermost recognized
      // error decides. A host-reported failure (HostError in the chain) is
      // the only evidence that AE itself rejected the request.
      let hostFailure = null;
      for (const link of causeChain(error)) {
        // A HostError is the leaf: the host script ran and reported. Its
        // `name` is the AE-side error name and could collide with a
        // transport error name, so it wins over name matching.
        if (isHostError(link)) {
          hostFailure = link;
          break;
        }
        const name = errorName(link);
        if (UNVERIFIED_DELIVERY.has(name)) {
          const detail = `${errorMessage(link)} ${link !== null && typeof link === "object" ? String(link.stderr ?? "") : ""}`;
          if (name === "ScriptInvocationError" && EVENT_NOT_PERMITTED.test(detail)) {
            // -1743: the Apple Event was denied before delivery — proved
            // non-dispatch, so a refusal is honest.
            return reply(requestId, {
              refusal: {
                code: "ScriptNotSentError",
                message: `ae-a8n proved the request was not sent: ${errorMessage(link)}`,
              },
            });
          }
          // The script may still be running inside AE — indistinguishable
          // from outside, so the runner must see UNKNOWN, never a resend.
          return null;
        }
        if (PROVED_NOT_SENT.has(name)) {
          // Proved non-dispatch: ae-a8n refused before the request reached
          // the host, so a refusal (not UNKNOWN) is honest.
          return reply(requestId, {
            refusal: {
              code: name,
              message: `ae-a8n proved the request was not sent: ${errorMessage(link)}`,
            },
          });
        }
      }
      const src = hostFailure ?? error;
      return reply(requestId, {
        error: {
          aeError: aeErrorPayload({
            name: errorName(src),
            message: errorMessage(src),
            line: src !== null && typeof src === "object" ? src.line : null,
            file: src !== null && typeof src === "object" ? src.file : null,
          }),
        },
      });
    }

    if (hostResult === null || typeof hostResult !== "object") {
      return reply(requestId, {
        error: { aeError: { name: "TransportError", message: "extension method returned a non-object result" } },
      });
    }
    // The host echoes the requestId it was given; a missing or different
    // echo means this result cannot be attributed to THIS request — UNKNOWN,
    // never COMPLETED on someone else's answer.
    if (hostResult.requestId !== requestId) {
      return null;
    }
    if (hostResult.ok === true) {
      let result = null;
      if (typeof hostResult.resultJson === "string" && hostResult.resultJson.length > 0) {
        try {
          result = codec.parse(hostResult.resultJson);
        } catch {
          result = hostResult.resultJson;
        }
      } else if (hostResult.valueText !== undefined && hostResult.valueText !== null) {
        result = hostResult.valueText;
      } else if ("value" in hostResult) {
        result = hostResult.value;
      }
      return reply(requestId, { ok: true, result });
    }
    if (hostResult.evalError !== null && typeof hostResult.evalError === "object") {
      const e = hostResult.evalError;
      return reply(requestId, {
        error: { aeError: aeErrorPayload({ name: e.name, message: e.message, line: e.line, file: e.file }) },
      });
    }
    return reply(requestId, {
      error: { aeError: { name: "EvalError", message: "host reported failure without detail" } },
    });
  }

  return {
    send,
    /** Number of times send() was invoked (including refused-before-call paths that still parsed). */
    sendCount: () => sends,
    method: evalMethod,
  };
}
