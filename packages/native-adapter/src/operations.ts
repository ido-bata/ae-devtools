/**
 * Per-operation dispatch registry — the ONLY place dispatchability is
 * defined (Issue #19 redesign).
 *
 * The coverage matrix's five classes are reporting buckets, not
 * capabilities. Dispatchability is per concrete suite/API operation:
 * each `OperationEntry` carries its own `implemented` /
 * `verifiedOnRealHost` evidence and derives its state from them.
 *
 *   dispatchable            ⇔ implemented === true AND verifiedOnRealHost === true
 *   implemented-unverified  ⇔ implemented === true, real-host proof missing
 *   inventory-only          ⇔ structurally attributed, no implementation
 *   unsupported-or-unknown  ⇔ cannot be attributed or called
 *
 * The committed registry is deliberately small: the committed
 * aggregate contains no per-symbol rows (symbol-level detail is
 * license-restricted to a local `.local/` path — see
 * `inventories/sdk/README.md`), so the only concrete operation entries
 * that can be named honestly today are the calls the in-repo
 * `experiments/native-sdk/minimal-plugin` NativeProbe actually makes.
 * Widening the registry is CAP047 child-Issue work; each new entry must
 * cite its header/source and carry honest evidence flags.
 *
 * Nothing here launches AE or loads a plug-in. `implemented` means
 * "code exists and compiles on the build host" per the repo's
 * verification taxonomy — it never implies real-host behaviour.
 */

import type { MatrixClass } from "./matrix.ts";

export const ENTRY_STATES = [
  "dispatchable",
  "implemented-unverified",
  "inventory-only",
  "unsupported-or-unknown",
] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export type OperationEntry = {
  /** Stable id: `"<SuiteName>.<member>"`, e.g. `"AEGP_ProjSuite6.AEGP_GetNumProjects"`. */
  id: string;
  /** SDK suite struct name the member belongs to. */
  suite: string;
  /** Member/procedure name as declared in the SDK headers. */
  member: string;
  /** Header the suite/member is declared in (inventory path). */
  sourceHeader: string;
  /**
   * Coverage-matrix class the extractor attributes this symbol to.
   * Reporting metadata only — it never grants dispatchability.
   */
  matrixClass: MatrixClass;
  /** Code exists and compiles (verification taxonomy `implemented`). */
  implemented: boolean;
  /** Observed running against an installed After Effects. */
  verifiedOnRealHost: boolean;
  /**
   * Technical basis + re-evaluation condition for an entry judged
   * non-callable (spec FR-013). When present the derived state is
   * `unsupported-or-unknown` regardless of the evidence flags.
   */
  unsupportedReason?: string;
  note?: string;
};

const PROBE_HEADER = "AE_GeneralPlug.h";
const SP_HEADER = "SP/SPRuntme.h";
const PROBE_NOTE =
  "Called by experiments/native-sdk/minimal-plugin/src/probe.cpp (NativeProbe). " +
  "Build-verified on macOS arm64; AE load/execution UNVERIFIED.";

function probe(
  suite: string,
  member: string,
  sourceHeader: string,
  matrixClass: MatrixClass,
  note?: string,
): OperationEntry {
  return {
    id: `${suite}.${member}`,
    suite,
    member,
    sourceHeader,
    matrixClass,
    implemented: true,
    verifiedOnRealHost: false,
    note: note ?? PROBE_NOTE,
  };
}

/**
 * The committed per-operation registry. Every entry corresponds to a
 * call `probe.cpp` actually makes (or the suite acquisition/release
 * pair it depends on). `implemented: true` reflects the probe's
 * BUILD SUCCEEDED artifact evidence; `verifiedOnRealHost: false`
 * reflects that no authorized AE session has loaded the plug-in yet
 * (`experiments/native-sdk/LOAD-PROOF.md` is the gated procedure).
 */
export const DISPATCH_ENTRIES: readonly OperationEntry[] = [
  // SPBasicSuite acquisition/release — the suite-lookup path itself.
  probe("SPBasicSuite", "AcquireSuite", SP_HEADER, "external-command",
    "Suite acquisition via the host-provided SPBasicSuite table; failure aborts the probe (fail closed)."),
  probe("SPBasicSuite", "ReleaseSuite", SP_HEADER, "external-command"),

  // AEGP_UtilitySuite6 — host/environment queries + diagnostic output.
  probe("AEGP_UtilitySuite6", "AEGP_WriteToDebugLog", PROBE_HEADER, "external-command",
    "Only side effect is diagnostic output to the AE debug log."),
  probe("AEGP_UtilitySuite6", "AEGP_RegisterWithAEGP", PROBE_HEADER, "external-command",
    "Registers plug-in identity (name → AEGP_PluginID); touches no project contents."),
  probe("AEGP_UtilitySuite6", "AEGP_GetDriverPluginInitFuncVersion", PROBE_HEADER, "external-command"),
  probe("AEGP_UtilitySuite6", "AEGP_GetDriverImplementationVersion", PROBE_HEADER, "external-command"),
  probe("AEGP_UtilitySuite6", "AEGP_GetSuppressInteractiveUI", PROBE_HEADER, "external-command"),
  probe("AEGP_UtilitySuite6", "AEGP_HostIsActivated", PROBE_HEADER, "external-command"),

  // AEGP_ProjSuite6 — open-project enumeration and metadata.
  probe("AEGP_ProjSuite6", "AEGP_GetNumProjects", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectByIndex", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectName", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_ProjectIsDirty", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectBitDepth", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectRootFolder", PROBE_HEADER, "external-command",
    "Returns an item handle to the project root folder; AEGP_GetProjectPath is deliberately not queried."),

  // AEGP_ItemSuite9 — top-level project-item iteration (read-only, capped).
  probe("AEGP_ItemSuite9", "AEGP_GetFirstProjItem", PROBE_HEADER, "external-command"),
  probe("AEGP_ItemSuite9", "AEGP_GetNextProjItem", PROBE_HEADER, "external-command"),
  probe("AEGP_ItemSuite9", "AEGP_GetItemName", PROBE_HEADER, "external-command",
    "UTF-16 name returned in an AE-allocated mem handle; disposed via AEGP_FreeMemHandle."),
  probe("AEGP_ItemSuite9", "AEGP_GetItemType", PROBE_HEADER, "external-command"),

  // AEGPMemorySuite1 — mem-handle access for the name strings above.
  probe("AEGPMemorySuite1", "AEGP_LockMemHandle", PROBE_HEADER, "external-command"),
  probe("AEGPMemorySuite1", "AEGP_UnlockMemHandle", PROBE_HEADER, "external-command"),
  probe("AEGPMemorySuite1", "AEGP_FreeMemHandle", PROBE_HEADER, "external-command",
    "Mandatory disposal of AE-allocated memory; memory hygiene, not mutation."),
];

const ENTRY_BY_ID = new Map(DISPATCH_ENTRIES.map((e) => [e.id, e]));

export function findOperation(id: string): OperationEntry | null {
  return ENTRY_BY_ID.get(id) ?? null;
}

/**
 * Derive the honest state of an entry. `dispatchable` is reachable
 * ONLY through `implemented && verifiedOnRealHost` — there is no other
 * path, and no entry may carry a `state` field that overrides this.
 */
export function operationState(entry: OperationEntry): EntryState {
  if (entry.unsupportedReason !== undefined) return "unsupported-or-unknown";
  if (entry.implemented && entry.verifiedOnRealHost) return "dispatchable";
  if (entry.implemented) return "implemented-unverified";
  return "inventory-only";
}

/** Entries a host may legitimately advertise as `dispatchable`. */
export function isDispatchableEntry(entry: OperationEntry): boolean {
  return entry.implemented === true && entry.verifiedOnRealHost === true;
}

/** Count of entries currently dispatchable. 0 today — fail-closed by design. */
export function dispatchableOperationCount(): number {
  return DISPATCH_ENTRIES.filter(isDispatchableEntry).length;
}

/**
 * Registry self-check. Throws if any entry violates the state
 * invariant or duplicates an id — a malformed registry must fail at
 * import/test time, never silently widen dispatchability.
 */
export function assertRegistryInvariants(entries: readonly OperationEntry[] = DISPATCH_ENTRIES): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(entry.id)) {
      throw new Error(`operation id ${JSON.stringify(entry.id)} is not "<Suite>.<member>"`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`duplicate operation id ${entry.id}`);
    }
    seen.add(entry.id);
    if (entry.id !== `${entry.suite}.${entry.member}`) {
      throw new Error(`operation id ${entry.id} does not match suite/member`);
    }
    const smuggled = (entry as { state?: unknown }).state;
    if (smuggled !== undefined) {
      // OperationEntry has no `state` field; guard against a cast-in override.
      throw new Error(`operation ${entry.id} carries a forbidden state override`);
    }
    if (entry.unsupportedReason !== undefined && entry.implemented === true) {
      throw new Error(`operation ${entry.id} is both implemented and marked unsupported`);
    }
    if (entry.verifiedOnRealHost === true && entry.implemented !== true) {
      throw new Error(`operation ${entry.id} claims real-host verification without implementation`);
    }
  }
}

assertRegistryInvariants();
