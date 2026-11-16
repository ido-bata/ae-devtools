/**
 * diagnostics.mjs — failure diagnostics + sourcemap resolution for the
 * devtools CLI (Issue #103).
 *
 * Two jobs, both additive over the existing evidence contract:
 *
 *   buildFailureDiagnostics() — turn a failed execute/verify result into
 *     `ae-devtools.diagnostics/v1` record(s) via the packaged
 *     diagnostics/ collectors, then resolve each record's generated JSX
 *     position back to TypeScript through diagnostics/source-map.mjs
 *     (sourcemap resolution itself is Issue #95 / #37 CAP064).
 *
 *   runDiagnose() — read a stored record back: a bare diagnostics record,
 *     a `ae-devtools.cli.run/v1` evidence file (--out), or a surviving
 *     run-guard marker (which links to its evidence file when one was
 *     written). Re-runs sourcemap resolution and reports honest statuses.
 *
 * Boundary notes:
 *   - diagnostics/ ships inside the @ae-devtools/cli tarball and is
 *     reached through guarded dynamic imports. A damaged/partial install
 *     degrades to an honest "unavailable" note — never a crash, never a
 *     fabricated position.
 *   - No dispatch happens here: diagnose only reads files. It adds no
 *     permission path.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RUNS_DIR, GUARD_SCHEMA } from "./session-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/ae-devtools-cli/devtools-cli → packaged diagnostics/
const DIAG_DIR = join(HERE, "..", "diagnostics");

export const DIAGNOSTICS_BLOCK_SCHEMA = "ae-devtools.cli.diagnostics/v1";
export const DIAGNOSE_SCHEMA = "ae-devtools.cli.diagnose/v1";
export const DIAGNOSTICS_RECORD_VERSION = "ae-devtools.diagnostics/v1";
export const RUN_GUARD_SCHEMA = GUARD_SCHEMA;

let libsPromise = null;
/**
 * Load the diagnostics schema/collectors/source-map modules. Returns
 * { schema, collectors, sourceMap } or { error } — callers must handle
 * the error path; this never throws for a missing packaged directory.
 */
export function loadDiagnosticsLibs() {
  if (libsPromise === null) {
    libsPromise = (async () => {
      try {
        const [schema, collectors, sourceMap] = await Promise.all([
          import(pathToFileURL(join(DIAG_DIR, "schema.mjs")).href),
          import(pathToFileURL(join(DIAG_DIR, "collectors.mjs")).href),
          import(pathToFileURL(join(DIAG_DIR, "source-map.mjs")).href),
        ]);
        return { schema, collectors, sourceMap };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    })();
  }
  return libsPromise;
}

/** Wire outcomes that mean the dispatch did not complete cleanly. */
const FAILURE_WIRE_STATES = new Set(["REFUSED", "FAILED", "BLOCKED", "UNKNOWN"]);

/** Normalize any outcome spelling to the wire vocabulary for severity. */
function wireState(raw) {
  const s = String(raw ?? "").toLowerCase();
  return { refused: "REFUSED", failed: "FAILED", completed: "COMPLETED", blocked: "BLOCKED", unknown: "UNKNOWN" }[s] ?? String(raw ?? "UNKNOWN");
}

/**
 * First failure-bearing outcome across a result's spellings, normalized
 * to the wire vocabulary, or null when nothing failure-shaped exists.
 *
 * Spellings seen in the wild:
 *   - wire results: uppercase `outcome` (FAILED/REFUSED/BLOCKED/UNKNOWN)
 *   - adapter-level refusals: lowercase `status` ("refused"/"failed")
 *     with NO wire `outcome` — the dispatch never reached the runner
 *   - adapter payload failures: wire `outcome` "COMPLETED" PLUS
 *     `status` "failed" — the failure-bearing status MUST win over the
 *     completed wire outcome
 *   - a host-reported `error` object is failure evidence even when every
 *     outcome spelling looks clean
 *
 * `outcome` is the caller-computed fallback (evidence.outcome). The
 * comparison is normalized — wire "REFUSED" and adapter "refused" are
 * the same state (Issue #127: uppercase REFUSED used to slip through).
 */
export function failureOutcome(result, outcome) {
  const candidates = [];
  if (result !== null && typeof result === "object") {
    candidates.push(result.status, result.outcome);
  }
  candidates.push(outcome);
  for (const c of candidates) {
    if (typeof c !== "string" || c.length === 0) continue;
    const w = wireState(c);
    if (FAILURE_WIRE_STATES.has(w)) return w;
  }
  if (
    result !== null && typeof result === "object" &&
    result.error !== null && typeof result.error === "object"
  ) {
    return "FAILED";
  }
  return null;
}

/**
 * Whether a execute/verify result deserves a diagnostics block.
 */
export function isFailureResult(result, outcome) {
  return failureOutcome(result, outcome) !== null;
}

/** Session pin → diagnostics `session` block (strings only, absent stays absent). */
function pinSession(pin) {
  if (pin === null || typeof pin !== "object") return undefined;
  const s = {};
  for (const k of ["sessionId", "aeVersion", "dispatchId"]) {
    if (typeof pin[k] === "string") s[k] = pin[k];
  }
  return Object.keys(s).length > 0 ? s : undefined;
}

/**
 * Pick the diagnostics record for one failure. A host-reported error
 * (runner `error` field: name/message/line?/file?/hostReported) becomes a
 * script-exception via fromAeError; everything else becomes a
 * transport-outcome record carrying the refusal/failure detail.
 */
function recordForFailure(libs, { result, outcome, session, requestId }) {
  const ctx = {
    session: pinSession(session?.pin),
    requestId: typeof requestId === "string" ? requestId : undefined,
    outcome: typeof outcome === "string" ? outcome : undefined,
  };
  const hostErr = result?.error;
  if (hostErr !== null && typeof hostErr === "object" && typeof hostErr.message === "string" && hostErr.message.length > 0) {
    // runner.mjs already normalized the codec aeError wrapper to inner
    // fields; fromAeError accepts either shape.
    return libs.collectors.fromAeError(hostErr, { ctx });
  }
  // The failure-bearing status wins over a COMPLETED wire outcome
  // (adapter ok:false payloads); failureOutcome normalizes every
  // spelling to the wire vocabulary.
  const state = failureOutcome(result, outcome) ?? wireState(result?.outcome ?? outcome ?? result?.status);
  const adapterMsg =
    result?.adapterError?.error?.message ??
    (typeof result?.adapterError?.message === "string" ? result.adapterError.message : null) ??
    (typeof result?.adapterError === "string" ? result.adapterError : null);
  // `code` carries the machine reason exactly once (reason / wire
  // refusal code); `detail` carries the human-readable fields —
  // including the host's refusal message, which used to be dropped.
  const detail = [
    result?.detail,
    result?.refusal?.message,
    result?.unknownCategory,
    adapterMsg,
  ].filter((v) => typeof v === "string" && v.length > 0).join(" ");
  return libs.collectors.fromTransportOutcome(
    { outcome: state, code: result?.reason ?? result?.refusal?.code ?? null, detail: detail || null },
    { ctx },
  );
}

/**
 * Build the additive `diagnostics` block for a failed execute/verify
 * evidence record. Never throws: a missing diagnostics checkout degrades
 * to status "unavailable"; a record-build/resolution failure degrades to
 * status "error" — the two are distinct so consumers can tell "module
 * not installed" from "module ran but failed".
 */
export async function buildFailureDiagnostics({ result, outcome, session, requestId, mapDir } = {}) {
  const block = {
    schema: DIAGNOSTICS_BLOCK_SCHEMA,
    status: "ok",
    reason: null,
    records: [],
    resolutions: [],
    mapDir: typeof mapDir === "string" ? mapDir : null,
  };
  const libs = await loadDiagnosticsLibs();
  if (libs.error) {
    block.status = "unavailable";
    block.reason = `packaged diagnostics not loadable: ${libs.error}`;
    return block;
  }
  try {
    const record = recordForFailure(libs, { result, outcome, session, requestId });
    // Evidence label honesty: "fake" only for fake sessions; "real-host"
    // only when the failure was actually observed through the host /
    // transport on an owned AE session (a wire outcome or a host error
    // reply). A client-side refusal never reached the host, and an
    // absent/unknown session proves nothing — leave `evidence` absent
    // rather than claim an observation that did not happen.
    const hostObserved =
      (result !== null && typeof result === "object" && typeof result.outcome === "string") ||
      (result !== null && typeof result === "object" && result.error !== null && typeof result.error === "object");
    if (session?.kind === "fake") {
      record.evidence = "fake";
    } else if (session?.kind === "a8n" && hostObserved) {
      record.evidence = "real-host";
    } else {
      delete record.evidence;
    }
    block.records.push(record);
    const opts = {};
    if (typeof mapDir === "string" && mapDir.length > 0) opts.mapDir = mapDir;
    block.resolutions.push(libs.sourceMap.resolveDiagnosticsSource(record, opts));
  } catch (e) {
    block.status = "error";
    block.reason = String(e?.message ?? e);
  }
  return block;
}

// ---------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Resolve the diagnose target to { path, parsed, via } or an error note. */
function resolveTarget(input, { dir = RUNS_DIR } = {}) {
  const direct = resolve(input);
  if (existsSync(direct)) {
    return { path: direct, via: "path" };
  }
  // Bare runId / marker name: look in the runs dir.
  for (const cand of [join(dir, `${input}.json`), join(dir, input)]) {
    if (existsSync(cand)) return { path: cand, via: "run-marker" };
  }
  return null;
}

/**
 * Extract diagnostics records from a parsed JSON document.
 * Returns { records, notes, followUp } — followUp is a path to load next
 * (run marker → linked evidence file).
 */
function recordsFromDocument(parsed, { recordVersion = DIAGNOSTICS_RECORD_VERSION } = {}) {
  const notes = [];
  if (parsed === null || typeof parsed !== "object") {
    return { records: [], notes: ["target is not a JSON object"], followUp: null };
  }
  if (parsed.recordVersion === recordVersion) {
    return { records: [parsed], source: "diagnostics-record", notes, followUp: null };
  }
  if (parsed.schema === "ae-devtools.cli.error/v1") {
    // The CLI writes this shape to --out when execute/verify throws
    // before producing a run record — say so instead of the generic
    // "unrecognized document" note.
    notes.push(
      `CLI run failed before producing a result (${parsed.code ?? "?"})` +
      (typeof parsed.message === "string" ? `: ${parsed.message}` : ""),
    );
    return { records: [], source: "cli-error", notes, followUp: null };
  }
  if (parsed.schema === "ae-devtools.cli.run/v1") {
    const d = parsed.diagnostics;
    if (d && Array.isArray(d.records) && d.records.length > 0) {
      return { records: d.records, source: "cli-run-evidence", notes, followUp: null };
    }
    notes.push("evidence record carries no diagnostics block (outcome was not a failure, or diagnostics were unavailable at run time)");
    return { records: [], source: "cli-run-evidence", notes, followUp: null };
  }
  if (parsed.schema === RUN_GUARD_SCHEMA) {
    if (typeof parsed.evidenceFile === "string" && existsSync(parsed.evidenceFile)) {
      return {
        records: [], source: "run-marker",
        notes: [`run marker ${parsed.runId ?? "?"} (status ${parsed.status ?? "?"}) links evidence file ${parsed.evidenceFile}`],
        followUp: parsed.evidenceFile,
      };
    }
    notes.push(`run marker ${parsed.runId ?? "?"} (status ${parsed.status ?? "?"}) has no linked evidence file — re-run with --out <file> to keep a diagnosable record`);
    return { records: [], source: "run-marker", notes, followUp: null };
  }
  notes.push(`unrecognized document (schema ${JSON.stringify(parsed.schema ?? parsed.recordVersion ?? null)})`);
  return { records: [], source: "unknown", notes, followUp: null };
}

/**
 * `ae-devtools diagnose <record.json|marker|runId>` — read a stored
 * diagnostics/evidence/marker record and report fresh sourcemap
 * resolution for every diagnostics record it contains. Read-only: no
 * dispatch, no session, no AE contact.
 *
 * flags: --map-dir <d> --jsx <p> --jsx-map <p> --bundle-map <p>
 * Returns { code, payload }.
 */
export async function runDiagnose(input, flags = {}, { dir = RUNS_DIR } = {}) {
  const payload = {
    schema: DIAGNOSE_SCHEMA,
    target: { input, resolvedPath: null, via: null },
    libs: null,
    source: null,
    recordCount: 0,
    results: [],
    notes: [],
    evidenceLevel: "local file reads only — no AE was contacted",
  };

  const libs = await loadDiagnosticsLibs();
  if (libs.error) {
    payload.libs = { status: "unavailable", reason: libs.error };
    payload.notes.push("packaged diagnostics/ is not loadable from this install; sourcemap resolution unavailable");
    return { code: 2, payload };
  }
  // The record version is owned by the packaged schema module — take it
  // from the loaded libs so a version bump there cannot silently break
  // recognition of stored records here.
  const recordVersion = libs.schema?.DIAGNOSTICS_RECORD_VERSION ?? DIAGNOSTICS_RECORD_VERSION;
  payload.libs = { status: "ok", recordVersion };

  const found = resolveTarget(input, { dir });
  if (found === null) {
    payload.notes.push(`no such file or run marker: ${input}`);
    return { code: 2, payload };
  }
  payload.target.resolvedPath = found.path;
  payload.target.via = found.via;

  let parsed;
  try {
    parsed = readJsonFile(found.path);
  } catch (e) {
    payload.notes.push(`cannot read ${found.path}: ${e.message}`);
    return { code: 2, payload };
  }

  const opts = {};
  if (typeof flags["map-dir"] === "string") opts.mapDir = flags["map-dir"];
  if (typeof flags.jsx === "string") opts.jsxPath = flags.jsx;
  if (typeof flags["jsx-map"] === "string") opts.jsxMapPath = flags["jsx-map"];
  if (typeof flags["bundle-map"] === "string") opts.bundleMapPath = flags["bundle-map"];

  // A run marker may link to the evidence file that holds the records.
  let doc = recordsFromDocument(parsed, { recordVersion });
  payload.source = doc.source;
  payload.notes.push(...doc.notes);
  if (doc.followUp !== null) {
    try {
      const follow = recordsFromDocument(readJsonFile(doc.followUp), { recordVersion });
      payload.notes.push(...follow.notes);
      if (follow.records.length > 0) {
        doc = { ...follow, source: `${doc.source} → ${follow.source}` };
        payload.source = doc.source;
      }
    } catch (e) {
      payload.notes.push(`cannot read linked evidence ${doc.followUp}: ${e.message}`);
    }
  }

  payload.recordCount = doc.records.length;
  for (const record of doc.records) {
    const entry = { record: null, resolution: null, recordValid: null };
    try {
      libs.schema.validateDiagnosticsRecord(record);
      entry.recordValid = true;
    } catch (e) {
      entry.recordValid = false;
      entry.validationError = String(e?.message ?? e);
    }
    entry.record = {
      kind: record?.kind ?? null,
      severity: record?.severity ?? null,
      message: typeof record?.message === "string" ? record.message.slice(0, 300) : null,
      collector: record?.collector ?? null,
      source: record?.source ?? null,
    };
    try {
      entry.resolution = libs.sourceMap.resolveDiagnosticsSource(record, opts);
    } catch (e) {
      entry.resolution = { schema: null, status: "error", reason: String(e?.message ?? e) };
    }
    payload.results.push(entry);
  }
  return { code: 0, payload };
}
