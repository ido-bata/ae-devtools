/**
 * supervision.mjs — ae-a8n GUI-supervision contract consumer (Issue #408,
 * Epic #407; ae-a8n specs/gui-supervision/spec.md, schema
 * `ae-a8n.supervision/v1`).
 *
 * This module is the ONE place ae-devtools reads the durable supervision
 * state ae-a8n's monitor publishes. Consumers (recovery-orchestrator,
 * dev-loop, devtools-cli, MCP, VSCode) NEVER implement their own GUI
 * probing, dialog pressing or recovery policy — they read this contract
 * and map it onto their own verdict/surface vocabulary.
 *
 * Read path (spec §Durable shared state, US6):
 *
 *   <sessionDir>/supervision.json       — the state document, atomic-published
 *   <sessionDir>/monitor.lease.json     — the monitor lease record
 *
 * `sessionDir` is the ae-a8n session root (`slice.sessionRoot` for a8n
 * sessions). The durable FILE is the contract, not the npm export
 * surface: this module deliberately implements the documented decode /
 * health re-evaluation rules itself so reads keep working for attached
 * sessions, post-mortem session dirs, and `--ae-a8n-root` builds that
 * predate or postdate any single npm pin. The pinned
 * `@ido-bata/ae-a8n@0.6.0` DOES export the public supervision API
 * (`supervisionReport`, `readSupervisionState`, `decodeSupervisionDoc`,
 * `evaluateObservationHealth`, `waitForSupervisionPhase`,
 * `ae.supervisionState()`); `supportsSupervisionApi(mod)` reports
 * whether a resolved build offers it. The local decoder is a
 * line-for-line port of ae-a8n `state.ts` — same validation, same
 * bounded-wait invariant — and `waitForSupervisionPhase` here adds a
 * phase-deadline bound the ae-a8n helper does not have, so it is not a
 * drop-in replacement.
 *
 * Honesty rules (mirroring ae-a8n state.ts):
 *
 *   - absent / corrupt / future-version state is `unavailable`, never a
 *     fabricated healthy report;
 *   - the stored `observationHealth` is re-evaluated against the monitor
 *     heartbeat clock at read time — a stale heartbeat is `monitor-lost`
 *     regardless of what the document claims;
 *   - `monitor-lost` / `degraded` / `unavailable` health is NEVER folded
 *     into "healthy" by the verdict mapping below.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPERVISION_SCHEMA_VERSION = "ae-a8n.supervision/v1";
export const SUPERVISION_STATE_FILE = "supervision.json";
export const MONITOR_LEASE_FILE = "monitor.lease.json";
export const MONITOR_LEASE_SCHEMA_VERSION = "ae-a8n.monitor-lease/v1";
export const DEFAULT_MONITOR_TTL_MS = 30 * 1000;

export const SUPERVISION_PHASES = Object.freeze([
  "running",
  "blocked",
  "recovering",
  "resumed",
  "needs-human",
  "quarantined",
]);

export const OBSERVATION_HEALTHS = Object.freeze(["ok", "degraded", "monitor-lost", "unavailable"]);

const PHASES = new Set(SUPERVISION_PHASES);
const HEALTHS = new Set(OBSERVATION_HEALTHS);
const HOST_STATES = new Set([
  "none",
  "process-gone",
  "not-responding",
  "busy-suspected",
  "gui-session-lost",
  "unknown",
]);
const TIERS = new Set(["auto-safe", "human-required", "report-only", "unknown"]);
const PENDING_STATES = new Set(["in-flight", "timed-out", "unknown"]);

export function supervisionStatePath(sessionDir) {
  return join(sessionDir, SUPERVISION_STATE_FILE);
}

export function monitorLeasePath(sessionDir) {
  return join(sessionDir, MONITOR_LEASE_FILE);
}

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSupervisionWindow(v) {
  return (
    isRecord(v) &&
    typeof v.title === "string" &&
    typeof v.role === "string" &&
    typeof v.blocking === "boolean" &&
    typeof v.tier === "string" &&
    TIERS.has(v.tier)
  );
}

function isPendingRequest(v) {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.method === "string" &&
    typeof v.since === "string" &&
    typeof v.state === "string" &&
    PENDING_STATES.has(v.state)
  );
}

function isMonitorRecord(v) {
  return (
    isRecord(v) &&
    typeof v.ownerId === "string" &&
    typeof v.pid === "number" &&
    typeof v.acquiredAt === "string" &&
    typeof v.heartbeatAt === "string"
  );
}

function isBlockingInfo(v) {
  if (v === null) return true;
  return (
    isRecord(v) &&
    typeof v.host === "string" &&
    HOST_STATES.has(v.host) &&
    typeof v.detail === "string" &&
    Array.isArray(v.windows) &&
    v.windows.every(isSupervisionWindow)
  );
}

/**
 * Validate a parsed supervision document. Returns the doc or null — a
 * document that fails validation is corrupt, never partially trusted.
 * Mirrors ae-a8n `decodeSupervisionDoc` including the bounded-wait
 * invariant: blocked/recovering/needs-human/quarantined MUST carry a
 * deadline, so supervision waits are bounded by contract.
 */
export function decodeSupervisionDoc(value) {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SUPERVISION_SCHEMA_VERSION) return null;
  if (typeof value.phase !== "string" || !PHASES.has(value.phase)) return null;
  if (typeof value.observationHealth !== "string" || !HEALTHS.has(value.observationHealth)) return null;
  if (typeof value.enteredAt !== "string" || typeof value.updatedAt !== "string") return null;
  if (value.deadline !== null && typeof value.deadline !== "string") return null;
  if (value.sessionId !== null && typeof value.sessionId !== "string") return null;
  if (!isBlockingInfo(value.blocking)) return null;
  if (!Array.isArray(value.pendingRequests) || !value.pendingRequests.every(isPendingRequest)) return null;
  if (value.monitor !== null && !isMonitorRecord(value.monitor)) return null;
  if (!Array.isArray(value.evidence) || !value.evidence.every((e) => typeof e === "string")) return null;
  if (!Array.isArray(value.history)) return null;
  const phase = value.phase;
  if (
    (phase === "blocked" || phase === "recovering" || phase === "needs-human" || phase === "quarantined") &&
    value.deadline === null
  ) {
    return null;
  }
  return value;
}

/**
 * Read and validate the state document. Never throws for bad content.
 * @returns {{kind:"state",doc:object}|{kind:"absent"}|{kind:"corrupt",detail:string}}
 */
export function readSupervisionState(sessionDir) {
  const path = supervisionStatePath(sessionDir);
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "corrupt", detail: `state file exists but cannot be read: ${path}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "corrupt", detail: `state file is not valid JSON: ${path}` };
  }
  const doc = decodeSupervisionDoc(parsed);
  if (doc === null) {
    return { kind: "corrupt", detail: `state file failed schema validation: ${path}` };
  }
  return { kind: "state", doc };
}

/**
 * Re-evaluate observation health at read time. The stored value is the
 * monitor's last claim; the heartbeat clock is the truth. Ported from
 * ae-a8n `evaluateObservationHealth` — same TTL default, same rules.
 */
export function evaluateObservationHealth(doc, now = new Date(), monitorTtlMs = DEFAULT_MONITOR_TTL_MS) {
  if (doc.monitor === null) {
    return {
      health: doc.observationHealth === "ok" ? "unavailable" : doc.observationHealth,
      detail: doc.observationHealth === "ok" ? "no monitor is recorded" : null,
    };
  }
  const heartbeatAt = Date.parse(doc.monitor.heartbeatAt);
  if (Number.isNaN(heartbeatAt)) {
    return { health: "monitor-lost", detail: "the recorded monitor heartbeat is unreadable" };
  }
  if (now.getTime() - heartbeatAt > monitorTtlMs) {
    return {
      health: "monitor-lost",
      detail:
        `the monitor heartbeat is stale (last beat ${doc.monitor.heartbeatAt}, ` +
        `ttl ${monitorTtlMs}ms); the target's current GUI state is unknown`,
    };
  }
  return { health: doc.observationHealth, detail: null };
}

/**
 * Build the supervision report for a session directory — the same shape
 * ae-a8n `supervisionReport()` returns (`ae-a8n.supervision/v1` report).
 * `status:"unavailable"` is an honest answer, never an empty success.
 */
export function supervisionReport(sessionDir, options = {}) {
  const now = options.now ?? new Date();
  const readAt = now.toISOString();
  const result = readSupervisionState(sessionDir);
  if (result.kind === "absent") {
    return {
      status: "unavailable",
      source: "absent",
      reason:
        "no supervision state exists for this session directory; " +
        "either supervision never ran or the session dir is wrong",
      readAt,
    };
  }
  if (result.kind === "corrupt") {
    return { status: "unavailable", source: "corrupt", reason: result.detail, readAt };
  }
  const evaluated = evaluateObservationHealth(result.doc, now, options.monitorTtlMs);
  return {
    status: "observed",
    source: "state",
    doc: result.doc,
    health: evaluated.health,
    healthDetail: evaluated.detail,
    readAt,
  };
}

/**
 * Read the monitor lease record (`monitor.lease.json`) for evidence.
 * Loose validation: the lease is informational for consumers — the
 * authoritative liveness signal is the heartbeat inside the state doc.
 * @returns {{kind:"lease",lease:object}|{kind:"absent"}|{kind:"corrupt",detail:string}}
 */
export function readMonitorLease(sessionDir) {
  const path = monitorLeasePath(sessionDir);
  if (!existsSync(path)) return { kind: "absent" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { kind: "corrupt", detail: `monitor lease file is not valid JSON: ${path}` };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== MONITOR_LEASE_SCHEMA_VERSION) {
    return { kind: "corrupt", detail: `monitor lease failed schema validation: ${path}` };
  }
  return { kind: "lease", lease: parsed };
}

// ------------------------------------------------------------ assessment

/**
 * Compact, surface-safe snapshot of a supervision report for embedding
 * in evidence/diagnostics payloads. Keeps the honesty axes (status,
 * source, phase, health) and the structured human request; drops only
 * fields consumers never act on (full history, raw evidence refs stay).
 * Returns null for a null/undefined report.
 */
export function supervisionSnapshot(report) {
  if (report === null || report === undefined || typeof report !== "object") return null;
  if (report.status !== "observed") {
    return {
      status: "unavailable",
      source: report.source ?? null,
      reason: typeof report.reason === "string" ? report.reason : null,
      readAt: report.readAt ?? null,
    };
  }
  const doc = report.doc;
  return {
    status: "observed",
    source: report.source ?? "state",
    schemaVersion: doc.schemaVersion ?? SUPERVISION_SCHEMA_VERSION,
    phase: doc.phase ?? null,
    health: report.health ?? doc.observationHealth ?? null,
    healthDetail: report.healthDetail ?? null,
    blocking: doc.blocking ?? null,
    pendingRequests: Array.isArray(doc.pendingRequests) ? doc.pendingRequests : [],
    deadline: doc.deadline ?? null,
    enteredAt: doc.enteredAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    monitor: doc.monitor ?? null,
    needsHuman: needsHumanInfo(report),
    readAt: report.readAt ?? null,
  };
}

/**
 * Structured human-escalation payload (spec US4): what is blocking, why
 * automation stopped, the choices the human has, and how to resume.
 * Returns null unless the phase actually requires a human
 * (`needs-human` or `quarantined`).
 *
 * `options` lists the button labels the blocking windows expose — they
 * are the measured choices a human may take, not automation permissions.
 * `requiredAction` and `resumePath` are guidance text; consumers must
 * surface them verbatim rather than re-deriving policy.
 */
export function needsHumanInfo(report) {
  if (report === null || report === undefined || report.status !== "observed") return null;
  const doc = report.doc;
  if (doc.phase !== "needs-human" && doc.phase !== "quarantined") return null;
  const blocking = doc.blocking ?? null;
  const windows = (blocking?.windows ?? []).filter((w) => w.blocking === true);
  const dialogs = windows.map((w) => ({
    title: w.title ?? "",
    role: w.role ?? "",
    subrole: w.subrole ?? null,
    tier: w.tier ?? "unknown",
    dialogClass: w.dialogClass ?? null,
    code: w.code ?? null,
    buttons: Array.isArray(w.buttons) ? [...w.buttons] : [],
    texts: Array.isArray(w.texts) ? [...w.texts] : [],
  }));
  const options = [...new Set(dialogs.flatMap((d) => d.buttons))];
  const what =
    dialogs.length > 0
      ? dialogs.map((d) => (d.title !== "" ? d.title : `${d.role}${d.dialogClass ? ` (${d.dialogClass})` : ""}`)).join(", ")
      : (blocking?.detail ?? `supervision phase '${doc.phase}'`);
  return {
    phase: doc.phase,
    reason: blocking?.detail ?? `After Effects supervision is '${doc.phase}'`,
    host: blocking?.host ?? null,
    dialogs,
    options,
    requiredAction:
      doc.phase === "quarantined"
        ? "Inspect the After Effects window and resolve the blocking state manually; automation will not press unmeasured dialogs."
        : "A human decision is required in the After Effects window; automation is paused, not failed.",
    resumePath:
      "Resolve the dialog/state in After Effects, then re-read supervision status " +
      "(ae-devtools supervision status / ae-a8n supervise status) — the session resumes when the monitor observes recovery.",
    deadline: doc.deadline ?? null,
    enteredAt: doc.enteredAt ?? null,
    evidence: Array.isArray(doc.evidence) ? [...doc.evidence] : [],
    readAt: report.readAt ?? null,
  };
}

// ------------------------------------------------------------ verdict mapping

/**
 * Supervision health/phase → recovery-orchestrator verdict escalation
 * (Issue #408). Returns one of:
 *
 *   "unknown"      — observation cannot be trusted (corrupt state,
 *                    monitor-lost, unavailable health). NEVER clean.
 *   "quarantined"  — phase quarantined or needs-human: a structured
 *                    stop; a human must act. needsHumanInfo() carries
 *                    the dialog/reason/options/resume detail.
 *   "await-original" — phase blocked/recovering: the affected request
 *                    may still complete; wait within the phase
 *                    deadline, never resend.
 *   null           — no escalation (running/resumed with ok/degraded
 *                    health, or no supervision state at all — "absent"
 *                    is honest non-applicability, not a verdict).
 *
 * `degraded` health deliberately does NOT escalate: the monitor still
 * reports, so the phase is evidence — but it is recorded on the
 * snapshot and must never be read as "healthy" by callers.
 */
export function supervisionEscalation(report) {
  if (report === null || report === undefined || typeof report !== "object") return null;
  if (report.status !== "observed") {
    // Corrupt state cannot be classified — unknown, never clean.
    // "absent" means supervision never ran for this session dir: honest
    // non-applicability, not a failure and not a healthy claim.
    return report.source === "corrupt" ? "unknown" : null;
  }
  const health = report.health ?? report.doc?.observationHealth ?? null;
  if (health === "monitor-lost" || health === "unavailable") return "unknown";
  const phase = report.doc?.phase ?? null;
  if (phase === "quarantined" || phase === "needs-human") return "quarantined";
  if (phase === "blocked" || phase === "recovering") return "await-original";
  return null;
}

/**
 * Whether a supervision report forbids a "clean" verdict: observation
 * health is not ok, or the phase still records an unresolved blocking
 * state. Used by verify-exit style acceptance where "clean" asserts the
 * GUI is provably unobstructed.
 */
export function supervisionBlocksClean(report) {
  if (report === null || report === undefined || report.status !== "observed") {
    // Absent supervision cannot disprove cleanliness either way — the
    // caller's other evidence channels decide. Corrupt state, however,
    // means the GUI state is unclassifiable: not clean.
    return report?.source === "corrupt";
  }
  const health = report.health ?? report.doc?.observationHealth ?? null;
  if (health !== "ok") return true;
  const phase = report.doc?.phase ?? null;
  return phase !== "running" && phase !== "resumed";
}

/**
 * Pick the stricter of an existing verdict and a supervision escalation.
 * Ordering (most severe first): unknown > quarantined > refused >
 * residue > await-original > clean/crash-*. Supervision can only ever
 * escalate — it never downgrades a verdict the recovery path earned.
 */
const VERDICT_SEVERITY = {
  unknown: 60,
  quarantined: 50,
  "crash-suspect": 45,
  "crash-verified": 40,
  "crash-unconfirmed": 35,
  residue: 30,
  refused: 20,
  "await-original": 10,
  clean: 0,
};

export function stricterVerdict(base, escalation) {
  if (escalation === null || escalation === undefined) return base;
  const a = VERDICT_SEVERITY[base] ?? 0;
  const b = VERDICT_SEVERITY[escalation] ?? 0;
  return b > a ? escalation : base;
}

// ------------------------------------------------------------ session wiring

/**
 * The session directory a devtools session's supervision state lives
 * in. `slice` is the raw openSliceSession/openAttachedSliceSession
 * result (a8n-transport/session-open.mjs keeps it internal); the
 * stripped session may also carry `sessionRoot` directly.
 */
export function sessionDirFor(session) {
  const root = session?.slice?.sessionRoot ?? session?.sessionRoot ?? null;
  return typeof root === "string" && root.length > 0 ? root : null;
}

/**
 * Read the supervision report for an open dev-loop session. Returns
 * null when the session has no ae-a8n session root (fake sessions) —
 * callers treat null as "supervision not applicable", which is honest:
 * a fake host has no GUI to supervise.
 *
 * Read-only by construction: this only reads files ae-a8n's monitor
 * published. It never starts a monitor, never takes a lease, never
 * touches After Effects — safe for attached sessions (Issue #410).
 */
export function supervisionForSession(session, options = {}) {
  const dir = sessionDirFor(session);
  if (dir === null) return null;
  return supervisionReport(dir, options);
}

/**
 * Whether a resolved ae-a8n module exports the supervision API
 * (`supervisionReport` et al., ae-a8n #287). Informational only — the
 * durable-file reader above works regardless; this tells consumers
 * which read path a given ae-a8n build offers.
 */
export function supportsSupervisionApi(mod) {
  return (
    mod !== null &&
    typeof mod === "object" &&
    typeof mod.supervisionReport === "function"
  );
}

/**
 * Bounded wait for a supervision phase transition (Issue #408:
 * "eliminate indefinite waits"). Polls the durable state file — never
 * AE — until `phases` includes the current phase, `timeoutMs` elapses,
 * or the document's own phase `deadline` passes, whichever is first.
 * The wait is ALWAYS bounded: a missing deadline does not extend it.
 *
 * @returns {Promise<{timedOut:boolean, deadlineExceeded:boolean, report:object}>}
 */
export async function waitForSupervisionPhase(sessionDir, {
  phases = null,
  timeoutMs = 10_000,
  intervalMs = 250,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = now().getTime();
  const cap = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  const poll = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 250;
  const wanted = Array.isArray(phases) ? new Set(phases) : null;
  let last = supervisionReport(sessionDir, { now: now() });
  for (;;) {
    const phase = last.status === "observed" ? last.doc.phase : null;
    if (wanted === null || (phase !== null && wanted.has(phase))) {
      return { timedOut: false, deadlineExceeded: false, report: last };
    }
    const elapsed = now().getTime() - started;
    // The phase deadline bounds the wait even when timeoutMs is larger.
    const docDeadline = last.status === "observed" && typeof last.doc.deadline === "string"
      ? Date.parse(last.doc.deadline)
      : null;
    const deadlineExceeded = docDeadline !== null && !Number.isNaN(docDeadline) && now().getTime() >= docDeadline;
    if (elapsed >= cap || deadlineExceeded) {
      return { timedOut: elapsed >= cap && !deadlineExceeded, deadlineExceeded, report: last };
    }
    await sleep(Math.min(poll, cap - elapsed));
    last = supervisionReport(sessionDir, { now: now() });
  }
}
