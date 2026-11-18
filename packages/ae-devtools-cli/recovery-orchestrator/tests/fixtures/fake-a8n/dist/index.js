/**
 * fake-a8n/dist/index.js — committed stub of the `@ido-bata/ae-a8n`
 * surface that `recovery-orchestrator/cli.mjs` consumes (Issue #195).
 *
 * Point `--ae-a8n-root tests/fixtures/fake-a8n` at this directory and every
 * recovery-orchestrator subcommand (`observe` / `verify-exit` / `recover`)
 * runs end-to-end at fake level: no After Effects, no GUI session, no real
 * WindowServer census, no lease files.
 *
 * Behavior is driven by a JSON config file:
 *
 *   FAKE_A8N_CONFIG  — path to a JSON file (see DEFAULTS below for shape)
 *   FAKE_A8N_OMIT    — comma-separated export names stubbed to `undefined`,
 *                      used to prove cli.mjs fails loudly on a build that
 *                      lacks a required export
 *   FAKE_A8N_STATE_ROOT — lease state root override (default: a tmp dir)
 *
 * Liveness is NOT faked: `defaultPidAlive` / `defaultPidStartedAt` run the
 * same `kill(pid, 0)` / `ps lstart` probes as the real build, so tests must
 * hand the CLI real live (or really dead) pids.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const OMIT = new Set(
  (process.env.FAKE_A8N_OMIT ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const omit = (name, value) => (OMIT.has(name) ? undefined : value);

const DEFAULTS = {
  // The login session readGuiSession reports. null → "no session".
  guiSession: { uid: 501, asid: 42, username: "fakeuser", kind: "Aqua" },
  // lsappinfo-style app instances. Tests set this to attribute their live
  // test pid to the fake session.
  instances: [],
  // MacGuiRecovery.listWindows() payload (GuiAppState shape).
  windows: [
    {
      title: "Fake After Effects",
      role: "AXWindow",
      subrole: "AXDialog",
      buttons: [{ title: "OK" }],
      texts: ["a measured fake dialog"],
    },
  ],
  frontmost: false,
  windowServer: { available: true, reason: null, windowCount: 0, onScreenCount: 0 },
  axSuspect: false,
  // When set, listWindows()/capture() throw this message (degraded path).
  guiError: null,
  // WindowServer census. {available:true, windows:[WindowServerWindow…]} or
  // {available:false, reason}. Serialized through the same pipe-delimited
  // runner protocol the real census uses.
  census: { available: true, windows: [] },
  // inspectGuiLease payload override; default is a free lease.
  lease: null,
  // MacHostRecovery.attempt() canned outcome (RecoveryOutcome shape).
  recoveryOutcome: {
    recovered: true,
    outcome: "dismissed",
    evidence: "fake-a8n: pressed OK on the measured dialog",
    window: "Fake After Effects",
  },
  // When set, every attempt() appends its RecoveryContext as a JSON line —
  // lets tests prove the CLI reached the fake host recovery with the
  // authorized ownerId/requestId/method.
  attemptLog: null,
};

function loadConfig() {
  const file = process.env.FAKE_A8N_CONFIG;
  if (!file) return { ...DEFAULTS };
  const over = JSON.parse(readFileSync(file, "utf-8"));
  return { ...DEFAULTS, ...over };
}

// ------------------------------------------------------------ session

export const readGuiSession = omit("readGuiSession", (uid) => {
  const cfg = loadConfig();
  const s = cfg.guiSession;
  if (s === null || s === undefined || s.uid !== uid) return null;
  return { uid: s.uid, asid: s.asid ?? null, username: s.username ?? `uid-${uid}`, kind: s.kind ?? "Aqua" };
});

export const readGuiSessionFailure = omit("readGuiSessionFailure", (uid) => {
  return readGuiSession(uid) === null ? "fake-a8n: no GUI session for uid" : null;
});

export const readUsername = omit("readUsername", (uid) => {
  const s = loadConfig().guiSession;
  return s !== null && s !== undefined && s.uid === uid ? (s.username ?? `uid-${uid}`) : `uid-${uid}`;
});

export const listAppInstances = omit("listAppInstances", () => {
  return loadConfig().instances.map((i) => ({ ...i }));
});

export const guiSessionKey = omit("guiSessionKey", ({ uid, asid }) => `${uid}/${asid ?? "none"}`);

// ------------------------------------------------------------ census

function censusText(cfg) {
  const c = cfg.census ?? { available: true, windows: [] };
  if (c.available === false) throw new Error(c.reason ?? "fake census unavailable");
  return (c.windows ?? [])
    .map((w) => {
      const b = w.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
      return [w.pid, w.owner ?? "fake", w.layer ?? 0, w.onScreen ? 1 : 0, w.name ?? "", b.x, b.y, b.width, b.height].join("|");
    })
    .join("\n");
}

function parseCensusText(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, owner, layer, onScreen, name, x, y, width, height] = line.split("|");
      return {
        pid: Number(pid),
        owner,
        layer: Number(layer),
        onScreen: onScreen === "1",
        name,
        bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
      };
    });
}

export const censusRunnerInSession = omit("censusRunnerInSession", () => {
  // Same contract as the real build: a CensusRunner (program, args) → stdout.
  return () => censusText(loadConfig());
});

export const windowServerCensus = omit("windowServerCensus", (run) => {
  try {
    const text = typeof run === "function" ? run("fake-census", []) : "";
    return { available: true, windows: parseCensusText(text) };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
});

// ------------------------------------------------------------ lease

export const defaultGuiLeaseRoot = omit("defaultGuiLeaseRoot", () => {
  return process.env.FAKE_A8N_STATE_ROOT ?? join(tmpdir(), "ae-a8n-fake-state");
});

export const guiLeasePaths = omit("guiLeasePaths", (stateRoot) => ({
  dir: join(stateRoot, "gui-leases"),
  auditLog: join(stateRoot, "audit", "gui.jsonl"),
}));

export const defaultPidAlive = omit("defaultPidAlive", (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Same rule as the real build: only ESRCH proves death.
    return error?.code !== "ESRCH";
  }
});

export const defaultPidStartedAt = omit("defaultPidStartedAt", (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
});

export const inspectGuiLease = omit("inspectGuiLease", () => {
  const lease = loadConfig().lease;
  return lease ?? { state: "free", record: null };
});

export const acquireGuiLease = omit("acquireGuiLease", (options) => ({
  ok: true,
  lease: {
    path: join(options?.stateRoot ?? tmpdir(), "fake-gui.lease.json"),
    release() {},
  },
}));

export const reapGuiLease = omit("reapGuiLease", (options) => ({
  ok: true,
  path: join(options?.stateRoot ?? tmpdir(), "fake-gui.lease.json"),
  detail: "fake-a8n reap",
}));

export const auditGuiEvent = omit("auditGuiEvent", () => "fake-a8n-audit");

export const assessGuiObservation = omit("assessGuiObservation", (pid, frontmost, windows, census) => {
  const ws = census?.available === true
    ? {
        available: true,
        reason: null,
        windowCount: census.windows.length,
        onScreenCount: census.windows.filter((w) => w.onScreen).length,
      }
    : { available: false, reason: census?.reason ?? "census unavailable", windowCount: 0, onScreenCount: 0 };
  return {
    pid,
    frontmost,
    windows,
    windowServer: ws,
    axSuspect: windows.length === 0 && ws.available === true && ws.windowCount > 0,
  };
});

// ------------------------------------------------------------ GUI classes

export const MacGuiRecovery = omit("MacGuiRecovery", class MacGuiRecovery {
  constructor(options) {
    this.session = options.session;
    this.pid = options.pid;
    this.screenshotDir = options.screenshotDir;
    this.allowConsoleSession = options.allowConsoleSession === true;
  }

  listWindows() {
    const cfg = loadConfig();
    if (cfg.guiError) throw new Error(cfg.guiError);
    return {
      pid: this.pid,
      frontmost: cfg.frontmost,
      windows: cfg.windows.map((w) => ({
        title: w.title,
        role: w.role,
        subrole: w.subrole ?? null,
        buttons: (w.buttons ?? []).map((b) => ({ ...b })),
        texts: w.texts ?? [],
      })),
      windowServer: { ...(cfg.windowServer ?? { available: true, reason: null, windowCount: 0, onScreenCount: 0 }) },
      axSuspect: cfg.axSuspect === true,
    };
  }

  capture(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from("fake-a8n screenshot bytes\n"));
    return path;
  }
});

export const MacHostRecovery = omit("MacHostRecovery", class MacHostRecovery {
  constructor(options) {
    this.session = options.session;
    this._pidFn = options.pid;
    this.screenshotDir = options.screenshotDir;
    this.ownerId = options.ownerId;
  }

  async attempt(context) {
    const cfg = loadConfig();
    if (cfg.attemptLog) {
      appendFileSync(
        cfg.attemptLog,
        `${JSON.stringify({ at: new Date().toISOString(), ownerId: this.ownerId, pid: this._pidFn?.() ?? null, ...context })}\n`,
      );
    }
    return { ...(cfg.recoveryOutcome ?? { recovered: false, outcome: "refused", evidence: "fake-a8n: no outcome configured" }) };
  }
});
