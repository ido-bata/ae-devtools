/**
 * attached-session tests — Issue #366 vertical slice.
 *
 * Automated-test level: fixture ae-a8n roots stub AfterEffects.launch;
 * no real After Effects is contacted. Real-host evidence is recorded
 * separately (a8n-transport/EVIDENCE.md).
 *
 * Covered invariants:
 *   - the launch carries ONLY the extensionMethods grant for
 *     aeDevtools.trustedEval (no hostEnvironment/menuCommands);
 *   - ownership must be "attached" — an "owned" result means this launch
 *     started a fresh AE, which is not the requested target: refuse and
 *     close;
 *   - an aeVersion pin mismatch refuses after attach;
 *   - the returned session is read-only at the dev-loop policy level.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openAttachedSliceSession } from "../attached-session.mjs";
import { execute as devloopExecute, verify as devloopVerify } from "../../dev-loop/devloop.mjs";
import * as okModule from "./fixtures/handshake-ok.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OK_FIXTURE_URL = pathToFileURL(join(HERE, "fixtures", "handshake-ok.mjs")).href;

/**
 * Fixture root whose AfterEffects.launch returns a scripted fake `ae`.
 * AE_FIXTURE_BEHAVIOR selects the post-launch shape:
 *   "attached-ok"   — ownership attached, version 26.5-fake, project read
 *   "owned"         — ownership owned (fresh AE — must refuse)
 *   "version-mismatch" — attached but live version differs from pin
 * launchArgs (exported) records every launch() options object.
 */
function launchFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "a8n-att-fixture-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "ae-a8n-fixture", version: "0.0.0-test" }),
  );
  const okUrl = JSON.stringify(OK_FIXTURE_URL);
  writeFileSync(join(root, "dist", "index.js"), `
export * from ${okUrl};
export const launchArgs = [];
export const launchLog = [];
// Read at launch() time, not import time — one fixture root serves
// several behavior selections within a single test.
const behavior = () => process.env.AE_FIXTURE_BEHAVIOR ?? "attached-ok";
// Install resolution is env-gated: unset → null → the attach
// pre-flight is skipped, so existing tests stay hermetic. Set
// AE_FIXTURE_INSTALL_EXE to exercise the pre-flight census (paired
// with an injected hostProcessProbe — never a real process scan).
export const resolveInstall = async () =>
  process.env.AE_FIXTURE_INSTALL_EXE
    ? { executable: process.env.AE_FIXTURE_INSTALL_EXE, installDir: "/fake/install" }
    : null;
export const AfterEffects = Object.assign(function AfterEffects() {}, {
  launch: async (options) => {
    launchArgs.push(options ?? {});
    const entry = { closed: 0 };
    launchLog.push(entry);
    const b = behavior();
    const version = b === "version-mismatch" ? "99.9-fake" : "26.5-fake";
    return {
      info: () => ({ version, build: "9" }),
      ownership: () => ({
        kind: b === "owned" ? "owned" : "attached",
        evidence: "fixture-evidence",
      }),
      project: () => ({
        info: async () => ({
          file: process.env.AE_FIXTURE_PROJECT_FILE ?? "/tmp/user-project.aep",
          name: "user-project",
          itemCount: 3,
        }),
      }),
      call: async () => { throw new Error("call not used in fixture tests"); },
      close: async () => { entry.closed += 1; },
      tracePath: "/tmp/fake-a8n-trace.jsonl",
    };
  },
});
`);
  writeFileSync(join(root, "dist", "cli.js"), `
import { writeFileSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
if (outIndex === -1) { console.error("fixture cli: --out is required"); process.exit(2); }
writeFileSync(process.argv[outIndex + 1], "// fixture host script");
`);
  return root;
}

async function importFixture(root) {
  return import(pathToFileURL(join(root, "dist", "index.js")).href);
}

function withEnvVars(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function withBehavior(value, fn) {
  return withEnvVars({ AE_FIXTURE_BEHAVIOR: value }, fn);
}

test("openAttachedSliceSession: attaches with narrow extensionMethods grant only", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withBehavior("attached-ok", async () => {
      const s = await openAttachedSliceSession({ aeA8nRoot: root, workdir });
      try {
        assert.equal(s.attached, true);
        assert.deepEqual(s.policy, { readOnly: true, mode: "attached" });
        assert.equal(s.ownership.kind, "attached");
        assert.equal(s.info.version, "26.5-fake");
        assert.equal(s.target.project.file, "/tmp/user-project.aep");
        const { launchArgs } = await importFixture(root);
        assert.equal(launchArgs.length, 1);
        const auth = launchArgs[0].authorization;
        assert.deepEqual(auth, { extensionMethods: ["aeDevtools.trustedEval"] });
        assert.equal(auth.hostEnvironment, undefined);
        assert.equal(auth.menuCommands, undefined);
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openAttachedSliceSession: owned result refuses — fresh AE is not the target", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withBehavior("owned", async () => {
      await assert.rejects(
        openAttachedSliceSession({ aeA8nRoot: root, workdir }),
        (e) => e.code === "ATTACHED_TARGET_NOT_RUNNING",
      );
      const { launchLog } = await importFixture(root);
      assert.equal(launchLog[0].closed, 1, "the freshly launched owned AE must be closed");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openAttachedSliceSession: aeVersion pin mismatch refuses after attach", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withBehavior("version-mismatch", async () => {
      await assert.rejects(
        openAttachedSliceSession({ aeA8nRoot: root, workdir, aeVersion: "26.5-fake" }),
        (e) => e.code === "ATTACHED_TARGET_MISMATCH",
      );
    });
    // Matching pin on the same behavior still opens (live is 99.9-fake).
    await withBehavior("attached-ok", async () => {
      const s = await openAttachedSliceSession({
        aeA8nRoot: root, workdir, aeVersion: "26.5-fake",
      });
      await s.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* attach pre-flight + project pin (Issue #366)                        */
/* ------------------------------------------------------------------ */

const FAKE_EXE =
  "/fake/Adobe After Effects 2027.app/Contents/MacOS/After Effects";
const FAKE_EXE_ENV = { AE_FIXTURE_INSTALL_EXE: FAKE_EXE };

test("preflight: zero AE processes refuses before any launch", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      await assert.rejects(
        openAttachedSliceSession({
          aeA8nRoot: root, workdir, hostProcessProbe: async () => [],
        }),
        (e) =>
          e.code === "ATTACHED_TARGET_NOT_RUNNING" &&
          /No AE process was launched/.test(e.message),
      );
      const { launchArgs, launchLog } = await importFixture(root);
      assert.equal(launchArgs.length, 0, "pre-flight refusal must not call launch()");
      assert.equal(launchLog.length, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("preflight: two instances of the same install refuse as ambiguous", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      await assert.rejects(
        openAttachedSliceSession({
          aeA8nRoot: root,
          workdir,
          hostProcessProbe: async () => [
            { pid: 101, path: FAKE_EXE },
            { pid: 202, path: FAKE_EXE },
          ],
        }),
        (e) => e.code === "ATTACHED_TARGET_AMBIGUOUS",
      );
      const { launchArgs } = await importFixture(root);
      assert.equal(launchArgs.length, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("preflight: unattributed or foreign-version rows stay inconclusive", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      // A path the OS would not disclose, and a DIFFERENT install's AE:
      // neither proves "no target", so launch + ownership decide.
      for (const rows of [
        [{ pid: 1, path: null }],
        [{ pid: 2, path: "/other/Adobe After Effects 2026.app/Contents/MacOS/After Effects" }],
        null, // probe failure
      ]) {
        const s = await openAttachedSliceSession({
          aeA8nRoot: root, workdir, hostProcessProbe: async () => rows,
        });
        await s.close();
      }
      const { launchArgs } = await importFixture(root);
      assert.equal(launchArgs.length, 3, "inconclusive scans must still reach launch()");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("projectFile pin: matching project opens, mismatch refuses", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(
      { ...FAKE_EXE_ENV, AE_FIXTURE_PROJECT_FILE: "/tmp/user-project.aep" },
      async () => {
        const ok = await openAttachedSliceSession({
          aeA8nRoot: root,
          workdir,
          projectFile: "/tmp/user-project.aep",
          hostProcessProbe: async () => [{ pid: 7, path: FAKE_EXE }],
        });
        assert.equal(ok.target.projectFile, "/tmp/user-project.aep");
        await ok.close();

        await assert.rejects(
          openAttachedSliceSession({
            aeA8nRoot: root,
            workdir,
            projectFile: "/tmp/other-project.aep",
            hostProcessProbe: async () => [{ pid: 7, path: FAKE_EXE }],
          }),
          (e) => e.code === "ATTACHED_TARGET_MISMATCH",
        );
        const { launchLog } = await importFixture(root);
        assert.equal(launchLog[1].closed, 1, "mismatch must close the attached session");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* dev-loop read-only policy (Issue #366)                              */
/* ------------------------------------------------------------------ */

const readOnlyPolicy = { readOnly: true, mode: "attached" };
const stubRunner = { runScript: async () => ({ ok: true }) };
const approvedConsent = async () => ({ approved: true });

test("devloop.execute: readOnly session refuses mutating ops before consent", async () => {
  let consentCalls = 0;
  const result = await devloopExecute({
    opId: "project.new",
    args: {},
    runner: stubRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: async () => { consentCalls += 1; return { approved: true }; },
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    sessionPolicy: readOnlyPolicy,
  });
  assert.equal(result.status, "refused");
  assert.equal(result.stage, "session-policy");
  assert.equal(result.reason, "READ_ONLY_SESSION");
  assert.equal(consentCalls, 0, "consent must not even be consulted for a policy refusal");
});

test("devloop.execute: readOnly session still allows read ops through", async () => {
  // read.projectSummary is non-mutating; with a stub runner the dispatch
  // reaches runOperation's own gates (which may still refuse downstream —
  // what matters is the session policy did NOT refuse it).
  const result = await devloopExecute({
    opId: "read.projectSummary",
    args: {},
    runner: stubRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: approvedConsent,
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    sessionPolicy: readOnlyPolicy,
  });
  assert.notEqual(result?.reason, "READ_ONLY_SESSION");
});

test("devloop.verify: read op unaffected by session policy", async () => {
  const result = await devloopVerify({
    readOpId: "read.projectSummary",
    runner: stubRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: approvedConsent,
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    sessionPolicy: readOnlyPolicy,
  });
  assert.notEqual(result?.reason, "READ_ONLY_SESSION");
});

/* ------------------------------------------------------------------ */
/* dev-loop mutation scope (Issue #366)                                */
/* ------------------------------------------------------------------ */

const scopedPolicy = {
  readOnly: false,
  mode: "attached",
  mutation: { allowedOps: ["project.new"] },
};

test("devloop.execute: scoped session refuses mutating ops outside allowedOps", async () => {
  let consentCalls = 0;
  const result = await devloopExecute({
    opId: "project.save",
    args: {},
    runner: stubRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: async () => { consentCalls += 1; return { approved: true }; },
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    sessionPolicy: scopedPolicy,
  });
  assert.equal(result.status, "refused");
  assert.equal(result.stage, "session-policy");
  assert.equal(result.reason, "ATTACHED_MUTATION_NOT_GRANTED");
  assert.equal(consentCalls, 0, "consent must not even be consulted for a scope refusal");
});

test("devloop.execute: scoped session lets an allowed mutating op reach the canonical path", async () => {
  // project.new is in allowedOps, so the session policy must NOT refuse;
  // whatever runOperation decides downstream (stub runner may still
  // refuse) is not a session-policy refusal.
  const result = await devloopExecute({
    opId: "project.new",
    args: {},
    runner: stubRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: approvedConsent,
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    sessionPolicy: scopedPolicy,
  });
  assert.notEqual(result?.reason, "ATTACHED_MUTATION_NOT_GRANTED");
  assert.notEqual(result?.reason, "READ_ONLY_SESSION");
});

test("devloop.execute: attached policy without allowedOps fails closed", async () => {
  const result = await devloopExecute({
    opId: "project.new",
    args: {},
    runner: stubRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: approvedConsent,
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    sessionPolicy: { readOnly: false, mode: "attached" },
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "ATTACHED_MUTATION_NOT_GRANTED");
});

/* ------------------------------------------------------------------ */
/* open-time mutation scope validation (Issue #366)                    */
/* ------------------------------------------------------------------ */

test("openAttachedSliceSession: mutatingOps produces a scoped policy", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withBehavior("attached-ok", async () => {
      const s = await openAttachedSliceSession({
        aeA8nRoot: root, workdir, mutatingOps: ["project.new", "project.new"],
      });
      try {
        assert.deepEqual(s.policy, {
          readOnly: false,
          mode: "attached",
          mutation: { allowedOps: ["project.new"] },
        });
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("openAttachedSliceSession: unknown/read-only/forbidden mutatingOps refuse BEFORE launch", async () => {
  const cases = [
    { ops: ["no.such.op"], code: "ATTACHED_MUTATION_SCOPE" },
    { ops: ["read.projectSummary"], code: "ATTACHED_MUTATION_SCOPE" },
    { ops: ["project.close"], code: "ATTACHED_MUTATION_FORBIDDEN" },
    { ops: "project.new", code: "ATTACHED_MUTATION_SCOPE" },
  ];
  for (const { ops, code } of cases) {
    const root = launchFixtureRoot();
    const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
    try {
      await assert.rejects(
        openAttachedSliceSession({ aeA8nRoot: root, workdir, mutatingOps: ops }),
        (e) => e.code === code,
        `mutatingOps ${JSON.stringify(ops)} must refuse with ${code}`,
      );
      const { launchArgs } = await importFixture(root);
      assert.equal(launchArgs.length, 0, "a bad mutation scope must never reach AfterEffects.launch");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }
});
