/**
 * attach-target.mjs — the attach-only session opener boundary (Issue
 * #366, hardened under #374).
 *
 * `a8n-attached` must NEVER be able to spawn a new After Effects process:
 * the whole point of the mode is operating on the instance the USER
 * already has open. ae-a8n's `AfterEffects.launch` does not honour that —
 * when its attach attempt fails (busy/modal host, census race) it falls
 * back to cold-starting a second AE, which is exactly the failure mode
 * observed on Windows (ae-a8n #99, ae-devtools #366 Windows pre-flight
 * findings).
 *
 * This module is the single seam where the attached lane obtains a
 * session, and it is attach-ONLY:
 *
 *   `AfterEffects.attach(options)` — the attach-only API ae-a8n ships
 *   for this contract (ae-a8n #269 / PR #270, released in the 0.5.0
 *   train — never launches; refuses when no attachable instance
 *      exists). The option/return shape mirrors `launch`:
 *      `{ installDir?, hostScript, sessionRoot, authorization,
 *         target?: { pid } }` in, an AfterEffects session out. When the
 *      pre-flight census identified exactly one process, its pid is
 *      forwarded as `target.pid` so ae-a8n binds the SAME process —
 *      a pid that no longer names an in-scope AE is refused upstream.
 *
 * There is NO fallback: an ae-a8n build without `attach` cannot serve
 * the attached lane at all, so this boundary refuses with
 * ATTACHED_TARGET_UNSUPPORTED instead of calling `launch`. The pinned
 * dependency must therefore carry ae-a8n >= 0.5.0 before the attached
 * lane is usable from the registry package (dep flip tracked at
 * release time — see Issue #374).
 *
 * Detection is deliberately explicit — no option-name guessing. If
 * ae-a8n ships the capability under a different export, this module is
 * the one place that changes.
 */

/** True when the resolved ae-a8n module exposes the attach-only API. */
export function hasAttachApi(AfterEffects) {
  return (
    AfterEffects !== null &&
    typeof AfterEffects === "function" &&
    typeof AfterEffects.attach === "function"
  );
}

/**
 * Open a session against an already-running After Effects.
 *
 * @param {object} deps
 *   AfterEffects   — ae-a8n AfterEffects class (or fixture)
 *   installDir     — optional install pin forwarded to ae-a8n
 *   hostScriptPath — built extension host script
 *   sessionRoot    — ae-a8n session root dir
 *   authorization  — ae-a8n launch authorization grant
 *   targetPid      — optional pid pin forwarded as `target.pid` (the
 *                    census-identified process)
 * @returns {Promise<object>} the ae-a8n session (AfterEffects instance)
 * @throws {Error} code ATTACHED_TARGET_UNSUPPORTED when the resolved
 *         ae-a8n does not export `AfterEffects.attach` — the attached
 *         lane has no spawn-capable fallback by contract (Issue #374).
 *         Whatever ae-a8n's attach throws propagates unchanged.
 *
 * Platform boundary: ae-a8n's attach on Windows refuses the default
 * script transport (every script delivery there spawns `AfterFX.exe
 * -r`); attach requires the `in-ae-dispatcher` transport or another
 * attach-capable selection, which this opener does not supply. On
 * win32 `AfterEffects.attach` therefore surfaces ae-a8n's typed
 * refusal — fail-closed, nothing is launched (Issue #382). Windows
 * attach remains UNVERIFIED on this path (#224).
 */
export async function openAttachTarget({ AfterEffects, installDir, hostScriptPath, sessionRoot, authorization, targetPid }) {
  if (!hasAttachApi(AfterEffects)) {
    const e = new Error(
      "ae-a8n does not export AfterEffects.attach — the a8n-attached lane " +
      "is attach-only and has no launch fallback (Issue #374). Pin " +
      "@ido-bata/ae-a8n >= 0.5.0 or point aeA8nRoot at an ae-a8n build " +
      "that carries the attach API (ae-a8n #269).",
    );
    e.code = "ATTACHED_TARGET_UNSUPPORTED";
    throw e;
  }
  const options = {
    ...(typeof installDir === "string" && installDir.length > 0 ? { installDir } : {}),
    hostScript: hostScriptPath,
    sessionRoot,
    authorization,
  };
  // Attach-only: ae-a8n refuses rather than spawn when no running,
  // attachable instance exists. There is no fallback from here.
  if (Number.isInteger(targetPid) && targetPid > 0) {
    options.target = { pid: targetPid };
  }
  const ae = await AfterEffects.attach(options);
  // Provenance marker for evidence: which opener actually ran.
  try { ae.attachApi = "AfterEffects.attach"; } catch { /* frozen session */ }
  return ae;
}

export const ATTACH_TARGET_DOC =
  "attach-only boundary: AfterEffects.attach only; no launch fallback (Issues #366, #374)";
