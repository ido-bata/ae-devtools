/**
 * fake-session.mjs — fake-host session for the devtools CLI (Issue #54).
 *
 * Replicates the codec-faithful fake transport used by the dev-loop tests:
 * the generated adapter source runs inside node:vm against
 * createAdapterFakeApp. This is FAKE/MOCK level evidence only — it proves
 * the CLI wiring, never After Effects behavior.
 */
import vm from "node:vm";
import { loadTrustedCodec, createJsxRunner } from "../trusted-execution/runner.mjs";
import { createAdapterFakeApp } from "../scripting-adapters/fake-app.mjs";

export const FAKE_PIN = { sessionId: "cli-fake-session", aeVersion: "99.0-fake", dispatchId: "cli-fake-disp" };

/**
 * Test seam (never set in real use):
 *   AE_DEVTOOLS_CLI_FAKE_HOST_ERROR — JSON object
 *     {"name": "...", "message": "...", "line"?: n, "file"?: "..."}
 *   makes the fake host reply carry an aeError wrapper with those
 *   fields instead of running the dispatch — simulating an ExtendScript
 *   exception reply, including a host-reported JSX position for
 *   diagnostics/sourcemap tests (#103). Unparseable values are ignored.
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

export function openFakeSession() {
  const app = createAdapterFakeApp();
  const codec = loadTrustedCodec();
  const transport = {
    send(text) {
      const env = codec.parse(text);
      const injected = injectedHostError();
      if (injected !== null) {
        const err = {
          name: typeof injected.name === "string" ? injected.name : "Error",
          message: typeof injected.message === "string" ? injected.message : "injected fake host error",
        };
        if (Number.isInteger(injected.line)) err.line = injected.line;
        if (typeof injected.file === "string") err.file = injected.file;
        return Promise.resolve(codec.stringify({
          ok: false,
          error: { aeError: err },
          requestId: env.requestId,
        }));
      }
      const ctx = vm.createContext({
        app, JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp,
        Error, TypeError, ReferenceError, parseInt, parseFloat, isNaN, isFinite, undefined,
        File: class { constructor(p) { this.fsName = p; this.exists = true; } },
        CloseOptions: { DO_NOT_SAVE_CHANGES: 2 },
        CompItem: app.CompItem, FolderItem: app.FolderItem, FootageItem: app.FootageItem,
      });
      try {
        const result = vm.runInContext("(function(){\n" + env.source + "\n})()", ctx);
        return Promise.resolve(codec.stringify({ ok: true, result, requestId: env.requestId }));
      } catch (e) {
        return Promise.resolve(codec.stringify({
          ok: false,
          error: { name: e?.name ?? "Error", message: String(e?.message ?? e) },
          requestId: env.requestId,
        }));
      }
    },
  };
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
