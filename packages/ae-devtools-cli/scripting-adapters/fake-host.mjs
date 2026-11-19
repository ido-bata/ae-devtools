/**
 * fake-host.mjs — codec-faithful fake AE host transport shared by the
 * dev-loop tests and the devtools CLI fake session.
 *
 * The generated adapter source runs inside node:vm against
 * createAdapterFakeApp; envelopes go through the trusted codec exactly
 * like the real bridge. This is FAKE/MOCK level evidence only — it
 * proves wiring, never After Effects behavior.
 *
 * `intercept(envelope)` is an optional test seam: return a reply object
 * to short-circuit the vm dispatch (the CLI uses it for injected host
 * errors / forced wire replies); the transport merges in the envelope's
 * requestId. Return null/undefined to run the dispatch normally.
 */
import vm from "node:vm";
import { KeyframeInterpolationType, TrackMatteType, KeyframeEase, MarkerValue, Shape } from "./fake-app.mjs";

/** The ExtendScript global surface the adapter sources expect. */
export function fakeHostContext(app) {
  return {
    app, JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp,
    Error, TypeError, ReferenceError, parseInt, parseFloat, isNaN, isFinite, undefined,
    // Fake convention: paths ending in ".missing" simulate absent files
    // so missing-footage counterexamples can run without real fs state.
    File: class { constructor(p) { this.fsName = p; this.exists = !String(p).endsWith(".missing"); } },
    CloseOptions: { DO_NOT_SAVE_CHANGES: 2 },
    CompItem: app.CompItem, FolderItem: app.FolderItem, FootageItem: app.FootageItem,
    ImportOptions: app.ImportOptions,
    FootageSource: app.FootageSource, FileSource: app.FileSource,
    SolidSource: app.SolidSource, PlaceholderSource: app.PlaceholderSource,
    // Enum globals referenced by generated adapter sources by NAME
    // (Issue #287). Values are the fake stand-ins — see fake-app.mjs.
    KeyframeInterpolationType, TrackMatteType, KeyframeEase, MarkerValue, Shape,
  };
}

/**
 * @param {object} deps
 *   app     — createAdapterFakeApp() instance
 *   codec   — TrustedCodec-compatible {stringify,parse}
 *   intercept — optional (envelope) => replyObject|null
 * @returns {{ send(text): Promise<string> }} — the transport contract
 *   createJsxRunner() expects.
 */
export function createFakeHostTransport({ app, codec, intercept = null }) {
  return {
    send(text) {
      const env = codec.parse(text);
      const injected = typeof intercept === "function" ? intercept(env) : null;
      if (injected !== null && injected !== undefined) {
        return Promise.resolve(codec.stringify({ ...injected, requestId: env.requestId }));
      }
      const ctx = vm.createContext(fakeHostContext(app));
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
}
