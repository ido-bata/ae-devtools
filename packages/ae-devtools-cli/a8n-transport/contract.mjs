/**
 * contract.mjs — behavioral contract battery for the resolved ae-a8n
 * module (Issue #144).
 *
 * compat.mjs's export probe answers "are the handshake exports present".
 * This module answers the next question: "do they behave per the canonical
 * `ae-devtools.capability-handshake/v1` contract" (packages/capability-
 * catalog/src/handshake.ts §4, ported by ae-a8n#102). Export presence is
 * not compatibility — a module can ship the names with different refusal
 * semantics, and the gate must not pass it.
 *
 * Everything here is pure: `negotiateCapabilities` / `assertDispatchAllowed`
 * are metadata functions over a HandshakeResponse and never touch AE, so
 * the battery runs pre-launch, in `doctor`, and in automated tests with
 * stub modules. Live-session handshake evidence (`ae.capabilities()`)
 * lives in real-run.mjs — a different layer.
 *
 * Dependency-free on purpose, same rule as compat.mjs: tests and the CLI
 * import this module without loading `@ido-bata/ae-a8n`.
 */

/** Canonical contract identity — owned by this repo's capability-catalog. */
export const HANDSHAKE_SCHEMA = "ae-devtools.capability-handshake/v1";
export const HANDSHAKE_CONTRACT_VERSION = { major: 1, minor: 0 };

/* ------------------------------------------------------------------ */
/* HandshakeResponse fixtures                                          */
/* ------------------------------------------------------------------ */

function capability(id, over = {}) {
  return {
    id,
    kind: "semantic-operation",
    persistence: "repository",
    permissions: ["read"],
    proofLevel: "verified-real-host",
    compatibility: {},
    execution: {
      class: "extendscript",
      lifecycle: "test fixture",
      canRemoteInvoke: true,
    },
    implementation: "implemented",
    verification: "verified-real-host",
    ...over,
  };
}

const READ_CAP = capability("ae.operation.app.version-info");

/**
 * Minimal HandshakeResponse satisfying the fields the contract functions
 * read. `over` replaces top-level members wholesale — pass a complete
 * `target`/`inventorySupply`/`availableCapabilities` when changing them.
 */
export function handshakeFixture(over = {}) {
  return {
    schema: HANDSHAKE_SCHEMA,
    contractVersion: { ...HANDSHAKE_CONTRACT_VERSION },
    catalogRevision: "contract-fixture",
    hostId: "contract-fixture",
    host: {
      os: "darwin",
      arch: "arm64",
      executionMode: "local",
      transport: "file-envelope",
      session: { uid: null, asid: null, user: null },
    },
    execution: {
      mode: "local",
      stability: "stable",
      requiresGuiDelivery: null,
      refusesConsoleTarget: null,
    },
    target: {
      identity: "pid:1",
      ownership: "owned",
      nonInterference: "unproven",
      ownershipKind: "owned",
      ownershipEvidence: "fixture",
      quitPolicy: "owned-only",
    },
    inventorySupply: { scripting: "not-supplied", tools: "not-supplied", sdk: "not-supplied" },
    availableCapabilities: [READ_CAP],
    diagnostics: [],
    provenance: {},
    ...over,
  };
}

function withOwnership(ownership) {
  return handshakeFixture({
    target: { ...handshakeFixture().target, ownership },
  });
}

function withCapabilities(caps, over = {}) {
  return handshakeFixture({ availableCapabilities: caps, ...over });
}

/* ------------------------------------------------------------------ */
/* Battery                                                             */
/* ------------------------------------------------------------------ */

const NEGOTIATE = "negotiateCapabilities";
const ASSERT = "assertDispatchAllowed";

function expectStatus(fn, want, label) {
  const result = fn();
  const status = result?.status;
  if (status !== want.status) {
    return `${label}: expected status ${want.status}, got ${JSON.stringify(status)} (${JSON.stringify(result)})`;
  }
  if (want.reason !== undefined && result?.reason !== want.reason) {
    return `${label}: expected reason ${want.reason}, got ${JSON.stringify(result?.reason)} (${result?.detail ?? ""})`;
  }
  return null;
}

function needs(mod, name) {
  return typeof mod?.[name] !== "function"
    ? `${name} is not a function — export gate should have refused earlier`
    : null;
}

/**
 * One battery entry per contract behavior. `run(mod)` returns null on
 * pass or a human-readable violation string.
 */
const CHECKS = [
  /* -- negotiateCapabilities: version / protocol ---------------------- */
  {
    id: "negotiation.compatible",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      return expectStatus(
        () => mod.negotiateCapabilities(handshakeFixture(), {
          contractVersion: { ...HANDSHAKE_CONTRACT_VERSION },
        }),
        { status: "compatible" },
        "matching contract version must negotiate compatible",
      );
    },
  },
  {
    id: "negotiation.client-older-minor",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      // Server speaks a newer minor: an older client stays compatible.
      return expectStatus(
        () => mod.negotiateCapabilities(
          handshakeFixture({ contractVersion: { major: 1, minor: 1 } }),
          { contractVersion: { major: 1, minor: 0 } },
        ),
        { status: "compatible" },
        "client minor older than server must stay compatible",
      );
    },
  },
  {
    id: "negotiation.incompatible-major",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      return expectStatus(
        () => mod.negotiateCapabilities(handshakeFixture(), {
          contractVersion: { major: 2, minor: 0 },
        }),
        { status: "refused", reason: "incompatible-contract-version" },
        "major version mismatch must refuse incompatible-contract-version",
      );
    },
  },
  {
    id: "negotiation.unsupported-minor",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      return expectStatus(
        () => mod.negotiateCapabilities(handshakeFixture(), {
          contractVersion: { major: 1, minor: 1 },
        }),
        { status: "refused", reason: "unsupported-minor-version" },
        "client minor newer than server must refuse unsupported-minor-version",
      );
    },
  },
  {
    id: "negotiation.malformed-schema",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      return expectStatus(
        () => mod.negotiateCapabilities(
          handshakeFixture({ schema: "not-the-handshake-schema" }),
          { contractVersion: { ...HANDSHAKE_CONTRACT_VERSION } },
        ),
        { status: "refused", reason: "malformed-response" },
        "wrong schema must refuse malformed-response",
      );
    },
  },
  /* -- negotiateCapabilities: capability / permission ----------------- */
  {
    id: "negotiation.requested-capability-compatible",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      return expectStatus(
        () => mod.negotiateCapabilities(handshakeFixture(), {
          contractVersion: { ...HANDSHAKE_CONTRACT_VERSION },
          requestedCapability: READ_CAP.id,
          requiredPermission: "read",
        }),
        { status: "compatible" },
        "advertised capability with declared permission must negotiate compatible",
      );
    },
  },
  {
    id: "negotiation.unknown-capability",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      // tools inventory supplied, id well-formed but not advertised.
      return expectStatus(
        () => mod.negotiateCapabilities(
          handshakeFixture({
            inventorySupply: { scripting: "not-supplied", tools: "supplied", sdk: "not-supplied" },
          }),
          {
            contractVersion: { ...HANDSHAKE_CONTRACT_VERSION },
            requestedCapability: "ae.operation.no.such.thing",
          },
        ),
        { status: "refused", reason: "unknown-capability" },
        "unadvertised id in a supplied inventory must refuse unknown-capability",
      );
    },
  },
  {
    id: "negotiation.capability-unassessed",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      // scripting inventory NOT supplied: unassessed is not absence.
      return expectStatus(
        () => mod.negotiateCapabilities(handshakeFixture(), {
          contractVersion: { ...HANDSHAKE_CONTRACT_VERSION },
          requestedCapability: "ae.scripting.app.getProject",
        }),
        { status: "refused", reason: "capability-unassessed" },
        "id in an unsupplied inventory must refuse capability-unassessed",
      );
    },
  },
  {
    id: "negotiation.missing-permission",
    run(mod) {
      const miss = needs(mod, NEGOTIATE);
      if (miss) return miss;
      return expectStatus(
        () => mod.negotiateCapabilities(handshakeFixture(), {
          contractVersion: { ...HANDSHAKE_CONTRACT_VERSION },
          requestedCapability: READ_CAP.id,
          requiredPermission: "execute",
        }),
        { status: "refused", reason: "missing-permission" },
        "undeclared required permission must refuse missing-permission",
      );
    },
  },
  /* -- assertDispatchAllowed: authorization --------------------------- */
  {
    id: "dispatch.pass-owned",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: handshakeFixture(),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "pass" },
        "implemented+verified capability on an owned target must pass",
      );
    },
  },
  {
    id: "dispatch.pass-explicitly-attached",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      // Canonical OwnershipEvidence has no "attached": an explicitly
      // attached, identified instance is the other passing value.
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: withOwnership("explicitly-attached"),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "pass" },
        "explicitly-attached ownership evidence must pass",
      );
    },
  },
  {
    id: "dispatch.refuse-unknown-ownership",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      // ae-a8n maps its "attached"/unproven kinds to canonical "unknown";
      // unknown ownership must refuse, never pass.
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: withOwnership("unknown"),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "refused", reason: "ownership-unproven" },
        "unknown ownership must refuse ownership-unproven",
      );
    },
  },
  {
    id: "dispatch.refuse-contradictory-claim",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      // A caller-side ownership claim that contradicts the handshake's own
      // attestation is not proof — it must refuse.
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: withOwnership("unknown"),
          capabilityId: READ_CAP.id,
          permission: "read",
          ownership: "owned",
        }),
        { status: "refused", reason: "ownership-unproven" },
        "caller claim contradicting attested ownership must refuse",
      );
    },
  },
  {
    id: "dispatch.refuse-unverified",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      const cap = capability(READ_CAP.id, { verification: "not-run", proofLevel: "unverified" });
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: withCapabilities([cap]),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "refused", reason: "unverified" },
        "verification=not-run must refuse unverified",
      );
    },
  },
  {
    id: "dispatch.refuse-not-implemented",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      const cap = capability(READ_CAP.id, { implementation: "adapter-present" });
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: withCapabilities([cap]),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "refused", reason: "not-implemented" },
        "implementation!=implemented must refuse not-implemented",
      );
    },
  },
  {
    id: "dispatch.refuse-no-execution-path",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      const cap = capability(READ_CAP.id, {
        execution: { class: "extendscript", lifecycle: "test", canRemoteInvoke: null },
      });
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: withCapabilities([cap]),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "refused", reason: "no-execution-path" },
        "canRemoteInvoke=null must refuse no-execution-path",
      );
    },
  },
  {
    id: "dispatch.refuse-missing-permission",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: handshakeFixture(),
          capabilityId: READ_CAP.id,
          permission: "execute",
        }),
        { status: "refused", reason: "missing-permission" },
        "undeclared permission class must refuse missing-permission",
      );
    },
  },
  {
    id: "dispatch.refuse-no-permission-declared",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: handshakeFixture(),
          capabilityId: READ_CAP.id,
          permission: undefined,
        }),
        { status: "refused", reason: "missing-permission" },
        "dispatch without a permission class must refuse missing-permission",
      );
    },
  },
  {
    id: "dispatch.refuse-unknown-capability",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: handshakeFixture({
            inventorySupply: { scripting: "not-supplied", tools: "supplied", sdk: "not-supplied" },
          }),
          capabilityId: "ae.operation.no.such.thing",
          permission: "read",
        }),
        { status: "refused", reason: "unknown-capability" },
        "unadvertised id in a supplied inventory must refuse unknown-capability",
      );
    },
  },
  {
    id: "dispatch.refuse-unassessed",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: handshakeFixture(),
          capabilityId: "ae.scripting.app.getProject",
          permission: "read",
        }),
        { status: "refused", reason: "capability-unassessed" },
        "id in an unsupplied inventory must refuse capability-unassessed",
      );
    },
  },
  {
    id: "dispatch.refuse-malformed",
    run(mod) {
      const miss = needs(mod, ASSERT);
      if (miss) return miss;
      return expectStatus(
        () => mod.assertDispatchAllowed({
          response: handshakeFixture({ schema: "forged" }),
          capabilityId: READ_CAP.id,
          permission: "read",
        }),
        { status: "refused", reason: "malformed-response" },
        "malformed response must refuse malformed-response",
      );
    },
  },
];

export const HANDSHAKE_CONTRACT_CHECK_IDS = CHECKS.map((c) => c.id);

/**
 * Run the full battery against a resolved ae-a8n module namespace.
 * Never throws: a throwing check is recorded as a violation.
 *
 * @param {object} mod — resolved `@ido-bata/ae-a8n` module namespace
 * @returns {{ ok: boolean, checks: Array<{id, ok, detail?}> }}
 */
export function runHandshakeContractChecks(mod) {
  const checks = CHECKS.map((check) => {
    try {
      const violation = check.run(mod);
      return violation === null
        ? { id: check.id, ok: true }
        : { id: check.id, ok: false, detail: violation };
    } catch (error) {
      return {
        id: check.id,
        ok: false,
        detail: `check threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  return { ok: checks.every((c) => c.ok), checks };
}
