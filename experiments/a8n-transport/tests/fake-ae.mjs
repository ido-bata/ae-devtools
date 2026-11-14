/**
 * fake-ae.mjs — test double for the `ae` surface createA8nTransport needs:
 * `call(name, params, options)` and `info()`. It emulates the
 * `aeDevtools.trustedEval` extension method's contract (see extension.mjs)
 * by evaluating `params.source` in a persistent node:vm context that
 * exposes stub `app` / `$` globals. NOT After Effects — automated-test /
 * fake-level evidence only.
 */
import vm from "node:vm";

export function createFakeAe({ version = "99.9.9-fake", app, fail } = {}) {
  const sandbox = {
    app: app ?? {
      version,
      project: { numItems: 3, file: null, name: "Untitled" },
    },
    $: { global: {} },
  };
  const context = vm.createContext(sandbox);
  const calls = [];

  return {
    calls,
    info() {
      return { version, build: "fake" };
    },
    async call(name, params, options) {
      calls.push({ name, params, options });
      if (fail !== undefined) {
        if (typeof fail === "function") throw fail(name, params);
        const err = new Error("injected ae.call failure");
        err.name = fail;
        throw err;
      }
      if (name !== "aeDevtools.trustedEval") {
        const err = new Error(`unknown method ${name}`);
        err.name = "ExtensionMethodNotFoundError";
        throw err;
      }
      const requestId = String(params.requestId);
      let value;
      try {
        value = vm.runInContext(String(params.source), context, { timeout: 5_000 });
      } catch (evalError) {
        return {
          requestId,
          ok: false,
          evalError: {
            name: String(evalError.name ?? "Error"),
            message: String(evalError.message ?? evalError),
            line: null,
            file: null,
          },
        };
      }
      const v = value === undefined ? null : value;
      return {
        requestId,
        ok: true,
        resultJson: JSON.stringify(v),
        valueText: v === null ? null : String(v),
        valueType: v === null ? "object" : typeof v,
      };
    },
  };
}

export function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}
