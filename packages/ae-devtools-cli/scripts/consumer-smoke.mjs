#!/usr/bin/env node
/**
 * consumer-smoke.mjs — verify the packed @ido-bata/ae-devtools-cli tarball works
 * from an external project directory (Issue #92 acceptance).
 *
 * Steps: npm pack → temp consumer dir → npm install <tgz> → run the real
 * bins (`ae-devtools`, `jsx-toolchain`, `ae-devtools-mcp`,
 * `ae-devtools-recover`) against a tiny TS fixture with the fake
 * session. The MCP check spawns `ae-devtools-mcp` and does an
 * initialize + tools/list JSON-RPC round-trip over stdio. The recover
 * check runs only the read-only `evidence` subcommand — `observe`,
 * `recover` and `verify-exit` need a real GUI session / After Effects
 * (ae-a8n #109/#111 surfaces) and stay out of smoke by design. The
 * diagnostics check runs a fake host failure through `execute --out`
 * and then `ae-devtools diagnose` on the stored evidence, proving the
 * packaged diagnostics/ module resolves sourcemaps in a consumer
 * install (Issue #113) — it must NOT degrade to "unavailable".
 * The CEP check scaffolds a panel into a temp dir through the installed
 * `ae-devtools-cep` bin and runs `ae-devtools-cep validate` on it,
 * proving the packaged cep-extension/ devkit works from a consumer
 * install (Issue #115) — static/fake-level only, `loadProof` stays
 * "NOT RUN"; real CEP panel load is out of scope.
 * The agent-loop check imports the packaged `@ido-bata/ae-devtools-cli/agent-loop`
 * library from the installed tarball and runs one dev loop against the
 * packaged fake host + fixture (Issue #117) — fake/mock level only;
 * fixer/consent/stateReset are injected stand-ins, no real AE.
 * No After Effects required; evidence stays fake-level.
 */
import { execFileSync, spawn } from "node:child_process";
import assertNode from "node:assert/strict";
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
async function checkAsync(name, fn) {
  try {
    await fn();
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
    assert(existsSync(join(consumer, "node_modules", ".bin", "ae-devtools-mcp")), "ae-devtools-mcp bin missing");
    assert(existsSync(join(consumer, "node_modules", ".bin", "ae-devtools-recover")), "ae-devtools-recover bin missing");
    assert(existsSync(join(consumer, "node_modules", ".bin", "ae-devtools-cep")), "ae-devtools-cep bin missing");
    assert(existsSync(join(consumer, "node_modules", ".bin", "ae-devtools-cep-lifecycle")), "ae-devtools-cep-lifecycle bin missing");
  });

  const BIN = join(consumer, "node_modules", ".bin");
  // JSX line in dist/panel.jsx that resolves back to a .ts source —
  // reused by the diagnostics round-trip below.
  let smokeMappedLine = null;

  // 3. doctor (no AE contact). Also asserts the ae-a8n contract probe
  // ships in the tarball (Issue #138): the consumer install resolves the
  // pinned ae-a8n, which currently predates the required contract, so
  // contractOk must be an honest boolean — never absent, never faked.
  check("ae-devtools doctor", () => {
    const out = run(join(BIN, "ae-devtools"), ["doctor"]);
    assert(out.length > 0, "empty doctor output");
    const json = JSON.parse(out);
    assertNode.equal(json.schema, "ae-devtools.cli.doctor/v1");
    assertNode.equal(typeof json.aeA8n?.contractOk, "boolean",
      "doctor must report aeA8n.contractOk");
    assertNode.ok(Array.isArray(json.aeA8n?.missing),
      "doctor must report aeA8n.missing");
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
        if (json?.original && /\.tsx?$/.test(json.original.source ?? json.original.file ?? "")) { mapped = json.original; smokeMappedLine = line; break outer; }
      }
    }
    assert(mapped, "no JSX position resolved back to a TypeScript source position");
  });

  // 8. failure diagnostics round-trip (Issue #113): a fake host error
  //    produces an evidence record whose diagnostics block resolves
  //    through sourcemaps, and `ae-devtools diagnose` re-resolves the
  //    stored record from the consumer install. The packaged
  //    diagnostics/ module must load — libs.status "ok", never
  //    "unavailable" — and the resolution must carry real sourcemap
  //    fields back to the consumer's TypeScript source.
  check("ae-devtools diagnose resolves packaged diagnostics in consumer install", () => {
    assert(smokeMappedLine !== null, "no mapped JSX line found in earlier check");
    const hostError = JSON.stringify({
      name: "Error",
      message: "consumer smoke injected host failure",
      line: smokeMappedLine,
      file: join(consumer, "dist", "panel.jsx"),
    });
    const evidencePath = join(work, "consumer-evidence.json");
    let out = "";
    try {
      out = run(join(BIN, "ae-devtools"), [
        "execute", "read.projectSummary", "--session", "fake",
        "--consent", "grant", "--out", evidencePath,
      ], { env: { ...process.env, AE_DEVTOOLS_CLI_FAKE_HOST_ERROR: hostError } });
    } catch (e) {
      // wire FAILED exits 1; the JSON payload is still on stdout
      out = String(e.stdout ?? "");
    }
    const ex = JSON.parse(out);
    assertNode.equal(ex.diagnostics?.schema, "ae-devtools.cli.diagnostics/v1", "diagnostics block missing");
    assertNode.equal(ex.diagnostics.status, "ok", "diagnostics block not ok: " + JSON.stringify(ex.diagnostics).slice(0, 300));
    assertNode.equal(ex.diagnostics.records[0]?.recordVersion, "ae-devtools.diagnostics/v1");
    assertNode.equal(ex.diagnostics.resolutions[0]?.status, "mapped", "execute-time resolution not mapped");
    assert(existsSync(evidencePath), "evidence file not written");

    const d = JSON.parse(run(join(BIN, "ae-devtools"), ["diagnose", evidencePath]));
    assertNode.equal(d.schema, "ae-devtools.cli.diagnose/v1");
    assertNode.equal(d.libs?.status, "ok", "diagnostics libs unavailable in consumer install: " + JSON.stringify(d.libs));
    assertNode.equal(d.recordCount, 1);
    const res = d.results[0]?.resolution;
    assertNode.ok(res, "diagnose resolution missing");
    assertNode.equal(res.status, "mapped", "diagnose resolution not mapped: " + JSON.stringify(res).slice(0, 300));
    assertNode.match(res.original?.file ?? "", /\.tsx?$/, "resolution did not reach a TypeScript source");
    assertNode.ok(res.maps?.jsx, "sourcemap path missing from resolution");
  });

  // 9. lint rejects ES3-incompatible syntax
  check("jsx-toolchain lint catches ES6+ syntax", () => {
    writeFileSync(join(consumer, "bad.ts"), "const f = () => JSON.stringify({a:1});\n");
    let code = 0, out = "";
    try { out = run(join(BIN, "jsx-toolchain"), ["lint", "bad.ts"], { cwd: consumer }); }
    catch (e) { code = e.status ?? 1; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
    assert(code !== 0 || out.includes('"ok":false') || out.includes('"ok": false'), "lint did not flag ES6 syntax");
  });

  // 10. ae-devtools-mcp: spawn the installed bin and do an initialize +
  //    tools/list JSON-RPC round-trip over stdio (fake session, consent
  //    defaults untouched — no dispatch is attempted here).
  await checkAsync("ae-devtools-mcp initialize + tools/list", async () => {
    const child = spawn(join(BIN, "ae-devtools-mcp"), ["--session", "fake"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    const inbox = [];
    const waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim().length === 0) continue;
        const msg = JSON.parse(line);
        const w = waiters.findIndex((x) => x.id === msg.id);
        if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
        else inbox.push(msg);
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });

    let nextId = 1;
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout ${method}; stderr: ${stderr}`)), 20_000);
      waiters.push({ id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    try {
      const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      assertNode.equal(init.result?.serverInfo?.name, "ae-devtools-mcp", "unexpected serverInfo");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const list = await request("tools/list");
      const names = (list.result?.tools ?? []).map((t) => t.name).sort();
      assertNode.deepEqual(names, ["ae_discover", "ae_execute", "ae_inspect", "ae_session", "ae_verify"], "tools/list mismatch");

      // Consent default deny still holds through the packaged bin: an
      // ae_execute without consent must be refused before any session.
      const denied = await request("tools/call", {
        name: "ae_execute",
        arguments: { opId: "read.projectSummary" },
      });
      const deniedPayload = JSON.parse(denied.result.content[0].text);
      assertNode.equal(deniedPayload.status, "refused");
      assertNode.equal(deniedPayload.reason, "CONSENT_NOT_GRANTED");
      assertNode.equal(deniedPayload.dispatched, false);

      child.stdin.end();
      const code = await new Promise((resolve) => child.on("exit", resolve));
      assertNode.equal(code, 0, `ae-devtools-mcp exited ${code}; stderr: ${stderr}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  // 11. ae-devtools-recover: read-only `evidence` subcommand only.
  //     observe/recover/verify-exit require a real GUI session and a
  //     built ae-a8n checkout (#109/#111 surfaces) — they are
  //     real-host paths and deliberately NOT smoke-tested here.
  check("ae-devtools-recover evidence emits JSON manifest", () => {
    const reportsDir = join(work, "reports-empty");
    mkdirSync(reportsDir, { recursive: true });
    const outDir = join(work, "evidence-out");
    const out = run(join(BIN, "ae-devtools-recover"), [
      "evidence",
      "--since", new Date(Date.now() - 3600e3).toISOString(),
      "--out", outDir,
      "--reports-dir", reportsDir,
    ]);
    const json = JSON.parse(out);
    // cli.mjs spreads the manifest last, so `schema` is the manifest's
    // own schema; `kind` is the stable discriminator for this output.
    assertNode.equal(json.kind, "crash-evidence", "unexpected evidence output kind");
    assertNode.equal(json.complete, true, "evidence collection reported incomplete");
    assertNode.ok(json.counts && typeof json.counts.total === "number", "counts missing");
    assert(existsSync(join(outDir, "manifest.json")), "manifest.json missing");
  });

  // 12. ae-devtools-cep: scaffold a panel into a temp dir through the
  //     installed bin, then `validate` it. Local-only round trip — the
  //     report must stay honest (loadProof "NOT RUN"); nothing touches
  //     AE or the real CEP dirs. `ae-devtools-cep-lifecycle` is also
  //     exercised read-only via `playerdebugmode` (reports status,
  //     writes nothing).
  check("ae-devtools-cep scaffold + validate round trip", () => {
    const panelDir = join(work, "smoke-panel");
    run(join(BIN, "ae-devtools-cep"), [
      "scaffold",
      "--id", "com.example.consumer-smoke",
      "--title", "Consumer Smoke",
      "--version", "0.1.0",
      "--host", "[25.0,99.0]",
      "--csxs", "12.0",
      "--out", panelDir,
    ]);
    for (const rel of ["CSXS/manifest.xml", "index.html", "CSInterface.js", "js/main.js", "jsx/host.jsx"]) {
      assert(existsSync(join(panelDir, rel)), `scaffold output missing: ${rel}`);
    }
    const report = JSON.parse(run(join(BIN, "ae-devtools-cep"), ["validate", panelDir]));
    assertNode.equal(report.ok, true, "validate reported failures: " + JSON.stringify(report.checks).slice(0, 300));
    assertNode.equal(report.loadProof, "NOT RUN", "loadProof must stay NOT RUN");
  });

  check("ae-devtools-cep-lifecycle playerdebugmode is read-only JSON", () => {
    const out = run(join(BIN, "ae-devtools-cep-lifecycle"), ["playerdebugmode"]);
    const json = JSON.parse(out);
    assertNode.ok(json && typeof json === "object", "unexpected playerdebugmode output");
  });

  // 13. agent-loop library (Issue #117): import the packaged module
  //     from the consumer install and run one dev loop on the packaged
  //     clean fixture through the packaged fake host. The consent
  //     provider is a stand-in (the loop never mints consent itself);
  //     no fixer is needed because the fixture completes first try.
  //     Fake/mock level only — NOT real AE.
  await checkAsync("agent-loop dev loop completes via packaged library import", async () => {
    writeFileSync(join(consumer, "agent-loop-smoke.mjs"), [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { runDevLoop, FAKE_SESSION } from "@ido-bata/ae-devtools-cli/agent-loop";',
      'import { createFakeHost, createFakeApp } from "@ido-bata/ae-devtools-cli/agent-loop/fake-host";',
      'import { loadTrustedCodec } from "@ido-bata/ae-devtools-cli/trusted-execution/runner.mjs";',
      'import { consentScopeFor } from "@ido-bata/ae-devtools-cli/trusted-execution/permissions.mjs";',
      "",
      "const codec = loadTrustedCodec();",
      "const host = createFakeHost({ app: createFakeApp() });",
      "const transport = { send: async (text) => host.send(text, codec) };",
      "const consentProvider = async (source) => ({",
      "  consent: {",
      "    scope: consentScopeFor({",
      "      pin: FAKE_SESSION.pin,",
      "      operationId: FAKE_SESSION.operationId,",
      "      args: { source, dispatchArgs: null },",
      "      projectIdentity: FAKE_SESSION.projectIdentity,",
      "    }),",
      "  },",
      '  trustedScriptOptIn: true,',
      '  scriptProvenance: "consumer-smoke",',
      "});",
      "const source = readFileSync(",
      '  join(process.cwd(), "node_modules", "@ido-bata", "ae-devtools-cli", "agent-loop", "fixtures", "clean.jsx"),',
      '  "utf8",',
      ");",
      "const report = await runDevLoop({ source, transport, consentProvider });",
      "console.log(JSON.stringify({",
      "  outcome: report.outcome,",
      "  iterations: report.iterations.length,",
      "  result: report.iterations[0] && report.iterations[0].result,",
      "}));",
      "",
    ].join("\n"));
    const out = run(process.execPath, ["agent-loop-smoke.mjs"], { cwd: consumer });
    const json = JSON.parse(out);
    assertNode.equal(json.outcome, "COMPLETED", "agent-loop outcome not COMPLETED: " + out);
    assertNode.equal(json.iterations, 1, "expected a single dispatch for the clean fixture");
    assertNode.equal(json.result, "final", "unexpected fake-host result: " + out);
  });

  // 14. exports boundary (Issue #184): the wildcard `./*` export was
  //     removed — every supported subpath must resolve (check 13 already
  //     imports all four) and every unsupported deep path must be
  //     rejected with ERR_PACKAGE_PATH_NOT_EXPORTED from the packed
  //     tarball install.
  check("unsupported deep imports are rejected by exports map", () => {
    writeFileSync(join(consumer, "exports-boundary-smoke.mjs"), [
      "const rejected = [];",
      "for (const subpath of [",
      '  "@ido-bata/ae-devtools-cli/dev-loop/outcomes.mjs",',
      '  "@ido-bata/ae-devtools-cli/dev-loop/session-open.mjs",',
      '  "@ido-bata/ae-devtools-cli/dev-loop/tests/run.mjs",',
      '  "@ido-bata/ae-devtools-cli/trusted-execution/outcomes.mjs",',
      '  "@ido-bata/ae-devtools-cli/trusted-execution/tests/run.mjs",',
      '  "@ido-bata/ae-devtools-cli/mcp-server/server.mjs",',
      "]) {",
      "  try {",
      "    await import(subpath);",
      "    rejected.push({ subpath, error: \"import succeeded\" });",
      "  } catch (e) {",
      "    rejected.push({ subpath, code: e.code ?? null });",
      "  }",
      "}",
      "console.log(JSON.stringify(rejected));",
      "",
    ].join("\n"));
    const out = run(process.execPath, ["exports-boundary-smoke.mjs"], { cwd: consumer });
    const results14 = JSON.parse(out);
    assertNode.equal(results14.length, 6, "unexpected probe count: " + out);
    for (const r of results14) {
      assertNode.equal(r.code, "ERR_PACKAGE_PATH_NOT_EXPORTED",
        `${r.subpath} was not rejected by exports map: ${JSON.stringify(r)}`);
    }
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
