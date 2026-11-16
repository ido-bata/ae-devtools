#!/usr/bin/env node
/**
 * consumer-smoke.mjs — verify the packed @ae-devtools/cli tarball works
 * from an external project directory (Issue #92 acceptance).
 *
 * Steps: npm pack → temp consumer dir → npm install <tgz> → run the real
 * bins (`ae-devtools`, `jsx-toolchain`) against a tiny TS fixture with the
 * fake session. No After Effects required; evidence stays fake-level.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const work = mkdtempSync(join(tmpdir(), "ae-devtools-consumer-"));
const results = [];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e.message ?? e).slice(0, 400) });
    console.log(`FAIL ${name}: ${String(e.message ?? e).slice(0, 200)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

try {
  // 1. pack
  const packOut = run("npm", ["pack", "--pack-destination", work], { cwd: PKG });
  const tgz = packOut.trim().split("\n").pop();
  const tgzPath = join(work, tgz);
  check("npm pack produces tarball", () => assert(existsSync(tgzPath), "tarball missing"));

  // 2. consumer project
  const consumer = join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer-fixture", private: true, type: "module" }, null, 2));
  writeFileSync(join(consumer, "main.ts"), [
    'import { greet } from "./lib/greet";',
    "var result = greet('ae');",
    "$.writeln(result);",
    "",
  ].join("\n"));
  mkdirSync(join(consumer, "lib"), { recursive: true });
  writeFileSync(join(consumer, "lib", "greet.ts"), 'export function greet(name: string): string {\n  return "hello " + name;\n}\n');

  check("npm install tarball in external project", () => {
    run("npm", ["install", "--no-audit", "--no-fund", tgzPath], { cwd: consumer });
    assert(existsSync(join(consumer, "node_modules", ".bin", "ae-devtools")), "ae-devtools bin missing");
    assert(existsSync(join(consumer, "node_modules", ".bin", "jsx-toolchain")), "jsx-toolchain bin missing");
  });

  const BIN = join(consumer, "node_modules", ".bin");

  // 3. doctor (no AE contact)
  check("ae-devtools doctor", () => {
    const out = run(join(BIN, "ae-devtools"), ["doctor"]);
    assert(out.length > 0, "empty doctor output");
  });

  // 4. discover + inspect (fake evidence levels)
  check("ae-devtools discover lists ops", () => {
    const out = run(join(BIN, "ae-devtools"), ["discover", "--session", "fake"]);
    const json = JSON.parse(out);
    assert(Array.isArray(json.operations ?? json.ops ?? json) , "discover output shape unexpected");
  });

  // 5. execute + verify on fake session with consent
  check("ae-devtools execute/verify fake session", () => {
    const ex = run(join(BIN, "ae-devtools"), ["execute", "read.projectSummary", "--session", "fake", "--consent", "grant"]);
    const exJson = JSON.parse(ex);
    assert(exJson && typeof exJson === "object", "execute output not JSON");
    const vf = run(join(BIN, "ae-devtools"), ["verify", "--session", "fake", "--consent", "grant"]);
    assert(vf.length > 0, "verify produced no output");
  });

  // 6. consent default deny
  check("execute without consent is refused", () => {
    let code = 0;
    try { run(join(BIN, "ae-devtools"), ["execute", "read.projectSummary", "--session", "fake"]); }
    catch (e) { code = e.status ?? 1; }
    assert(code !== 0, "execute succeeded without consent");
  });

  // 7. jsx-toolchain check + build-project + resolve on consumer TS
  check("jsx-toolchain check consumer TS", () => {
    const out = run(join(BIN, "jsx-toolchain"), ["check", "main.ts"], { cwd: consumer });
    const json = JSON.parse(out);
    assert(json.ok === true || json.status === "ok" || (json.diagnostics ?? []).every((d) => d.severity !== "error"), "check reported errors: " + out.slice(0, 300));
  });

  check("jsx-toolchain build-project + resolve", () => {
    run(join(BIN, "jsx-toolchain"), ["build-project", "main.ts", "-o", "dist", "--name", "panel"], { cwd: consumer });
    assert(existsSync(join(consumer, "dist", "panel.jsx")), "panel.jsx missing");
    assert(existsSync(join(consumer, "dist", "panel.jsx.map")), "panel.jsx.map missing");
    // generated boilerplate lines legitimately map to nothing; scan for a
    // line that resolves back to a .ts source position.
    let mapped = null;
    outer: for (let line = 1; line <= 60; line++) {
      for (const col of [1, 5, 10, 20]) {
        let json = null;
        try {
          json = JSON.parse(run(join(BIN, "jsx-toolchain"), ["resolve", "dist", String(line), String(col)], { cwd: consumer }));
        } catch { /* exit 1 = unmapped position; keep scanning */ }
        if (json?.original && /\.tsx?$/.test(json.original.source ?? json.original.file ?? "")) { mapped = json.original; break outer; }
      }
    }
    assert(mapped, "no JSX position resolved back to a TypeScript source position");
  });

  // 8. lint rejects ES3-incompatible syntax
  check("jsx-toolchain lint catches ES6+ syntax", () => {
    writeFileSync(join(consumer, "bad.ts"), "const f = () => JSON.stringify({a:1});\n");
    let code = 0, out = "";
    try { out = run(join(BIN, "jsx-toolchain"), ["lint", "bad.ts"], { cwd: consumer }); }
    catch (e) { code = e.status ?? 1; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
    assert(code !== 0 || out.includes('"ok":false') || out.includes('"ok": false'), "lint did not flag ES6 syntax");
  });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} consumer smoke checks passed`);
  if (failed.length === 0) {
    rmSync(work, { recursive: true, force: true });
  } else {
    console.log(`work dir kept for inspection: ${work}`);
    process.exitCode = 1;
  }
}
