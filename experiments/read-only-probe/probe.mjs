#!/usr/bin/env node
/**
 * read-only-probe client — ae-devtools #13 (CAP021–CAP024).
 *
 * Experiment client for the transport-agnostic read-only probe contract
 * (see README.md / outcome-model.md / snapshot-schema.md). This file is a
 * MEASUREMENT HARNESS: the file-envelope channel it drives is how this
 * experiment reaches a real AE today, not a transport decision
 * (ADR-0005 Open Q1).
 *
 * Commands:
 *   prepare   <channel>                        create private channel + probe-start.jsx
 *   identify  <channel> [timeoutMs] [--expect-ae <ver>] [ --pin-session]
 *   ping      <channel> [timeoutMs] [--expect-ae <ver>]
 *   snapshot  <channel> [timeoutMs]
 *   sysinfo   <channel> [timeoutMs]
 *   diagnose  <channel> [timeoutMs]
 *
 * Hard rules enforced here (CAP023):
 *   - one request in flight at a time; a second concurrent request is BLOCKED
 *     client-side and nothing is written
 *   - NO automatic retry on timeout: deadline → UNKNOWN { outcome }, exit
 *   - request ids are never reused (burned in <channel>/ids.json)
 *   - targets are pinned in <channel>/target.json after the first
 *     successful identify; a reply from a different sessionId is REFUSED
 *     WRONG_TARGET, never silently accepted (mis-delivery guard)
 *   - every command appends a JSONL trace line to <channel>/trace.jsonl
 *
 * Node >= 22, zero dependencies.
 */
import { randomBytes } from "node:crypto";
import {
  lstat, mkdir, open, readFile, rename, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_TIMEOUT = 30_000;
const MIN_TIMEOUT = 100;
const POLL_INTERVAL_MS = 50;
const METHODS = {
  identify: "probe.identify",
  ping: "probe.echo",
  snapshot: "probe.snapshot",
  sysinfo: "probe.sysinfo",
};

function fail(message) {
  process.stderr.write(`read-only-probe: ${message}\n`);
  process.exitCode = 1;
}

function hex(n) {
  return randomBytes(n).toString("hex");
}

function stringLiteral(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function nowIso() {
  return new Date().toISOString();
}

function channelPaths(channel) {
  return {
    root: channel,
    inbox: join(channel, "inbox"),
    outbox: join(channel, "outbox"),
    probeJson: join(channel, "probe.json"),
    idsFile: join(channel, "ids.json"),
    traceFile: join(channel, "trace.jsonl"),
    targetFile: join(channel, "target.json"),
    startScript: join(channel, "probe-start.jsx"),
  };
}

/** Environment checks that are provable without AE's help (CAP023 BLOCKED). */
async function checkChannelPreconditions(channel, { mustBePrepared = true } = {}) {
  const root = resolve(channel);
  if (!isAbsolute(channel) && !channel.startsWith("/") || !isAbsolute(root)) {
    return { ok: false, code: "CHANNEL_NOT_ABSOLUTE", message: "channel must be an absolute path" };
  }
  let stat;
  try {
    stat = await lstat(root);
  } catch {
    return { ok: false, code: "CHANNEL_NOT_PREPARED", message: `channel ${root} does not exist; run prepare first` };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, code: "CHANNEL_NOT_PREPARED", message: "channel must be a real private directory" };
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    return {
      ok: false,
      code: "CHANNEL_NOT_PRIVATE",
      message: "channel is accessible to group/other; use chmod 700",
    };
  }
  if (mustBePrepared) {
    try {
      await lstat(join(root, "probe.json"));
    } catch {
      return { ok: false, code: "CHANNEL_NOT_PREPARED", message: "probe.json missing; run prepare first" };
    }
  }
  return { ok: true, root };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function loadChannelMetadata(paths) {
  let probe;
  try {
    probe = await readJson(paths.probeJson);
  } catch {
    return { ok: false, code: "CHANNEL_NOT_PREPARED", message: "cannot read probe.json" };
  }
  if (probe?.version !== 1 || !/^[a-f0-9]{64}$/.test(probe?.token ?? "")) {
    return { ok: false, code: "CHANNEL_NOT_PREPARED", message: "invalid channel metadata" };
  }
  return { ok: true, probe };
}

/** id registry: any id that has EVER been used is burned forever. */
async function checkAndBurnId(paths, id) {
  let ids = { burned: [] };
  try {
    ids = await readJson(paths.idsFile);
  } catch {
    // first use
  }
  if (!Array.isArray(ids.burned)) ids.burned = [];
  if (ids.burned.includes(id)) {
    return { ok: false };
  }
  ids.burned.push(id);
  await writeFile(paths.idsFile, JSON.stringify(ids) + "\n", { mode: 0o600 });
  return { ok: true };
}

/** one-in-flight: the marker's deadline bounds the guard (MAX_TIMEOUT). */
async function claimInFlight(paths, id, timeout) {
  const inFlightFile = join(paths.root, "in-flight.json");
  let existing;
  try {
    existing = await readJson(inFlightFile);
    if (existing?.state === "SENT" || existing?.state === "SENT_NOT_ACKNOWLEDGED") {
      if (Date.now() < existing.deadlineMs) {
        return {
          ok: false,
          blocker: {
            code: "ONE_IN_FLIGHT",
            message: `request ${existing.id} is still in flight until deadline ${existing.deadlineMs}; this command wrote nothing`,
          },
        };
      }
      // The previous request's guard window has passed. UNKNOWN it stays;
      // a NEW request id is allowed (this is a new command, not a resend).
    }
  } catch {
    // no in-flight file → nothing in flight
  }
  await writeFile(inFlightFile, JSON.stringify({
    id, state: "SENT_NOT_ACKNOWLEDGED", startedAt: nowIso(),
    deadlineMs: Date.now() + timeout,
  }) + "\n", { mode: 0o600 });
  return { ok: true, inFlightFile, priorInFlight: existing };
}

async function markInFlight(paths, inFlightFile, state) {
  try {
    const data = await readJson(inFlightFile);
    data.state = state;
    await writeFile(inFlightFile, JSON.stringify(data) + "\n", { mode: 0o600 });
  } catch {
    // never let bookkeeping failures change an outcome
  }
}

async function appendTrace(paths, event) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(paths.traceFile, JSON.stringify(event) + "\n");
}

function classifyReply(reply, { pinnedTarget, channelId, requestId, probe }) {
  if (reply?.v !== 1) return { outcome: "UNKNOWN", unknownCategory: "UNATTRIBUTABLE_REPLY" };
  if (reply.token !== probe.token || reply.channelId !== channelId) {
    return { outcome: "UNKNOWN", unknownCategory: "UNATTRIBUTABLE_REPLY" };
  }
  if (reply.id !== requestId) {
    return { outcome: "UNKNOWN", unknownCategory: "UNATTRIBUTABLE_REPLY" };
  }
  if (reply.ok !== true) {
    // a host-issued refusal is the only source of REFUSED
    const code = reply.refusal?.code;
    const refusalCodes = ["WRONG_TARGET", "BAD_REQUEST", "UNSUPPORTED_METHOD", "EXPIRED", "CHANNEL_TOKEN_MISMATCH"];
    return {
      outcome: "REFUSED",
      refusal: {
        code: refusalCodes.includes(code) ? code : "BAD_REQUEST",
        message: String(reply.refusal?.message ?? "host refused"),
      },
    };
  }
  // success path — wrong-target check (CAP023 §5)
  const identity = reply.result ?? {};
  if (pinnedTarget) {
    if (pinnedTarget.sessionId && identity.sessionId &&
        identity.sessionId !== pinnedTarget.sessionId) {
      return {
        outcome: "REFUSED",
        refusal: {
          code: "WRONG_TARGET",
          message: `reply sessionId ${identity.sessionId} does not match pinned target ${pinnedTarget.sessionId}`,
        },
      };
    }
    if (pinnedTarget.aeVersion && identity.aeVersion &&
        identity.aeVersion !== pinnedTarget.aeVersion) {
      return {
        outcome: "REFUSED",
        refusal: {
          code: "WRONG_TARGET",
          message: `reply aeVersion ${identity.aeVersion} does not match pinned target ${pinnedTarget.aeVersion}`,
        },
      };
    }
  }
  return { outcome: "COMPLETED", identity };
}

async function prepare(channel, { expectAe = "" } = {}) {
  if (!isAbsolute(channel)) {
    return fail("channel must be an absolute path");
  }
  const root = resolve(channel);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const pre = await checkChannelPreconditions(root, { mustBePrepared: false });
  if (!pre.ok) return fail(pre.message);
  const paths = channelPaths(root);
  try {
    await lstat(paths.probeJson);
    return fail("channel already prepared; do not replace an active probe channel");
  } catch {
    // fresh channel
  }
  for (const name of ["inbox", "outbox"]) {
    await mkdir(join(root, name), { mode: 0o700 });
  }
  const token = hex(32);
  const channelId = "chan-" + hex(8);
  const template = await readFile(join(here, "host", "probe-dispatcher.jsx"), "utf8");
  const source = template
    .replace(/"__PROBE_ROOT__"/, stringLiteral(root.replace(/\\/g, "/")))
    .replace(/"__PROBE_TOKEN__"/, stringLiteral(token))
    .replace(/"__PROBE_CHANNEL_ID__"/, stringLiteral(channelId))
    .replace(/"__PROBE_EXPECTED_AE_VERSION__"/, stringLiteral(expectAe));
  const { copyFile } = await import("node:fs/promises");
  await copyFile(join(here, "host", "probe-json.js"), join(root, "probe-json.js"));
  await writeFile(paths.startScript, source, { mode: 0o600, flag: "wx" });
  await writeFile(paths.probeJson, JSON.stringify({
    version: 1, token, channelId, createdAt: nowIso(),
    expectedAeVersion: expectAe,
  }) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(paths.idsFile, JSON.stringify({ burned: [] }) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({
    outcome: "COMPLETED", command: "prepare",
    startScript: paths.startScript, channelId,
    note: "activate inside an OWNED AE via File > Scripts > Run Script File; never install silently",
  }, null, 2));
  return 0;
}

async function loadPinnedTarget(paths) {
  try {
    return await readJson(paths.targetFile);
  } catch {
    return null;
  }
}

async function pinTarget(paths, identity) {
  const pinned = {
    sessionId: identity.sessionId,
    aeVersion: identity.aeVersion,
    pinnedAt: nowIso(),
  };
  await writeFile(paths.targetFile, JSON.stringify(pinned) + "\n", { mode: 0o600 });
  return pinned;
}

async function dispatch(paths, channelId, probe, method, timeout, { expectAe = "", pinSession = false, name = method } = {}) {
  const startedAt = Date.now();
  const startedIso = nowIso();
  const id = hex(16);
  if (!(await checkAndBurnId(paths, id)).ok) {
    // practically impossible (128-bit random), but the invariant must hold
    return { outcome: "BLOCKED", blocker: { code: "DUPLICATE_ID", message: "id collision; rerun the command" } };
  }
  const claimed = await claimInFlight(paths, id, timeout);
  if (!claimed.ok) {
    return {
      outcome: "BLOCKED",
      blocker: claimed.blocker,
      requestState: "NOT_SENT",
      command: name,
      ts: nowIso(),
      note: "this command wrote nothing; the in-flight request keeps its own id and deadline",
    };
  }
  const end = Date.now() + timeout;
  const request = {
    v: 1, id, token: probe.token, channelId,
    method, params: method === "probe.echo" ? { message: "ping-" + id.slice(0, 8) } : {},
    deadlineMs: end, targetAeVersion: expectAe || probe.expectedAeVersion || "",
  };
  const requestPath = join(paths.inbox, `${id}.request.json`);
  const responsePath = join(paths.outbox, `${id}.result.json`);
  const partPath = requestPath + ".part";
  const handle = await open(partPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(request));
  } finally {
    await handle.close();
  }
  await rename(partPath, requestPath);
  await markInFlight(paths, claimed.inFlightFile, "SENT");

  const pinnedTarget = pinSession ? null : await loadPinnedTarget(paths);
  let lastError = null;
  while (Date.now() < end) {
    let text;
    try {
      text = await readFile(responsePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") { lastError = String(error); }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    let reply;
    try {
      reply = JSON.parse(text);
    } catch {
      const event = {
        outcome: "UNKNOWN", unknownCategory: "UNREADABLE_REPLY",
        requestId: id, requestState: "SENT_NOT_ACKNOWLEDGED",
        command: name, ts: nowIso(),
        note: "reply does not parse; quarantine the channel; do not retry",
      };
      await appendTrace(paths, event);
      return event;
    }
    const verdict = classifyReply(reply, {
      pinnedTarget, channelId, requestId: id, probe,
    });
    const durationMs = Date.now() - startedAt;
    if (verdict.outcome === "COMPLETED") {
      const identity = verdict.identity;
      let pinnedNow = pinnedTarget;
      if (pinSession || !pinnedTarget) {
        pinnedNow = await pinTarget(paths, identity);
      }
      const event = {
        outcome: "COMPLETED", command: name, method,
        requestId: id, requestState: "ACKED",
        startedAt: startedIso, endedAt: nowIso(), durationMs,
        roundTripMs: durationMs, hostEvalMs: reply.hostEvalMs ?? null,
        hostClock: reply.hostClock ?? null,
        pinned: !!pinnedNow, result: reply.result ?? null,
      };
      await markInFlight(paths, claimed.inFlightFile, "ACKED");
      await appendTrace(paths, event);
      return event;
    }
    const event = {
      outcome: verdict.outcome, command: name, method,
      requestId: id,
      requestState: verdict.outcome === "REFUSED" ? "ACKED" : "SENT_NOT_ACKNOWLEDGED",
      refusal: verdict.refusal ?? null,
      unknownCategory: verdict.unknownCategory ?? null,
      startedAt: startedIso, endedAt: nowIso(), durationMs,
      ts: nowIso(),
      note: verdict.outcome === "UNKNOWN"
        ? "no attributable reply before deadline or unattributable reply; do not resend this request id"
        : undefined,
    };
    await appendTrace(paths, event);
    return event;
  }
  // deadline passed with no attributable reply → UNKNOWN, never retried
  const event = {
    outcome: "UNKNOWN", unknownCategory: "NO_REPLY_BEFORE_DEADLINE",
    command: name, method, requestId: id,
    requestState: "SENT_NOT_ACKNOWLEDGED",
    startedAt: startedIso, endedAt: nowIso(),
    durationMs: Date.now() - startedAt, ts: nowIso(),
    pollIntervalMs: POLL_INTERVAL_MS, lastError,
    note: "the request may have been claimed and executed; do not resend; if the dispatcher is late, its own EXPIRED refusal will appear in the outbox",
  };
  await appendTrace(paths, event);
  return event;
}

async function precheckTargetRunning() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("pgrep", ["-x", "After Effects"]);
      return { running: stdout.trim().length > 0 };
    } catch {
      return { running: false };
    }
  }
  return { running: null, platform: process.platform, note: "process-existence precheck only implemented on macOS" };
}

async function runCommand(command, channel, args) {
  const timeoutArg = Number(args.timeout ?? 10_000);
  if (!Number.isSafeInteger(timeoutArg) || timeoutArg < MIN_TIMEOUT || timeoutArg > MAX_TIMEOUT) {
    return fail(`timeout must be ${MIN_TIMEOUT}..${MAX_TIMEOUT} ms`);
  }
  const pre = await checkChannelPreconditions(channel);
  if (!pre.ok) {
    const event = {
      outcome: "BLOCKED", blocker: { code: pre.code, message: pre.message },
      command, requestState: "NOT_SENT", ts: nowIso(),
    };
    console.log(JSON.stringify(event, null, 2));
    return event;
  }
  const paths = channelPaths(pre.root);
  const meta = await loadChannelMetadata(paths);
  if (!meta.ok) {
    const event = {
      outcome: "BLOCKED", blocker: { code: meta.code, message: meta.message },
      command, requestState: "NOT_SENT", ts: nowIso(),
    };
    console.log(JSON.stringify(event, null, 2));
    return event;
  }
  const { probe } = meta;
  if (args.expectAe && probe.expectedAeVersion && args.expectAe !== probe.expectedAeVersion) {
    const event = {
      outcome: "BLOCKED",
      blocker: { code: "PIN_CONFLICT", message: `--expect-ae ${args.expectAe} conflicts with channel pinned ${probe.expectedAeVersion}` },
      command, requestState: "NOT_SENT", ts: nowIso(),
    };
    console.log(JSON.stringify(event, null, 2));
    return event;
  }

  if (command === "diagnose") {
    const target = await precheckTargetRunning();
    const pinned = await loadPinnedTarget(paths);
    const event = {
      command: "diagnose", ts: nowIso(),
      platform: process.platform, arch: process.arch,
      osRelease: os.release(), cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpuCount: os.cpus().length,
      aeProcessObserved: target,
      pinnedTarget: pinned,
      note: "process-existence observed from the OS only; it says nothing about AE's internal state and never touches any AE instance",
    };
    await appendTrace(paths, event);
    console.log(JSON.stringify(event, null, 2));
    return event;
  }

  const method = METHODS[command];
  if (!method) return fail(`unknown command ${command}`);

  const event = await dispatch(paths, probe.channelId, probe, method, timeoutArg, {
    expectAe: args.expectAe ?? "",
    pinSession: command === "identify",
    name: command,
  });
  console.log(JSON.stringify(event, null, 2));
  return event;
}

function parseArgs(argv) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expect-ae") {
      out.expectAe = argv[i + 1];
      i++;
    } else if (argv[i] === "--pin-session") {
      out.pinSession = true;
    } else {
      positional.push(argv[i]);
    }
  }
  return { out, positional };
}

async function main(argv) {
  const command = argv[2];
  if (command === "prepare") {
    const { out, positional } = parseArgs(argv.slice(3));
    return prepare(positional[0], { expectAe: out.expectAe ?? "" });
  }
  const known = ["identify", "ping", "snapshot", "sysinfo", "diagnose"];
  if (!known.includes(command)) {
    return fail(`usage: probe.mjs <prepare|identify|ping|snapshot|sysinfo|diagnose> <channel> [timeoutMs] [--expect-ae <ver>]`);
  }
  const { out, positional } = parseArgs(argv.slice(3));
  const channel = positional[0];
  if (!channel) return fail("channel path required");
  const timeout = positional[1] !== undefined ? Number(positional[1]) : undefined;
  return runCommand(command, channel, { timeout, ...out });
}

process.on("unhandledRejection", (error) => {
  fail(`unhandled rejection: ${error?.stack ?? error}`);
});

await main(process.argv);
