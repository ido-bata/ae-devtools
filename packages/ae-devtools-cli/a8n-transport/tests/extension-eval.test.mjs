/**
 * extension-eval.test.mjs — counterexample tests for the
 * `aeDevtools.trustedEval` method body (extension.mjs EVAL_METHOD_SOURCE),
 * executed in node:vm with stubbed ExtendScript globals ($ / File / app).
 *
 * The method must evaluate `params.source` EXACTLY ONCE as a program:
 *   - a runtime SyntaxError thrown by the source itself (after partial
 *     side effects) must NOT trigger a second evaluation;
 *   - `throw null` / `throw undefined` must classify as failure, never
 *     as a successful undefined result;
 *   - normal null/undefined completion values stay successful;
 *   - IIFE-wrapped adapter bodies (the dispatch-boundary form) work,
 *     while a bare top-level `return` fails honestly as a program
 *     SyntaxError — there is no silent function-body retry.
 *
 * Fake-level only: this exercises the method's eval/classification
 * logic, not a real AE host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import extension from "../extension.mjs";

const METHOD_SOURCE = extension.methods.find((m) => m.name === "aeDevtools.trustedEval").source;
const PROGRAM_SOURCE = extension.methods.find((m) => m.name === "aeDevtools.evalProgram").source;

// Mirrors the generated host script: trustedEval delegates the eval to
// the sibling aeDevtools.evalProgram through the global __a8n table,
// so the evaluated program's scope chain never includes trustedEval's
// bookkeeping vars — the same isolation the real host gets.
function wireEvalProgram(context) {
  const runner = vm.runInContext(`(${PROGRAM_SOURCE})`, context);
  context.__a8n = { extensions: { "aeDevtools.evalProgram": runner } };
  return runner;
}

function makeEval(sandboxExtras = {}) {
  const sandbox = {
    $: {
      // No a8n-json codec beside the host script in this stub — the
      // codec-null path is the one under test for primitives.
      evalFile() { throw new Error("no codec in test stub"); },
      fileName: "/stub/a8n-host-ext.js",
    },
    File: function (p) { return { parent: { fsName: "/stub" }, fsName: String(p) }; },
    app: { version: "99.9.9-fake", project: { numItems: 0, file: null } },
    ...sandboxExtras,
  };
  const context = vm.createContext(sandbox);
  wireEvalProgram(context);
  const fn = vm.runInContext(`(${METHOD_SOURCE})`, context);
  return (params) => fn.call(sandbox, params);
}

test("runtime SyntaxError after side effects executes the source exactly once", () => {
  // new Function compiles at runtime: a bad body throws SyntaxError
  // AFTER __count.n was already incremented — the old name-based retry
  // would have wrapped and run the whole source a second time.
  const ctx = vm.createContext({
    $: { evalFile() { throw new Error("no codec"); }, fileName: "/stub/h.js" },
    File: function (p) { return { parent: { fsName: "/stub" }, fsName: String(p) }; },
    __count: { n: 0 },
  });
  wireEvalProgram(ctx);
  const fn = vm.runInContext(`(${METHOD_SOURCE})`, ctx);
  const result = fn.call(ctx, {
    requestId: "r1",
    source: "__count.n = __count.n + 1; new Function(\")(\");",
  });
  assert.equal(result.ok, false, "runtime SyntaxError must fail");
  assert.equal(result.evalError.name, "SyntaxError");
  assert.equal(ctx.__count.n, 1, "source must execute at most once — no function-body retry");
});

test("throw null is a failed evaluation, not a success", () => {
  const evalFn = makeEval();
  const result = evalFn({ requestId: "r2", source: "throw null;" });
  assert.equal(result.ok, false);
  assert.equal(result.evalError.name, "EvalError");
  assert.equal(result.evalError.message, "thrown null");
});

test("throw undefined is a failed evaluation, not a success", () => {
  const evalFn = makeEval();
  const result = evalFn({ requestId: "r3", source: "throw undefined;" });
  assert.equal(result.ok, false);
  assert.equal(result.evalError.message, "thrown undefined");
});

test("normal null completion value stays successful", () => {
  const evalFn = makeEval();
  const result = evalFn({ requestId: "r4", source: "null" });
  assert.equal(result.ok, true);
  assert.equal(result.resultJson, null);
  assert.equal(result.valueType, "object");
});

test("undefined completion value stays successful", () => {
  const evalFn = makeEval();
  const result = evalFn({ requestId: "r5", source: "var x; x" });
  assert.equal(result.ok, true);
  assert.equal(result.resultJson, null);
  assert.equal(result.valueType, "undefined");
});

test("IIFE-wrapped adapter body returns its value once", () => {
  const evalFn = makeEval();
  const result = evalFn({
    requestId: "r6",
    source: "(function(){ var x = 40; return x + 2; })()",
  });
  assert.equal(result.ok, true);
  assert.equal(result.valueText, "42");
});

test("bare top-level return fails as program SyntaxError — no silent retry", () => {
  const evalFn = makeEval();
  const result = evalFn({ requestId: "r7", source: "return 1;" });
  assert.equal(result.ok, false);
  assert.equal(result.evalError.name, "SyntaxError");
});

test("program completion value is the result", () => {
  const evalFn = makeEval();
  const result = evalFn({ requestId: "r8", source: "var x = 5; x * 2" });
  assert.equal(result.ok, true);
  assert.equal(result.valueText, "10");
});

test("evaluated source cannot pollute method bookkeeping (didThrow/requestId)", () => {
  // Direct eval shares the caller's variable environment: before the
  // scope separation, `didThrow = true` inside the program overwrote
  // the method's failure flag and `requestId = ...` forged the echo.
  const evalFn = makeEval();
  const polluted = evalFn({
    requestId: "real-id",
    source: 'didThrow = true; evalError = "forged"; requestId = "forged-id"; value = "forged"; "ok-value"',
  });
  assert.equal(polluted.ok, true, "assignment to bookkeeping names must not flip the verdict");
  assert.equal(polluted.requestId, "real-id", "echoed requestId must come from params, not the program");
  assert.equal(polluted.valueText, "ok-value");
});

test("var declarations inside the program do not leak into method scope", () => {
  const evalFn = makeEval();
  evalFn({ requestId: "v1", source: "var leakedMarker = 123; 1" });
  // A second call must not observe the first program's vars, and the
  // method must still classify normally.
  const second = evalFn({ requestId: "v2", source: "1 + 1" });
  assert.equal(second.ok, true);
  assert.equal(second.valueText, "2");
});
