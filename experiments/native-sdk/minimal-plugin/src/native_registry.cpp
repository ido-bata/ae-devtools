#include "native_intake.h"

#include "native_consent.h"
#include "native_json.h"

#if !defined(_WIN32)

#include <ctype.h>
#include <dirent.h>
#include <fcntl.h>
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "native_registry.h"
#include "native_state.h"

/* Record the dispatched op's own AEGP call under its allowlist id —
   the common case (no extra evidence string). */
void RecordAllowOp(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    A_Err err)
{
    IntakeOpRecord(utilP, allow->opRecordId, (long)err, NULL);
}

/* ---- allowlist + per-operation argument schema ----------------------
   Issue #270 Stage 1: each entry declares the exact `args` contract the
   plug-in enforces BEFORE any AEGP call. The devtools-side canonical
   statement is NATIVE_INTAKE_ARG_SCHEMAS in
   packages/native-adapter/src/dispatch.ts — keep the two in sync. */

static const IntakeArgSpec S_TYPENAME_ARGS[] = {
    { "itemType", ARGK_INT, 1.0, 4.0 },
};

/* AEGP_ItemSuite9.AEGP_GetItemName / AEGP_GetItemID (Issue #270
   identity slice): the item handle is resolved host-side from an aeRef
   descriptor. `projectIndex` selects the project via
   AEGP_GetProjectByIndex (bounds-checked → STALE_REFERENCE); `item` is
   the §7b descriptor — legacy {type,name,path} or identity-bearing
   {type,name,path,itemId?,projectName?,projectPath?}. */
static const IntakeArgSpec S_AEREF_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "item", ARGK_AEREFITEM, 0.0, 0.0 },
};

/* AEGP_ItemSuite9.AEGP_SetItemComment (Issue #327): the first
   mutating op. Same aeRef resolution as the getters plus a bounded
   UTF-8 `comment` string (2048 bytes, matching ITEM_COMMENT_MAX). */
static const IntakeArgSpec S_SETCOMMENT_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "item", ARGK_AEREFITEM, 0.0, 0.0 },
    { "comment", ARGK_STR, 0.0, 2048.0 },
};

/* AEGP_ItemSuite9.AEGP_GetFirstProjItem as the discovery/enumeration
   op (Issue #270 identity slice): {projectIndex, offset, limit}. */
static const IntakeArgSpec S_FIRSTITEM_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "offset", ARGK_INT, 0.0, 1000000.0 },
    { "limit", ARGK_INT, 1.0, 32.0 },
};

/* CompSuite13 read-only getters (Issue #318 / #64): the comp handle is
   NEVER taken from the wire — `comp` is the same §7b aeRef item
   descriptor (type must be "comp"); the executor resolves it to an
   itemH via the shared resolver, then maps itemH → compH through
   AEGP_GetCompFromItem inside the request window. */
static const IntakeArgSpec S_COMP_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "comp", ARGK_AEREFITEM, 0.0, 0.0 },
};

/* AEGP_LayerSuite9 comp-scoped enumeration (Issue #318 layer slice):
   GetCompLayerByIndex is layer-descriptor ISSUANCE — it resolves the
   comp aeRef, derives compH, reads the layer's live id+name and emits
   a ready-to-use aeRefLayer descriptor. `layerIndex` is the
   GetCompLayerByIndex position (0-based). */
static const IntakeArgSpec S_COMP_INDEX_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "comp", ARGK_AEREFITEM, 0.0, 0.0 },
    { "layerIndex", ARGK_INT, 0.0, 1000000.0 },
};

/* AEGP_LayerSuite9 layer-handle getters (Issue #318 layer slice): the
   layer handle is NEVER taken from the wire — `layer` is an aeRefLayer
   descriptor {type:"layer", name, layerId, comp:{aeRef:<comp item
   descriptor>}}; the executor resolves the comp descriptor through the
   shared item resolver, derives compH via AEGP_GetCompFromItem, then
   scans the comp's layers for the live AEGP_GetLayerID match with
   name corroboration — reorder-tolerant, fail-closed. */
static const IntakeArgSpec S_LAYER_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "layer", ARGK_AEREFLAYER, 0.0, 0.0 },
};

/* Time-mode variants: AEGP_LTimeMode is {LayerTime=0, CompTime=1} —
   exposed as a bounded integer, never defaulted silently. */
static const IntakeArgSpec S_LAYER_TIME_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "layer", ARGK_AEREFLAYER, 0.0, 0.0 },
    { "timeMode", ARGK_INT, 0.0, 1.0 },
};

/* IsLayerUsedAsTrackMatte's fill_must_be_active flag — same bounded
   boolean-as-integer convention. */
static const IntakeArgSpec S_LAYER_MATTE_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "layer", ARGK_AEREFLAYER, 0.0, 0.0 },
    { "fillMustBeActive", ARGK_INT, 0.0, 1.0 },
};

/* Issue #318 §7e: project-scoped getters take the aeRefProject
   descriptor alone — the descriptor carries the project index. */
static const IntakeArgSpec S_PROJECT_ARGS[] = {
    { "project", ARGK_AEREFPROJECT, 0.0, 0.0 },
};

/* Issue #318 §7f: RQ-item getters take the comp's projectIndex plus
   the aeRefRQItem descriptor (index + comp aeRef + fingerprint). */
static const IntakeArgSpec S_RQITEM_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "rqItem", ARGK_AEREFRQITEM, 0.0, 0.0 },
};

/* AEGP_GetRQItemByIndex doubles as RQ descriptor issuance/enumeration:
   {offset, limit} pages the queue. */
static const IntakeArgSpec S_RQENUM_ARGS[] = {
    { "offset", ARGK_INT, 0.0, 1000000.0 },
    { "limit", ARGK_INT, 1.0, 32.0 },
};

const AllowEntry S_ALLOWLIST[] = {
    { "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ProjSuite6.AEGP_GetNumProjects", NULL, 0, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion", NULL, 0, 0 },
    { "AEGP_ItemSuite9.AEGP_GetTypeName",
      "AEGP_ItemSuite9.AEGP_GetTypeName", S_TYPENAME_ARGS, 1, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemName",
      "AEGP_ItemSuite9.AEGP_GetItemName", S_AEREF_ARGS, 2, 0 },
    /* Issue #270 identity slice: GetItemID is descriptor issuance
       (resolve → read live id + project identity → canonical aeRef);
       GetFirstProjItem is discovery/enumeration. Both reuse the same
       identity resolver — no per-kind resolver duplication. */
    { "AEGP_ItemSuite9.AEGP_GetItemID",
      "AEGP_ItemSuite9.AEGP_GetItemID", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
      "AEGP_ItemSuite9.AEGP_GetFirstProjItem", S_FIRSTITEM_ARGS, 3, 0 },
    /* Issue #318 / #64: CompSuite13 read-only getters. All share the
       {projectIndex, comp:<aeRefItem type=comp>} contract; the comp
       handle is derived host-side via AEGP_GetCompFromItem — never
       taken from the wire. GetCompShutterFrameRange is excluded: it
       takes an A_Time input argument (arg-bearing ops are a separate
       slice). */
    { "AEGP_CompSuite13.AEGP_GetCompFramerate",
      "AEGP_CompSuite13.AEGP_GetCompFramerate", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompFrameDuration",
      "AEGP_CompSuite13.AEGP_GetCompFrameDuration", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime",
      "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame",
      "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor",
      "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName",
      "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetShowBlendModes",
      "AEGP_CompSuite13.AEGP_GetShowBlendModes", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples",
      "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit",
      "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompBGColor",
      "AEGP_CompSuite13.AEGP_GetCompBGColor", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase",
      "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase", S_COMP_ARGS, 2, 0 },
    /* Issue #318 / #63: ItemSuite9 read-only detail getters that take
       AEGP_ItemH — same {projectIndex, item:<aeRefItem>} contract as
       GetItemName; the resolved handle is used directly (no derived
       handle). GetItemParentFolder and GetItemMRUView stay out: they
       return host handles of other identity kinds (folder item /
       item-view) that need their own descriptor story first. */
    { "AEGP_ItemSuite9.AEGP_GetItemType",
      "AEGP_ItemSuite9.AEGP_GetItemType", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemFlags",
      "AEGP_ItemSuite9.AEGP_GetItemFlags", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_IsItemSelected",
      "AEGP_ItemSuite9.AEGP_IsItemSelected", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemLabel",
      "AEGP_ItemSuite9.AEGP_GetItemLabel", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemDuration",
      "AEGP_ItemSuite9.AEGP_GetItemDuration", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemCurrentTime",
      "AEGP_ItemSuite9.AEGP_GetItemCurrentTime", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemDimensions",
      "AEGP_ItemSuite9.AEGP_GetItemDimensions", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio",
      "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemComment",
      "AEGP_ItemSuite9.AEGP_GetItemComment", S_AEREF_ARGS, 2, 0 },
    /* Issue #327: first mutating op — AEGP_ItemSuite9.AEGP_SetItemComment
       (UNDOABLE). requiresConsent=1: the §7g MAC is verified after
       session attestation and before the AEGP call; the aeRef item is
       resolved host-side exactly like the read-only getters. `comment`
       is bounded UTF-8 (same 2048-byte bound as the getter payload);
       empty string clears the comment. */
    { "AEGP_ItemSuite9.AEGP_SetItemComment",
      "AEGP_ItemSuite9.AEGP_SetItemComment", S_SETCOMMENT_ARGS, 3, 1 },
    /* Issue #318 / #64 layer slice: AEGP_LayerSuite9. The layer handle
       is never taken from the wire — `layer` is an aeRefLayer descriptor
       embedding its parent comp's aeRef item descriptor; resolution is
       comp aeRef → itemH → compH (AEGP_GetCompFromItem) → layer scan by
       live AEGP_GetLayerID + name corroboration. GetCompNumLayers and
       GetCompLayerByIndex are comp-scoped: the latter is descriptor
       ISSUANCE (emits a ready-to-use aeRefLayer). Deferred members:
       GetActiveLayer (no comp binding arg), GetLayerSourceItem /
       GetLayerParentComp / GetTrackMatteLayer-returning-handle paths
       that would put a raw handle on the wire (GetTrackMatteLayer is
       handled by emitting an aeRefLayer instead), all mutating members,
       and members needing A_Time/A_FloatRect/stream arguments. */
    { "AEGP_LayerSuite9.AEGP_GetCompNumLayers",
      "AEGP_LayerSuite9.AEGP_GetCompNumLayers", S_COMP_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex",
      "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex", S_COMP_INDEX_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerIndex",
      "AEGP_LayerSuite9.AEGP_GetLayerIndex", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerName",
      "AEGP_LayerSuite9.AEGP_GetLayerName", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerFlags",
      "AEGP_LayerSuite9.AEGP_GetLayerFlags", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerQuality",
      "AEGP_LayerSuite9.AEGP_GetLayerQuality", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerObjectType",
      "AEGP_LayerSuite9.AEGP_GetLayerObjectType", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayer3D",
      "AEGP_LayerSuite9.AEGP_IsLayer3D", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayer2D",
      "AEGP_LayerSuite9.AEGP_IsLayer2D", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime",
      "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime", S_LAYER_TIME_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerInPoint",
      "AEGP_LayerSuite9.AEGP_GetLayerInPoint", S_LAYER_TIME_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerDuration",
      "AEGP_LayerSuite9.AEGP_GetLayerDuration", S_LAYER_TIME_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerID",
      "AEGP_LayerSuite9.AEGP_GetLayerID", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerLabel",
      "AEGP_LayerSuite9.AEGP_GetLayerLabel", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality",
      "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID",
      "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn",
      "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn",
      "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte",
      "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte",
      "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte", S_LAYER_MATTE_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer",
      "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer", S_LAYER_ARGS, 2, 0 },
    /* Issue #270 Stage 2: zero-arg read-only getters needing no
       identity resolution. The three UtilitySuite members use the
       already-held utilP; the two render-queue members acquire their
       suite inside the request window like GetTypeName. */
    { "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion", NULL, 0, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
      "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI", NULL, 0, 0 },
    { "AEGP_UtilitySuite6.AEGP_HostIsActivated",
      "AEGP_UtilitySuite6.AEGP_HostIsActivated", NULL, 0, 0 },
    { "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
      "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState", NULL, 0, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
      "AEGP_RQItemSuite4.AEGP_GetNumRQItems", NULL, 0, 0 },
    /* Issue #318 §7e: project-scoped read-only getters on the
       aeRefProject descriptor (§7e). GetProjectRootFolder stays out —
       the root folder is not a top-level item, so its itemId is outside
       the GetFirstProjItem scan and an emitted aeRef could never
       resolve. */
    { "AEGP_ProjSuite6.AEGP_ProjectIsDirty",
      "AEGP_ProjSuite6.AEGP_ProjectIsDirty", S_PROJECT_ARGS, 1, 0 },
    { "AEGP_ProjSuite6.AEGP_GetProjectBitDepth",
      "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", S_PROJECT_ARGS, 1, 0 },
    { "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay",
      "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay", S_PROJECT_ARGS, 1, 0 },
    /* Issue #318 §7f: RQ-item read-only getters on the aeRefRQItem
       descriptor — index + bound-comp aeRef + (status,
       numOutputModules) fingerprint, all re-verified atomically inside
       the request window. GetRQItemByIndex doubles as descriptor
       issuance/enumeration ({offset, limit}). GetNextRQItem stays out:
       it takes a borrowed RQItemRefH which cannot cross the wire.
       Mutating members (SetRenderState, SetLogType, SetComment,
       AddDefaultOutputModule, RemoveOutputModule, DeleteRQItem) are
       out of scope. */
    { "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
      "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex", S_RQENUM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetRenderState",
      "AEGP_RQItemSuite4.AEGP_GetRenderState", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetStartedTime",
      "AEGP_RQItemSuite4.AEGP_GetStartedTime", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetElapsedTime",
      "AEGP_RQItemSuite4.AEGP_GetElapsedTime", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetLogType",
      "AEGP_RQItemSuite4.AEGP_GetLogType", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetComment",
      "AEGP_RQItemSuite4.AEGP_GetComment", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
      "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
      "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem", S_RQITEM_ARGS, 2, 0 },
};
const int S_ALLOWLIST_COUNT =
    (int)(sizeof(S_ALLOWLIST) / sizeof(S_ALLOWLIST[0]));

const AllowEntry* AllowFind(const char* opIdZ, size_t len)
{
    int i;
    for (i = 0; i < S_ALLOWLIST_COUNT; i++)
    {
        const char* a = S_ALLOWLIST[i].operationId;
        if (strlen(a) == len && memcmp(a, opIdZ, len) == 0) return &S_ALLOWLIST[i];
    }
    return NULL;
}

static int ValidateAeRefItem(JVal* v, char* detailZ, size_t detailCap);
static int ValidateAeRefLayer(JVal* v, char* detailZ, size_t detailCap);
static int ValidateAeRefProject(JVal* v, char* detailZ, size_t detailCap);
static int ValidateAeRefRQItem(JVal* v, char* detailZ, size_t detailCap);
int AeRefTypeToItemType(JVal* typeV, AEGP_ItemType* outP);

/* Per-operation args validation (Issue #270 Stage 1). `args` is the
   request envelope's args member: absent (JGet NULL), JK_NULL, or any
   parsed JSON value. Returns 1 when acceptable; on refusal fills
   `detailZ` (bounded) for the MALFORMED_REQUEST verdict. Runs BEFORE
   session attestation and any AEGP call — unpermitted input never
   reaches the host. */
int ValidateArgs(
    const AllowEntry* allow,
    JVal* args,
    char* detailZ, size_t detailCap)
{
    int i;
    if (allow->nargs == 0)
    {
        if (args && args->kind != JK_NULL)
        {
            snprintf(detailZ, detailCap, "operation takes no arguments");
            return 0;
        }
        return 1;
    }
    if (!args || args->kind != JK_OBJ)
    {
        snprintf(detailZ, detailCap, "args must be an object of named arguments");
        return 0;
    }
    /* exact key set: every spec name present, no extras */
    if ((int)args->npairs != allow->nargs)
    {
        snprintf(detailZ, detailCap, "args field count mismatch");
        return 0;
    }
    for (i = 0; i < allow->nargs; i++)
    {
        const IntakeArgSpec* spec = &allow->argsSpec[i];
        JVal* v = JGet(args, spec->name);
        if (!v)
        {
            snprintf(detailZ, detailCap, "missing argument \"%s\"", spec->name);
            return 0;
        }
        if (spec->kind == ARGK_AEREFITEM)
        {
            if (!ValidateAeRefItem(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_AEREFLAYER)
        {
            if (!ValidateAeRefLayer(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_AEREFPROJECT)
        {
            if (!ValidateAeRefProject(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_AEREFRQITEM)
        {
            if (!ValidateAeRefRQItem(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_STR)
        {
            /* Bounded UTF-8 string (Issue #327): slen is the byte
               count; empty string is permitted (clears the field). */
            if (v->kind != JK_STR || v->slen > (size_t)spec->max)
            {
                snprintf(detailZ, detailCap,
                         "argument \"%s\" out of permitted range", spec->name);
                return 0;
            }
            continue;
        }
        if (v->kind != JK_NUM || !isfinite(v->num) ||
            floor(v->num) != v->num || v->num < spec->min || v->num > spec->max)
        {
            snprintf(detailZ, detailCap,
                     "argument \"%s\" out of permitted range", spec->name);
            return 0;
        }
    }
    /* duplicate spec names would let one field satisfy two slots; the
       table is compile-time constant so this cannot happen, but the
       exact-count check above already bounds the surface. */
    return 1;
}

/* aeRef project-item descriptor shape check (Issue #270, identity
   slice; contract native-channel.md §7b). Wire form:
     {"aeRef":{"type":"folder"|"comp"|"footage","name":"<str>",
               "path":[<non-neg int>],
               "itemId"?:<int>,"projectName"?:"<str>","projectPath"?:"<str>"}}
   Required keys: type, name, path (Stage-3 form). Optional identity
   keys: itemId (integer in [0, 4294967295]), projectName/projectPath
   (strings ≤ 4096 UTF-8 bytes; projectPath may be empty). Any other inner
   key — including contentHash — refuses MALFORMED_REQUEST.
   This proves SHAPE only; resolution against live state happens in
   the executor and its failure is STALE_REFERENCE. */
#define AEREF_MAX_STR 4096
#define AEREF_MAX_ITEMID 4294967295.0

static int AeRefKeyAllowed(const char* keyZ, size_t klen)
{
    static const char* keys[] = {
        "type", "name", "path", "itemId", "projectName", "projectPath"
    };
    size_t i;
    for (i = 0; i < sizeof(keys) / sizeof(keys[0]); i++)
        if (strlen(keys[i]) == klen && memcmp(keyZ, keys[i], klen) == 0)
            return 1;
    return 0;
}

static int ValidateAeRefItem(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* nameV;
    JVal* pathV;
    JVal* idxV;
    JVal* idV;
    JVal* pnV;
    JVal* ppV;
    size_t i;
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRef arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs < 3 || ref->npairs > 6)
    {
        snprintf(detailZ, detailCap,
                 "aeRef must carry type,name,path plus optional itemId/projectName/projectPath");
        return 0;
    }
    /* every key must be in the permitted set; required keys checked below */
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        if (!AeRefKeyAllowed(p->key, p->klen))
        {
            snprintf(detailZ, detailCap,
                     "aeRef carries unsupported key (contentHash unsupported)");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    nameV = JGet(ref, "name");
    pathV = JGet(ref, "path");
    idV = JGet(ref, "itemId");
    pnV = JGet(ref, "projectName");
    ppV = JGet(ref, "projectPath");
    if (!typeV || !nameV || !pathV)
    {
        snprintf(detailZ, detailCap, "aeRef requires type, name, path");
        return 0;
    }
    if (typeV->kind != JK_STR ||
        !(JStrEq(typeV, "folder") || JStrEq(typeV, "comp") || JStrEq(typeV, "footage")))
    {
        snprintf(detailZ, detailCap, "aeRef.type must be folder|comp|footage");
        return 0;
    }
    if (nameV->kind != JK_STR || nameV->slen == 0 ||
        nameV->slen > AEREF_NAME_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRef.name must be a non-empty string ≤ 1024 UTF-8 bytes");
        return 0;
    }
    if (pathV->kind != JK_ARR || pathV->nitems != 1)
    {
        snprintf(detailZ, detailCap,
                 "aeRef.path must be [<index>] — one top-level item index");
        return 0;
    }
    idxV = pathV->items[0];
    if (!idxV || idxV->kind != JK_NUM || !isfinite(idxV->num) ||
        floor(idxV->num) != idxV->num || idxV->num < 0.0 || idxV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap, "aeRef.path[0] must be a non-negative integer");
        return 0;
    }
    if (idV && (idV->kind != JK_NUM || !isfinite(idV->num) ||
                floor(idV->num) != idV->num || idV->num < 0.0 ||
                idV->num > AEREF_MAX_ITEMID))
    {
        snprintf(detailZ, detailCap,
                 "aeRef.itemId must be an integer in [0, 4294967295]");
        return 0;
    }
    if (pnV && (pnV->kind != JK_STR || pnV->slen > AEREF_MAX_STR))
    {
        snprintf(detailZ, detailCap, "aeRef.projectName must be a string ≤ 4096 chars");
        return 0;
    }
    if (ppV && (ppV->kind != JK_STR || ppV->slen > AEREF_MAX_STR))
    {
        snprintf(detailZ, detailCap, "aeRef.projectPath must be a string ≤ 4096 chars");
        return 0;
    }
    return 1;
}

/* aeRefLayer descriptor shape check (Issue #318 layer slice; contract
   native-channel.md §7d). Wire form:
     {"aeRef":{"type":"layer","name":"<str>","layerId":<int32>,
               "comp":{"aeRef":{<item descriptor>}}}}
   All four keys are required — the parent comp binding is part of the
   layer's identity, so a layer descriptor can never resolve against
   the wrong comp. `layerId` is the live AEGP_GetLayerID value
   (AEGP_LayerIDVal = A_long, full int32 range); `name` corroborates.
   Shape only — resolution is host-side and failure is
   STALE_REFERENCE. */
#define AEREF_LAYER_ID_MIN (-2147483648.0)
#define AEREF_LAYER_ID_MAX 2147483647.0

static int ValidateAeRefLayer(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* nameV;
    JVal* idV;
    JVal* compV;
    size_t i;
    static const char* keys[] = { "type", "name", "layerId", "comp" };
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRefLayer arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs != 4)
    {
        snprintf(detailZ, detailCap,
                 "aeRefLayer must carry exactly type,name,layerId,comp");
        return 0;
    }
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        size_t k;
        int ok = 0;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++)
            if (strlen(keys[k]) == p->klen && memcmp(keys[k], p->key, p->klen) == 0)
            { ok = 1; break; }
        if (!ok)
        {
            snprintf(detailZ, detailCap, "aeRefLayer carries unsupported key");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    nameV = JGet(ref, "name");
    idV = JGet(ref, "layerId");
    compV = JGet(ref, "comp");
    if (!typeV || !nameV || !idV || !compV)
    {
        snprintf(detailZ, detailCap, "aeRefLayer requires type, name, layerId, comp");
        return 0;
    }
    if (typeV->kind != JK_STR || !JStrEq(typeV, "layer"))
    {
        snprintf(detailZ, detailCap, "aeRefLayer.type must be \"layer\"");
        return 0;
    }
    if (nameV->kind != JK_STR || nameV->slen == 0 ||
        nameV->slen > AEREF_NAME_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRefLayer.name must be a non-empty string ≤ 1024 UTF-8 bytes");
        return 0;
    }
    if (idV->kind != JK_NUM || !isfinite(idV->num) ||
        floor(idV->num) != idV->num ||
        idV->num < AEREF_LAYER_ID_MIN || idV->num > AEREF_LAYER_ID_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRefLayer.layerId must be an integer in [-2147483648, 2147483647]");
        return 0;
    }
    /* comp is the same {"aeRef":{...}} item-descriptor arg shape —
       recursive shape check; its type must corroborate "comp" at
       resolution time. */
    if (!ValidateAeRefItem(compV, detailZ, detailCap)) return 0;
    return 1;
}

/* aeRefProject descriptor shape check (Issue #318 §7e; contract
   native-channel.md §7e). Wire form:
     {"aeRef":{"type":"project","index":<int>,"name":"<str>","path":"<str>"}}
   Exactly these four keys; index is the 0-based GetProjectByIndex
   position; name non-empty ≤1024 UTF-8 bytes; path may be empty
   (unsaved project). Shape only — resolution is host-side. */
static int ValidateAeRefProject(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* idxV;
    JVal* nameV;
    JVal* pathV;
    size_t i;
    static const char* keys[] = { "type", "index", "name", "path" };
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRefProject arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs != 4)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject must carry exactly type,index,name,path");
        return 0;
    }
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        size_t k;
        int ok = 0;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++)
            if (strlen(keys[k]) == p->klen && memcmp(keys[k], p->key, p->klen) == 0)
            { ok = 1; break; }
        if (!ok)
        {
            snprintf(detailZ, detailCap, "aeRefProject carries unsupported key");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    idxV = JGet(ref, "index");
    nameV = JGet(ref, "name");
    pathV = JGet(ref, "path");
    if (!typeV || !idxV || !nameV || !pathV)
    {
        snprintf(detailZ, detailCap, "aeRefProject requires type, index, name, path");
        return 0;
    }
    if (typeV->kind != JK_STR || !JStrEq(typeV, "project"))
    {
        snprintf(detailZ, detailCap, "aeRefProject.type must be \"project\"");
        return 0;
    }
    if (idxV->kind != JK_NUM || !isfinite(idxV->num) ||
        floor(idxV->num) != idxV->num || idxV->num < 0.0 || idxV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject.index must be an integer in [0, 1000000]");
        return 0;
    }
    if (nameV->kind != JK_STR || nameV->slen == 0 ||
        nameV->slen > AEREF_NAME_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject.name must be a non-empty string ≤ 1024 UTF-8 bytes");
        return 0;
    }
    if (pathV->kind != JK_STR || pathV->slen > AEREF_MAX_STR)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject.path must be a string ≤ 4096 UTF-8 bytes (may be empty)");
        return 0;
    }
    return 1;
}

/* aeRefRQItem descriptor shape check (Issue #318 §7f; contract
   native-channel.md §7f). Wire form:
     {"aeRef":{"type":"rqItem","index":<int>,
               "comp":{"aeRef":{<item descriptor>}},
               "status":<int>,"numOutputModules":<int>}}
   Exactly these five keys. index is the 0-based GetRQItemByIndex
   position; comp is the bound composition's §7b item descriptor
   (recursive shape check); status is AEGP_RenderItemStatusType
   (int32 range); numOutputModules is a non-negative count. Shape
   only — resolution re-verifies every pin atomically. */
static int ValidateAeRefRQItem(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* idxV;
    JVal* compV;
    JVal* statusV;
    JVal* nomV;
    size_t i;
    static const char* keys[] = { "type", "index", "comp", "status", "numOutputModules" };
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRefRQItem arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs != 5)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem must carry exactly type,index,comp,status,numOutputModules");
        return 0;
    }
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        size_t k;
        int ok = 0;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++)
            if (strlen(keys[k]) == p->klen && memcmp(keys[k], p->key, p->klen) == 0)
            { ok = 1; break; }
        if (!ok)
        {
            snprintf(detailZ, detailCap, "aeRefRQItem carries unsupported key");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    idxV = JGet(ref, "index");
    compV = JGet(ref, "comp");
    statusV = JGet(ref, "status");
    nomV = JGet(ref, "numOutputModules");
    if (!typeV || !idxV || !compV || !statusV || !nomV)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem requires type, index, comp, status, numOutputModules");
        return 0;
    }
    if (typeV->kind != JK_STR || !JStrEq(typeV, "rqItem"))
    {
        snprintf(detailZ, detailCap, "aeRefRQItem.type must be \"rqItem\"");
        return 0;
    }
    if (idxV->kind != JK_NUM || !isfinite(idxV->num) ||
        floor(idxV->num) != idxV->num || idxV->num < 0.0 || idxV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem.index must be an integer in [0, 1000000]");
        return 0;
    }
    if (!ValidateAeRefItem(compV, detailZ, detailCap)) return 0;
    if (statusV->kind != JK_NUM || !isfinite(statusV->num) ||
        floor(statusV->num) != statusV->num ||
        statusV->num < -2147483648.0 || statusV->num > 2147483647.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem.status must be an integer in int32 range");
        return 0;
    }
    if (nomV->kind != JK_NUM || !isfinite(nomV->num) ||
        floor(nomV->num) != nomV->num || nomV->num < 0.0 || nomV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem.numOutputModules must be a non-negative integer");
        return 0;
    }
    return 1;
}

/* Map the aeRef type tag to the AEGP_ItemType it claims. Only the three
   live item kinds are expressible; SOLID_defunct has no live identity. */
int AeRefTypeToItemType(JVal* typeV, AEGP_ItemType* outP)
{
    if (JStrEq(typeV, "folder")) { *outP = AEGP_ItemType_FOLDER; return 1; }
    if (JStrEq(typeV, "comp")) { *outP = AEGP_ItemType_COMP; return 1; }
    if (JStrEq(typeV, "footage")) { *outP = AEGP_ItemType_FOOTAGE; return 1; }
    return 0;
}

/* Inverse of AeRefTypeToItemType for payload emission. Returns NULL for
   types with no descriptor tag (NONE, SOLID_defunct, undefined). */
const char* ItemTypeToAeRefTag(AEGP_ItemType t)
{
    if (t == AEGP_ItemType_FOLDER) return "folder";
    if (t == AEGP_ItemType_COMP) return "comp";
    if (t == AEGP_ItemType_FOOTAGE) return "footage";
    return NULL;
}

/* Fetch a validated integer argument (call only after ValidateArgs
   succeeded for this op). */
long ArgsInt(const AllowEntry* allow, JVal* args, int index)
{
    JVal* v = JGet(args, allow->argsSpec[index].name);
    return v ? (long)v->num : 0;
}


#else /* _WIN32 */
#endif
