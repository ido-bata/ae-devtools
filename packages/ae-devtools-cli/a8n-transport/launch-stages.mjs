/**
 * launch-stages.mjs — staged AE launch diagnostics (Issue #144 follow-up).
 *
 * The 2026-11-17 AE 2027 launch-blocked incident (#144 comments) showed a
 * single "launch failed" outcome hides which stage actually failed. This
 * module decomposes the openSliceSession path into named stages and
 * reports each one honestly:
 *
 *   PASS     — stage ran and its contract held
 *   FAIL     — stage ran and refused/errored (detail carries the reason)
 *   BLOCKED  — stage cannot run in this context (e.g. needs real AE)
 *   UNKNOWN  — stage is not observable from this side at all
 *
 * Hard rules (same discipline as the rest of a8n-transport):
 *   - No stage guesses a downstream result. A stage that was never
 *     reached is BLOCKED, not assumed.
 *   - GUI/modal state, host-internal busy state and Adobe-bundled plugin
 *     behavior (e.g. the UXP ae-mcp-bridge exception seen in #144 logs)
 *     are UNOBSERVABLE from Node — they report UNKNOWN with the log
 *     locations a human can check, never a root-cause claim.
 *   - Nothing here disables, reconfigures or works around Adobe bundled
 *     features; setup guidance points at owned-session/installer facts
 *     only.
 *
 * Stages 1–3 (resolution, contract gates, host-script build) are
 * executable now via injectable probes; stages 4–7 require a real AE
 * session and report BLOCKED/UNKNOWN until a real run supplies the
 * observation — matching the release-candidate real-host acceptance
 * lane, not fake-level claims.
 */

export const LAUNCH_DIAG_SCHEMA = "ae-devtools.a8n-launch-diag/v1";

export const LAUNCH_STAGES = Object.freeze([
  "ae-a8n-resolution",
  "contract-gates",
  "host-script-build",
  "ae-launch",
  "ownership",
  "gui-modal-state",
  "dispatch-result",
]);

const STAGE_STATUS = Object.freeze(["PASS", "FAIL", "BLOCKED", "UNKNOWN"]);

function stage(id, status, detail, extra = {}) {
  return { id, status, detail, ...extra };
}

const HOST_SCRIPT_BUILD_DEFAULT = {
  BLOCKED: "host-script build requires the ae-a8n CLI dist build; pass buildHostScript probe or run openSliceSession",
};

/**
 * @param {object} options
 *   aeA8nRoot      — local ae-a8n checkout root (dist/ built) or null for npm pin
 *   probes         — injectable stage probes for tests/real runs:
 *     loadModule()            -> { mod, source, version }   (stage 1)
 *     runContractGates(mod)   -> { ok, failures }           (stage 2)
 *     buildHostScript(workdir)-> { path }                   (stage 3)
 *     launch({hostScript})    -> session-ish                (stage 4)
 *     checkOwnership(ae)      -> ownership object           (stage 5)
 *     observeGui()            -> gui observation or null    (stage 6)
 *     dispatchProbe(ae)       -> outcome                    (stage 7)
 *   workdir        — scratch dir forwarded to buildHostScript
 */
export async function diagnoseLaunchStages(options = {}) {
  const probes = options.probes ?? {};
  const stages = [];

  // --- 1. ae-a8n resolution -------------------------------------------
  let mod = null;
  let aeA8nSource = null;
  try {
    if (typeof probes.loadModule === "function") {
      const loaded = await probes.loadModule();
      mod = loaded.mod ?? null;
      aeA8nSource = loaded.source ?? null;
      stages.push(stage("ae-a8n-resolution", "PASS",
        `module resolved (${aeA8nSource ?? "unknown source"})`));
    } else {
      stages.push(stage("ae-a8n-resolution", "BLOCKED",
        "no loadModule probe — resolution happens inside openSliceSession; run it or inject the probe"));
    }
  } catch (e) {
    stages.push(stage("ae-a8n-resolution", "FAIL",
      `module resolution failed: ${e?.message ?? e}`));
    return finish(stages, options);
  }

  // --- 2. contract gates ------------------------------------------------
  if (mod && typeof probes.runContractGates === "function") {
    try {
      const r = await probes.runContractGates(mod);
      stages.push(r.ok
        ? stage("contract-gates", "PASS", "export + handshake contract battery passed")
        : stage("contract-gates", "FAIL",
            `contract battery failed: ${(r.failures ?? []).map((f) => f.id ?? f).join(", ")}`));
      if (!r.ok) return finish(stages, options);
    } catch (e) {
      stages.push(stage("contract-gates", "FAIL", `contract gate error: ${e?.message ?? e}`));
      return finish(stages, options);
    }
  } else {
    stages.push(stage("contract-gates", "BLOCKED",
      mod ? "runContractGates probe not supplied" : "no module to gate"));
    if (!mod) {
      for (const id of ["host-script-build", "ae-launch", "ownership", "dispatch-result"]) {
        stages.push(stage(id, "BLOCKED", "not reached — no ae-a8n module resolved"));
      }
      stages.push(stage("gui-modal-state", "UNKNOWN",
        "not observable from Node — see stage detail in full report"));
      return finish(stages, options);
    }
  }

  // --- 3. host-script build --------------------------------------------
  if (typeof probes.buildHostScript === "function") {
    try {
      const r = await probes.buildHostScript(options.workdir);
      stages.push(stage("host-script-build", "PASS", `host script at ${r?.path ?? "(path unreported)"}`));
    } catch (e) {
      stages.push(stage("host-script-build", "FAIL", `extension build failed: ${e?.message ?? e}`));
      return finish(stages, options);
    }
  } else {
    stages.push(stage("host-script-build", "BLOCKED", HOST_SCRIPT_BUILD_DEFAULT.BLOCKED));
  }

  // --- 4. AE launch ------------------------------------------------------
  // Real launch is NEVER attempted by this diagnostic — it is the
  // real-host lane. A supplied probe result is recorded verbatim.
  if (typeof probes.launch === "function") {
    try {
      const ae = await probes.launch({ workdir: options.workdir });
      stages.push(stage("ae-launch", "PASS", "launch probe returned a session object"));
      // --- 5. ownership ---
      if (typeof probes.checkOwnership === "function") {
        try {
          const ownership = await probes.checkOwnership(ae);
          const kind = ownership?.kind ?? null;
          stages.push(kind === "owned"
            ? stage("ownership", "PASS", `ownership.kind=${kind}`)
            : stage("ownership", "FAIL", `ownership.kind=${JSON.stringify(kind)} — slice requires owned`));
        } catch (e) {
          stages.push(stage("ownership", "FAIL", `ownership check failed: ${e?.message ?? e}`));
        }
      } else {
        stages.push(stage("ownership", "BLOCKED", "checkOwnership probe not supplied"));
      }
      // --- 6. GUI / modal state ------------------------------------------
      // UNOBSERVABLE from Node: no API reports modal dialogs, UXP plugin
      // init state, or ExtendScript engine busy-ness. A probe MAY supply
      // an observation (e.g. a screenshot/log correlation done by a
      // human); absent that, this stage is UNKNOWN — never guessed.
      if (typeof probes.observeGui === "function") {
        try {
          const obs = await probes.observeGui(ae);
          stages.push(obs && typeof obs === "object"
            ? stage("gui-modal-state", obs.status ?? "UNKNOWN",
                obs.detail ?? "GUI observation supplied by probe",
                obs.status === "PASS" || obs.status === "FAIL" ? {} : { unobservable: true })
            : stage("gui-modal-state", "UNKNOWN", "observeGui returned no observation"));
        } catch (e) {
          stages.push(stage("gui-modal-state", "UNKNOWN",
            `GUI state is not observable from Node (${e?.message ?? e}); check AE UXPLogs + GUI manually`));
        }
      } else {
        stages.push(stage("gui-modal-state", "UNKNOWN",
          "not observable from Node — correlate ~/Library/Logs/Adobe/Adobe After Effects <ver>/UXPLogs_* and the GUI manually; do NOT infer root cause from ae-mcp-bridge exceptions alone"));
      }
      // --- 7. dispatch / result -------------------------------------------
      if (typeof probes.dispatchProbe === "function") {
        try {
          const out = await probes.dispatchProbe(ae);
          stages.push(stage("dispatch-result", out?.ok === true ? "PASS" : "FAIL",
            out?.detail ?? `dispatch probe outcome=${out?.outcome ?? "unreported"}`));
        } catch (e) {
          stages.push(stage("dispatch-result", "UNKNOWN",
            `dispatch outcome unobservable (${e?.message ?? e}); UNKNOWN is never retried`));
        }
      } else {
        stages.push(stage("dispatch-result", "BLOCKED", "dispatchProbe probe not supplied"));
      }
      if (typeof ae.close === "function") {
        await ae.close({ unsavedChanges: "refuse" }).catch(() => {});
      }
    } catch (e) {
      stages.push(stage("ae-launch", "FAIL", `launch failed: ${e?.message ?? e}`));
      // Downstream stages cannot be evaluated — a launch failure does
      // not imply ownership/GUI/dispatch state.
      for (const id of ["ownership", "gui-modal-state", "dispatch-result"]) {
        stages.push(stage(id, "BLOCKED", "not reached — ae-launch failed"));
      }
    }
  } else {
    stages.push(stage("ae-launch", "BLOCKED",
      "real AE launch is the release-candidate real-host lane; inject a launch probe or run openSliceSession on an owned session"));
    for (const id of ["ownership", "gui-modal-state", "dispatch-result"]) {
      stages.push(id === "gui-modal-state" ? stage(id, "UNKNOWN",
        "not observable from Node — see stage detail in full report")
        : stage(id, "BLOCKED", "not reached — ae-launch not attempted"));
    }
  }

  return finish(stages, options);
}

function finish(stages, options) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 };
  for (const s of stages) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const worst = stages.some((s) => s.status === "FAIL") ? "FAIL"
    : stages.some((s) => s.status === "UNKNOWN") ? "UNKNOWN"
    : stages.some((s) => s.status === "BLOCKED") ? "BLOCKED" : "PASS";
  return {
    schema: LAUNCH_DIAG_SCHEMA,
    verdict: worst,
    counts,
    stages: stages.map((s) => ({ id: s.id, status: s.status, detail: s.detail })),
    guidance: buildGuidance(stages),
    honesty:
      "Stage statuses are observations or explicit BLOCKED/UNKNOWN — " +
      "nothing here claims a root cause for host-side failures (modal, " +
      "UXP plugin init, ExtendScript busy state) and nothing disables or " +
      "reconfigures Adobe bundled features.",
    aeA8nRoot: options.aeA8nRoot ?? null,
  };
}

function buildGuidance(stages) {
  const byId = Object.fromEntries(stages.map((s) => [s.id, s]));
  const tips = [];
  if (byId["ae-a8n-resolution"]?.status === "FAIL") {
    tips.push("Resolve @ido-bata/ae-a8n: npm pin or --ae-a8n-root pointing at a checkout with built dist/.");
  }
  if (byId["contract-gates"]?.status === "FAIL") {
    tips.push("ae-a8n fails the handshake contract battery — use a contract-satisfying build (see #143 pin policy); export presence alone is not compatibility.");
  }
  if (byId["ae-launch"]?.status === "BLOCKED") {
    tips.push("Launch requires a real AE session — run on macOS release-candidate acceptance or inject a launch probe. Check installDir and that no modal dialog is blocking AE startup (GUI state is not Node-observable).");
  }
  if (byId["gui-modal-state"]?.status === "UNKNOWN") {
    tips.push("For modal/busy suspicion: inspect ~/Library/Logs/Adobe/After Effects <ver>/UXPLogs_* and the AE GUI directly. A UXP plugin exception (e.g. ae-mcp-bridge) is a correlation clue, NOT a proven root cause.");
  }
  if (byId["ownership"]?.status === "FAIL") {
    tips.push("Slice requires ownership.kind='owned' — launch through the ae-a8n owned path; attached/unknown sessions are refused by design.");
  }
  if (tips.length === 0) {
    tips.push("All observable stages passed; remaining UNKNOWN/BLOCKED stages need a real-host run.");
  }
  return tips;
}
