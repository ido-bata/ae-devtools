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
#include "native_identity.h"
#include "native_suites.h"
#include "native_support.h"
#include "native_state.h"

/* ---- identity resolution + payload emit (Issue #270 identity slice)
   Contract: native-channel.md §7b. One shared resolver serves every
   identity-bearing intake op — project/comp/layer/RQ-item descriptor
   kinds extend THIS structure later, not parallel resolvers. */

#define RESOLVE_SCAN_MAX 100000L
#define ENUM_LIMIT_MAX 32

void ReleaseResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    ItemResolution* r)
{
    if (r->itemSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (r->memSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    memset(r, 0, sizeof(*r));
}


/* Read the project's display name (A_char, bounded) and file path
   (UTF-16 mem handle → UTF-8). wantName/wantPath select which reads
   run; every call is op-recorded. Returns FPI_* status. */
enum { FPI_OK = 0, FPI_AEGP_ERR, FPI_TRUNCATED };
static int FetchProjectIdentity(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_MemorySuite1* memP,
    AEGP_ProjectH projectH,
    int wantName, int wantPath,
    char* nameOut, size_t nameCap,
    char* pathOut, size_t pathCap,
    A_Err* errP)
{
    *errP = A_Err_NONE;
    nameOut[0] = '\0';
    pathOut[0] = '\0';
    if (wantName)
    {
        A_char nb[AEGP_MAX_PROJ_NAME_SIZE + 1];
        A_Err e;
        if (!projP->AEGP_GetProjectName) { *errP = A_Err_STRUCT; return FPI_AEGP_ERR; }
        memset(nb, 0, sizeof(nb));
        e = projP->AEGP_GetProjectName(projectH, nb);
        IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectName", (long)e, NULL);
        if (e != A_Err_NONE) { *errP = e; return FPI_AEGP_ERR; }
        strncpy(nameOut, nb, nameCap - 1);
        nameOut[nameCap - 1] = '\0';
    }
    if (wantPath)
    {
        AEGP_MemHandle ph = NULL;
        A_Err e;
        IntakeMemStatus ms;
        if (!projP->AEGP_GetProjectPath || !memP) { *errP = A_Err_STRUCT; return FPI_AEGP_ERR; }
        e = projP->AEGP_GetProjectPath(projectH, &ph);
        IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectPath", (long)e, NULL);
        if (e != A_Err_NONE) { *errP = e; return FPI_AEGP_ERR; }
        ms = IntakeReadMemHandleUtf8(utilP, memP, ph, pathOut, pathCap);
        if (ms == IMH_TRUNCATED) return FPI_TRUNCATED;
        if (ms != IMH_OK) { *errP = A_Err_STRUCT; return FPI_AEGP_ERR; }
    }
    return FPI_OK;
}

/* Exact-match a descriptor string field (JVal, slen bytes — may hold
   embedded NULs) against a NUL-terminated live string. */
static int JStrEqCStr(JVal* v, const char* liveZ)
{
    size_t n = strlen(liveZ);
    return v && v->kind == JK_STR && v->slen == n &&
           memcmp(v->str, liveZ, n) == 0;
}

/* Resolve a validated aeRef descriptor to a live item inside the
   request window (contract §7b). `ref` is the aeRef object; shape was
   proven by ValidateArgs. wantProjectIdentity forces the project
   name/path fetch even when the descriptor does not carry them
   (issuance/enumeration payloads need the values).
   nameCallExtraZ marks the GetItemName record (" (resolve+result)"
   when the consuming op IS GetItemName, " (resolve)" otherwise).
   On success returns 1: r is filled and its suites stay acquired —
   the caller MUST ReleaseResolution before leaving the request.
   On failure returns 0 with `v` already carrying the verdict
   (refused STALE_REFERENCE / failed / not-sent). */
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
    ReqVerdict* v)
{
    JVal* typeV = JGet(ref, "type");
    JVal* nameV = JGet(ref, "name");
    JVal* pathV = JGet(ref, "path");
    JVal* idV = JGet(ref, "itemId");
    JVal* pnV = JGet(ref, "projectName");
    JVal* ppV = JGet(ref, "projectPath");
    AEGP_ItemType wantType = AEGP_ItemType_NONE;
    long wantIndex = -1;
    long wantId = -1;
    int haveId = 0;
    int wantName, wantPath;
    const void* itemSuite = NULL;
    const void* memSuite = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    AEGP_ProjectH projectH = NULL;
    AEGP_ItemH itemH = NULL;
    A_Err perr;

    memset(r, 0, sizeof(*r));
    AeRefTypeToItemType(typeV, &wantType); /* shape already validated */
    if (pathV && pathV->kind == JK_ARR && pathV->nitems == 1 &&
        pathV->items[0] && pathV->items[0]->kind == JK_NUM)
        wantIndex = (long)pathV->items[0]->num;
    if (idV) { wantId = (long)idV->num; haveId = 1; }

    /* project selection — projP is the fingerprint-held suite */
    wantName = wantProjectIdentity || pnV != NULL;
    wantPath = wantProjectIdentity || ppV != NULL;
    if (!projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex ||
        (wantName && !projP->AEGP_GetProjectName) ||
        (wantPath && !projP->AEGP_GetProjectPath))
    {
        VerdictSet(v, "not-sent", "project suite entries unavailable for identity resolve");
        return 0;
    }
    {
        A_long numProjects = 0;
        perr = projP->AEGP_GetNumProjects(&numProjects);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetNumProjects", (long)perr,
            perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE)
        {
            VerdictSet(v, "failed", "AEGP_GetNumProjects err=%ld", (long)perr);
            return 0;
        }
        if (projectIndex < 0 || projectIndex >= (long)numProjects)
        {
            VerdictRefuse(v, "STALE_REFERENCE", "projectIndex out of range");
            return 0;
        }
        perr = projP->AEGP_GetProjectByIndex(projectIndex, &projectH);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetProjectByIndex", (long)perr,
            perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE || !projectH)
        {
            VerdictSet(v, "failed", "AEGP_GetProjectByIndex err=%ld", (long)perr);
            return 0;
        }
    }

    /* item + memory suites inside the request window */
    itemSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPItemSuite, kAEGPItemSuiteVersion9);
    memSuite = IntakeAcquireSuite(utilP, basicP,
                                  kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (!itemSuite || !memSuite)
    {
        if (itemSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPItemSuite, kAEGPItemSuiteVersion9);
        if (memSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        VerdictSet(v, "not-sent", "item/memory suite unavailable for identity resolve");
        return 0;
    }
    itemP = (const AEGP_ItemSuite9*)itemSuite;
    memP = (const AEGP_MemorySuite1*)memSuite;
    r->itemSuite = itemSuite;
    r->memSuite = memSuite;
    r->itemP = itemP;
    r->memP = memP;
    r->projectH = projectH;

#define RESOLVE_NOT_SENT(msg) do { \
        ReleaseResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RESOLVE_FAILED(fmt, err) do { \
        ReleaseResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RESOLVE_STALE(why) do { \
        ReleaseResolution(utilP, basicP, r); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    if (!itemP->AEGP_GetFirstProjItem || !itemP->AEGP_GetNextProjItem ||
        !itemP->AEGP_GetItemType || !itemP->AEGP_GetItemName ||
        (haveId && !itemP->AEGP_GetItemID))
        RESOLVE_NOT_SENT("item suite entries unavailable for identity resolve");

    /* project corroboration + payload identity fields */
    {
        A_Err ferr = A_Err_NONE;
        int fpi = FetchProjectIdentity(utilP, projP, memP, projectH,
                                     wantName, wantPath,
                                     r->projectName, sizeof(r->projectName),
                                     r->projectPath, sizeof(r->projectPath),
                                     &ferr);
        if (fpi == FPI_AEGP_ERR)
            RESOLVE_FAILED("project identity read err=%ld", ferr);
        if (fpi == FPI_TRUNCATED)
            RESOLVE_FAILED("project path exceeds descriptor bound err=%ld", ferr);
        r->haveProjectName = wantName;
        r->haveProjectPath = wantPath;
        if (pnV && !JStrEqCStr(pnV, r->projectName))
            RESOLVE_STALE("project name mismatch");
        if (ppV && !JStrEqCStr(ppV, r->projectPath))
            RESOLVE_STALE("project path mismatch");
    }

    /* item resolution: itemId present → authoritative id scan;
       absent → legacy positional path walk (Stage-3 semantics). */
    {
        A_Err ierr = itemP->AEGP_GetFirstProjItem(projectH, &itemH);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetFirstProjItem", (long)ierr,
            ierr == A_Err_NONE ? " (resolve)" : NULL);
        if (ierr != A_Err_NONE)
            RESOLVE_FAILED("AEGP_GetFirstProjItem err=%ld", ierr);
    }
    if (haveId)
    {
        /* scan every top-level item for exactly one itemId match —
           reorder-tolerant; path is not consulted. */
        AEGP_ItemH matchH = NULL;
        long matchPos = -1;
        long matches = 0;
        long pos = 0;
        while (itemH)
        {
            if (pos >= RESOLVE_SCAN_MAX)
                RESOLVE_FAILED("item scan limit exceeded err=%ld", (long)pos);
            {
                A_long id = 0;
                A_Err iderr = itemP->AEGP_GetItemID(itemH, &id);
                IntakeOpRecord(utilP,
                    "AEGP_ItemSuite9.AEGP_GetItemID", (long)iderr,
                    iderr == A_Err_NONE ? " (resolve)" : NULL);
                if (iderr != A_Err_NONE)
                    RESOLVE_FAILED("AEGP_GetItemID err=%ld", iderr);
                /* A_long is int32; the wire itemId range is u32 —
                   compare bit-exact so ids with the sign bit set still
                   match instead of silently never resolving. */
                if ((unsigned int)id == (unsigned int)wantId)
                { matches++; matchH = itemH; matchPos = pos; }
            }
            {
                AEGP_ItemH nextH = NULL;
                A_Err nerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
                IntakeOpRecord(utilP,
                    "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)nerr,
                    nerr == A_Err_NONE ? " (resolve)" : NULL);
                if (nerr != A_Err_NONE)
                    RESOLVE_FAILED("AEGP_GetNextProjItem err=%ld", nerr);
                itemH = nextH;
                pos++;
            }
        }
        if (matches == 0)
            RESOLVE_STALE("itemId not found");
        if (matches > 1)
            RESOLVE_STALE("itemId ambiguous");
        itemH = matchH;
        r->index = matchPos;
    }
    else
    {
        /* legacy positional walk to path[0] */
        long pos = 0;
        while (itemH && pos < wantIndex)
        {
            AEGP_ItemH nextH = NULL;
            A_Err nerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
            IntakeOpRecord(utilP,
                "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)nerr,
                nerr == A_Err_NONE ? " (resolve)" : NULL);
            if (nerr != A_Err_NONE) { itemH = NULL; break; }
            itemH = nextH;
            pos++;
        }
        if (!itemH || pos != wantIndex)
            RESOLVE_STALE("item path index out of range");
        r->index = wantIndex;
    }
    r->itemH = itemH;

    /* corroboration: type + name must match the descriptor in BOTH
       modes — a renamed item stales its descriptor (client re-issues). */
    {
        AEGP_ItemType actualType = AEGP_ItemType_NONE;
        A_Err terr = itemP->AEGP_GetItemType(itemH, &actualType);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetItemType", (long)terr,
            terr == A_Err_NONE ? " (resolve)" : NULL);
        if (terr != A_Err_NONE)
            RESOLVE_FAILED("AEGP_GetItemType err=%ld", terr);
        if (actualType != wantType)
            RESOLVE_STALE("item type mismatch");
        r->type = actualType;
    }
    {
        AEGP_MemHandle nameH = NULL;
        A_Err nerr = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetItemName", (long)nerr,
            nerr == A_Err_NONE ? nameCallExtraZ : NULL);
        if (nerr != A_Err_NONE)
            RESOLVE_FAILED("AEGP_GetItemName err=%ld", nerr);
        {
            IntakeMemStatus mst =
                IntakeReadMemHandleUtf8(utilP, memP, nameH,
                                        r->name, sizeof(r->name));
            if (mst != IMH_OK && mst != IMH_TRUNCATED)
                RESOLVE_FAILED("item name mem-handle read failed err=%ld", (long)mst);
            r->nameTruncated = (mst == IMH_TRUNCATED);
            if (r->nameTruncated)
                RESOLVE_STALE("item name exceeds identity bound");
            if (nameV->slen != strlen(r->name) ||
                memcmp(nameV->str, r->name, nameV->slen) != 0)
                RESOLVE_STALE("item name mismatch");
        }
    }

#undef RESOLVE_NOT_SENT
#undef RESOLVE_FAILED
#undef RESOLVE_STALE
    return 1;
}

/* Emit the canonical issued descriptor for a resolved item:
   {"itemId":N,"item":{"aeRef":{...}}} — result.item is stored
   verbatim as args.item by the client. Returns 1 on success; 0 when
   the payload would exceed the result bound or the type has no tag. */
int EmitIssuedDescriptor(
    ReqVerdict* v,
    const ItemResolution* r,
    long itemId)
{
    const char* tag = ItemTypeToAeRefTag(r->type);
    JBuf b;
    if (!tag) return 0;
    JBInit(&b, v->payload, sizeof(v->payload));
    JBPut(&b, "{\"itemId\":");
    JBNum(&b, itemId);
    JBPut(&b, ",\"item\":{\"aeRef\":{\"type\":\"");
    JBPut(&b, tag);
    JBPut(&b, "\",\"name\":\"");
    JBEsc(&b, r->name);
    JBPut(&b, "\",\"path\":[");
    JBNum(&b, r->index);
    JBPut(&b, "],\"itemId\":");
    JBNum(&b, itemId);
    if (r->haveProjectName)
    {
        JBPut(&b, ",\"projectName\":\"");
        JBEsc(&b, r->projectName);
        JBPut(&b, "\"");
    }
    if (r->haveProjectPath)
    {
        JBPut(&b, ",\"projectPath\":\"");
        JBEsc(&b, r->projectPath);
        JBPut(&b, "\"");
    }
    JBPut(&b, "}}}");
    if (b.of) return 0;
    *b.cur = '\0';
    return 1;
}

/* Emit one enumeration item entry. Normal items get a complete usable
   descriptor; names over the identity bound get an honest marker. */
static void EmitEnumItem(
    JBuf* b,
    long index,
    AEGP_ItemType type,
    const char* nameZ,
    int nameTruncated,
    long itemId,
    const char* projectNameZ,
    const char* projectPathZ)
{
    const char* tag = ItemTypeToAeRefTag(type);
    if (!tag)
    {
        /* live item kind with no descriptor tag (e.g. solid): report
           honestly, never emit a partial/invalid aeRef. */
        JBPut(b, "{\"index\":");
        JBNum(b, index);
        JBPut(b, ",\"unsupportedType\":true}");
        return;
    }
    if (nameTruncated)
    {
        JBPut(b, "{\"index\":");
        JBNum(b, index);
        JBPut(b, ",\"type\":\"");
        JBPut(b, tag);
        JBPut(b, "\",\"itemId\":");
        JBNum(b, itemId);
        JBPut(b, ",\"nameTruncated\":true}");
        return;
    }
    JBPut(b, "{\"item\":{\"aeRef\":{\"type\":\"");
    JBPut(b, tag);
    JBPut(b, "\",\"name\":\"");
    JBEsc(b, nameZ);
    JBPut(b, "\",\"path\":[");
    JBNum(b, index);
    JBPut(b, "],\"itemId\":");
    JBNum(b, itemId);
    JBPut(b, ",\"projectName\":\"");
    JBEsc(b, projectNameZ);
    JBPut(b, "\",\"projectPath\":\"");
    JBEsc(b, projectPathZ);
    JBPut(b, "\"}}}");
}

/* AEGP_ItemSuite9.AEGP_GetFirstProjItem as discovery/enumeration
   (Issue #270 identity slice): {projectIndex, offset, limit} →
   ready-to-use aeRef descriptors for the project's top-level items.
   Walks the full list once (total is exact), emits the [offset,
   offset+limit) window, pages via offset. Every call op-recorded;
   failures are typed verdicts, never partial payloads. */
void EnumerateProjItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)plugin_id;
    long projectIndex = (long)JGet(args, "projectIndex")->num;
    long offset = (long)JGet(args, "offset")->num;
    long limit = (long)JGet(args, "limit")->num;
    AEGP_ProjectH projectH = NULL;
    AEGP_ItemH itemH = NULL;
    const void* itemSuite = NULL;
    const void* memSuite = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    ItemResolution projIds;
    long pos = 0;
    long total = 0;
    int windowStart, windowCount = 0;
    /* window slots: limit ≤ 32, each ~1.1 KB worst case */
    struct EnumSlot
    {
        long index;
        AEGP_ItemType type;
        long itemId;
        int nameTruncated;
        char name[AEREF_NAME_MAX + 1];
    } slots[ENUM_LIMIT_MAX];
    JBuf b;
    int cut = 0;
    A_Err perr;

    memset(&projIds, 0, sizeof(projIds));
    projIds.haveProjectName = 1;
    projIds.haveProjectPath = 1;

    if (!projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex ||
        !projP->AEGP_GetProjectName || !projP->AEGP_GetProjectPath)
    {
        VerdictSet(v, "not-sent", "project suite entries unavailable for enumeration");
        return;
    }
    {
        A_long numProjects = 0;
        perr = projP->AEGP_GetNumProjects(&numProjects);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetNumProjects", (long)perr,
            perr == A_Err_NONE ? " (enum)" : NULL);
        if (perr != A_Err_NONE)
        {
            VerdictSet(v, "failed", "AEGP_GetNumProjects err=%ld", (long)perr);
            return;
        }
        if (projectIndex < 0 || projectIndex >= (long)numProjects)
        {
            VerdictRefuse(v, "STALE_REFERENCE", "projectIndex out of range");
            return;
        }
        perr = projP->AEGP_GetProjectByIndex(projectIndex, &projectH);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetProjectByIndex", (long)perr,
            perr == A_Err_NONE ? " (enum)" : NULL);
        if (perr != A_Err_NONE || !projectH)
        {
            VerdictSet(v, "failed", "AEGP_GetProjectByIndex err=%ld", (long)perr);
            return;
        }
    }

    itemSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPItemSuite, kAEGPItemSuiteVersion9);
    memSuite = IntakeAcquireSuite(utilP, basicP,
                                  kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (!itemSuite || !memSuite)
    {
        if (itemSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPItemSuite, kAEGPItemSuiteVersion9);
        if (memSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        VerdictSet(v, "not-sent", "item/memory suite unavailable for enumeration");
        return;
    }
    itemP = (const AEGP_ItemSuite9*)itemSuite;
    memP = (const AEGP_MemorySuite1*)memSuite;

#define ENUM_NOT_SENT(msg) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9); \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return; } while (0)
#define ENUM_FAILED(fmt, err) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9); \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return; } while (0)

    if (!itemP->AEGP_GetFirstProjItem || !itemP->AEGP_GetNextProjItem ||
        !itemP->AEGP_GetItemType || !itemP->AEGP_GetItemName ||
        !itemP->AEGP_GetItemID)
        ENUM_NOT_SENT("item suite entries unavailable for enumeration");

    {
        A_Err ferr = A_Err_NONE;
        int fpi = FetchProjectIdentity(utilP, projP, memP, projectH,
                                     1, 1,
                                     projIds.projectName, sizeof(projIds.projectName),
                                     projIds.projectPath, sizeof(projIds.projectPath),
                                     &ferr);
        if (fpi == FPI_AEGP_ERR)
            ENUM_FAILED("project identity read err=%ld", ferr);
        if (fpi == FPI_TRUNCATED)
            ENUM_FAILED("project path exceeds descriptor bound err=%ld", ferr);
    }

    /* single walk: count total, capture the [offset, offset+limit)
       window's type/name/id. */
    windowStart = (int)(offset < 0 ? 0 : offset);
    {
        A_Err ierr = itemP->AEGP_GetFirstProjItem(projectH, &itemH);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetFirstProjItem", (long)ierr,
            ierr == A_Err_NONE ? " (enum)" : NULL);
        if (ierr != A_Err_NONE)
            ENUM_FAILED("AEGP_GetFirstProjItem err=%ld", ierr);
    }
    while (itemH)
    {
        if (pos >= RESOLVE_SCAN_MAX)
            ENUM_FAILED("item scan limit exceeded err=%ld", pos);
        if (pos >= windowStart && pos < windowStart + limit &&
            windowCount < ENUM_LIMIT_MAX)
        {
            struct EnumSlot* s = &slots[windowCount];
            AEGP_ItemType t = AEGP_ItemType_NONE;
            AEGP_MemHandle nh = NULL;
            A_long id = 0;
            A_Err e1, e2, e3;
            IntakeMemStatus ms;
            s->index = pos;
            s->name[0] = '\0';
            s->nameTruncated = 0;
            e1 = itemP->AEGP_GetItemType(itemH, &t);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemType",
                           (long)e1, e1 == A_Err_NONE ? " (enum)" : NULL);
            if (e1 != A_Err_NONE) ENUM_FAILED("AEGP_GetItemType err=%ld", e1);
            s->type = t;
            e2 = itemP->AEGP_GetItemName(plugin_id, itemH, &nh);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemName",
                           (long)e2, e2 == A_Err_NONE ? " (enum)" : NULL);
            if (e2 != A_Err_NONE) ENUM_FAILED("AEGP_GetItemName err=%ld", e2);
            ms = IntakeReadMemHandleUtf8(utilP, memP, nh,
                                         s->name, sizeof(s->name));
            if (ms != IMH_OK && ms != IMH_TRUNCATED)
                ENUM_FAILED("item name mem-handle read failed err=%ld", (long)ms);
            s->nameTruncated = (ms == IMH_TRUNCATED);
            e3 = itemP->AEGP_GetItemID(itemH, &id);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                           (long)e3, e3 == A_Err_NONE ? " (enum)" : NULL);
            if (e3 != A_Err_NONE) ENUM_FAILED("AEGP_GetItemID err=%ld", e3);
            s->itemId = (long)(unsigned int)id; /* emit u32, not sign-extended */
            windowCount++;
        }
        {
            AEGP_ItemH nextH = NULL;
            A_Err nerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
            IntakeOpRecord(utilP,
                "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)nerr,
                nerr == A_Err_NONE ? " (enum)" : NULL);
            if (nerr != A_Err_NONE) ENUM_FAILED("AEGP_GetNextProjItem err=%ld", nerr);
            itemH = nextH;
            pos++;
        }
    }
    total = pos;

    /* emit: project block + window items + paging flags. `truncated`
       is written last so a payload-budget cut can still be reported. */
    JBInit(&b, v->payload, sizeof(v->payload));
    JBPut(&b, "{\"project\":{\"index\":");
    JBNum(&b, projectIndex);
    JBPut(&b, ",\"name\":\"");
    JBEsc(&b, projIds.projectName);
    JBPut(&b, "\",\"path\":\"");
    JBEsc(&b, projIds.projectPath);
    JBPut(&b, "\"},\"total\":");
    JBNum(&b, total);
    JBPut(&b, ",\"offset\":");
    JBNum(&b, offset);
    JBPut(&b, ",\"items\":[");
    {
        int i;
        for (i = 0; i < windowCount && !b.of; i++)
        {
            size_t mark = (size_t)(b.cur - v->payload);
            if (i) JBPut(&b, ",");
            EmitEnumItem(&b, slots[i].index, slots[i].type, slots[i].name,
                         slots[i].nameTruncated, slots[i].itemId,
                         projIds.projectName, projIds.projectPath);
            if (b.of)
            {
                /* roll back the partial item; mark the page cut */
                b.cur = v->payload + mark;
                b.left = sizeof(v->payload) - mark;
                b.of = 0;
                cut = 1;
                break;
            }
        }
    }
    JBPut(&b, "],\"truncated\":");
    JBPut(&b, (cut || total > windowStart + windowCount) ? "true" : "false");
    JBPut(&b, "}");
    if (b.of)
        ENUM_FAILED("enumeration payload exceeds result bound err=%ld", (long)0);
    *b.cur = '\0';

    IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    {
        char eb[48];
        snprintf(eb, sizeof(eb), " value=%ld", total);
        IntakeOpRecord(utilP, allow->opRecordId, A_Err_NONE, eb);
    }
    snprintf(v->outcome, sizeof(v->outcome), "completed");
    v->havePayload = 1;
    v->mayHaveMutated = 0;
    v->publish = 1;

#undef ENUM_NOT_SENT
#undef ENUM_FAILED
}


/* ---- AEGP_LayerSuite9 (Issue #318 / #64 layer slice) -----------------
   Vertical slice of the shared identity resolver, one level deeper:
   the wire carries an aeRefLayer descriptor
     {"aeRef":{"type":"layer","name":..,"layerId":N,
               "comp":{"aeRef":{<comp item descriptor>}}}}
   — the parent comp binding is part of the layer's identity. Resolution:
   comp aeRef → ResolveAeRefItem → itemH → AEGP_GetCompFromItem →
   compH → scan AEGP_GetCompNumLayers/GetCompLayerByIndex for the live
   AEGP_GetLayerID match, then AEGP_GetLayerName corroboration. Layer
   and comp handles are borrowed — never freed, never on the wire; both
   suites are released before the request completes. Missing
   suite/entry → not-sent; AEGP errors → failed; identity mismatch →
   refused STALE_REFERENCE; all read-only → mayHaveMutated=false. */

#define LAYER_SCAN_MAX 100000L

void ReleaseLayerResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    LayerResolution* lr)
{
    if (lr->compSuite)
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
    if (lr->layerSuite)
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    ReleaseResolution(utilP, basicP, &lr->res);
    memset(lr, 0, sizeof(*lr));
}

/* Resolve a validated aeRefLayer descriptor to a live layer inside the
   request window. On success returns 1 with lr filled — caller MUST
   ReleaseLayerResolution. On failure returns 0 with `v` carrying the
   verdict. */
int ResolveLayerRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* layerRef,
    int wantProjectIdentity,
    const char* nameCallExtraZ,
    LayerResolution* lr,
    ReqVerdict* v)
{
    JVal* nameV = JGet(layerRef, "name");
    JVal* idV = JGet(layerRef, "layerId");
    JVal* compObj = JGet(layerRef, "comp");
    JVal* compRef = compObj ? JGet(compObj, "aeRef") : NULL;
    long wantId = 0;
    const void* compSuite = NULL;
    const void* layerSuite = NULL;
    const AEGP_CompSuite13* compP = NULL;
    const AEGP_LayerSuite9* layerP = NULL;
    AEGP_CompH compH = NULL;
    AEGP_LayerH matchH = NULL;
    A_long numLayers = 0;
    long matches = 0;
    long i;
    A_Err perr;

    memset(lr, 0, sizeof(*lr));
    if (idV) wantId = (long)idV->num;
    if (!nameV || !idV || !compRef)
    {
        VerdictRefuse(v, "MALFORMED_REQUEST",
                      "aeRefLayer requires name, layerId, comp.aeRef");
        return 0;
    }

    /* parent comp first — full §7b item resolution + corroboration */
    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projectIndex, compRef, wantProjectIdentity,
                          nameCallExtraZ, &lr->res, v))
        return 0;
    if (lr->res.type != AEGP_ItemType_COMP)
    {
        ReleaseResolution(utilP, basicP, &lr->res);
        VerdictRefuse(v, "STALE_REFERENCE",
                      "parent comp descriptor does not resolve to a comp item");
        return 0;
    }

    compSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPCompSuite, kAEGPCompSuiteVersion13);
    layerSuite = IntakeAcquireSuite(utilP, basicP,
                                    kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    if (!compSuite || !layerSuite)
    {
        if (compSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPCompSuite, kAEGPCompSuiteVersion13);
        if (layerSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
        ReleaseResolution(utilP, basicP, &lr->res);
        VerdictSet(v, "not-sent", "comp/layer suite unavailable for layer resolve");
        return 0;
    }
    compP = (const AEGP_CompSuite13*)compSuite;
    layerP = (const AEGP_LayerSuite9*)layerSuite;
    lr->compSuite = compSuite;
    lr->layerSuite = layerSuite;
    lr->compP = compP;
    lr->layerP = layerP;

#define LRES_NOT_SENT(msg) do { \
        ReleaseLayerResolution(utilP, basicP, lr); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define LRES_FAILED(fmt, err) do { \
        ReleaseLayerResolution(utilP, basicP, lr); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define LRES_STALE(why) do { \
        ReleaseLayerResolution(utilP, basicP, lr); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    if (!compP->AEGP_GetCompFromItem || !layerP->AEGP_GetCompNumLayers ||
        !layerP->AEGP_GetCompLayerByIndex || !layerP->AEGP_GetLayerID ||
        !layerP->AEGP_GetLayerName)
        LRES_NOT_SENT("comp/layer suite entries unavailable for layer resolve");

    perr = compP->AEGP_GetCompFromItem(lr->res.itemH, &compH);
    IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE || !compH)
        LRES_FAILED("AEGP_GetCompFromItem err=%ld", perr);
    lr->compH = compH;

    perr = layerP->AEGP_GetCompNumLayers(compH, &numLayers);
    IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetCompNumLayers",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE)
        LRES_FAILED("AEGP_GetCompNumLayers err=%ld", perr);
    if (numLayers < 0 || numLayers > LAYER_SCAN_MAX)
        LRES_FAILED("layer count exceeds scan bound err=%ld", numLayers);

    /* layerId-authoritative scan — reorder-tolerant like the item
       resolver; every candidate's live id is compared bit-exact. */
    for (i = 0; i < (long)numLayers; i++)
    {
        AEGP_LayerH lh = NULL;
        AEGP_LayerIDVal lid = 0;
        perr = layerP->AEGP_GetCompLayerByIndex(compH, (A_long)i, &lh);
        IntakeOpRecord(utilP,
            "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex", (long)perr,
            perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE || !lh)
            LRES_FAILED("AEGP_GetCompLayerByIndex err=%ld", perr);
        perr = layerP->AEGP_GetLayerID(lh, &lid);
        IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerID",
                       (long)perr,
                       perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE)
            LRES_FAILED("AEGP_GetLayerID err=%ld", perr);
        if ((long)lid == wantId) { matches++; matchH = lh; }
    }
    if (matches == 0) LRES_STALE("layerId not found");
    if (matches > 1) LRES_STALE("layerId ambiguous");
    lr->layerH = matchH;

    /* name corroboration — a renamed layer stales its descriptor
       (client re-issues via GetCompLayerByIndex). GetLayerName returns
       TWO mem handles; both are freed (the reader frees the layer
       name, the source name is freed explicitly). */
    {
        AEGP_MemHandle lnH = NULL;
        AEGP_MemHandle snH = NULL;
        char lname[LAYER_NAME_MAX + 1];
        IntakeMemStatus ms;
        perr = layerP->AEGP_GetLayerName(plugin_id, matchH, &lnH, &snH);
        IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerName",
                       (long)perr,
                       perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE)
        {
            if (snH) IntakeFreeMemHandle(utilP, lr->res.memP, snH);
            LRES_FAILED("AEGP_GetLayerName err=%ld", perr);
        }
        ms = IntakeReadMemHandleUtf8(utilP, lr->res.memP, lnH,
                                     lname, sizeof(lname));
        if (snH) IntakeFreeMemHandle(utilP, lr->res.memP, snH);
        if (ms == IMH_TRUNCATED)
            LRES_STALE("layer name exceeds identity bound");
        if (ms != IMH_OK)
            LRES_FAILED("layer name mem-handle read failed err=%ld", (long)ms);
        if (nameV->slen != strlen(lname) ||
            memcmp(nameV->str, lname, nameV->slen) != 0)
            LRES_STALE("layer name mismatch");
    }

#undef LRES_NOT_SENT
#undef LRES_FAILED
#undef LRES_STALE
    return 1;
}

/* ================= Issue #318 Stage 4: project + RQ-item identity ====
   §7e aeRefProject: the SDK has no project id — identity is
   index + name + path corroboration with a collision scan (§7e).
   §7f aeRefRQItem: no RQ-item id and RQItemRefH dies on any queue
   change — identity is index + bound-comp itemId + (status,
   numOutputModules) fingerprint, all re-verified inside ONE dispatch
   (atomic select+read; the handle never leaves the request window). */

/* Resolve an aeRefProject descriptor to a borrowed projectH inside the
   request window. projP is the fingerprint-held suite; the memory suite
   is acquired/released internally for the path read. On success
   returns 1 with *projectHOut set (borrowed — caller must NOT free);
   name/path are re-fetched into out params for payload use. On failure
   returns 0 with `v` carrying the verdict. */
int ResolveProjectRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    JVal* ref,
    AEGP_ProjectH* projectHOut,
    long* indexOut,
    ReqVerdict* v)
{
    JVal* idxV = JGet(ref, "index");
    JVal* nameV = JGet(ref, "name");
    JVal* pathV = JGet(ref, "path");
    long wantIndex = (long)idxV->num;
    const void* memSuite = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    AEGP_ProjectH projectH = NULL;
    A_long numProjects = 0;
    A_Err perr;
    char liveName[AEGP_MAX_PROJ_NAME_SIZE + 1];
    char livePath[PROJ_STR_MAX + 1];
    A_Err ferr = A_Err_NONE;

    *projectHOut = NULL;
    *indexOut = wantIndex;

    if (!projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex ||
        !projP->AEGP_GetProjectName || !projP->AEGP_GetProjectPath)
    {
        VerdictSet(v, "not-sent", "project suite entries unavailable for identity resolve");
        return 0;
    }
    memSuite = IntakeAcquireSuite(utilP, basicP,
                                  kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (!memSuite)
    {
        VerdictSet(v, "not-sent", "memory suite unavailable for project identity resolve");
        return 0;
    }
    memP = (const AEGP_MemorySuite1*)memSuite;

#define PROJRES_NOT_SENT(msg) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define PROJRES_FAILED(fmt, err) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define PROJRES_STALE(why) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    perr = projP->AEGP_GetNumProjects(&numProjects);
    IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetNumProjects",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE)
        PROJRES_FAILED("AEGP_GetNumProjects err=%ld", perr);
    if (wantIndex < 0 || wantIndex >= (long)numProjects)
        PROJRES_STALE("project index out of range");
    perr = projP->AEGP_GetProjectByIndex(wantIndex, &projectH);
    IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE || !projectH)
        PROJRES_FAILED("AEGP_GetProjectByIndex err=%ld", perr);

    /* corroborate name + path against live identity */
    {
        int fpi = FetchProjectIdentity(utilP, projP, memP, projectH,
                                     1, 1, liveName, sizeof(liveName),
                                     livePath, sizeof(livePath), &ferr);
        if (fpi == FPI_AEGP_ERR)
            PROJRES_FAILED("project identity read err=%ld", ferr);
        if (fpi == FPI_TRUNCATED)
            PROJRES_FAILED("project path exceeds descriptor bound err=%ld", ferr);
    }
    if (!JStrEqCStr(nameV, liveName))
        PROJRES_STALE("project name mismatch");
    /* path: descriptor empty → accept any live path (save tolerance);
       non-empty → exact match required. */
    if (pathV->slen > 0 && !JStrEqCStr(pathV, livePath))
        PROJRES_STALE("project path mismatch");

    /* collision scan: count open projects satisfying the same
       (name, path) corroboration. >1 → ambiguous → fail closed (§7e). */
    {
        long matches = 0;
        long pi;
        for (pi = 0; pi < (long)numProjects && matches <= 1; pi++)
        {
            AEGP_ProjectH ph2 = NULL;
            char n2[AEGP_MAX_PROJ_NAME_SIZE + 1];
            char p2[PROJ_STR_MAX + 1];
            A_Err e2;
            int f2;
            perr = projP->AEGP_GetProjectByIndex(pi, &ph2);
            IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                           (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
            if (perr != A_Err_NONE || !ph2) continue;
            f2 = FetchProjectIdentity(utilP, projP, memP, ph2,
                                    1, 1, n2, sizeof(n2), p2, sizeof(p2), &e2);
            if (f2 != FPI_OK) continue;
            if (!JStrEqCStr(nameV, n2)) continue;
            if (pathV->slen > 0 && !JStrEqCStr(pathV, p2)) continue;
            matches++;
        }
        if (matches > 1)
            PROJRES_STALE("project identity ambiguous");
    }

#undef PROJRES_NOT_SENT
#undef PROJRES_FAILED
#undef PROJRES_STALE
    IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    *projectHOut = projectH;
    return 1;
}


/* ---- §7f RQ-item resolution -------------------------------------- */

void ReleaseRQResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    RQResolution* r)
{
    if (r->rqItemSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    if (r->compSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
    ReleaseResolution(utilP, basicP, &r->item);
    memset(r, 0, sizeof(*r));
}

/* Resolve an aeRefRQItem descriptor + projectIndex to a live
   AEGP_RQItemRefH inside ONE dispatch (§7f): comp aeRef → shared item
   resolver → comp's live itemId; queue index → RQItemByIndex →
   GetCompFromRQItem → GetItemFromComp → live itemId must match;
   (status, numOutputModules) fingerprint must match. All pins
   re-verified before the caller's getter runs. */
int ResolveRQItemRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* ref,
    RQResolution* r,
    ReqVerdict* v)
{
    JVal* idxV = JGet(ref, "index");
    JVal* compArg = JGet(ref, "comp");
    JVal* compRef = compArg ? JGet(compArg, "aeRef") : NULL;
    JVal* statusV = JGet(ref, "status");
    JVal* nomV = JGet(ref, "numOutputModules");
    long rqIndex = (long)idxV->num;
    AEGP_RQItemRefH rqH = NULL;
    AEGP_CompH boundCompH = NULL;
    AEGP_ItemH boundItemH = NULL;
    A_long boundItemId = 0;
    A_long numRQ = 0;
    AEGP_RenderItemStatusType liveStatus = 0;
    A_long liveNumOM = 0;
    A_Err e;

    memset(r, 0, sizeof(*r));
    r->rqIndex = rqIndex;
    r->wantStatus = (long)statusV->num;
    r->wantNumOM = (long)nomV->num;
    r->wantItemId = -1;

    /* 1. bound comp via the shared item resolver (project identity
       fetched so callers can emit descriptors). */
    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projectIndex, compRef, 1, " (resolve)",
                          &r->item, v))
        return 0;
    if (r->item.type != AEGP_ItemType_COMP)
    {
        ReleaseResolution(utilP, basicP, &r->item);
        VerdictRefuse(v, "STALE_REFERENCE", "rqItem comp binding is not a comp");
        return 0;
    }
    e = r->item.itemP->AEGP_GetItemID
        ? r->item.itemP->AEGP_GetItemID(r->item.itemH, &boundItemId)
        : A_Err_STRUCT;
    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
    {
        ReleaseResolution(utilP, basicP, &r->item);
        VerdictSet(v, "failed", "AEGP_GetItemID err=%ld", (long)e);
        return 0;
    }
    r->wantItemId = (long)(unsigned int)boundItemId;

    /* 2. RQ-item + comp suites inside the window */
    r->rqItemSuite = IntakeAcquireSuite(utilP, basicP,
                                        kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    r->compSuite = IntakeAcquireSuite(utilP, basicP,
                                      kAEGPCompSuite, kAEGPCompSuiteVersion13);
    if (!r->rqItemSuite || !r->compSuite)
    {
        ReleaseRQResolution(utilP, basicP, r);
        VerdictSet(v, "not-sent", "RQ-item/comp suite unavailable for identity resolve");
        return 0;
    }
    r->rqItemP = (const AEGP_RQItemSuite4*)r->rqItemSuite;
    r->compP = (const AEGP_CompSuite13*)r->compSuite;

#define RQRES_NOT_SENT(msg) do { \
        ReleaseRQResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RQRES_FAILED(fmt, err) do { \
        ReleaseRQResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RQRES_STALE(why) do { \
        ReleaseRQResolution(utilP, basicP, r); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    if (!r->rqItemP->AEGP_GetNumRQItems || !r->rqItemP->AEGP_GetRQItemByIndex ||
        !r->rqItemP->AEGP_GetCompFromRQItem ||
        !r->rqItemP->AEGP_GetRenderState ||
        !r->rqItemP->AEGP_GetNumOutputModulesForRQItem ||
        !r->compP->AEGP_GetItemFromComp ||
        !r->item.itemP->AEGP_GetItemID)
        RQRES_NOT_SENT("RQ-item suite entries unavailable for identity resolve");

    e = r->rqItemP->AEGP_GetNumRQItems(&numRQ);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetNumRQItems err=%ld", e);
    if (rqIndex < 0 || rqIndex >= (long)numRQ)
        RQRES_STALE("rqItem index out of range");

    e = r->rqItemP->AEGP_GetRQItemByIndex(rqIndex, &rqH);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE || !rqH)
        RQRES_FAILED("AEGP_GetRQItemByIndex err=%ld", e);
    r->rqH = rqH;

    /* 3. bound comp identity: rqH → compH → itemH → live itemId */
    e = r->rqItemP->AEGP_GetCompFromRQItem(rqH, &boundCompH);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE || !boundCompH)
        RQRES_STALE("rqItem has no bound comp");
    e = r->compP->AEGP_GetItemFromComp(boundCompH, &boundItemH);
    IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetItemFromComp",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE || !boundItemH)
        RQRES_FAILED("AEGP_GetItemFromComp err=%ld", e);
    e = r->item.itemP->AEGP_GetItemID(boundItemH, &boundItemId);
    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetItemID err=%ld", e);
    if ((long)(unsigned int)boundItemId != r->wantItemId)
        RQRES_STALE("rqItem comp binding mismatch");

    /* 4. fingerprint: status + numOutputModules */
    e = r->rqItemP->AEGP_GetRenderState(rqH, &liveStatus);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRenderState",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetRenderState err=%ld", e);
    if ((long)liveStatus != r->wantStatus)
        RQRES_STALE("rqItem status changed");
    e = r->rqItemP->AEGP_GetNumOutputModulesForRQItem(rqH, &liveNumOM);
    IntakeOpRecord(utilP,
                   "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetNumOutputModulesForRQItem err=%ld", e);
    if ((long)liveNumOM != r->wantNumOM)
        RQRES_STALE("rqItem output-module count changed");

#undef RQRES_NOT_SENT
#undef RQRES_FAILED
#undef RQRES_STALE
    return 1;
}

/* Locate the open project that owns a top-level item by live itemId.
   Returns 1 with *projIndexOut set, or 0. Bounded scan; used by RQ
   enumeration to recover the projectIndex a descriptor needs. */
static int FindProjectForItemId(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    unsigned int wantId,
    long* projIndexOut)
{
    const void* itemSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPItemSuite, kAEGPItemSuiteVersion9);
    const AEGP_ItemSuite9* itemP = itemSuite
        ? (const AEGP_ItemSuite9*)itemSuite : NULL;
    A_long numProjects = 0;
    A_Err perr;
    long pi;
    int found = 0;
    *projIndexOut = -1;
    if (!itemP || !itemP->AEGP_GetFirstProjItem ||
        !itemP->AEGP_GetNextProjItem || !itemP->AEGP_GetItemID ||
        !projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex)
    {
        if (itemSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPItemSuite, kAEGPItemSuiteVersion9);
        return 0;
    }
    perr = projP->AEGP_GetNumProjects(&numProjects);
    IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetNumProjects",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE) { found = -1; goto done; }
    for (pi = 0; pi < (long)numProjects && !found; pi++)
    {
        AEGP_ProjectH ph = NULL;
        AEGP_ItemH ih = NULL;
        perr = projP->AEGP_GetProjectByIndex(pi, &ph);
        IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                       (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE || !ph) continue;
        perr = itemP->AEGP_GetFirstProjItem(ph, &ih);
        IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
                       (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE) continue;
        while (ih)
        {
            A_long id = 0;
            AEGP_ItemH nextH = NULL;
            A_Err e2 = itemP->AEGP_GetItemID(ih, &id);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                           (long)e2, e2 == A_Err_NONE ? " (resolve)" : NULL);
            if (e2 == A_Err_NONE && (unsigned int)id == wantId)
            { found = 1; *projIndexOut = pi; break; }
            e2 = itemP->AEGP_GetNextProjItem(ph, ih, &nextH);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetNextProjItem",
                           (long)e2, e2 == A_Err_NONE ? " (resolve)" : NULL);
            if (e2 != A_Err_NONE) break;
            ih = nextH;
        }
    }
done:
    IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    return found == 1;
}

/* AEGP_GetRQItemByIndex as RQ descriptor issuance/enumeration (§7f):
   {offset, limit} → per-slot aeRefRQItem descriptors + the projectIndex
   each bound comp lives in. Slots whose comp cannot be resolved are
   emitted with "rqItem":null — never a fabricated descriptor. */
void EnumerateRQItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    long offset = ArgsInt(allow, args, 0);
    long limit = ArgsInt(allow, args, 1);
    const void* rqSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    const void* compSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPCompSuite, kAEGPCompSuiteVersion13);
    const void* memSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    const AEGP_RQItemSuite4* rqP = rqSuite
        ? (const AEGP_RQItemSuite4*)rqSuite : NULL;
    const AEGP_CompSuite13* compP = compSuite
        ? (const AEGP_CompSuite13*)compSuite : NULL;
    const AEGP_MemorySuite1* memP = memSuite
        ? (const AEGP_MemorySuite1*)memSuite : NULL;
    const void* itemSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPItemSuite, kAEGPItemSuiteVersion9);
    const AEGP_ItemSuite9* itemP = itemSuite
        ? (const AEGP_ItemSuite9*)itemSuite : NULL;
    A_long numRQ = 0;
    A_Err e;
    long i;
    JBuf b;
    int of = 0;

    if (!rqP || !compP || !memP || !itemP ||
        !rqP->AEGP_GetNumRQItems || !rqP->AEGP_GetRQItemByIndex ||
        !rqP->AEGP_GetCompFromRQItem || !rqP->AEGP_GetRenderState ||
        !rqP->AEGP_GetNumOutputModulesForRQItem ||
        !compP->AEGP_GetItemFromComp ||
        !itemP->AEGP_GetItemID || !itemP->AEGP_GetItemType ||
        !itemP->AEGP_GetItemName || !itemP->AEGP_GetFirstProjItem ||
        !itemP->AEGP_GetNextProjItem)
    {
        if (rqSuite) IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
        if (compSuite) IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
        if (memSuite) IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        if (itemSuite) IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
        VerdictSet(v, "not-sent", "RQ-item suite entries unavailable for enumeration");
        return;
    }

    e = rqP->AEGP_GetNumRQItems(&numRQ);
    RecordAllowOp(utilP, allow, e);
    if (e != A_Err_NONE)
    {
        IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
        IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
        VerdictSet(v, "failed", "AEGP_GetNumRQItems err=%ld", (long)e);
        return;
    }

    JBInit(&b, v->payload, sizeof(v->payload));
    JBPut(&b, "{\"items\":[");
    {
        long emitted = 0;
        for (i = offset; i < offset + limit && i < (long)numRQ; i++)
        {
            AEGP_RQItemRefH rqH = NULL;
            AEGP_CompH compH = NULL;
            AEGP_ItemH itemH = NULL;
            A_long itemId = 0;
            AEGP_ItemType itype = AEGP_ItemType_NONE;
            AEGP_RenderItemStatusType st = 0;
            A_long nom = 0;
            int describable = 0;
            long projIndex = -1;
            char nm[AEREF_NAME_MAX + 1];
            char pn[AEGP_MAX_PROJ_NAME_SIZE + 1];
            char pp[PROJ_STR_MAX + 1];
            AEGP_MemHandle nameH = NULL;

            e = rqP->AEGP_GetRQItemByIndex(i, &rqH);
            IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
                           (long)e, NULL);
            if (e != A_Err_NONE || !rqH) continue;
            if (emitted) JBPut(&b, ",");
            JBPut(&b, "{\"index\":"); JBNum(&b, i);
            /* fingerprint */
            e = rqP->AEGP_GetRenderState(rqH, &st);
            IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRenderState",
                           (long)e, NULL);
            e = rqP->AEGP_GetNumOutputModulesForRQItem(rqH, &nom);
            IntakeOpRecord(utilP,
                "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
                (long)e, NULL);
            /* bound comp → item → id */
            if (e == A_Err_NONE &&
                rqP->AEGP_GetCompFromRQItem(rqH, &compH) == A_Err_NONE &&
                compH &&
                compP->AEGP_GetItemFromComp(compH, &itemH) == A_Err_NONE &&
                itemH &&
                itemP->AEGP_GetItemID(itemH, &itemId) == A_Err_NONE &&
                itemP->AEGP_GetItemType(itemH, &itype) == A_Err_NONE &&
                ItemTypeToAeRefTag(itype) != NULL &&
                FindProjectForItemId(utilP, projP, basicP,
                                     (unsigned int)itemId, &projIndex))
            {
                /* project identity for the comp's aeRef */
                AEGP_ProjectH ph = NULL;
                A_Err pe = projP->AEGP_GetProjectByIndex(projIndex, &ph);
                IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                               (long)pe, NULL);
                if (pe == A_Err_NONE && ph)
                {
                    A_Err fe = A_Err_NONE;
                    int fpi = FetchProjectIdentity(utilP, projP, memP, ph,
                        1, 1, pn, sizeof(pn), pp, sizeof(pp), &fe);
                    e = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
                    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemName",
                                   (long)e, e == A_Err_NONE ? " (result)" : NULL);
                    if (fpi == FPI_OK && e == A_Err_NONE && nameH)
                    {
                        IntakeMemStatus ms = IntakeReadMemHandleUtf8(
                            utilP, memP, nameH, nm, sizeof(nm));
                        if (ms == IMH_OK && strlen(nm) <= AEREF_NAME_MAX)
                            describable = 1;
                    }
                }
            }
            if (describable)
            {
                JBPut(&b, ",\"projectIndex\":"); JBNum(&b, projIndex);
                JBPut(&b, ",\"rqItem\":{\"aeRef\":{\"type\":\"rqItem\",");
                JBPut(&b, "\"index\":"); JBNum(&b, i);
                JBPut(&b, ",\"comp\":{\"aeRef\":{\"type\":\"");
                JBPut(&b, ItemTypeToAeRefTag(itype));
                JBPut(&b, "\",\"name\":\""); JBEsc(&b, nm);
                JBPut(&b, "\",\"path\":[0],\"itemId\":");
                JBNum(&b, (long)(unsigned int)itemId);
                JBPut(&b, ",\"projectName\":\""); JBEsc(&b, pn);
                JBPut(&b, "\",\"projectPath\":\""); JBEsc(&b, pp);
                JBPut(&b, "\"}},\"status\":"); JBNum(&b, (long)st);
                JBPut(&b, ",\"numOutputModules\":"); JBNum(&b, (long)nom);
                JBPut(&b, "}}}");
            }
            else
            {
                JBPut(&b, ",\"projectIndex\":null,\"rqItem\":null}");
            }
            emitted++;
        }
    }
    JBPut(&b, "],\"numRQItems\":"); JBNum(&b, (long)numRQ); JBPut(&b, "}");
    of = b.of;
    IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
    IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (of)
    {
        VerdictSet(v, "failed", "enumeration payload exceeds result bound");
        return;
    }
    *b.cur = '\0';
    snprintf(v->outcome, sizeof(v->outcome), "completed");
    v->havePayload = 1;
    v->mayHaveMutated = 0;
}

#else /* _WIN32 */
#endif
