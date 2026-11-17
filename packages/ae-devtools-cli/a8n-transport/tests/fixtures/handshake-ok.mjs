/**
 * handshake-ok.mjs — contract-conformant ae-a8n stub for automated tests.
 *
 * NOT ae-a8n: a minimal re-implementation of the canonical
 * `ae-devtools.capability-handshake/v1` semantics
 * (packages/capability-catalog/src/handshake.ts §4, ported by ae-a8n#102)
 * covering exactly the behaviors a8n-transport/contract.mjs's battery
 * asserts. It exists so the gate/battery has a passing reference in CI
 * where no real ae-a8n build is present. Real-module verification is the
 * opt-in AE_A8N_ROOT path — do not treat a green run against this stub as
 * evidence about ae-a8n itself.
 */

export const CAPABILITY_CONTRACT_SCHEMA = "ae-devtools.capability-handshake/v1";
export const CAPABILITY_CONTRACT_VERSION = { major: 1, minor: 0 };
export const PERMISSION_VALUES = ["read", "write", "execute", "build-test", "host-callback"];
export const CAPABILITY_ID_SNAPSHOT = "contract-fixture";

export function AfterEffects() {}

const ID_NAMESPACES = ["scripting", "sdk", "operation", "tool"];
const SEGMENT_RE = /^[A-Za-z0-9_$-]+$/;
const NAMESPACE_SUPPLY = { scripting: "scripting", sdk: "sdk", tool: "tools", operation: "tools" };
const VERIFICATION_AXES = ["not-run", "automated-fake", "verified-real-host"];

function parseCapabilityId(id) {
  const parts = typeof id === "string" ? id.split(".") : [];
  if (parts.length < 4 || parts[0] !== "ae") return null;
  const ns = parts[1];
  if (!ID_NAMESPACES.includes(ns)) return null;
  const segments = parts.slice(2);
  if (segments.length < 2) return null;
  for (const s of segments) if (!SEGMENT_RE.test(s)) return null;
  return { namespace: ns, segments };
}

function lookupCapability(response, id) {
  const found = (response.availableCapabilities ?? []).find((c) => c.id === id);
  if (found !== undefined) return { kind: "found", capability: found };
  const parsed = parseCapabilityId(id);
  if (parsed === null) return { kind: "unknown" };
  const supplyKey = NAMESPACE_SUPPLY[parsed.namespace];
  return response.inventorySupply?.[supplyKey] === "supplied" ? { kind: "unknown" } : { kind: "unassessed" };
}

const refused = (reason, detail) => ({ status: "refused", reason, detail });

export function negotiateCapabilities(response, request) {
  if (response?.schema !== CAPABILITY_CONTRACT_SCHEMA) {
    return refused("malformed-response", `handshake schema ${JSON.stringify(response?.schema)} is not ${CAPABILITY_CONTRACT_SCHEMA}`);
  }
  const client = request.contractVersion;
  const server = response.contractVersion;
  if (client.major !== server.major) {
    return refused("incompatible-contract-version", `client contract major ${client.major} is incompatible with server major ${server.major}`);
  }
  if (client.minor > server.minor) {
    return refused("unsupported-minor-version", `client contract minor ${client.minor} is newer than server minor ${server.minor}`);
  }
  if (request.requestedCapability !== undefined) {
    const lookup = lookupCapability(response, request.requestedCapability);
    if (lookup.kind === "unassessed") {
      return refused("capability-unassessed", `capability ${request.requestedCapability} is unassessed`);
    }
    if (lookup.kind === "unknown") {
      return refused("unknown-capability", `capability ${request.requestedCapability} is not advertised`);
    }
    if (
      request.requiredPermission !== undefined &&
      !lookup.capability.permissions.includes(request.requiredPermission)
    ) {
      return refused("missing-permission", `capability ${lookup.capability.id} does not declare permission ${request.requiredPermission}`);
    }
  }
  return { status: "compatible" };
}

export function assertDispatchAllowed(check) {
  if (check?.response?.schema !== CAPABILITY_CONTRACT_SCHEMA || !Array.isArray(check.response?.availableCapabilities)) {
    return refused("malformed-response", "dispatch authorization requires a well-formed handshake response");
  }
  const lookup = lookupCapability(check.response, check.capabilityId);
  if (lookup.kind === "unassessed") {
    return refused("capability-unassessed", `capability ${check.capabilityId} is unassessed`);
  }
  if (lookup.kind === "unknown") {
    return refused("unknown-capability", `capability ${check.capabilityId} is not advertised by this host`);
  }
  const capability = lookup.capability;
  if (capability.implementation !== "implemented") {
    return refused("not-implemented", `capability ${capability.id} has implementation=${capability.implementation}`);
  }
  if (!VERIFICATION_AXES.includes(capability.verification) || capability.verification === "not-run") {
    return refused("unverified", `capability ${capability.id} has verification=${JSON.stringify(capability.verification)}`);
  }
  if (capability.execution?.canRemoteInvoke !== true) {
    return refused("no-execution-path", `capability ${capability.id} has canRemoteInvoke=${JSON.stringify(capability.execution?.canRemoteInvoke)}`);
  }
  if (
    check.permission === undefined ||
    !PERMISSION_VALUES.includes(check.permission) ||
    !Array.isArray(capability.permissions) ||
    !capability.permissions.includes(check.permission)
  ) {
    return refused("missing-permission", "dispatch permission class is not declared by the capability");
  }
  const attested = check.response.target?.ownership ?? "unknown";
  if (check.ownership !== undefined && check.ownership !== attested) {
    return refused("ownership-unproven", `caller claims ownership=${check.ownership} but the handshake attests ${attested}`);
  }
  if (attested !== "owned" && attested !== "explicitly-attached") {
    return refused("ownership-unproven", `target ownership is ${attested}`);
  }
  return { status: "pass" };
}
