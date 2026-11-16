/**
 * fake-session.mjs — fake-host session for the devtools CLI (Issue #54).
 *
 * Uses the shared codec-faithful fake transport
 * (../scripting-adapters/fake-host.mjs): the generated adapter source
 * runs inside node:vm against createAdapterFakeApp. This is FAKE/MOCK
 * level evidence only — it proves the CLI wiring, never After Effects
 * behavior.
 */
import { loadTrustedCodec, createJsxRunner } from "../trusted-execution/runner.mjs";
import { createAdapterFakeApp } from "../scripting-adapters/fake-app.mjs";
import { createFakeHostTransport } from "../scripting-adapters/fake-host.mjs";

export const FAKE_PIN = { sessionId: "cli-fake-session", aeVersion: "99.0-fake", dispatchId: "cli-fake-disp" };

/**
 * Test seams (never set in real use):
 *   AE_DEVTOOLS_CLI_FAKE_HOST_ERROR — JSON object
 *     {"name": "...", "message": "...", "line"?: n, "file"?: "..."}
 *   makes the fake host reply carry an aeError wrapper with those
 *   fields instead of running the dispatch — simulating an ExtendScript
 *   exception reply, including a host-reported JSX position for
 *   diagnostics/sourcemap tests (#103). Unparseable values are ignored.
 *   AE_DEVTOOLS_CLI_FAKE_REPLY — JSON object
 *   replaces the whole host reply (requestId is added by the transport)
 *   — e.g. {"ok":false,"refusal":{"code":"HOST_BUSY","message":"..."}}
 *   simulates a wire-level REFUSED outcome for diagnostics tests (#127).
 */
function injectedHostError() {
  const raw = process.env.AE_DEVTOOLS_CLI_FAKE_HOST_ERROR;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function injectedReply() {
  const raw = process.env.AE_DEVTOOLS_CLI_FAKE_REPLY;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function openFakeSession() {
  const app = createAdapterFakeApp();
  const codec = loadTrustedCodec();
  const transport = createFakeHostTransport({
    app,
    codec,
    intercept: () => {
      const reply = injectedReply();
      if (reply !== null) return reply;
      const injected = injectedHostError();
      if (injected === null) return null;
      const err = {
        name: typeof injected.name === "string" ? injected.name : "Error",
        message: typeof injected.message === "string" ? injected.message : "injected fake host error",
      };
      if (Number.isInteger(injected.line)) err.line = injected.line;
      if (typeof injected.file === "string") err.file = injected.file;
      return { ok: false, error: { aeError: err } };
    },
  });
  const runner = createJsxRunner({ transport, codec });
  return {
    kind: "fake",
    evidenceLevel: "fake/mock only",
    runner,
    pin: FAKE_PIN,
    app,
    async close() {
      // Test seams (never set in real use):
      //   AE_DEVTOOLS_CLI_FAKE_CLOSE=throw → close rejects
      //   AE_DEVTOOLS_CLI_FAKE_CLOSE=hang  → close never resolves
      const mode = process.env.AE_DEVTOOLS_CLI_FAKE_CLOSE;
      if (mode === "throw") throw new Error("injected fake close failure");
      if (mode === "hang") await new Promise(() => {});
    },
  };
}
