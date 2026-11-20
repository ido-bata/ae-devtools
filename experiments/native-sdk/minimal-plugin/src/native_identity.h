/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — aeRef identity descriptors:            */
/* validation-time resolution, project corroboration, and           */
/* enumeration/issuance                                             */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/* Contract: native-channel.md §7b–§7f.                             */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_IDENTITY_H
#define AE_PROBE_NATIVE_IDENTITY_H

#include <stddef.h>

#include "native_intake.h"   /* AE_GeneralPlug.h types */
#include "native_json.h"     /* JVal */
#include "native_registry.h" /* AllowEntry, AEREF_NAME_MAX */
#include "native_request.h"  /* ReqVerdict */

#define PROJ_STR_MAX 4096     /* projectPath fetch bound (= descriptor bound) */
#define LAYER_NAME_MAX 1024   /* UTF-8 bytes; shared with layer emitters in native_ops.cpp */

typedef struct
{
    AEGP_ProjectH projectH;
    AEGP_ItemH itemH;
    long index;                 /* live top-level iteration position */
    AEGP_ItemType type;
    int nameTruncated;          /* live name exceeded AEREF_NAME_MAX */
    char name[AEREF_NAME_MAX + 1];
    char projectName[AEGP_MAX_PROJ_NAME_SIZE + 1];
    char projectPath[PROJ_STR_MAX + 1];
    int haveProjectName;
    int haveProjectPath;
    const void* itemSuite;
    const void* memSuite;
    const AEGP_ItemSuite9* itemP;
    const AEGP_MemorySuite1* memP;
} ItemResolution;

typedef struct
{
    ItemResolution res;          /* resolved parent comp item */
    const void* compSuite;
    const void* layerSuite;
    const AEGP_CompSuite13* compP;
    const AEGP_LayerSuite9* layerP;
    AEGP_CompH compH;            /* borrowed, request-window only */
    AEGP_LayerH layerH;          /* borrowed, request-window only */
} LayerResolution;

typedef struct
{
    ItemResolution item;          /* comp item resolution (suites held) */
    const void* compSuite;
    const void* rqItemSuite;
    const AEGP_CompSuite13* compP;
    const AEGP_RQItemSuite4* rqItemP;
    AEGP_RQItemRefH rqH;          /* borrowed — never freed, never leaves window */
    long rqIndex;
    long wantItemId;              /* descriptor comp's live itemId (-1 = legacy) */
    long wantStatus;
    long wantNumOM;
} RQResolution;

void ReleaseResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    ItemResolution* r);
void ReleaseLayerResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    LayerResolution* lr);
void ReleaseRQResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    RQResolution* r);

/* Resolve a validated aeRef descriptor to a live item inside the
   request window (contract §7b). On success returns 1 with r filled —
   the caller MUST ReleaseResolution before leaving the request. On
   failure returns 0 with `v` already carrying the verdict. */
int ResolveAeRefItem(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* ref,
    int wantProjectIdentity,
    const char* nameCallExtraZ,
    ItemResolution* r,
    ReqVerdict* v);

/* Same contract one level deeper: aeRefLayer embeds its parent comp
   aeRef; resolution goes comp aeRef → compH → live layerId+name match. */
int ResolveLayerRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* ref,
    int wantProjectIdentity,
    const char* nameCallExtraZ,
    LayerResolution* lr,
    ReqVerdict* v);

/* aeRefProject (§7e): index + name + path corroboration with a
   collision scan; no project id exists in the SDK. */
int ResolveProjectRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    JVal* ref,
    AEGP_ProjectH* projectHOut,
    long* indexOut,
    ReqVerdict* v);

/* aeRefRQItem (§7f): atomic select+read inside ONE dispatch — comp
   aeRef → live itemId, queue index → fingerprint (status,
   numOutputModules) re-verified before the caller's getter runs. */
int ResolveRQItemRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* ref,
    RQResolution* r,
    ReqVerdict* v);

/* Canonical issued descriptor for a resolved item:
   {"itemId":N,"item":{"aeRef":{...}}}. Returns 1 on success; 0 when
   the payload would exceed the result bound or the type has no tag. */
int EmitIssuedDescriptor(
    ReqVerdict* v,
    const ItemResolution* r,
    long itemId);

/* Discovery/enumeration executors (routed via the dispatch table). */
void EnumerateProjItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v);
void EnumerateRQItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v);

#endif /* AE_PROBE_NATIVE_IDENTITY_H */
