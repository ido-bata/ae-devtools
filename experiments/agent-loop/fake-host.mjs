/*
 * fake-host.mjs — a FAKE After Effects ExtendScript host for the
 * agent-loop experiment (Issue #38, CAP065).
 *
 * Evidence level: fake/mock only. This is NOT After Effects. It runs
 * probe sources in a Node vm sandbox with a stub `app` object so that
 * ordinary JavaScript errors (ReferenceError, TypeError, ...) occur
 * with real stack positions, which the loop maps back to source
 * locations exactly like host-reported aeError fields would.
 *
 * Contract it simulates (from the trusted-execution runner, PR #42):
 *   send(requestText) -> replyText, exactly once, no retry.
 *   request  : codec.stringify({v:1, kind:"extendscript.eval",
 *                               requestId, source})
 *   reply ok : codec.stringify({v:1, kind:"extendscript.eval.reply",
 *                               requestId, ok:true, result})
 *   reply err: codec.stringify({..., requestId, ok:false,
 *                               error:{name,message,line,file}})
 *
 * ExtendScript probes are ES3 JavaScript; the vm wraps the source so
 * a top-level `return` yields the completion value, matching how
 * .jsx files behave under $.evalFile/evalScript.
 */
import vm from "node:vm";

export function createFakeHost({ app, globals = {} } = {}) {
  const context = vm.createContext({
    app,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Date,
    RegExp,
    Error,
    TypeError,
    ReferenceError,
    RangeError,
    SyntaxError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    undefined,
    ...globals,
  });

  function evalSource(source, filename) {
    // Wrap so top-level `return` behaves like a .jsx file body and the
    // completion value is captured. ES3-safe probes only.
    const wrapped = `(function(){\n${source}\n})()`;
    try {
      const result = vm.runInContext(wrapped, context, {
        filename,
        timeout: 2000,
      });
      return { ok: true, result: result === undefined ? null : result };
    } catch (e) {
      // Map the vm stack line back to the probe source line. The
      // wrapper adds one line, so subtract 1.
      const m = /:(\d+):(\d+)/.exec(e.stack || "");
      const line = m ? Math.max(1, Number(m[1]) - 1) : null;
      return {
        ok: false,
        error: {
          name: e.name || "Error",
          message: String(e.message || e),
          line,
          file: filename,
        },
      };
    }
  }

  return {
    kind: "fake-extendscript-host",
    evalSource,
    send(requestText, codec) {
      const req = codec.parse(requestText);
      if (!req || req.kind !== "extendscript.eval" || typeof req.source !== "string") {
        throw new Error("fake-host: unrecognized request envelope");
      }
      const reply = evalSource(req.source, `<eval:${req.requestId || "?"}>`);
      // vm results come from another realm; normalize to plain JSON so
      // the codec sees ordinary values (functions/undefined dropped).
      if (reply.ok && reply.result !== null && typeof reply.result === "object") {
        try {
          reply.result = JSON.parse(JSON.stringify(reply.result));
        } catch {
          reply.result = String(reply.result);
        }
      }
      return codec.stringify({
        v: 1,
        kind: "extendscript.eval.reply",
        requestId: req.requestId ?? null,
        ...reply,
      });
    },
  };
}

/*
 * Minimal fake `app` object — just enough ExtendScript surface for
 * loop fixtures. Anything else is intentionally absent so probes that
 * touch unimplemented API fail loudly (ReferenceError/TypeError),
 * which is exactly the error the loop must diagnose.
 */
export function createFakeApp() {
  const items = [];
  const app = {
    version: "99.0-fake",
    project: {
      items: {
        add: function (item) {
          const it = { name: (item && item.name) || "untitled", type: "folder" };
          items.push(it);
          return it;
        },
        length: items.length,
      },
      activeItem: null,
    },
  };
  // Fake-only state inspection for the loop's dirty-state verification.
  // NOT part of any AE contract — ExtendScript has no such API.
  app.__state = {
    items,
    fingerprint: () => JSON.stringify(items),
    reset: () => { items.length = 0; },
  };
  return app;
}
