/**
 * attach-target.mjs — the attach-only session opener boundary (Issue #366).
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
 * session:
 *
 *   1. PRIMARY — `AfterEffects.attach(options)`: the attach-only API
 *      ae-a8n ships for this contract (ae-a8n #269 / PR #270 — never
 *      launches; refuses when no attachable instance exists). The
 *      option/return shape mirrors `launch`:
 *      `{ installDir?, hostScript, sessionRoot, authorization,
 *         target?: { pid } }` in, an AfterEffects session out. When the
 *      pre-flight census identified exactly one process, its pid is
 *      forwarded as `target.pid` so ae-a8n binds the SAME process —
 *      a pid that no longer names an in-scope AE is refused upstream.
 *   2. TRANSITIONAL — `AfterEffects.launch(options)` on ae-a8n builds
 *      that do not yet export `attach`. The caller MUST still verify
 *      `ownership().kind === "attached"` and close+refuse otherwise;
 *      the residual cold-start window (target exits between the
 *      pre-flight census and launch) is closed only by the primary
 *      path. Remove this fallback once the pinned ae-a8n carries
 *      `attach` (tracked under Issue #366 / ae-a8n #99).
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
 *                    census-identified process); ignored by the
 *                    transitional fallback, which has no attach target
 *                    concept beyond its own census
 * @returns {Promise<object>} the ae-a8n session (AfterEffects instance)
 * @throws whatever ae-a8n throws; `attachApi` on the error is not set —
 *         callers that need provenance read `session.attachApi` instead.
 */
export async function openAttachTarget({ AfterEffects, installDir, hostScriptPath, sessionRoot, authorization, targetPid }) {
  const options = {
    ...(typeof installDir === "string" && installDir.length > 0 ? { installDir } : {}),
    hostScript: hostScriptPath,
    sessionRoot,
    authorization,
  };
  if (hasAttachApi(AfterEffects)) {
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
  // TRANSITIONAL fallback — see module docblock. `launch` may cold-start
  // AE; the caller's ownership check is the only guard until the
  // attach-only API ships and the dependency pin carries it.
  const ae = await AfterEffects.launch(options);
  try { ae.attachApi = "AfterEffects.launch(transitional)"; } catch { /* frozen session */ }
  return ae;
}

export const ATTACH_TARGET_DOC =
  "attach-only boundary: AfterEffects.attach preferred; launch fallback is transitional (Issue #366)";
