#!/usr/bin/env node
/**
 * real-run.mjs — Issue #177 minimal REAL-AE conformance run.
 *
 *   node packages/ae-devtools-cli/conformance/real-run.mjs \
 *     --install-dir "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app" \
 *     --workdir <dir> --out <evidence.json>
 *
 * ONE owned AE session (registry @ido-bata/ae-a8n — never --ae-a8n-root)
 * drives every lane so the disposable-project guarantee covers all of
 * them:
 *
 *   0. provenance   — sourceSha, ae-a8n source/version, AE install,
 *                     generated host script copied out before close
 *   1. identity     — eval read of app.version / project.file /
 *                     numItems / project.dirty BEFORE any mutation;
 *                     dirty===true aborts (never discard user changes)
 *   2. disposable   — project.new → project.save(<workdir>/fixture.aep)
 *                     → identity re-read must show file==fixture and
 *                     numItems==0, otherwise the run fails closed
 *   3. cli-path     — registry ops via dev-loop runOperation (the same
 *                     dispatch path devtools-cli execute uses):
 *                     read.projectSummary → item.addComp →
 *                     read.projectSummary (read-back) → ae.undo →
 *                     read.projectSummary → item.addComp#2 →
 *                     item.remove → read.projectSummary
 *   4. jsx lane     — jsx-toolchain buildFile(ok.ts) dispatch +
 *                     $.global read-back; runtime-error.ts dispatch →
 *                     FAILED → sourcemap → TS source line
 *   5. a8n slice    — runVerticalSlice + assertSliceOutcomes (the
 *                     Issue #49 read-only consent/transport scenario)
 *   6. timeout      — $.sleep dispatch under a short-deadline runner
 *                     must classify UNKNOWN and never resend
 *   7. close        — session.close({unsavedChanges:"refuse"}) must
 *                     quit:true; the project is provably back at its
 *                     saved state, so a refusal is a FAILED run, not
 *                     a pass. Main-AE process must be gone afterwards.
 *
 * Consent is a LOCAL POLICY (approve-all for this harness), identical
 * in strength to a8n-transport/scenario.mjs — it exercises gate
 * mechanics, not authenticated authorization (ae-a8n #97–#99).
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openRealRunSession } from "../dev-loop/real-run-session.mjs";
import { runVerticalSlice, assertSliceOutcomes } from "../a8n-transport/scenario.mjs";
import { createJsxRunner } from "../trusted-execution/runner.mjs";
import { runOperation } from "../scripting-adapters/execute.mjs";
import { buildFile } from "../jsx-toolchain/src/build.mjs";
import { lookup } from "../jsx-toolchain/src/sourcemap.mjs";
import { arg } from "../devtools-cli/argv.mjs";
import { isMainEntry } from "../devtools-cli/is-main-entry.mjs";
import {
  MAIN_EXE,
  aeProcessSnapshot,
  createEvalDispatch,
  gitHeadAndDirty,
} from "../devtools-cli/real-run-kit.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURES = join(HERE, "..", "jsx-toolchain", "fixtures");

const EVAL_OP = "op.a8n-transport.eval";
const PROJECT_IDENTITY_PRE = "conformance-pre-disposable";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function main() {
  const installDir = arg("--install-dir");
  const out = arg("--out") ?? join(process.cwd(), `conformance-run-${Date.now()}.json`);
  const workdir = arg("--workdir") ?? mkdtempSync(join(tmpdir(), "ae-conformance-"));
  const fixturePath = join(workdir, "Conformance-Disposable.aep");
  const hostScriptCopy = join(workdir, "a8n-host-ext.js");
  const processFragment = installDir ?? "Adobe After Effects";
  const startedAt = new Date().toISOString();

  const evidence = {
    schema: "ae-devtools.conformance-run/v1",
    issue: 177,
    startedAt,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    installDir: installDir ?? null,
    workdir,
    fixturePath,
    git: await gitHeadAndDirty(HERE),
    consentModel: "local approve-all policy (gate mechanics only; not authenticated authorization)",
    aeProcessesBeforeLaunch: await aeProcessSnapshot(processFragment),
    steps: [],
    ok: true,
  };
  const step = (name, data = {}) => {
    evidence.steps.push({ name, at: new Date().toISOString(), ...data });
    console.log(`${data.ok === false ? "FAIL" : "ok"} ${name}`);
    if (data.ok === false) evidence.ok = false;
  };

  let session = null;
  let guard = null;
  const opResults = {};
  const evalResults = {};
  try {
    // Canonical session open + run-guard marker (Issue #252): a killed
    // driver leaves an attested, reap/recover-visible residue record.
    // The raw slice handle stays available as `session` for internals.
    const opened = await openRealRunSession({
      surface: "conformance-real-run",
      argv: process.argv.slice(2),
      sessionOptions: {
        ...(installDir !== undefined ? { installDir } : {}),
        workdir: join(workdir, "session"),
      },
    });
    guard = opened.guard;
    session = opened.slice;
    step("session.launch", {
      ok: true,
      aeVersion: session.info?.version ?? null,
      aeBuild: session.info?.build ?? null,
      ownership: session.ownership?.kind ?? null,
      aeA8nSource: session.aeA8nSource,
      aeA8nHead: session.aeA8nHead,
    });
    // Keep the generated host script + trace: session.close() deletes
    // the session workdir, so copy them out first.
    const wsHostScript = join(workdir, "session", "a8n-host-ext.js");
    if (existsSync(wsHostScript)) {
      copyFileSync(wsHostScript, hostScriptCopy);
      evidence.hostScriptSha256 = sha256File(hostScriptCopy);
      evidence.hostScriptCopy = hostScriptCopy;
    }

    // ---- eval dispatch helper (consent scope bound to exact source) ----
    // Shared wrapper (Issue #197): the consent scope and the runScript
    // args shape are hashed together inside runner.mjs, so one builder
    // keeps them from drifting. projectIdentity is read lazily — it is
    // re-bound after project.new/project.save below.
    let projectIdentity = PROJECT_IDENTITY_PRE;
    const evalDispatchRaw = createEvalDispatch({
      runner: session.runner,
      pin: session.pin,
      projectIdentity: () => projectIdentity,
      operationId: EVAL_OP,
      scriptProvenance: "conformance-run",
    });
    const evalDispatch = async (label, source) => {
      const r = await evalDispatchRaw(source, `conf-eval-${label}-${Date.now().toString(36)}`);
      evalResults[label] = r;
      return r;
    };

    // ---- op dispatch helper (dev-loop runOperation = CLI path) ----
    const opSeq = { n: 0 };
    const op = async (opId, args = {}, extra = {}) => {
      const label = `${opId}#${++opSeq.n}`;
      const r = await runOperation({
        opId,
        args,
        runner: session.runner,
        pin: session.pin,
        projectIdentity,
        consentProvider: async () => ({ approved: true }),
        trustedScriptOptIn: true,
        scriptProvenance: "conformance-run",
        requestId: `conf-op-${label}-${Date.now().toString(36)}`,
        ...extra,
      });
      opResults[label] = r;
      return r;
    };

    const IDENTITY_SOURCE =
      "(function(){var f=app.project.file;var d=(typeof app.project.dirty===\"boolean\")?String(app.project.dirty):\"unsupported\";" +
      // The file path is percent-encoded: a raw fsName may itself
      // contain "|" or look like a "V:/N:/D:" field, which would make
      // the delimiter parse ambiguous. encodeURIComponent output can
      // never contain the "|" separator.
      "return \"V:\"+String(app.version)+\"|F:\"+(f?encodeURIComponent(f.fsName):\"\")+\"|N:\"+String(app.project.numItems)+\"|D:\"+d;})()";
    const parseIdentity = (result) => {
      const s = typeof result === "string" ? result : "";
      const get = (k) => {
        const m = s.match(new RegExp(`${k}:([^|]*)`));
        return m ? m[1] : null;
      };
      const rawFile = get("F");
      let file = null;
      if (rawFile !== null) {
        try { file = rawFile === "" ? "" : decodeURIComponent(rawFile); }
        catch { file = null; } // undecodable path -> fail closed downstream
      }
      return { version: get("V"), file, items: get("N"), dirty: get("D"), raw: s };
    };

    // ---- 1. project identity BEFORE any mutation ----
    const id1 = await evalDispatch("identity.before", IDENTITY_SOURCE);
    const before = parseIdentity(id1.result);
    // The disposable gate below is only as safe as this read: when the
    // identity probe did not COMPLETE, before.* fields are null and the
    // gate cannot prove the restored project is untouched — proceeding
    // to project.new could destroy user state. Fail closed instead.
    const identityReadOk = id1.outcome === "COMPLETED" && before.file !== null;
    step("identity.before", {
      ok: identityReadOk,
      outcome: id1.outcome,
      project: before,
    });
    evidence.projectBefore = before;
    if (!identityReadOk) {
      throw new Error(
        `project identity read did not complete (outcome=${id1.outcome}); refusing to proceed toward mutation`,
      );
    }

    // ---- 2. disposable project gate ----
    // app.newProject() prompts to save when the current project was
    // edited (Adobe Scripting Guide). dirty===true means the restored
    // project carries unsaved state — abort rather than risk a modal or
    // a discard. dirty unsupported is tolerated ONLY for an untouched
    // untitled empty project (file=="" && items=="0"): nothing user-owned
    // can be lost there.
    const disposableDecision =
      before.dirty === "true"
        ? { proceed: false, reason: "restored project reports unsaved changes (dirty=true); refusing to touch it" }
        : before.dirty === "unsupported" && !(before.file === "" && before.items === "0")
          ? { proceed: false, reason: "project.dirty unsupported and project is not an empty untitled project; cannot prove safe" }
          : { proceed: true, reason: `dirty=${before.dirty}, file='${before.file}', items=${before.items}` };
    step("disposable.gate", { ok: disposableDecision.proceed, decision: disposableDecision });
    evidence.disposableDecision = disposableDecision;
    if (!disposableDecision.proceed) {
      throw new Error(`disposable gate refused: ${disposableDecision.reason}`);
    }

    // The dirty/file/items read above and the app.newProject() mutation
    // below are separate dispatches — project state could in principle
    // change in between. True atomicity is impossible without a
    // host-side precondition inside the op itself, so re-read identity
    // immediately before mutating and require it UNCHANGED; any drift
    // aborts fail-closed. (Owned session: no user input can intervene,
    // this guards harness/AE-side state transitions only.)
    const idRecheck = await evalDispatch("identity.recheck", IDENTITY_SOURCE);
    const recheck = parseIdentity(idRecheck.result);
    const unchanged =
      idRecheck.outcome === "COMPLETED" &&
      recheck.file === before.file &&
      recheck.items === before.items &&
      recheck.dirty === before.dirty;
    step("identity.recheck", {
      ok: unchanged,
      outcome: idRecheck.outcome,
      project: recheck,
    });
    evidence.projectRecheck = recheck;
    if (!unchanged) {
      throw new Error(
        `project identity changed between gate and mutation (before file='${before.file}' items=${before.items} dirty=${before.dirty}; recheck file='${recheck.file}' items=${recheck.items} dirty=${recheck.dirty}); refusing to mutate`,
      );
    }

    const rNew = await op("project.new", {}, { confirmDestructive: true });
    step("op.project.new", {
      ok: rNew.outcome === "COMPLETED",
      outcome: rNew.outcome,
      status: rNew.status ?? null,
      result: rNew.result ?? null,
    });
    if (rNew.outcome !== "COMPLETED") {
      throw new Error(`project.new did not complete: ${JSON.stringify(rNew).slice(0, 400)}`);
    }

    const rSave = await op("project.save", { path: fixturePath });
    step("op.project.save", {
      ok: rSave.outcome === "COMPLETED",
      outcome: rSave.outcome,
      result: rSave.result ?? null,
      fixturePath,
    });
    if (rSave.outcome !== "COMPLETED") {
      throw new Error(`project.save did not complete: ${JSON.stringify(rSave).slice(0, 400)}`);
    }

    projectIdentity = `conformance-fixture:${fixturePath}`;
    const id2 = await evalDispatch("identity.fixture", IDENTITY_SOURCE);
    const fixtureIdent = parseIdentity(id2.result);
    const disposableOk =
      id2.outcome === "COMPLETED" &&
      fixtureIdent.file === fixturePath &&
      fixtureIdent.items === "0";
    step("identity.fixture", {
      ok: disposableOk,
      outcome: id2.outcome,
      project: fixtureIdent,
      expectedFile: fixturePath,
    });
    evidence.projectFixture = fixtureIdent;
    if (!disposableOk) {
      throw new Error(
        `disposable project not confirmed: file='${fixtureIdent.file}' items=${fixtureIdent.items} (expected '${fixturePath}' / 0)`,
      );
    }
    evidence.fixtureSha256 = existsSync(fixturePath) ? sha256File(fixturePath) : null;

    // ---- 3. cli-path registry ops (dev-loop runOperation) ----
    const baseline = await op("read.projectSummary");
    step("op.read.projectSummary.baseline", {
      ok: baseline.outcome === "COMPLETED",
      outcome: baseline.outcome,
      result: baseline.result ?? null,
    });

    const add1 = await op("item.addComp", {
      name: "Conformance QA Comp",
      width: 320, height: 240, pixelAspect: 1, duration: 5, frameRate: 30,
    });
    step("op.item.addComp", {
      ok: add1.outcome === "COMPLETED",
      outcome: add1.outcome,
      result: add1.result ?? null,
    });

    const verify1 = await op("read.projectSummary");
    const verify1Items = verify1.result?.items ?? null;
    const sawComp = Array.isArray(verify1Items) &&
      verify1Items.some((i) => i && i.name === "Conformance QA Comp");
    step("op.read.projectSummary.readback", {
      ok: verify1.outcome === "COMPLETED" && sawComp === true,
      outcome: verify1.outcome,
      sawComp,
      items: verify1Items,
    });

    // undo dimension: Edit > Undo must remove exactly the comp we added.
    let undoOutcome = null;
    try {
      const u = await session.ae.undo();
      undoOutcome = { ok: true, result: u ?? null };
    } catch (error) {
      undoOutcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const afterUndo = await op("read.projectSummary");
    const undoClean =
      afterUndo.outcome === "COMPLETED" &&
      Array.isArray(afterUndo.result?.items) &&
      afterUndo.result.items.length === 0;
    step("ae.undo", {
      ok: undoOutcome.ok === true && undoClean,
      undo: undoOutcome,
      outcome: afterUndo.outcome,
      itemsAfter: afterUndo.result?.items ?? null,
    });
    evidence.undo = { call: undoOutcome, readbackEmpty: undoClean };

    // item.remove claim: second comp added then removed by name+type.
    const add2 = await op("item.addComp", {
      name: "Conformance Temp Comp",
      width: 64, height: 64, pixelAspect: 1, duration: 1, frameRate: 30,
    });
    step("op.item.addComp.second", {
      ok: add2.outcome === "COMPLETED",
      outcome: add2.outcome,
      result: add2.result ?? null,
    });
    const rem = await op("item.remove", { name: "Conformance Temp Comp", type: "CompItem" }, { confirmDestructive: true });
    step("op.item.remove", {
      ok: rem.outcome === "COMPLETED",
      outcome: rem.outcome,
      result: rem.result ?? null,
    });
    const finalSummary = await op("read.projectSummary");
    const finalClean =
      finalSummary.outcome === "COMPLETED" &&
      Array.isArray(finalSummary.result?.items) &&
      finalSummary.result.items.length === 0;
    step("op.read.projectSummary.final", {
      ok: finalClean,
      outcome: finalSummary.outcome,
      items: finalSummary.result?.items ?? null,
    });
    // Content is back at the saved state but AE's dirty flag stays set
    // once the project was edited — re-save so close({unsavedChanges:
    // "refuse"}) can quit. The fixture is disposable, so this is safe.
    const rResave = await op("project.save", { path: fixturePath });
    step("op.project.save.resave", {
      ok: rResave.outcome === "COMPLETED",
      outcome: rResave.outcome,
      result: rResave.result ?? null,
    });
    evidence.projectOps = {
      baseline: baseline.result ?? null,
      addComp: add1.result ?? null,
      readbackSawComp: sawComp,
      undo: evidence.undo,
      addComp2: add2.result ?? null,
      remove: rem.result ?? null,
      finalItems: finalSummary.result?.items ?? null,
    };

    // ---- 4. jsx toolchain lane ----
    const okBuild = buildFile(join(FIXTURES, "ok.ts"));
    step("jsx.build.ok", { ok: okBuild.status === "ok", status: okBuild.status });
    if (okBuild.status === "ok") {
      // Same consent-bound eval dispatch as the identity probes above —
      // the shared wrapper (Issue #197) replaced the hand-built copy.
      const jsxDispatch = evalDispatchRaw;
      const j1 = await jsxDispatch(okBuild.output, `conf-jsx-ok-${Date.now().toString(36)}`);
      step("jsx.dispatch.ok", { ok: j1.outcome === "COMPLETED", outcome: j1.outcome });
      const j2 = await jsxDispatch('"" + $.global.__toolchainProbe', `conf-jsx-read-${Date.now().toString(36)}`);
      step("jsx.verify.global-write", {
        ok: j2.outcome === "COMPLETED" && typeof j2.result === "string" && j2.result.includes("hello ae"),
        observed: j2.result ?? null,
        outcome: j2.outcome,
      });

      const badBuild = buildFile(join(FIXTURES, "runtime-error.ts"));
      step("jsx.build.runtime-error", { ok: badBuild.status === "ok", status: badBuild.status });
      if (badBuild.status === "ok") {
        const j3 = await jsxDispatch(badBuild.output, `conf-jsx-bad-${Date.now().toString(36)}`);
        const hostLine = j3.error?.line ?? null;
        const mapped = hostLine != null ? lookup(badBuild.map, hostLine, 1e9) : null;
        step("jsx.dispatch.runtime-error", {
          ok: j3.outcome === "FAILED",
          outcome: j3.outcome,
          hostError: j3.error?.message ?? null,
          hostErrorName: j3.error?.name ?? null,
          hostLine,
        });
        step("jsx.sourcemap.to-source", {
          ok: mapped != null && mapped.line === 3 && /runtime-error\.ts$/.test(mapped.source ?? ""),
          mapped,
        });
        evidence.jsx = {
          okBuild: { status: okBuild.status, jsxBytes: okBuild.output?.length ?? 0 },
          dispatchOk: j1.outcome,
          globalWrite: j2.result ?? null,
          runtimeError: {
            outcome: j3.outcome,
            hostErrorName: j3.error?.name ?? null,
            hostLine,
            mapped,
          },
        };
      }
    }

    // ---- 5. a8n transport slice (Issue #49 scenario) ----
    const { steps: sliceSteps } = await runVerticalSlice({
      runner: session.runner,
      pin: session.pin,
      sendCount: session.transport.sendCount,
    });
    evidence.sliceSteps = sliceSteps;
    evidence.sliceViolations = assertSliceOutcomes(sliceSteps);
    step("a8n.slice", {
      ok: Array.isArray(evidence.sliceViolations) && evidence.sliceViolations.length === 0,
      violations: evidence.sliceViolations,
      outcomes: sliceSteps.map((s) => `${s.label}:${s.outcome}`),
    });

    // ---- 6. timeout dimension: deadline must yield UNKNOWN, no resend ----
    const shortRunner = createJsxRunner({ transport: session.transport, deadlineMs: 800 });
    const timeoutDispatch = createEvalDispatch({
      runner: shortRunner,
      pin: session.pin,
      projectIdentity: () => projectIdentity,
      operationId: EVAL_OP,
      scriptProvenance: "conformance-run",
    });
    const t0 = Date.now();
    const timeoutRequestId = `conf-timeout-${Date.now().toString(36)}`;
    const timeoutResult = await timeoutDispatch('$.sleep(2000); "slept"', timeoutRequestId);
    evidence.timeoutProbe = {
      outcome: timeoutResult.outcome,
      contractOutcome: timeoutResult.contractOutcome ?? null,
      retry: timeoutResult.retry ?? null,
      elapsedMs: Date.now() - t0,
      quarantined: shortRunner.isQuarantined(timeoutRequestId),
    };
    step("timeout.probe", {
      ok: timeoutResult.outcome === "UNKNOWN",
      ...evidence.timeoutProbe,
    });
    // Let the sleeping host script finish before close.
    await new Promise((r) => setTimeout(r, 2500));

    evidence.transportSends = session.transport.sendCount();
    evidence.opResultSummary = Object.fromEntries(
      Object.entries(opResults).map(([k, v]) => [k, v.outcome ?? v.status ?? null]),
    );
    evidence.evidenceLevel = "verified on real host";
  } catch (error) {
    evidence.fatal = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
    step("fatal", { ok: false, message: evidence.fatal.message });
    evidence.ok = false;
  } finally {
    if (session) {
      // Preserve the ae-a8n trace before close() removes the workdir.
      try {
        if (typeof session.tracePath === "string" && existsSync(session.tracePath)) {
          const traceCopy = join(workdir, "trace.jsonl");
          copyFileSync(session.tracePath, traceCopy);
          evidence.traceCopy = traceCopy;
          evidence.traceSha256 = sha256File(traceCopy);
        }
      } catch { /* trace preservation is best-effort */ }
      try {
        await session.close();
        evidence.close = { quit: true };
        step("session.close", { ok: true });
      } catch (error) {
        evidence.close = {
          quit: false,
          error: error instanceof Error ? error.message : String(error),
        };
        step("session.close", { ok: false, message: evidence.close.error });
        evidence.ok = false;
      }
      // Settle the run marker with the CLI contract: "closed" removes
      // it, "close-failed" keeps it as residue (Issue #252).
      if (guard !== null) {
        guard.end(evidence.close.quit === true ? "closed" : "close-failed");
      }
      const after = await aeProcessSnapshot(processFragment);
      evidence.aeProcessesAfterClose = after;
      // aeProcessSnapshot returns {error} when `ps` itself fails — that
      // is NOT proof of shutdown. An unverifiable snapshot must fail
      // the run closed, never silently pass the quarantine check.
      if (!Array.isArray(after)) {
        evidence.sessionQuarantined = true;
        evidence.quarantineReason = `AE process snapshot failed (${after?.error ?? "unknown"}); cannot prove session shutdown`;
        evidence.ok = false;
      } else {
        const mainLeft = after.filter((p) => MAIN_EXE.test(p.args ?? ""));
        if (mainLeft.length > 0) {
          evidence.sessionQuarantined = true;
          evidence.quarantineReason = `main AE process(es) survived close(): ${mainLeft.map((p) => p.pid).join(", ")}`;
          evidence.ok = false;
        }
      }
    }
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(`evidence written: ${out}`);
  }
  if (evidence.ok === false) process.exitCode = 1;
}

if (isMainEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(`conformance real-run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
