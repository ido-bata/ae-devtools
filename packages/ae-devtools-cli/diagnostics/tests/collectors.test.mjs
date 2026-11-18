/**
 * Tests for diagnostics collectors — automated-test / fake-level
 * evidence only. No After Effects is involved.
 *
 * The native-crash tests drive the REAL manifest shape: a synthetic
 * .ips file is collected by recovery-orchestrator's own
 * `collectCrashEvidence`, then normalized by `fromCrashEvidence`.
 * The panel-log tests parse the clearly-fake fixture under
 * ./fixtures/panel-logs (not a real CEP log).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fromCrashEvidence,
  fromPanelLog,
  collectPanelLogs,
  fromRenderItem,
} from "../collectors.mjs";
import { collectCrashEvidence } from "../../recovery-orchestrator/orchestrator.mjs";
import { validateDiagnosticsRecord } from "../schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_FIXTURE_DIR = join(HERE, "fixtures", "panel-logs");
const PANEL_FIXTURE = join(PANEL_FIXTURE_DIR, "CEPHtmlEngine-fake-2026.log");

// --- native-crash ---------------------------------------------------------

function makeIpsFixture(dir) {
  const reports = join(dir, "reports");
  mkdirSync(reports, { recursive: true });
  const header = {
    app_name: "After Effects",
    timestamp: "2026-01-01 09:00:05.000 +0900",
    app_version: "27.0.0",
    build_version: "27",
    bundleID: "com.adobe.AfterEffects",
    bug_type: "309",
    incident_id: "FAKE-FIXTURE-0001",
  };
  const body = {
    pid: 4242,
    procName: "After Effects",
    procPath: "/fake/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/Adobe After Effects 2026",
    procLaunch: "2026-01-01 09:00:00.0000 +0900",
    captureTime: "2026-01-01 09:00:05.1234 +0900",
    userID: 501,
  };
  writeFileSync(join(reports, "After Effects-2026-01-01-090005.ips"), `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`);
  return reports;
}

const CRASH_TARGET = {
  pid: 4242,
  procName: "After Effects",
  appName: "After Effects",
  appVersion: "27.0.0",
  procPath: "/fake/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/Adobe After Effects 2026",
  procLaunch: "2026-01-01 09:00:00.0000 +0900",
  runId: "fixture-run",
};

test("fromCrashEvidence: real collectCrashEvidence manifest → native-crash record", () => {
  const dir = mkdtempSync(join(tmpdir(), "diag-crash-"));
  try {
    const reports = makeIpsFixture(dir);
    const manifest = collectCrashEvidence({
      since: "2025-01-01T00:00:00Z",
      outDir: join(dir, "evidence"),
      reportsDirs: [reports],
      sentryDirs: [],
      target: CRASH_TARGET,
    });
    assert.equal(manifest.counts.correlated, 1);

    const records = fromCrashEvidence(manifest);
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.kind, "native-crash");
    assert.equal(rec.severity, "error");
    assert.equal(rec.outcome, "crash-correlated");
    assert.equal(rec.evidence, "fake");
    // artifactHashes pins the preserved report bytes by sha256
    const hashes = Object.values(rec.artifactHashes ?? {});
    assert.equal(hashes.length, 1);
    assert.match(hashes[0], /^[0-9a-f]{64}$/);
    // and the pinned hash matches the copied artifact on disk
    const dest = Object.keys(rec.artifactHashes)[0];
    assert.equal(
      createHash("sha256").update(readFileSync(dest)).digest("hex"),
      rec.artifactHashes[dest],
    );
    validateDiagnosticsRecord(rec); // schema-clean
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fromCrashEvidence: empty-but-complete manifest yields no records", () => {
  const records = fromCrashEvidence({
    kind: "crash-evidence",
    complete: true,
    counts: { correlated: 0, candidate: 0, unrelated: 0, unclassified: 0 },
    correlated: [],
    target: {},
  });
  assert.deepEqual(records, []);
});

test("fromCrashEvidence: incomplete collection surfaces a warning record", () => {
  const records = fromCrashEvidence({
    kind: "crash-evidence",
    complete: false,
    incompleteReasons: ["unreadable reports dir: /x (EACCES)"],
    counts: { correlated: 0 },
    correlated: [],
    target: {},
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "transport-outcome");
  assert.equal(records[0].severity, "warning");
  assert.match(records[0].message, /incomplete/);
});

test("fromCrashEvidence: refuses non-manifest input", () => {
  assert.throws(() => fromCrashEvidence(null), /crash-evidence/);
  assert.throws(() => fromCrashEvidence({ kind: "other" }), /crash-evidence/);
});

// --- panel-log ------------------------------------------------------------

test("fromPanelLog: fixture lines map to severity; unparseable lines skipped", () => {
  const text = readFileSync(PANEL_FIXTURE, "utf8");
  const { records, skipped } = fromPanelLog(text, { path: PANEL_FIXTURE });
  assert.equal(records.length, 5);
  assert.equal(skipped, 4); // 3 comment lines + 1 plain continuation line
  const sevOf = (needle) => records.find((r) => r.message.includes(needle))?.severity;
  assert.equal(sevOf("cannot evaluate"), "error");
  assert.equal(sevOf("slow asset"), "warning");
  assert.equal(sevOf("DEBUG"), "info"); // DEBUG normalizes to info
  assert.equal(sevOf("panel ready"), "info");
  for (const r of records) {
    assert.equal(r.kind, "panel-log");
    assert.equal(r.source.assetKind, "panel-asset");
    assert.equal(r.source.path, PANEL_FIXTURE);
    assert.equal(r.source.line, undefined); // log line ≠ asset position
    assert.equal(r.evidence, "fake");
    assert.equal(r.artifactHashes[PANEL_FIXTURE], createHash("sha256").update(text, "utf8").digest("hex"));
    validateDiagnosticsRecord(r);
  }
  // leading timestamp becomes occurredAt
  assert.equal(records[0].occurredAt, "2026-01-01T09:00:00.000Z");
});

test("fromPanelLog: refuses non-string input", () => {
  assert.throws(() => fromPanelLog(null), /log text/);
  assert.throws(() => fromPanelLog({}), /log text/);
});

test("collectPanelLogs: fixture dir yields records, ignores non-matching files", () => {
  const res = collectPanelLogs({ logDir: PANEL_FIXTURE_DIR });
  assert.equal(res.complete, true);
  assert.deepEqual(res.errors, []);
  assert.equal(res.files.length, 1); // other-app.log filtered out
  assert.equal(res.files[0].path, PANEL_FIXTURE);
  assert.ok(res.files[0].bytes > 0);
  assert.equal(res.records.length, 5);
  assert.equal(res.skippedLines, 4);
});

test("collectPanelLogs: missing dir is explicit incomplete, never fabricated", () => {
  const res = collectPanelLogs({ logDir: join(PANEL_FIXTURE_DIR, "does-not-exist") });
  assert.equal(res.complete, false);
  assert.equal(res.records.length, 0);
  assert.equal(res.files.length, 0);
  assert.ok(res.errors.length > 0);
  assert.match(res.errors[0], /unreadable log dir/);
});

test("collectPanelLogs: unsupported platform reports incomplete", () => {
  const res = collectPanelLogs({ platform: "linux" });
  assert.equal(res.complete, false);
  assert.equal(res.records.length, 0);
  assert.ok(res.errors.length > 0);
});

// --- render-failure ---------------------------------------------------------

test("fromRenderItem: error-ish status → error severity", () => {
  const rec = fromRenderItem({ status: "ERR_STOPPED", error: "fixture: output path unwritable" });
  assert.equal(rec.kind, "render-failure");
  assert.equal(rec.severity, "error");
  assert.equal(rec.source.assetKind, "render-output");
  assert.equal(rec.outcome, "ERR_STOPPED");
  assert.match(rec.message, /unwritable/);
  assert.equal(rec.source.line, undefined);
  validateDiagnosticsRecord(rec);
});

test("fromRenderItem: non-error status → warning, bare string accepted", () => {
  const rec = fromRenderItem("USER_STOPPED");
  assert.equal(rec.severity, "warning");
  assert.equal(rec.message, 'render queue item status "USER_STOPPED"');
});

test("fromRenderItem: refuses missing status", () => {
  assert.throws(() => fromRenderItem({}), /status/);
  assert.throws(() => fromRenderItem(null), /status/);
  assert.throws(() => fromRenderItem({ status: "" }), /status/);
});
