/**
 * testkit.mjs — minimal test helpers for the hand-rolled suite files
 * (Issue #185).
 *
 * Four suites (devtools-cli, recovery-orchestrator, vscode-debugger,
 * jsx-toolchain) keep their tests inline in `tests/run.mjs` rather than
 * `*.test.mjs` files because they drive the real CLI as a subprocess or
 * need ordered async steps; converting them to node:test is a separate
 * mechanical migration. What they share — the `t`/`at` wrappers,
 * pass counting and failure reporting — lives here once.
 *
 *   import { t, at, finish } from "../../scripts/testkit.mjs";
 *   t("name", () => { ... });
 *   await at("name", async () => { ... });
 *   await finish("tests passed");
 *
 * `t` also accepts an async fn: the returned promise is tracked and
 * `finish()` awaits all of them (the jsx-toolchain pattern). `at` is
 * the explicitly-awaited variant for ordered async tests.
 */

let passed = 0;
const pending = [];

function report(name, error) {
  if (error === null) {
    passed++;
    console.log(`ok ${name}`);
  } else {
    console.error(`FAIL ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

/**
 * Run a test. Sync fns report immediately; thenables are queued and
 * awaited by finish(). Returns the test's promise when async so callers
 * MAY await it for ordering (prefer `at` for that).
 */
export function t(name, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    report(name, e);
    return undefined;
  }
  if (result && typeof result.then === "function") {
    const p = Promise.resolve(result).then(
      () => report(name, null),
      (e) => report(name, e),
    );
    pending.push(p);
    return p;
  }
  report(name, null);
  return undefined;
}

/** Async test, awaited inline — preserves declaration order. */
export async function at(name, fn) {
  try {
    await fn();
    report(name, null);
  } catch (e) {
    report(name, e);
  }
}

/** Await queued async `t` tests, then print the suite summary. */
export async function finish(label = "tests passed") {
  await Promise.all(pending);
  console.log(`\n${passed} ${label}${process.exitCode ? " (with failures)" : ""}`);
}
