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
 * `tests/registry-reconcile.test.ts` parses `probe.cpp` and fails if
 * this registry and the plug-in's real call set drift in either
 * direction (missing call → test failure; registered-but-uncalled →
 * test failure). Widening the registry is CAP047 child-Issue work;
 * each new entry must cite its header/source and carry honest
 * evidence flags.
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
  /**
   * The operation was OBSERVED being called successfully inside AE on
   * a real host (e.g. a NativeProbe `op` record with `err=0` under
   * LOAD-PROOF.md). This proves the SDK call works in-process; it does
   * NOT prove an external adapter can dispatch it.
   */
  verifiedOnRealHost: boolean;
  /**
   * An AUTHORIZED external dispatch path exists and was exercised for
   * this operation — i.e. a transport + authorization model that lets
   * an adapter outside the AE process invoke it, with real-host
   * evidence. No such path exists today, so every entry leaves this
   * false. `dispatchable` requires all three evidence axes; a getter
   * succeeding inside AE (`verifiedOnRealHost`) alone never suffices.
   */
  externalDispatchVerified?: boolean;
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
 * Inventory-only entry: structurally attributed to a suite member in
 * the licensed headers but NOT implemented by any in-repo code.
 * Derived state is `inventory-only`; it can never dispatch. Used by
 * the CAP047 cluster Issues (#63–#69) to register suite surface ahead
 * of implementation — each entry cites suite.member + header only.
 */
function inv(
  suite: string,
  member: string,
  sourceHeader: string,
  matrixClass: MatrixClass,
  note: string,
): OperationEntry {
  return {
    id: `${suite}.${member}`,
    suite,
    member,
    sourceHeader,
    matrixClass,
    implemented: false,
    verifiedOnRealHost: false,
    note,
  };
}

/**
 * The committed per-operation registry. Entries with
 * `implemented: true` correspond exactly to calls `probe.cpp` actually
 * makes (or the suite acquisition/release pair it depends on),
 * verified mechanically by `tests/registry-reconcile.test.ts`;
 * `implemented: false` entries are inventory-only suite surface
 * registered ahead of implementation by the CAP047 cluster Issues.
 * `implemented: true` reflects the probe's BUILD SUCCEEDED artifact
 * evidence; `verifiedOnRealHost: false` reflects that no authorized AE
 * session has loaded the plug-in yet
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

  // AEGP_RegisterSuite5 — deferred dispatch registration (idle hook).
  probe("AEGP_RegisterSuite5", "AEGP_RegisterIdleHook", PROBE_HEADER, "external-command",
    "Registers ProbeIdleHook for host-dispatched main-thread execution; the probe's only execution context. Host-callback direction: the host invokes the registered function."),

  // AEGP_ProjSuite6 — open-project enumeration and metadata.
  probe("AEGP_ProjSuite6", "AEGP_GetNumProjects", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectByIndex", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectName", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_ProjectIsDirty", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectBitDepth", PROBE_HEADER, "external-command"),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectPath", PROBE_HEADER, "external-command",
    "UTF-16 project path via mem handle; used for the idle-trigger fingerprint and logged as project[i].path. Local paths reach the AE debug log — redact evidence excerpts before sharing."),
  probe("AEGP_ProjSuite6", "AEGP_GetProjectRootFolder", PROBE_HEADER, "external-command",
    "Returns an item handle to the project root folder; AEGP_SaveProjectToPath is deliberately not queried."),

  // AEGP_ItemSuite9 — top-level project-item iteration (read-only, capped).
  probe("AEGP_ItemSuite9", "AEGP_GetFirstProjItem", PROBE_HEADER, "external-command"),
  probe("AEGP_ItemSuite9", "AEGP_GetNextProjItem", PROBE_HEADER, "external-command"),
  probe("AEGP_ItemSuite9", "AEGP_GetItemName", PROBE_HEADER, "external-command",
    "UTF-16 name returned in an AE-allocated mem handle; disposed via AEGP_FreeMemHandle."),
  probe("AEGP_ItemSuite9", "AEGP_GetItemType", PROBE_HEADER, "external-command"),

  // AEGPMemorySuite1 — mem-handle access for the name/path strings above.
  probe("AEGPMemorySuite1", "AEGP_GetMemHandleSize", PROBE_HEADER, "external-command",
    "Bounds UTF-16 reads to the AE-allocated block; never trusts the terminator."),
  probe("AEGPMemorySuite1", "AEGP_LockMemHandle", PROBE_HEADER, "external-command"),
  probe("AEGPMemorySuite1", "AEGP_UnlockMemHandle", PROBE_HEADER, "external-command"),
  probe("AEGPMemorySuite1", "AEGP_FreeMemHandle", PROBE_HEADER, "external-command",
    "Mandatory disposal of AE-allocated memory; memory hygiene, not mutation."),

  // ------------------------------------------------------------------
  // Issue #63 — AEGP project & item suite family (AE_GeneralPlug.h).
  // The 11 members NativeProbe already calls are registered above as
  // implemented-unverified; the remaining suite members are
  // inventory-only until an implementation + real-host proof exist.
  // Mutation candidates carry the FR-07/US3 write-permission caveat.
  // ------------------------------------------------------------------
  inv("AEGP_ProjSuite6", "AEGP_SaveProjectToPath", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ProjSuite6", "AEGP_GetProjectTimeDisplay", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ProjSuite6", "AEGP_SetProjectTimeDisplay", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ProjSuite6", "AEGP_SaveProjectAs", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ProjSuite6", "AEGP_NewProject", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ProjSuite6", "AEGP_OpenProjectFromPath", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ProjSuite6", "AEGP_SetProjectBitDepth", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetActiveItem", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_IsItemSelected", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SelectItem", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetTypeName", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SetItemName", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemID", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemFlags", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SetItemUseProxy", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemParentFolder", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SetItemParentFolder", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemDuration", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemCurrentTime", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemDimensions", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemPixelAspectRatio", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_DeleteItem", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_CreateNewFolder", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SetItemCurrentTime", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemComment", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SetItemComment", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemLabel", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_SetItemLabel", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemSuite9", "AEGP_GetItemMRUView", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_GetItemViewPlaybackTime", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_GetItemViewGuidesVisible", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_SetItemViewGuidesVisible", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_GetItemViewGuidesSnap", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_SetItemViewGuidesSnap", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_GetItemViewGuidesLocked", PROBE_HEADER, "external-command",
    "Read-only query candidate; inventory-only until implemented and real-host verified. Cluster: Issue #63."),
  inv("AEGP_ItemViewSuite2", "AEGP_SetItemViewGuidesLocked", PROBE_HEADER, "external-command",
    "Mutation candidate: requires the explicit write-permission model (spec FR-07/US3) before any dispatch path. Cluster: Issue #63."),
  // Issue #69 — PICA/SP plug-in runtime surface (SP/*.h, SDK 26.5).
  // Host-provided SP suite procedures the plug-in calls; the two
  // SPBasicSuite members NativeProbe already uses stay registered
  // above as implemented-unverified. OS-divergent runtime/plugin
  // tables carry the Windows-UNVERIFIED caveat per constraints.md.
  // ------------------------------------------------------------------
  inv("SPRuntimeSuite", "GetRuntimeStringPool", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimeSuiteList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimeFileList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimePluginList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimeAdapterList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimeHostProcs", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimePluginsFolder", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPRuntimeSuite", "GetRuntimeHostFileSpec", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "GetRuntimeStringPool", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "GetRuntimeSuiteList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "GetRuntimeFileList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "GetRuntimePluginList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "GetRuntimeAdapterList", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "GetRuntimeHostProcs", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "XPlatGetRuntimePluginsFolder", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatRuntimeSuite", "XPlatGetRuntimeHostFileSpec", "SP/SPRuntme.h", "external-command",
    "OS-divergent procedure table (constraints.md §3.2): Windows entries UNVERIFIED; macOS header evidence only. Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "AllocatePluginList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "FreePluginList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "AddPlugin", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "NewPluginListIterator", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "NextPlugin", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "DeletePluginListIterator", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginListNeededSuiteAvailable", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginHostEntry", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginFileSpecification", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginPropertyList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginGlobals", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginGlobals", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginStarted", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginStarted", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginSkipShutdown", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginSkipShutdown", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginBroken", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginBroken", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginAdapter", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginAdapterInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginAdapterInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "FindPluginProperty", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginName", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginName", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetNamedPlugin", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginPropertyList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "GetPluginHostInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPluginsSuite", "SetPluginHostInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "AllocatePluginList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "FreePluginList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "AddXPlatPlugin", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "NewPluginListIterator", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "NextPlugin", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "DeletePluginListIterator", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginListNeededSuiteAvailable", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginHostEntry", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginXplatFileSpec", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginPropertyList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginGlobals", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginGlobals", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginStarted", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginStarted", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginSkipShutdown", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginSkipShutdown", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginBroken", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginBroken", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginAdapter", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginAdapterInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginAdapterInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "FindPluginProperty", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginName", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginName", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetNamedPlugin", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginPropertyList", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "GetPluginHostInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPXPlatPluginsSuite", "SetPluginHostInfo", "SP/SPPlugs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "AllocateFileList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "FreeFileList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "AddFiles", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "NewFileListIterator", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "NextFile", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "DeleteFileListIterator", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "GetFileSpecification", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "GetFileInfo", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "GetIsAPlugin", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "SetIsAPlugin", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "GetFilePropertyList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesSuite", "SetFilePropertyList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "AllocateFileList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "FreeFileList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "AddFiles", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "NewFileListIterator", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "NextFile", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "DeleteFileListIterator", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "GetFileSpecification", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "GetFileInfo", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "GetIsAPlugin", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "SetIsAPlugin", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "GetFilePropertyList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPFilesV3Suite", "SetFilePropertyList", "SP/SPFiles.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "AllocateSuiteList", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "FreeSuiteList", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "AddSuite", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "AcquireSuite", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "ReleaseSuite", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "FindSuite", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "NewSuiteListIterator", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "NextSuite", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "DeleteSuiteListIterator", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "GetSuiteHost", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "GetSuiteName", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "GetSuiteAPIVersion", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "GetSuiteInternalVersion", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "GetSuiteProcs", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPSuitesSuite", "GetSuiteAcquireCount", "SP/SPSuites.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "AllocatePropertyList", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "FreePropertyList", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "AddProperties", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "AddProperty", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "FindProperty", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "NewPropertyListIterator", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "NextProperty", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "DeletePropertyListIterator", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "GetPropertyPIProperty", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "GetPropertyRefCon", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "GetPropertyCacheable", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "GetPropertyAllocatedByPlugin", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "SPHasMultiplePropertyLists", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "GetNextPropertyList", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPPropertiesSuite", "FindPropertyLocal", "SP/SPProps.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlocksSuite", "AllocateBlock", "SP/SPBlocks.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlocksSuite", "FreeBlock", "SP/SPBlocks.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlocksSuite", "ReallocateBlock", "SP/SPBlocks.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "AcquirePlugin", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "ReleasePlugin", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetPluginAccess", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetAccessPlugin", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetAccessEntry", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetAccessCount", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetAccessInfo", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetPluginResourceAccess", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "SetPluginResourceAccess", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "CallPlugin", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "GetCurrentPlugin", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAccessSuite", "SetCurrentPlugin", "SP/SPAccess.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "AllocateAdapterList", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "FreeAdapterList", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "AddAdapter", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "SPFindAdapter", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "NewAdapterListIterator", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "NextAdapter", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "DeleteAdapterListIterator", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "GetAdapterHost", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "GetAdapterName", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPAdaptersSuite", "GetAdapterVersion", "SP/SPAdapts.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPStringsSuite", "AllocateStringPool", "SP/SPStrngs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPStringsSuite", "FreeStringPool", "SP/SPStrngs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPStringsSuite", "MakeWString", "SP/SPStrngs.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlockDebugSuite", "GetBlockDebugEnabled", "SP/SPBckDbg.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlockDebugSuite", "SetBlockDebugEnabled", "SP/SPBckDbg.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlockDebugSuite", "GetFirstBlock", "SP/SPBckDbg.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlockDebugSuite", "GetNextBlock", "SP/SPBckDbg.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBlockDebugSuite", "GetBlockDebug", "SP/SPBckDbg.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPInterfaceSuite", "SendMessage", "SP/SPInterf.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPInterfaceSuite", "SetupMessageData", "SP/SPInterf.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPInterfaceSuite", "EmptyMessageData", "SP/SPInterf.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPInterfaceSuite", "StartupExport", "SP/SPInterf.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPCachesSuite", "SPFlushCaches", "SP/SPCaches.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBasicSuite", "IsEqual", "SP/SPBasic.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBasicSuite", "AllocateBlock", "SP/SPBasic.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBasicSuite", "FreeBlock", "SP/SPBasic.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBasicSuite", "ReallocateBlock", "SP/SPBasic.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
  inv("SPBasicSuite", "Undefined", "SP/SPBasic.h", "external-command",
    "Host-provided SP runtime procedure; inventory-only until implemented and real-host verified. Cluster: Issue #69."),
];


const ENTRY_BY_ID = new Map(DISPATCH_ENTRIES.map((e) => [e.id, e]));

export function findOperation(id: string): OperationEntry | null {
  return ENTRY_BY_ID.get(id) ?? null;
}

/**
 * Derive the honest state of an entry. `dispatchable` is reachable
 * ONLY through `implemented && verifiedOnRealHost &&
 * externalDispatchVerified` — there is no other path, and no entry
 * may carry a `state` field that overrides this.
 */
export function operationState(entry: OperationEntry): EntryState {
  if (entry.unsupportedReason !== undefined) return "unsupported-or-unknown";
  if (entry.implemented && entry.verifiedOnRealHost && entry.externalDispatchVerified === true) {
    return "dispatchable";
  }
  if (entry.implemented) return "implemented-unverified";
  return "inventory-only";
}

/**
 * Entries a host may legitimately advertise as `dispatchable`.
 * Three independent evidence axes are required:
 *   implemented               — code exists and compiles;
 *   verifiedOnRealHost        — the call succeeded inside AE on a real host;
 *   externalDispatchVerified  — an authorized external dispatch path exists.
 * The third axis is what separates "AE can call it" from "an adapter
 * may dispatch it"; without it, in-host success is not dispatch
 * authorization.
 */
export function isDispatchableEntry(entry: OperationEntry): boolean {
  return entry.implemented === true &&
         entry.verifiedOnRealHost === true &&
         entry.externalDispatchVerified === true;
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
    if (entry.externalDispatchVerified === true &&
        !(entry.implemented === true && entry.verifiedOnRealHost === true)) {
      throw new Error(
        `operation ${entry.id} claims external dispatch verification ` +
        "without implemented+verifiedOnRealHost evidence",
      );
    }
  }
}

assertRegistryInvariants();
