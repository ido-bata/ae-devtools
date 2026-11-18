/**
 * compat.mjs — ae-a8n contract probe for the a8n-transport slice (Issue #138).
 *
 * Dependency-free on purpose: automated tests import this module, while
 * session.mjs (which imports `@ido-bata/ae-a8n`) must never be loaded by
 * tests. Everything here is a pure check or a dynamic import performed
 * only when a caller asks for a probe.
 *
 * Why a contract gate exists: `@ido-bata/ae-a8n@0.1.0-alpha.2` and earlier
 * predate the fixes this transport was verified against — ae-a8n#103
 * (extension prelude must register from a named function; the IIFE form
 * reads `this.__a8n` as undefined on real ExtendScript), ae-a8n#105
 * (LaunchServices launch so AE 27 does not fork a second instance and
 * ownership stays `unknown`), and ae-a8n#102 (capability handshake). A
 * consumer install that resolves that version would fail mid-run with an
 * obscure host error or an unexplained ownership refusal. The gate fails
 * closed BEFORE `AfterEffects.launch` with an actionable message.
 *
 * Marker choice: `negotiateCapabilities` / `assertDispatchAllowed` are the
 * ae-a8n#102 handshake exports. On ae-a8n `release-0-2-0` they were merged
 * AFTER #103 and #105, so their presence implies the required ancestors.
 * This is a contract probe, not a version compare — a local
 * `--ae-a8n-root` build is judged by the same exports.
 */
import { runHandshakeContractChecks } from "./contract.mjs";
import { resolveAeA8n } from "./ae-a8n-resolve.mjs";

/** Exports the resolved ae-a8n module must provide for this transport. */
export const REQUIRED_AE_A8N_CONTRACT = {
  AfterEffects: "function",
  negotiateCapabilities: "function",
  assertDispatchAllowed: "function",
};

export const CONTRACT_DESCRIPTION =
  "ae-a8n capability handshake (ae-a8n#102), which post-dates the " +
  "ae-a8n#103 extension-prelude and ae-a8n#105 LaunchServices fixes";

/**
 * Names of required contract members missing from a resolved ae-a8n
 * module namespace. `mod` may be null/undefined (unresolvable install).
 * @returns {string[]} missing member names; empty = contract satisfied
 */
export function missingContractExports(mod) {
  const missing = [];
  for (const [name, kind] of Object.entries(REQUIRED_AE_A8N_CONTRACT)) {
    const value = mod?.[name];
    const ok = kind === "function" ? typeof value === "function" : value != null;
    if (!ok) missing.push(name);
  }
  return missing;
}

/**
 * Structured refusal for an ae-a8n that does not satisfy the contract.
 * `code` is stable so callers/tests can match on it; the message carries
 * the remediation a consumer actually needs.
 */
export function aeA8nContractError({ source, version, missing }) {
  const error = new Error(
    `ae-a8n contract unsupported: ${source}` +
      (version ? `@${version}` : "") +
      ` is missing ${missing.join(", ")} — required: ${CONTRACT_DESCRIPTION}. ` +
      "ae-a8n@0.1.0-alpha.2 and earlier predate these fixes " +
      "(@ido-bata/ae-a8n@0.2.0 under the `next` dist-tag satisfies them); " +
      "pass --ae-a8n-root <ae-a8n checkout> to override the pinned dependency.",
  );
  error.code = "AE_A8N_CONTRACT_UNSUPPORTED";
  error.aeA8nSource = source;
  error.aeA8nVersion = version ?? null;
  error.missingContract = missing;
  return error;
}

/**
 * Structured refusal for an ae-a8n whose handshake exports exist but whose
 * negotiation/dispatch semantics fail the behavioral contract battery
 * (Issue #144). Distinct code from AE_A8N_CONTRACT_UNSUPPORTED: the
 * exports are present, the behavior is wrong.
 */
export function aeA8nHandshakeError({ source, version, failures }) {
  const error = new Error(
    `ae-a8n handshake contract incompatible: ${source}` +
      (version ? `@${version}` : "") +
      ` failed ${failures.length} contract check(s): ` +
      failures.map((f) => f.id).join(", ") +
      ". The handshake exports exist but do not honor " +
      "ae-devtools.capability-handshake/v1 — pass --ae-a8n-root " +
      "<ae-a8n checkout at release-0-2-0 or later> or wait for the next " +
      "@ido-bata/ae-a8n publish.",
  );
  error.code = "AE_A8N_CONTRACT_INCOMPATIBLE";
  error.aeA8nSource = source;
  error.aeA8nVersion = version ?? null;
  error.contractFailures = failures;
  return error;
}

/**
 * Resolve ae-a8n and report its contract status WITHOUT launching AE.
 * Never throws: resolution failures come back as `{ resolvable: false }`.
 * Resolution itself is delegated to the shared resolver
 * (ae-a8n-resolve.mjs, Issue #253) — the same root-vs-npm mechanics
 * session.mjs uses, so the probe can never disagree with the launcher
 * about which ae-a8n a run would bind.
 *
 * @param {object} [options]
 *   aeA8nRoot — local ae-a8n checkout root with a built dist/; overrides
 *               the npm-resolved dependency (same rule as session.mjs)
 * @returns {Promise<object>} probe result; `contractOk` is the gate input
 */
export async function probeAeA8n(options = {}) {
  const aeA8nRoot = options.aeA8nRoot;
  const source = typeof aeA8nRoot === "string" && aeA8nRoot.length > 0
    ? `local:${aeA8nRoot}`
    : "npm:@ido-bata/ae-a8n";
  let resolved;
  try {
    resolved = await resolveAeA8n({ aeA8nRoot });
  } catch (e) {
    return {
      resolvable: false,
      source,
      version: null,
      contractOk: false,
      missing: Object.keys(REQUIRED_AE_A8N_CONTRACT),
      required: CONTRACT_DESCRIPTION,
      error: String(e?.message ?? e),
    };
  }
  const mod = resolved.mod;
  const missing = missingContractExports(mod);
  // Export presence is necessary, not sufficient (Issue #144): when the
  // required exports exist, the handshake battery verifies the actual
  // negotiation/refusal/ownership/dispatch semantics before the probe
  // reports contractOk. Pure functions — no AE is contacted.
  const battery = missing.length === 0 ? runHandshakeContractChecks(mod) : null;
  return {
    resolvable: true,
    source: resolved.source,
    version: resolved.version,
    contractOk: missing.length === 0 && battery.ok,
    missing,
    checks: battery?.checks ?? null,
    required: CONTRACT_DESCRIPTION,
  };
}
