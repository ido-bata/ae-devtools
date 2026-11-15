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

export function openFakeSession() {
  const app = createAdapterFakeApp();
  const codec = loadTrustedCodec();
  const transport = {
    send(text) {
      const env = codec.parse(text);
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
