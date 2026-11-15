/**
 * preflight.mjs — attach precondition checks for the
 * `extendscript-debug` lane (Issue #53).
 *
 * Answers three questions WITHOUT launching AE or touching a debug
 * session:
 *
 *   1. Does `hostAppSpecifier` plausibly name an installed Adobe app?
 *      The extension itself discovers installed apps and shows their
 *      specifiers only inside VS Code — offline we can detect installed
 *      .app bundles and versions, but the exact specifier string is
 *      extension-reported, so a version-plausible match is reported as
 *      a CANDIDATE, never as proof.
 *
 *   2. How many After Effects processes are running? `hostAppSpecifier`
 *      selects family+version, NOT a PID. With multiple AE instances
 *      the extension's target is ambiguous — attach could land on a
 *      non-owned instance. Multiple instances therefore refuse the
 *      unambiguous-target verdict unless `--owned-pid` attests which
 *      process is the ae-a8n owned session.
 *
 *   3. Can we prove the attach lands on the OWNED session? launch.json
 *      cannot express PID pinning. `--owned-pid` is a caller attestation
 *      (the session owner knows which PID it launched); without it,
 *      ownership is UNPROVEN and the verdict says so explicitly.
 *
 * Nothing here claims debug completion: even a clean preflight leaves
 * protocol acceptance (ESTK-derived debug protocol on AE 2026/2027)
 * UNVERIFIED — that requires a real attach.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOST_APP_SPECIFIER_RE } from "./schema.mjs";

export const PREFLIGHT_SCHEMA = "ae-devtools.vscode-debugger.preflight/v1";

const AE_FAMILY = "aftereffects";
const APP_DIRS = ["/Applications", join(process.env.HOME ?? "", "Applications")];

/** Parse `aftereffects-27.0` -> { family, version:"27.0" }. */
export function parseSpecifier(specifier) {
  if (typeof specifier !== "string" || !HOST_APP_SPECIFIER_RE.test(specifier)) return null;
  const dash = specifier.indexOf("-");
  return { family: specifier.slice(0, dash), version: specifier.slice(dash + 1) };
}

/**
 * Version plausibility: specifier "27.0" matches installed "27.0.x" /
 * "27.x". Returns true/false/null(unknown — version unreadable).
 */
export function versionPlausible(specVersion, appVersion) {
  if (typeof specVersion !== "string" || typeof appVersion !== "string") return null;
  const specParts = specVersion.split(".").map(Number);
  const appParts = appVersion.split(".").map(Number);
  if (specParts.some(Number.isNaN) || appParts.some(Number.isNaN)) return null;
  // Compare the numeric components the specifier declares: a specifier
  // "27.0" is satisfied by app "27.0.x" or "27.x" (minor unspecified
  // when the app only exposes major).
  for (let i = 0; i < specParts.length; i++) {
    if (appParts[i] === undefined) return specParts.slice(i).every((n) => n === 0);
    if (specParts[i] !== appParts[i]) return false;
  }
  return true;
}

/**
 * Pure verdict evaluation — fully testable without a host.
 *
 * input: {
 *   specifier,                // string|null
 *   installedApps,            // [{name, bundleId, version, path}] — After Effects only
 *   aeProcesses,              // [{pid, command}] — running AE processes
 *   ownedPid,                 // number|null — caller-attested owned session PID
 * }
 */
export function evaluatePreflight({ specifier = null, installedApps = [], aeProcesses = [], ownedPid = null } = {}) {
  const reasons = [];
  const checks = {};
  const parsed = specifier == null ? null : parseSpecifier(specifier);

  // --- specifier format + install plausibility ---
  if (specifier != null && !parsed) {
    reasons.push(`hostAppSpecifier ${JSON.stringify(specifier)} fails the documented 'appname-x.y' shape`);
    checks.specifier = { status: "invalid", detail: specifier };
  } else if (parsed) {
    if (parsed.family !== AE_FAMILY) {
      reasons.push(`hostAppSpecifier family '${parsed.family}' is outside this lane's scope (After Effects only)`);
      checks.specifier = { status: "out-of-scope", detail: specifier };
    } else {
      const plausible = installedApps
        .map((app) => ({ app, match: versionPlausible(parsed.version, app.version) }))
        .filter((x) => x.match !== false);
      const candidates = plausible.filter((x) => x.match === true);
      checks.specifier = {
        status: candidates.length > 0 ? "candidate-match" : plausible.length > 0 ? "version-unreadable" : "no-installed-match",
        detail: specifier,
        // The authoritative specifier is reported by the extension's app
        // picker; offline we can only say an installed app plausibly
        // produces it. Never claim this as proof.
        proof: "unverified — confirm via the extension's app picker or a real attach",
        candidates: candidates.map((x) => x.app.name),
      };
      if (plausible.length === 0) {
        reasons.push(`no installed After Effects app plausibly matches ${specifier} — the specifier is likely wrong or the app is not installed`);
      }
    }
  } else {
    checks.specifier = { status: "unpinned", detail: null };
    reasons.push("no hostAppSpecifier — attach will show the extension's app picker; target cannot be pre-validated");
  }

  // --- running instances ---
  checks.instances = { count: aeProcesses.length, pids: aeProcesses.map((p) => p.pid) };
  let ownedAttested = false;
  if (ownedPid != null) {
    const hit = aeProcesses.find((p) => p.pid === ownedPid);
    if (hit) {
      ownedAttested = true;
      checks.ownedSession = { status: "attested", pid: ownedPid, command: hit.command };
    } else {
      checks.ownedSession = { status: "attestation-failed", pid: ownedPid };
      reasons.push(`--owned-pid ${ownedPid} is not a running After Effects process — cannot prove owned-session attach`);
    }
  } else {
    checks.ownedSession = { status: "unattested", detail: "launch.json cannot pin a PID; pass --owned-pid with the ae-a8n owned session's PID to attest" };
  }

  // --- verdict ---
  let verdict;
  if (checks.specifier.status === "invalid" || checks.specifier.status === "out-of-scope" || checks.specifier.status === "no-installed-match") {
    verdict = "blocked-specifier";
  } else if (aeProcesses.length === 0) {
    verdict = "no-running-instance";
    reasons.push("no After Effects process is running — attach has no target (launch AE via the owned-session path first)");
  } else if (aeProcesses.length > 1 && !ownedAttested) {
    verdict = "ambiguous-multiple-instances";
    reasons.push(`${aeProcesses.length} After Effects processes are running and no --owned-pid attests which is the owned session — attach target is ambiguous; refusing to claim an unambiguous attach`);
  } else if (aeProcesses.length > 1 && ownedAttested) {
    verdict = "ready-owned-session";
  } else if (ownedAttested) {
    verdict = "ready-owned-session";
  } else {
    verdict = "ready-unowned-single-instance";
    reasons.push("exactly one After Effects process is running, but nothing proves it is the ae-a8n owned session — attach would reach it, ownership UNPROVEN");
  }

  return {
    schema: PREFLIGHT_SCHEMA,
    verdict,
    attachAttemptable: ["ready-owned-session", "ready-unowned-single-instance"].includes(verdict),
    // We never claim the debug session will succeed: protocol
    // acceptance on this AE version is real-host UNVERIFIED.
    debugCompletionClaimed: false,
    protocolStatus: "unverified — ESTK-derived debug protocol acceptance on AE 2026/2027 requires a real attach",
    checks,
    reasons,
  };
}

// ------------------------------------------------------------- darwin IO

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

/** Read a plist string value via PlistBuddy (read-only). */
function plistValue(appPath, key) {
  try {
    return sh("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents", "Info.plist")]).trim();
  } catch {
    return null;
  }
}

/**
 * Discover installed After Effects .app bundles (read-only).
 *
 * Real layout on macOS: `/Applications/Adobe After Effects 2026/` is a
 * *folder* containing `Adobe After Effects 2026.app` — so .app bundles
 * are found both directly under the app dirs and one level deep.
 */
export function discoverAdobeApps({ dirs = APP_DIRS } = {}) {
  const apps = [];
  const consider = (appPath) => {
    if (!appPath.endsWith(".app") || !existsSync(join(appPath, "Contents", "Info.plist"))) return;
    const bundleId = plistValue(appPath, "CFBundleIdentifier");
    // Real bundle id is com.adobe.AfterEffects.application (observed on
    // AE 2026/2027 installs). The Render Engine companion app
    // (com.adobe.AfterEffectsRenderEngine, aerender) is NOT a debuggable
    // host and is excluded.
    if (!bundleId || !bundleId.startsWith("com.adobe.AfterEffects") || bundleId.includes("RenderEngine")) return;
    apps.push({
      name: appPath.split("/").pop().slice(0, -4),
      bundleId,
      version: plistValue(appPath, "CFBundleShortVersionString"),
      path: appPath,
    });
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (entry.endsWith(".app")) {
        consider(p);
      } else {
        // e.g. "Adobe After Effects 2026/" folder holding the .app
        try {
          for (const sub of readdirSync(p)) {
            if (sub.endsWith(".app")) consider(join(p, sub));
          }
        } catch { /* not a readable dir */ }
      }
    }
  }
  return apps;
}

/**
 * PIDs of running After Effects MAIN processes (read-only pgrep/ps).
 *
 * The pattern targets the main executable `Contents/MacOS/After
 * Effects` — helper processes (CEPHtmlEngine, GPU/Renderer helpers)
 * live under differently-named binaries and must not count as
 * instances.
 */
export function findAfterEffectsProcesses() {
  let out;
  try {
    out = sh("pgrep", ["-f", "MacOS/After Effects([[:space:]]|$)"]);
  } catch {
    return []; // pgrep exits 1 on no match
  }
  return out.split("\n").map((s) => s.trim()).filter(Boolean).map((pid) => {
    let command = null;
    try { command = sh("ps", ["-p", pid, "-o", "comm="]).trim(); } catch { /* gone */ }
    return { pid: Number(pid), command };
  });
}

/**
 * Gather live state and evaluate. `deps` allows test injection.
 */
export function runPreflight({ specifier = null, ownedPid = null, deps = {} } = {}) {
  const discover = deps.discoverAdobeApps ?? discoverAdobeApps;
  const findProcs = deps.findAfterEffectsProcesses ?? findAfterEffectsProcesses;
  return evaluatePreflight({
    specifier,
    ownedPid,
    installedApps: discover(),
    aeProcesses: findProcs(),
  });
}
