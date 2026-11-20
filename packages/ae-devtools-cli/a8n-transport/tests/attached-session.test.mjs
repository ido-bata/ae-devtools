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
export const attachArgs = [];
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
const openImpl = async (options, sink) => {
    (sink?.args ?? launchArgs).push(options ?? {});
    const entry = { closed: 0 };
    (sink?.log ?? launchLog).push(entry);
    const b = behavior();
    const version = b === "version-mismatch" ? "99.9-fake" : "26.5-fake";
    return {
      info: () => ({ version, build: "9" }),
      ownership: () => ({
        kind: b === "owned" ? "owned" : "attached",
        evidence: "fixture-evidence",
      }),
      project: () => {
        if (process.env.AE_FIXTURE_PROJECT_FAIL === "1") {
          throw new Error("fixture: project unreadable");
        }
        return {
          info: async () => ({
            file: process.env.AE_FIXTURE_PROJECT_FILE ?? "/tmp/user-project.aep",
            name: process.env.AE_FIXTURE_PROJECT_NAME ?? "user-project",
            itemCount: 3,
          }),
        };
      },
      call: async () => { throw new Error("call not used in fixture tests"); },
      close: async () => { entry.closed += 1; },
      tracePath: "/tmp/fake-a8n-trace.jsonl",
    };
  };
export const AfterEffects = Object.assign(function AfterEffects() {}, {
  launch: (options) => openImpl(options, { args: launchArgs, log: launchLog }),
  // Attach-only API (ae-a8n >= 0.5.0 contract): present by default so
  // tests exercise the only supported opener; AE_FIXTURE_NO_ATTACH=1
  // removes it to cover the ATTACHED_TARGET_UNSUPPORTED refusal.
  // Records into attachArgs so tests can prove which opener ran.
  ...(process.env.AE_FIXTURE_NO_ATTACH !== "1"
    ? { attach: (options) => { attachArgs.push(options ?? {}); return openImpl(options, { args: launchArgs, log: launchLog }); } }
    : {}),
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

test("preflight: unattributed rows refuse UNVERIFIED, foreign-only rows NOT_RUNNING", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      // An AE process whose image path the OS would not disclose can
      // never be proven "not the target" — launching would risk a
      // duplicate instance, so attach refuses before any side effect.
      await assert.rejects(
        openAttachedSliceSession({
          aeA8nRoot: root, workdir,
          hostProcessProbe: async () => [{ pid: 1, path: null }],
        }),
        (e) => e.code === "ATTACHED_TARGET_UNVERIFIED",
      );
      // Fully attributed rows for a DIFFERENT install prove this
      // install has no running target.
      await assert.rejects(
        openAttachedSliceSession({
          aeA8nRoot: root, workdir,
          hostProcessProbe: async () => [
            { pid: 2, path: "/other/Adobe After Effects 2026.app/Contents/MacOS/After Effects" },
          ],
        }),
        (e) => e.code === "ATTACHED_TARGET_NOT_RUNNING",
      );
      // Only a failed/absent probe stays inconclusive and reaches
      // launch(), where ae-a8n's own census + ownership decide.
      const s = await openAttachedSliceSession({
        aeA8nRoot: root, workdir, hostProcessProbe: async () => null,
      });
      await s.close();
      const { launchArgs } = await importFixture(root);
      assert.equal(launchArgs.length, 1, "only an inconclusive probe reaches launch()");
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

/* ------------------------------------------------------------------ */
/* attach-only opener + target re-validation (Issues #366, #374)     */
/* ------------------------------------------------------------------ */

test("attach boundary: AfterEffects.attach is the only opener", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars({ ...FAKE_EXE_ENV }, async () => {
      const s = await openAttachedSliceSession({
        aeA8nRoot: root,
        workdir,
        hostProcessProbe: async () => [{ pid: 7, path: FAKE_EXE, startedAt: "start-1" }],
      });
      try {
        const { attachArgs } = await importFixture(root);
        assert.equal(attachArgs.length, 1, "attach-only API must be used when present");
        assert.equal(s.target.attachApi, "AfterEffects.attach");
        assert.equal(s.target.identity.pid, 7);
        assert.equal(s.target.identity.processStart, "start-1");
        assert.equal(s.target.identity.executable, FAKE_EXE);
        // The census-identified pid is forwarded as the attach target pin.
        assert.deepEqual(attachArgs[0].target, { pid: 7 });
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("attach boundary: ae-a8n without attach API refuses — no launch fallback", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars({ AE_FIXTURE_NO_ATTACH: "1" }, async () => {
      await assert.rejects(
        openAttachedSliceSession({ aeA8nRoot: root, workdir }),
        (e) => e.code === "ATTACHED_TARGET_UNSUPPORTED",
      );
      // The launch path must never run for the attached lane.
      const { launchArgs } = await importFixture(root);
      assert.equal(launchArgs.length, 0, "AfterEffects.launch must not be called");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

const STABLE_ROWS = [{ pid: 7, path: FAKE_EXE, startedAt: "start-1" }];

async function openWithProbe(root, workdir, probe, extra = {}) {
  return openAttachedSliceSession({
    aeA8nRoot: root,
    workdir,
    hostProcessProbe: probe,
    ...extra,
  });
}

test("revalidateTarget: stable census + project passes", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      const s = await openWithProbe(root, workdir, async () => STABLE_ROWS);
      try {
        const g = await s.revalidateTarget();
        assert.equal(g.ok, true);
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("revalidateTarget: pid change / second instance / unreadable census / project switch all refuse", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  const cases = [
    {
      name: "pid changed",
      probe: async () => [{ pid: 99, path: FAKE_EXE, startedAt: "start-1" }],
      code: "ATTACHED_TARGET_CHANGED",
    },
    {
      name: "pid reused (start stamp differs)",
      probe: async () => [{ pid: 7, path: FAKE_EXE, startedAt: "start-2" }],
      code: "ATTACHED_TARGET_CHANGED",
    },
    {
      name: "second instance of same install",
      probe: async () => [
        { pid: 7, path: FAKE_EXE, startedAt: "start-1" },
        { pid: 8, path: FAKE_EXE, startedAt: "start-0" },
      ],
      code: "ATTACHED_TARGET_AMBIGUOUS",
    },
    {
      name: "target gone",
      probe: async () => [{ pid: 8, path: "/other/AE.app/x", startedAt: "s" }],
      code: "ATTACHED_TARGET_NOT_RUNNING",
    },
    {
      name: "unreadable census",
      probe: async () => null,
      code: "ATTACHED_TARGET_UNVERIFIED",
    },
    {
      name: "unattributed row",
      probe: async () => [{ pid: 7, path: null, startedAt: null }],
      code: "ATTACHED_TARGET_UNVERIFIED",
    },
  ];
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      for (const c of cases) {
        // Probe is per-open; revalidation re-invokes the SAME probe, so
        // make it stateful: first call (pre-flight) stable, later calls
        // return the drifted census.
        let calls = 0;
        const stateful = async () => (++calls === 1 ? STABLE_ROWS : c.probe());
        const s = await openWithProbe(root, workdir, stateful);
        try {
          const g = await s.revalidateTarget();
          assert.equal(g.ok, false, `${c.name} must refuse`);
          assert.equal(g.code, c.code, `${c.name}: expected ${c.code}, got ${g.code}`);
        } finally {
          await s.close();
        }
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("revalidateTarget: project switch refuses; unattested identity refuses mutating guard", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(
      { ...FAKE_EXE_ENV, AE_FIXTURE_PROJECT_FILE: "/tmp/project-a.aep", AE_FIXTURE_PROJECT_NAME: "proj-a" },
      async () => {
        const s = await openWithProbe(root, workdir, async () => STABLE_ROWS);
        try {
          assert.equal((await s.revalidateTarget()).ok, true);
          // Switch the project the fixture reports → next revalidation refuses.
          process.env.AE_FIXTURE_PROJECT_FILE = "/tmp/project-b.aep";
          process.env.AE_FIXTURE_PROJECT_NAME = "proj-b";
          const g = await s.revalidateTarget();
          assert.equal(g.ok, false);
          assert.equal(g.code, "ATTACHED_TARGET_CHANGED");
        } finally {
          await s.close();
        }
      },
    );
    // No install exe → no census → unattested identity.
    await withBehavior("attached-ok", async () => {
      const s = await openAttachedSliceSession({ aeA8nRoot: root, workdir });
      try {
        const g = await s.revalidateTarget();
        assert.equal(g.ok, false);
        assert.equal(g.code, "ATTACHED_TARGET_UNVERIFIED");
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("runOperation targetGuard: mutating op refused before send when guard fails; reads unaffected", async () => {
  let sends = 0;
  const countingRunner = { runScript: async () => { sends += 1; return { outcome: "COMPLETED" }; } };
  const base = {
    runner: countingRunner,
    pin: { sessionId: "s", aeVersion: "26.5", dispatchId: "d" },
    projectIdentity: "test",
    consentProvider: approvedConsent,
    trustedScriptOptIn: true,
    scriptProvenance: "test",
    confirmDestructive: true,
  };
  const failingGuard = async () => ({ ok: false, code: "ATTACHED_TARGET_CHANGED", detail: "pid drifted" });
  const r1 = await devloopExecute({
    opId: "project.new", args: {}, ...base,
    sessionPolicy: { readOnly: false, mode: "attached", mutation: { allowedOps: ["project.new"] } },
    targetGuard: failingGuard,
  });
  assert.equal(r1.status, "refused");
  assert.equal(r1.reason, "ATTACHED_TARGET_GUARD");
  assert.equal(r1.guardCode, "ATTACHED_TARGET_CHANGED");
  assert.equal(sends, 0, "a refused guard must never reach the transport");

  // Throwing guard fails closed the same way.
  const r2 = await devloopExecute({
    opId: "project.new", args: {}, ...base,
    sessionPolicy: { readOnly: false, mode: "attached", mutation: { allowedOps: ["project.new"] } },
    targetGuard: async () => { throw new Error("census exploded"); },
  });
  assert.equal(r2.status, "refused");
  assert.equal(r2.reason, "ATTACHED_TARGET_GUARD");
  assert.equal(sends, 0);

  // Passing guard lets the dispatch through.
  const r3 = await devloopExecute({
    opId: "project.new", args: {}, ...base,
    sessionPolicy: { readOnly: false, mode: "attached", mutation: { allowedOps: ["project.new"] } },
    targetGuard: async () => ({ ok: true }),
  });
  assert.equal(sends, 1);
  assert.notEqual(r3?.reason, "ATTACHED_TARGET_GUARD");

  // Read ops never invoke the guard.
  let guardCalls = 0;
  await devloopExecute({
    opId: "read.projectSummary", args: {}, ...base,
    sessionPolicy: readOnlyPolicy,
    targetGuard: async () => { guardCalls += 1; return { ok: false, code: "X", detail: "no" }; },
  });
  assert.equal(guardCalls, 0, "read ops must not pay the re-validation cost");
});

test("revalidateTarget: missing baseline process start stamp refuses mutation (Issue #382)", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      // Census rows without startedAt → identity.processStart stays
      // null; pid reuse can then never be ruled out, so the guard must
      // refuse mutation instead of skipping the stamp comparison.
      const s = await openWithProbe(root, workdir, async () => [{ pid: 7, path: FAKE_EXE }]);
      try {
        assert.equal(s.target.identity.processStart, null);
        const g = await s.revalidateTarget();
        assert.equal(g.ok, false);
        assert.equal(g.code, "ATTACHED_TARGET_UNVERIFIED");
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("revalidateTarget: project unreadable at re-validation refuses mutation (Issue #382)", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      const s = await openWithProbe(root, workdir, async () => STABLE_ROWS);
      try {
        assert.equal((await s.revalidateTarget()).ok, true);
        // Project becomes unreadable AFTER open — a switch can no
        // longer be ruled out, so writes must refuse even though the
        // baseline had a readable project. withEnvVars restores the
        // flag afterwards — a leaked "1" would poison later tests.
        await withEnvVars({ AE_FIXTURE_PROJECT_FAIL: "1" }, async () => {
          const g = await s.revalidateTarget();
          assert.equal(g.ok, false);
          assert.equal(g.code, "ATTACHED_TARGET_UNVERIFIED");
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

test("revalidateTarget: second instance appearing during project RPCs is caught (Issue #382)", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  try {
    await withEnvVars(FAKE_EXE_ENV, async () => {
      // Probe call order: 1 = open pre-flight, 2 = first census inside
      // revalidateTarget, 3 = post-RPC census. The second instance
      // appears only for the post-RPC read — approval must refuse.
      let calls = 0;
      const lateJoiner = async () => {
        calls += 1;
        if (calls <= 2) return STABLE_ROWS;
        return [
          { pid: 7, path: FAKE_EXE, startedAt: "start-1" },
          { pid: 8, path: FAKE_EXE, startedAt: "start-0" },
        ];
      };
      const s = await openWithProbe(root, workdir, lateJoiner);
      try {
        const g = await s.revalidateTarget();
        assert.equal(g.ok, false);
        assert.equal(g.code, "ATTACHED_TARGET_AMBIGUOUS");
      } finally {
        await s.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("projectFile pin: case-variant spelling of the same file still matches (Issue #382)", async () => {
  const root = launchFixtureRoot();
  const workdir = mkdtempSync(join(tmpdir(), "a8n-att-wd-"));
  const projDir = mkdtempSync(join(tmpdir(), "a8n-att-proj-"));
  try {
    // A real file so stat identity (dev+ino) decides equality: a
    // case-variant spelling of the SAME file is an alias, not a
    // different project.
    const realPath = join(projDir, "CaseProbe.aep");
    writeFileSync(realPath, "fixture");
    const caseVariant = join(projDir, "caseprobe.aep");
    // On a case-insensitive volume the variant stats to the same inode
    // → alias, pin matches. On a case-sensitive volume it is a
    // different (nonexistent) path → the pin must refuse, never fold.
    let sameFile = false;
    try {
      const { statSync } = await import("node:fs");
      const a = statSync(realPath), b = statSync(caseVariant);
      sameFile = a.dev === b.dev && a.ino === b.ino;
    } catch { sameFile = false; }
    await withEnvVars(
      { ...FAKE_EXE_ENV, AE_FIXTURE_PROJECT_FILE: realPath },
      async () => {
        if (sameFile) {
          const s = await openAttachedSliceSession({
            aeA8nRoot: root,
            workdir,
            projectFile: caseVariant,
            hostProcessProbe: async () => [{ pid: 7, path: FAKE_EXE }],
          });
          try {
            assert.equal(s.target.projectFile, caseVariant);
          } finally {
            await s.close();
          }
        } else {
          await assert.rejects(
            openAttachedSliceSession({
              aeA8nRoot: root,
              workdir,
              projectFile: caseVariant,
              hostProcessProbe: async () => [{ pid: 7, path: FAKE_EXE }],
            }),
            (e) => e.code === "ATTACHED_TARGET_MISMATCH",
          );
        }
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  }
});
