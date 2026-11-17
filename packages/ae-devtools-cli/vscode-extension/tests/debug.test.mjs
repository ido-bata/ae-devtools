/**
 * debug.test.mjs — debug.setup / debug.attach controller tests
 * (Issue #154). Fake level only: preflight host state is injected via
 * runPreflight deps; launch.json writes go to a temp dir. No AE, no
 * vscode API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createController } from "../controller.mjs";
import { parseJsonc } from "../../vscode-debugger/src/jsonc.mjs";

const ui = { async confirm() { return true; }, async info() {}, async error() {} };
const SPEC = "aftereffects-27.0";

function tmpProject() {
  return mkdtempSync(join(tmpdir(), "ae-devtools-debug-"));
}

const APPS = [{ name: "AE2027", version: "27.0.0", bundleId: "com.adobe.AfterEffects.application", path: "/Applications/x.app" }];

test("debug.setup without hostAppSpecifier is a usage refusal", () => {
  const c = createController({ ui });
  const res = c.debugSetup({ projectDir: tmpProject() });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "USAGE");
});

test("debug.setup writes an attach-only launch.json and validates it", () => {
  const dir = tmpProject();
  const c = createController({ ui });
  const res = c.debugSetup({ projectDir: dir, hostAppSpecifier: SPEC });
  assert.equal(res.status, "ok");
  assert.equal(res.config.request, "attach");
  assert.equal(res.config.type, "extendscript-debug");
  assert.equal(res.config.hostAppSpecifier, SPEC);
  assert.equal(res.merged, false);
  const onDisk = JSON.parse(readFileSync(res.path, "utf8"));
  assert.equal(onDisk.configurations.length, 1);
  assert.equal(onDisk.configurations[0].request, "attach");
});

test("debug.setup merges into an existing launch.json without clobbering", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  writeFileSync(join(dir, ".vscode", "launch.json"),
    '{\n  // user comment\n  "version": "0.2.0",\n  "configurations": [\n    { "type": "node", "request": "launch", "name": "mine" }\n  ]\n}\n');
  const c = createController({ ui });
  const res = c.debugSetup({ projectDir: dir, hostAppSpecifier: SPEC });
  assert.equal(res.status, "ok");
  assert.equal(res.merged, true);
  const onDisk = readFileSync(res.path, "utf8");
  assert.match(onDisk, /user comment/);
  const doc = parseJsonc(onDisk).value; // launch.json is JSONC
  assert.equal(doc.configurations.length, 2);
  assert.equal(doc.configurations[0].name, "mine");
});

test("debug.setup refuses an unparseable existing launch.json (fail closed)", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  writeFileSync(join(dir, ".vscode", "launch.json"), "{ not json :::");
  const c = createController({ ui });
  const res = c.debugSetup({ projectDir: dir, hostAppSpecifier: SPEC });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "WRITE_FAILED");
});

test("debug.attach: verified owned pin → ready-owned-session, attach guidance only", () => {
  const c = createController({ ui });
  const res = c.debugAttach({
    hostAppSpecifier: SPEC,
    ownedPid: 123,
    preflightDeps: {
      discoverAdobeApps: () => APPS,
      findAfterEffectsProcesses: () => [{ pid: 123, command: "After Effects" }],
    },
  });
  assert.equal(res.status, "ok");
  assert.equal(res.preflight.verdict, "ready-owned-session");
  assert.equal(res.preflight.attachAttemptable, true);
  assert.equal(res.preflight.debugCompletionClaimed, false);
  assert.match(res.guidance, /UNVERIFIED/);
});

test("debug.attach: unverified single instance → blocked, no attach claim", () => {
  const c = createController({ ui });
  const res = c.debugAttach({
    hostAppSpecifier: SPEC,
    preflightDeps: {
      discoverAdobeApps: () => APPS,
      findAfterEffectsProcesses: () => [{ pid: 123, command: "After Effects" }],
    },
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.preflight.verdict, "unowned-single-instance");
  assert.equal(res.preflight.attachAttemptable, false);
  assert.match(res.guidance, /not claimed/);
});

test("debug.attach: multiple instances always refuse, owned-pid cannot rescue", () => {
  const c = createController({ ui });
  const res = c.debugAttach({
    hostAppSpecifier: SPEC,
    ownedPid: 123,
    preflightDeps: {
      discoverAdobeApps: () => APPS,
      findAfterEffectsProcesses: () => [{ pid: 123, command: "AE" }, { pid: 456, command: "AE" }],
    },
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.preflight.verdict, "ambiguous-multiple-instances");
});

test("debug.attach: no running instance and bad specifier block honestly", () => {
  const c = createController({ ui });
  const none = c.debugAttach({
    hostAppSpecifier: SPEC,
    preflightDeps: { discoverAdobeApps: () => APPS, findAfterEffectsProcesses: () => [] },
  });
  assert.equal(none.preflight.verdict, "no-running-instance");
  const bad = c.debugAttach({
    hostAppSpecifier: "not a specifier!",
    preflightDeps: { discoverAdobeApps: () => APPS, findAfterEffectsProcesses: () => [{ pid: 1, command: "AE" }] },
  });
  assert.equal(bad.preflight.verdict, "blocked-specifier");
});

test("debug.attach: non-integer ownedPid is a usage refusal", () => {
  const c = createController({ ui });
  const res = c.debugAttach({ hostAppSpecifier: SPEC, ownedPid: "abc" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "USAGE");
});
