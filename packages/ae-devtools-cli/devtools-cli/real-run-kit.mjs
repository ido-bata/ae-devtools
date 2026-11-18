/**
 * real-run-kit.mjs — shared helpers for the opt-in REAL-AE run drivers
 * (Issue #197).
 *
 * These drivers (a8n-transport/real-run, jsx-toolchain/real-run,
 * conformance/real-run, mcp-server/real-run, conformance/mcp-real-run)
 * each re-implemented the same small pieces; drift between copies is
 * how evidence semantics silently diverge. Everything here is
 * behavior-preserving extraction — the drivers still require a real,
 * owned AE session; nothing in this module fakes host evidence.
 *
 *   aeProcessSnapshot / MAIN_EXE / ADOBE_HELPER — `ps` snapshot used by
 *     the post-close leak checks (main exe vs known Adobe helpers).
 *   gitHead / gitHeadAndDirty — provenance probes (also used by
 *     a8n-transport/session.mjs for --ae-a8n-root checkouts).
 *   createEvalDispatch — the eval-dispatch consent wrapper. The consent
 *     scope and the runner.runScript args shape are hashed together
 *     inside trusted-execution/runner.mjs; rebuilding them by hand at
 *     each call site is how they drift. The wrapper binds
 *     {source, dispatchArgs} into BOTH the scope and the dispatch so
 *     they can never disagree.
 *   spawnMcpStdio / withTimeout — NDJSON MCP stdio client harness shared
 *     by the two MCP real-run drivers.
 *
 * trusted-execution/permissions.mjs is imported LAZILY inside
 * createEvalDispatch: jsx-toolchain/real-run.mjs guards on the
 * existence of the trusted-execution tree before importing drivers, and
 * a static import here would break that guard on branches without it.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The main AE executable — helpers (crashpad_handler, CEPHtmlEngine,
 *  dynamiclinkmanager, TeamProjectsLocalHub) legitimately outlive it. */
export const MAIN_EXE = /Contents\/MacOS\/After Effects(\s|$)/;
/** Known Adobe helper executables — used to classify
 *  aeHelpersAfterClose. Anything else matching the install fragment
 *  (e.g. this node's own harness) is NOT an Adobe helper. */
export const ADOBE_HELPER = /crashpad_handler|CEPHtmlEngine|dynamiclinkmanager|TeamProjectsLocalHub|AdobeCrashReport/i;

/**
 * Snapshot `ps` rows whose command line mentions the AE install. With no
 * --install-dir the fragment is the generic bundle directory name, which
 * matches every installed AE version — the evidence records all of them so
 * a leftover is never hidden by an over-narrow filter.
 */
export async function aeProcessSnapshot(fragment) {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,args="], { timeout: 10_000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes(fragment))
      .map((line) => {
        const m = /^(\d+)\s+(.*)$/.exec(line);
        return m ? { pid: Number(m[1]), args: m[2] } : { pid: null, args: line };
      });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** git HEAD of a local checkout, or null when unavailable. */
export async function gitHead(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** git HEAD + dirty flag of a local checkout; both null on failure. */
export async function gitHeadAndDirty(root) {
  try {
    const { stdout: head } = await execFileAsync(
      "git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 });
    const { stdout: dirty } = await execFileAsync(
      "git", ["-C", root, "status", "--porcelain"], { timeout: 5_000 });
    return { head: head.trim() || null, dirty: dirty.trim().length > 0 };
  } catch {
    return { head: null, dirty: null };
  }
}

let consentScopeForPromise = null;
function loadConsentScopeFor() {
  consentScopeForPromise ??= import("../trusted-execution/permissions.mjs")
    .then((m) => m.consentScopeFor);
  return consentScopeForPromise;
}

/**
 * Build the eval-dispatch function the real-run drivers share.
 *
 * @param {object} input
 *   runner            — trusted-execution runner (session.runner or a
 *                       deadline-bounded variant)
 *   pin               — session pin {sessionId, aeVersion?, dispatchId?}
 *   projectIdentity   — string, or () => string when the identity changes
 *                       mid-run (conformance re-binds it after
 *                       project.new/project.save)
 *   operationId       — catalog operation id (default the eval op)
 *   scriptProvenance  — provenance declaration for trusted-dev-script
 * @returns {(source: string, requestId: string, dispatchArgs?: *) => Promise<object>}
 */
export function createEvalDispatch({ runner, pin, projectIdentity, operationId = "op.a8n-transport.eval", scriptProvenance }) {
  const identity = typeof projectIdentity === "function" ? projectIdentity : () => projectIdentity;
  return async (source, requestId, dispatchArgs = null) => {
    const pi = identity();
    const consentScopeFor = await loadConsentScopeFor();
    const scope = consentScopeFor({
      pin,
      operationId,
      args: { source, dispatchArgs },
      projectIdentity: pi,
    });
    return runner.runScript({
      source,
      pin,
      operationId,
      args: dispatchArgs,
      projectIdentity: pi,
      consent: { scope },
      trustedScriptOptIn: true,
      scriptProvenance,
      requestId,
    });
  };
}

/**
 * Spawn an NDJSON JSON-RPC stdio server (mcp-server/server.mjs) and
 * return { child, send, notify, call }. Every inbound frame is reported
 * through onRecord as { rx: msg } (parsed) or { rxRaw: line } (unparsed)
 * so drivers keep their own evidence log format. stderr chunks go to
 * onStderr as raw strings (drivers choose the slice length).
 */
export function spawnMcpStdio({ scriptArgs, cwd, onRecord, onStderr }) {
  const child = spawn(process.execPath, scriptArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (onStderr) child.stderr.on("data", (d) => onStderr(String(d)));
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        onRecord?.({ rx: msg });
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id).res(msg);
          pending.delete(msg.id);
        }
      } catch {
        onRecord?.({ rxRaw: line.slice(0, 300) });
      }
    }
  });
  // Reject every in-flight request when the child dies — otherwise send()
  // promises hang until the caller's withTimeout fires (Issue #219).
  const failPending = () => {
    const err = new Error("mcp stdio child exited with requests in flight");
    for (const { rej } of pending.values()) rej(err);
    pending.clear();
  };
  child.on("exit", failPending);
  child.on("error", failPending);
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const call = (name, args) => send("tools/call", { name, arguments: args });
  return { child, send, notify, call };
}

/** Race a promise against a timeout; rejects with "TIMEOUT <tag>". */
export function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + tag)), ms)),
  ]);
}
