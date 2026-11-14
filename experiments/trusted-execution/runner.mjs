/**
 * runner.mjs — safe ExtendScript execution pipeline (Issue #14, CAP028).
 *
 * Composes the trusted-execution units into one dispatch path:
 *
 *   validate source → consent/permission gate (permissions.mjs)
 *   → wire envelope (trusted-codec) → transport.send → reply decode
 *   → outcome classification (outcomes.mjs) → retry policy (mutation-guard)
 *
 * This is the client-side half of "run this JSX safely". The transport is
 * INJECTED — this module never picks a channel (ADR-0005 Open Q1). A fake
 * transport in tests proves the pipeline; a real channel (file envelope,
 * ae-a8n bridge, CEP evalScript) plugs in later without changing this code.
 *
 * Hard rules (same discipline as the probe outcome model):
 *   - consent refusal happens BEFORE anything is sent; a refused dispatch
 *     never reaches the transport (send count stays 0)
 *   - deadline → UNKNOWN, never retried here; retryDecision returns
 *     "quarantine" for UNKNOWN and the runner never resends
 *   - host aeError fields (name/message/line/file) pass through verbatim —
 *     source positions are host-reported, never inferred client-side
 *
 * Evidence level: automated-test / fake only. No AE involved.
 * Node >= 22, zero dependencies (node:vm + node:crypto only).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { authorizeExecution } from "./permissions.mjs";
import { classifyWriteResult, toContractOutcome } from "./outcomes.mjs";
import { retryDecision } from "./mutation-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEC_PATH = join(HERE, "codec", "trusted-codec.js");

/** Default cap on script source size (bytes of UTF-8). */
export const MAX_SOURCE_BYTES = 256 * 1024;
/** Default dispatch deadline. */
export const DEFAULT_DEADLINE_MS = 10_000;

/**
 * Load the ES3 codec in node:vm with native JSON removed — identical to
 * the host execution path used by tests/codec.test.mjs.
 */
export function loadTrustedCodec() {
  const source = readFileSync(CODEC_PATH, "utf8");
  const ctx = vm.createContext({
    Object, Array, String, Number, Boolean, Date, RegExp,
    isFinite, parseInt, parseFloat, Error, Math,
  });
  vm.runInContext("var JSON = undefined;", ctx);
  return vm.runInContext(`${source}\nTrustedCodec`, ctx, { filename: "trusted-codec.js" });
}

/**
 * Advertisement row for a raw trusted-dev-script eval dispatch.
 * execute permission + extendscript class → trusted-dev-script (see
 * permissions.mjs executionClassFor).
 */
export const EVAL_ADVERTISEMENT = Object.freeze({
  access: "execute",
  risk: Object.freeze({ trust: "privileged-dev-code" }),
  execution: Object.freeze({ class: "extendscript" }),
});

function newRequestId() {
  return "req-" + randomBytes(8).toString("hex");
}

function blocked(stage, reason, detail, extra = {}) {
  return {
    outcome: "BLOCKED",
    contractOutcome: "not-sent",
    requestState: "NOT_SENT",
    mayHaveMutated: false,
    stage,
    refusal: { code: reason, message: detail },
    retry: "new-request-after-reauth",
    ...extra,
  };
}

/**
 * Normalize a decoded host reply into the classifyWriteResult input.
 * Host error replies carry the codec aeError wrapper
 * ({aeError:{name,message,line?,file?}}); the inner fields pass through
 * untouched so downstream diagnostics see host-reported positions only.
 */
function normalizeReply(reply) {
  if (reply == null || typeof reply !== "object") return reply;
  if (reply.error != null && typeof reply.error === "object") {
    const inner = reply.error.aeError ?? reply.error;
    return { ...reply, error: inner };
  }
  return reply;
}

/**
 * @param {object} deps
 *   transport — { send(requestText) -> Promise<string|null> }; required.
 *               Receives the codec-serialized envelope; returns the raw
 *               reply text, or null on transport-level failure.
 *   codec     — TrustedCodec-compatible {stringify,parse}; default loads
 *               codec/trusted-codec.js via node:vm.
 *   deadlineMs— per-dispatch deadline (default DEFAULT_DEADLINE_MS).
 */
export function createJsxRunner({ transport, codec, deadlineMs } = {}) {
  if (!transport || typeof transport.send !== "function") {
    throw new Error("createJsxRunner: transport.send is required");
  }
  const c = codec ?? loadTrustedCodec();
  const deadline = deadlineMs ?? DEFAULT_DEADLINE_MS;

  /**
   * Run one ExtendScript source against the pinned session.
   *
   * @param {object} input
   *   source            — JSX/ExtendScript source string (required)
   *   pin               — {sessionId, aeVersion?, dispatchId?} target pin
   *   operationId       — catalog/operation id this eval belongs to
   *   args              — dispatch arguments hashed into consent scope
   *                       (default {source}; pass explicit args to bind
   *                       consent to something narrower)
   *   projectIdentity   — project the dispatch acts on (required for
   *                       write-class consent scopes)
   *   consent           — presented consent token {scope} or null
   *   trustedScriptOptIn— explicit operator opt-in (trusted-dev-script)
   *   scriptProvenance  — provenance declaration (trusted-dev-script)
   *   advertisement     — capability advertisement row (default EVAL_ADVERTISEMENT)
   *   permission        — declared Permission (default "execute")
   *   requestId         — optional caller-chosen id (default generated)
   */
  async function runScript(input = {}) {
    const requestId = typeof input.requestId === "string" && input.requestId.length > 0
      ? input.requestId
      : newRequestId();
    const base = { requestId, operationId: input.operationId ?? null };

    // 1. Source validation — before consent, before send.
    const source = input.source;
    if (typeof source !== "string" || source.trim().length === 0) {
      return blocked("validate", "EMPTY_SOURCE", "script source must be a non-empty string", base);
    }
    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
      return blocked("validate", "SOURCE_TOO_LARGE",
        `script source exceeds ${MAX_SOURCE_BYTES} bytes`, base);
    }

    // 2. Consent/permission gate — refusal means NOTHING is sent.
    const auth = authorizeExecution({
      advertisement: input.advertisement ?? EVAL_ADVERTISEMENT,
      permission: input.permission ?? "execute",
      pin: input.pin,
      operationId: input.operationId,
      args: input.args ?? { source },
      projectIdentity: input.projectIdentity,
      consent: input.consent,
      trustedScriptOptIn: input.trustedScriptOptIn,
      scriptProvenance: input.scriptProvenance,
    });
    if (auth.status !== "pass") {
      return blocked("consent", auth.reason, auth.detail, base);
    }

    // 3. Wire envelope — codec.stringify refuses non-serializable values.
    const envelope = {
      v: 1,
      kind: "extendscript.eval",
      requestId,
      operationId: input.operationId ?? null,
      pin: input.pin
        ? {
            sessionId: input.pin.sessionId,
            aeVersion: input.pin.aeVersion ?? null,
            dispatchId: input.pin.dispatchId ?? null,
          }
        : null,
      source,
    };
    let requestText;
    try {
      requestText = c.stringify(envelope);
    } catch (err) {
      return blocked("encode", "ENCODE_REFUSED",
        err instanceof Error ? err.message : String(err), base);
    }

    // 4. Send with a single deadline. No retry, ever, inside this call.
    let replyText = null;
    let deadlineExceeded = false;
    try {
      const timeout = new Promise((resolve) => {
        const t = setTimeout(() => resolve("__deadline__"), deadline);
        if (typeof t.unref === "function") t.unref();
      });
      const sent = transport.send(requestText);
      const raced = await Promise.race([sent, timeout]);
      if (raced === "__deadline__") {
        deadlineExceeded = true;
      } else {
        replyText = raced;
      }
    } catch {
      replyText = null; // transport threw: indistinguishable from no reply
    }

    // 5. Decode + classify.
    let reply = null;
    if (replyText !== null && typeof replyText === "string") {
      try {
        reply = c.parse(replyText);
      } catch {
        reply = { __unparseable: true };
      }
    }
    const classified = classifyWriteResult({
      dispatched: true,
      reply: normalizeReply(reply),
      deadlineExceeded,
      partialMutation: input.mayMutatePartial === true,
    });

    const out = {
      ...base,
      ...classified,
      contractOutcome: toContractOutcome(classified.outcome),
      retry: retryDecision({ outcome: classified.outcome, idempotent: false }),
    };

    // Host-reported error fields pass through for diagnostics (#37).
    if (classified.error != null && typeof classified.error === "object") {
      out.error = {
        name: typeof classified.error.name === "string" ? classified.error.name : null,
        message: typeof classified.error.message === "string" ? classified.error.message : null,
        ...(Number.isInteger(classified.error.line) ? { line: classified.error.line } : {}),
        ...(typeof classified.error.file === "string" ? { file: classified.error.file } : {}),
        hostReported: true,
      };
    }
    return out;
  }

  return { runScript, codec: c };
}
