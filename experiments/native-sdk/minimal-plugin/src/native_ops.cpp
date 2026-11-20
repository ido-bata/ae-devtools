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
#include "native_ops.h"
#include "native_identity.h"
#include "native_suites.h"
#include "native_support.h"
#include "native_request.h"
#include "native_registry.h"
#include "native_state.h"

/* ---- operation executors ---------------------------------------------
   Every allowlisted op body lives here; ProcessClaimed's routing table
   (native_intake.cpp) maps operationId -> IntakeExecFn. Read-only
   executors keep mayHaveMutated=0; the mutation executor
   (ExecSetItemComment) sets it only once the AEGP call is attempted. */

/* AEGP_ItemType (AE_GeneralPlug.h): NONE=0 FOLDER=1 COMP=2
   SOLID_defunct=3 FOOTAGE=4, NUM_TYPES1=5. GetTypeName rejects NONE;
   the permitted span is the defined non-NONE values [1, 4]. */

/* ---- CompSuite13 read-only getters (Issue #318 / #64) ---------------
   Vertical slice of the shared identity resolver: args carry
   {"projectIndex": int, "comp": {"aeRef": {...}}}; ResolveAeRefItem
   resolves the item handle host-side (type+name corroborated, itemId
   authoritative when present), then AEGP_GetCompFromItem derives the
   comp handle inside the request window. The comp handle is borrowed —
   never freed; the comp suite is released before leaving. Missing
   suite/entry → not-sent; AEGP errors → failed with
   mayHaveMutated=false (read-only). The wire never carries a handle. */

/* Entry-presence gate: the specific getter must exist in the acquired
   suite table before any comp call (not-sent = environment-proven
   non-dispatch, same convention as GetTypeName). */
static int CompEntryPresent(const AEGP_CompSuite13* c, const char* opIdZ)
{
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompFramerate") == 0)
        return c->AEGP_GetCompFramerate != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompFrameDuration") == 0)
        return c->AEGP_GetCompFrameDuration != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart") == 0)
        return c->AEGP_GetCompWorkAreaStart != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration") == 0)
        return c->AEGP_GetCompWorkAreaDuration != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime") == 0)
        return c->AEGP_GetCompDisplayStartTime != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame") == 0)
        return c->AEGP_GetCompDisplayDropFrame != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor") == 0)
        return c->AEGP_GetCompDownsampleFactor != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName") == 0)
        return c->AEGP_GetShowLayerNameOrSourceName != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetShowBlendModes") == 0)
        return c->AEGP_GetShowBlendModes != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples") == 0)
        return c->AEGP_GetCompSuggestedMotionBlurSamples != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit") == 0)
        return c->AEGP_GetCompMotionBlurAdaptiveSampleLimit != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompBGColor") == 0)
        return c->AEGP_GetCompBGColor != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase") == 0)
        return c->AEGP_GetCompShutterAnglePhase != NULL;
    return 0;
}

void ExecCompGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* compArg = JGet(args, "comp");
    JVal* ref = compArg ? JGet(compArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;
    const void* compSuite = NULL;
    const AEGP_CompSuite13* compP = NULL;
    AEGP_CompH compH = NULL;
    A_Err cerr, oerr;
    const char* opId = allow->operationId;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, 0, " (resolve)", &res, v))
        return; /* v already carries the verdict */

    compSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPCompSuite, kAEGPCompSuiteVersion13);
    if (!compSuite)
    {
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "AEGP Comp Suite unavailable");
        return;
    }
    compP = (const AEGP_CompSuite13*)compSuite;

    if (!compP->AEGP_GetCompFromItem || !CompEntryPresent(compP, opId))
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "comp suite entry unavailable");
        return;
    }

    cerr = compP->AEGP_GetCompFromItem(res.itemH, &compH);
    IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem",
                   (long)cerr, NULL);
    if (cerr != A_Err_NONE || !compH)
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "failed", "AEGP_GetCompFromItem err=%ld", (long)cerr);
        return;
    }

    oerr = A_Err_STRUCT;
    if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompFramerate") == 0)
    {
        A_FpLong fps = 0;
        oerr = compP->AEGP_GetCompFramerate(compH, &fps);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"fps\":%.12g}", fps);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompFrameDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompFrameDuration(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"frameDuration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompWorkAreaStart(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"workAreaStart\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompWorkAreaDuration(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"workAreaDuration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompDisplayStartTime(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"displayStartTime\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame") == 0)
    {
        A_Boolean dropB = FALSE;
        oerr = compP->AEGP_GetCompDisplayDropFrame(compH, &dropB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"displayDropFrame\":%s}", dropB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor") == 0)
    {
        AEGP_DownsampleFactor dsf;
        dsf.xS = 0; dsf.yS = 0;
        oerr = compP->AEGP_GetCompDownsampleFactor(compH, &dsf);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"downsampleFactor\":{\"x\":%d,\"y\":%d}}",
                     (int)dsf.xS, (int)dsf.yS);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName") == 0)
    {
        A_Boolean shownB = FALSE;
        oerr = compP->AEGP_GetShowLayerNameOrSourceName(compH, &shownB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"showLayerNameOrSourceName\":%s}",
                     shownB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetShowBlendModes") == 0)
    {
        A_Boolean shownB = FALSE;
        oerr = compP->AEGP_GetShowBlendModes(compH, &shownB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"showBlendModes\":%s}", shownB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples") == 0)
    {
        A_long samplesL = 0;
        oerr = compP->AEGP_GetCompSuggestedMotionBlurSamples(compH, &samplesL);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"suggestedMotionBlurSamples\":%ld}", (long)samplesL);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit") == 0)
    {
        A_long samplesL = 0;
        oerr = compP->AEGP_GetCompMotionBlurAdaptiveSampleLimit(compH, &samplesL);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"motionBlurAdaptiveSampleLimit\":%ld}", (long)samplesL);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompBGColor") == 0)
    {
        AEGP_ColorVal bg;
        memset(&bg, 0, sizeof(bg));
        oerr = compP->AEGP_GetCompBGColor(compH, &bg);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"bgColor\":{\"alpha\":%.12g,\"red\":%.12g,"
                     "\"green\":%.12g,\"blue\":%.12g}}",
                     bg.alphaF, bg.redF, bg.greenF, bg.blueF);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase") == 0)
    {
        A_Ratio angle = {0, 0}, phase = {0, 0};
        oerr = compP->AEGP_GetCompShutterAnglePhase(compH, &angle, &phase);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"shutterAngle\":{\"num\":%ld,\"den\":%lu},"
                     "\"shutterPhase\":{\"num\":%ld,\"den\":%lu}}",
                     (long)angle.num, (unsigned long)angle.den,
                     (long)phase.num, (unsigned long)phase.den);
        }
    }
    else
    {
        /* allowlist/entry gate already proved this unreachable; keep
           the verdict honest rather than emitting garbage. */
        oerr = A_Err_STRUCT;
    }

    IntakeReleaseSuite(utilP, basicP,
                       kAEGPCompSuite, kAEGPCompSuiteVersion13);
    ReleaseResolution(utilP, basicP, &res);

    GetterTailReadOnly(allow, v, oerr, NULL);
}


/* ---- ItemSuite9 read-only detail getters (Issue #318 / #63) ---------
   Same {projectIndex, item:<aeRefItem>} contract as GetItemName: the
   shared resolver produces the item handle; the getter runs on it
   directly — no derived handle, no extra suite. Missing entry →
   not-sent; AEGP errors → failed with mayHaveMutated=false. */

#define ITEM_COMMENT_MAX 2048  /* UTF-8 bytes; larger comments fail honestly */

static int ItemGetterEntryPresent(const AEGP_ItemSuite9* c, const char* opIdZ)
{
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemType") == 0)
        return c->AEGP_GetItemType != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0)
        return c->AEGP_GetItemFlags != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0)
        return c->AEGP_IsItemSelected != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0)
        return c->AEGP_GetItemLabel != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0)
        return c->AEGP_GetItemDuration != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0)
        return c->AEGP_GetItemCurrentTime != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0)
        return c->AEGP_GetItemDimensions != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0)
        return c->AEGP_GetItemPixelAspectRatio != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0)
        return c->AEGP_GetItemComment != NULL;
    return 0;
}

/* Dispatch router for the #63 item-detail getters — explicit id list
   so a future ItemSuite9 allowlist addition without an executor still
   reaches OPERATION_NOT_DISPATCHABLE instead of being misrouted. */
int IsItemGetterOpId(const char* opIdZ)
{
    return strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemType") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0;
}

void ExecItemGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* itemArg = JGet(args, "item");
    JVal* ref = itemArg ? JGet(itemArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;
    A_Err oerr = A_Err_STRUCT;
    const char* opId = allow->operationId;
    int commentStatus = -1;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, 0, " (resolve)", &res, v))
        return; /* v already carries the verdict */

    if (!ItemGetterEntryPresent(res.itemP, opId))
    {
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "item suite entry unavailable");
        return;
    }

    if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemType") == 0)
    {
        AEGP_ItemType t = AEGP_ItemType_NONE;
        oerr = res.itemP->AEGP_GetItemType(res.itemH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"itemType\":%d}", (int)t);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0)
    {
        AEGP_ItemFlags flags = 0;
        oerr = res.itemP->AEGP_GetItemFlags(res.itemH, &flags);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"flags\":%ld}", (long)flags);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0)
    {
        A_Boolean selB = FALSE;
        oerr = res.itemP->AEGP_IsItemSelected(res.itemH, &selB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"selected\":%s}", selB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0)
    {
        AEGP_LabelID label = AEGP_Label_NO_LABEL;
        oerr = res.itemP->AEGP_GetItemLabel(res.itemH, &label);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"label\":%d}", (int)label);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = res.itemP->AEGP_GetItemDuration(res.itemH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"duration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0)
    {
        A_Time t = {0, 0};
        oerr = res.itemP->AEGP_GetItemCurrentTime(res.itemH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"currentTime\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0)
    {
        A_long w = 0, hgt = 0;
        oerr = res.itemP->AEGP_GetItemDimensions(res.itemH, &w, &hgt);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"width\":%ld,\"height\":%ld}", (long)w, (long)hgt);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0)
    {
        A_Ratio par = {0, 0};
        oerr = res.itemP->AEGP_GetItemPixelAspectRatio(res.itemH, &par);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"pixelAspectRatio\":{\"num\":%ld,\"den\":%lu}}",
                     (long)par.num, (unsigned long)par.den);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0)
    {
        AEGP_MemHandle commentH = NULL;
        char comment[ITEM_COMMENT_MAX + 1];
        char esc[ITEM_COMMENT_MAX * 2 + 16];
        oerr = res.itemP->AEGP_GetItemComment(res.itemH, &commentH);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            IntakeMemStatus ms = IntakeReadMemHandleUtf8(
                utilP, res.memP, commentH, comment, sizeof(comment));
            commentStatus = (int)ms;
            if (ms == IMH_OK)
            {
                JsonEscape(esc, sizeof(esc), comment);
                PayloadSet(v, "{\"comment\":\"%s\"}", esc);
            }
            else if (ms == IMH_TRUNCATED)
            {
                oerr = A_Err_STRUCT; /* over the declared bound: honest fail */
            }
            else
            {
                oerr = A_Err_STRUCT;
            }
        }
    }
    else
    {
        oerr = A_Err_STRUCT;
    }

    ReleaseResolution(utilP, basicP, &res);

    {
        char cdetail[96];
        const char* ov = NULL;
        if (commentStatus == (int)IMH_TRUNCATED)
        {
            snprintf(cdetail, sizeof(cdetail),
                     "comment exceeds %d-byte bound", ITEM_COMMENT_MAX);
            ov = cdetail;
        }
        GetterTailReadOnly(allow, v, oerr, ov);
    }
}

/* ---- Issue #327: first mutating op -------------------------------
   AEGP_ItemSuite9.AEGP_SetItemComment (UNDOABLE). Consent was already
   verified in ProcessClaimed before dispatch; this executor resolves
   the aeRef item host-side exactly like the read-only getters, then
   performs the single mutating AEGP call. mayHaveMutated semantics
   (contract §7g / trusted-execution §8): false until the AEGP call is
   actually attempted — once invoked, ANY outcome (success or error)
   sets mayHaveMutated=1 because the host may have applied the change
   before reporting failure. Pre-execution refusals (stale identity,
   missing suite entry, arg/codec failure) keep mayHaveMutated=0. */
void ExecSetItemComment(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* itemArg = JGet(args, "item");
    JVal* ref = itemArg ? JGet(itemArg, "aeRef") : NULL;
    JVal* commentV = JGet(args, "comment");
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;
    A_Err oerr = A_Err_STRUCT;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, 0, " (resolve)", &res, v))
        return; /* v already carries the verdict */

    if (!res.itemP->AEGP_SetItemComment)
    {
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "item suite entry unavailable");
        return;
    }

    {
        /* comment is bounded UTF-8 (ARGK_STR, ≤ ITEM_COMMENT_MAX
           bytes); AEGP wants NUL-terminated UTF-16. Worst case the
           UTF-16 unit count equals the byte count (all-ASCII), plus
           the NUL — allocate slen+1 units. */
        size_t u16cap = (commentV ? commentV->slen : 0) + 1;
        A_UTF16Char* u16 = (A_UTF16Char*)malloc(u16cap * sizeof(A_UTF16Char));
        int units = -1;
        if (u16 && commentV && commentV->kind == JK_STR)
            units = IntakeUtf8ToUtf16(commentV->str, commentV->slen,
                                      u16, u16cap);
        if (!u16 || units < 0)
        {
            free(u16);
            ReleaseResolution(utilP, basicP, &res);
            VerdictSet(v, "failed", "comment is not valid UTF-8");
            return;
        }
        oerr = res.itemP->AEGP_SetItemComment(res.itemH, u16);
        RecordAllowOp(utilP, allow, oerr);
        free(u16);
    }

    ReleaseResolution(utilP, basicP, &res);

    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"commentSet\":true}");
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "%s err=%ld", allow->operationId, (long)oerr);
        v->havePayload = 0;
        v->publish = 1;
    }
    /* Reaching here means the AEGP entry was invoked (every earlier
       path returned): the mutation may have been applied even when
       the call reported an error. */
    v->mayHaveMutated = 1;
}



/* Entry-presence gate for the layer-scoped getters. */
static int LayerGetterEntryPresent(const AEGP_LayerSuite9* c, const char* opIdZ)
{
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerIndex") == 0)
        return c->AEGP_GetLayerIndex != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerName") == 0)
        return c->AEGP_GetLayerName != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerFlags") == 0)
        return c->AEGP_GetLayerFlags != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerQuality") == 0)
        return c->AEGP_GetLayerQuality != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerObjectType") == 0)
        return c->AEGP_GetLayerObjectType != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer3D") == 0)
        return c->AEGP_IsLayer3D != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer2D") == 0)
        return c->AEGP_IsLayer2D != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0)
        return c->AEGP_GetLayerCurrentTime != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0)
        return c->AEGP_GetLayerInPoint != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerDuration") == 0)
        return c->AEGP_GetLayerDuration != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerID") == 0)
        return c->AEGP_GetLayerID != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerLabel") == 0)
        return c->AEGP_GetLayerLabel != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality") == 0)
        return c->AEGP_GetLayerSamplingQuality != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID") == 0)
        return c->AEGP_GetLayerSourceItemID != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn") == 0)
        return c->AEGP_IsLayerVideoReallyOn != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn") == 0)
        return c->AEGP_IsLayerAudioReallyOn != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte") == 0)
        return c->AEGP_DoesLayerHaveTrackMatte != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte") == 0)
        return c->AEGP_IsLayerUsedAsTrackMatte != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0)
        return c->AEGP_GetTrackMatteLayer != NULL;
    return 0;
}

/* Dispatch routers — explicit id lists so a future LayerSuite9
   allowlist addition without an executor still reaches
   OPERATION_NOT_DISPATCHABLE instead of being misrouted. */
int IsLayerCompOpId(const char* opIdZ)
{
    return strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetCompNumLayers") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex") == 0;
}

int IsLayerGetterOpId(const char* opIdZ)
{
    return strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerIndex") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerName") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerFlags") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerQuality") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerObjectType") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer3D") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer2D") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerDuration") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerID") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerLabel") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0;
}

/* Emit one aeRefLayer descriptor object {"type":"layer",...} into the
   JBuf — used by GetCompLayerByIndex (issuance) and GetTrackMatteLayer
   (derived-handle → descriptor). Reads the layer's live id+name and
   the comp item's live id; the comp aeRef is rebuilt from the resolved
   ItemResolution (which carries the live name/index and, when
   wantProjectIdentity was set, project name/path). Returns A_Err_NONE
   on success; A_Err_STRUCT on payload overflow or unreadable identity
   data (caller maps to `failed` — never a partial descriptor). */
static A_Err EmitLayerRefInner(
    JBuf* b,
    const AEGP_UtilitySuite6* utilP,
    AEGP_PluginID plugin_id,
    const AEGP_MemorySuite1* memP,
    const AEGP_ItemSuite9* itemP,
    AEGP_ItemH compItemH,
    const ItemResolution* compRes,
    const AEGP_LayerSuite9* layerP,
    AEGP_LayerH layerH)
{
    AEGP_LayerIDVal lid = 0;
    A_long compId = 0;
    AEGP_MemHandle lnH = NULL;
    AEGP_MemHandle snH = NULL;
    char lname[LAYER_NAME_MAX + 1];
    IntakeMemStatus ms;
    A_Err err;

    err = layerP->AEGP_GetLayerID(layerH, &lid);
    IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerID", (long)err,
                   err == A_Err_NONE ? " (issuance)" : NULL);
    if (err != A_Err_NONE) return err;
    err = layerP->AEGP_GetLayerName(plugin_id, layerH, &lnH, &snH);
    IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerName", (long)err,
                   err == A_Err_NONE ? " (issuance)" : NULL);
    if (err != A_Err_NONE)
    {
        if (snH) IntakeFreeMemHandle(utilP, memP, snH);
        return err;
    }
    ms = IntakeReadMemHandleUtf8(utilP, memP, lnH, lname, sizeof(lname));
    if (snH) IntakeFreeMemHandle(utilP, memP, snH);
    if (ms != IMH_OK) return A_Err_STRUCT; /* truncated or unreadable */
    if (!itemP->AEGP_GetItemID) return A_Err_STRUCT;
    err = itemP->AEGP_GetItemID(compItemH, &compId);
    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID", (long)err,
                   err == A_Err_NONE ? " (issuance)" : NULL);
    if (err != A_Err_NONE) return err;

    JBPut(b, "{\"type\":\"layer\",\"name\":\"");
    JBEsc(b, lname);
    JBPut(b, "\",\"layerId\":");
    JBNum(b, (long)lid);
    JBPut(b, ",\"comp\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"");
    JBEsc(b, compRes->name);
    JBPut(b, "\",\"path\":[");
    JBNum(b, compRes->index);
    JBPut(b, "],\"itemId\":");
    JBNum(b, (long)(unsigned int)compId);
    if (compRes->haveProjectName)
    {
        JBPut(b, ",\"projectName\":\"");
        JBEsc(b, compRes->projectName);
        JBPut(b, "\"");
    }
    if (compRes->haveProjectPath)
    {
        JBPut(b, ",\"projectPath\":\"");
        JBEsc(b, compRes->projectPath);
        JBPut(b, "\"");
    }
    JBPut(b, "}}}");
    return b->of ? A_Err_STRUCT : A_Err_NONE;
}

/* Comp-scoped layer ops: GetCompNumLayers (count) and
   GetCompLayerByIndex (descriptor issuance). Args carry the comp aeRef
   (+ layerIndex for the latter). */
void ExecLayerCompOp(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* compArg = JGet(args, "comp");
    JVal* ref = compArg ? JGet(compArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    int isIndexOp =
        strcmp(allow->operationId,
               "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex") == 0;
    ItemResolution res;
    const void* compSuite = NULL;
    const void* layerSuite = NULL;
    const AEGP_CompSuite13* compP = NULL;
    const AEGP_LayerSuite9* layerP = NULL;
    AEGP_CompH compH = NULL;
    A_Err oerr = A_Err_STRUCT;
    const char* opId = allow->operationId;

    /* issuance needs the full comp descriptor (itemId + project
       identity) embedded in the emitted aeRefLayer */
    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, isIndexOp, " (resolve)",
                          &res, v))
        return;
    if (res.type != AEGP_ItemType_COMP)
    {
        ReleaseResolution(utilP, basicP, &res);
        VerdictRefuse(v, "STALE_REFERENCE",
                      "comp descriptor does not resolve to a comp item");
        return;
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
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "comp/layer suite unavailable");
        return;
    }
    compP = (const AEGP_CompSuite13*)compSuite;
    layerP = (const AEGP_LayerSuite9*)layerSuite;

    if (!compP->AEGP_GetCompFromItem || !layerP->AEGP_GetCompNumLayers ||
        !layerP->AEGP_GetCompLayerByIndex || !layerP->AEGP_GetLayerID ||
        !layerP->AEGP_GetLayerName)
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "comp/layer suite entry unavailable");
        return;
    }

    {
        A_Err cerr = compP->AEGP_GetCompFromItem(res.itemH, &compH);
        IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem",
                       (long)cerr, NULL);
        if (cerr != A_Err_NONE || !compH)
        {
            IntakeReleaseSuite(utilP, basicP,
                               kAEGPCompSuite, kAEGPCompSuiteVersion13);
            IntakeReleaseSuite(utilP, basicP,
                               kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
            ReleaseResolution(utilP, basicP, &res);
            VerdictSet(v, "failed", "AEGP_GetCompFromItem err=%ld", (long)cerr);
            return;
        }
    }

    if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetCompNumLayers") == 0)
    {
        A_long n = 0;
        oerr = layerP->AEGP_GetCompNumLayers(compH, &n);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"numLayers\":%ld}", (long)n);
        }
    }
    else
    {
        long idx = ArgsInt(allow, args, 2);
        AEGP_LayerH lh = NULL;
        oerr = layerP->AEGP_GetCompLayerByIndex(compH, (A_long)idx, &lh);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE && lh)
        {
            JBuf b;
            A_Err e2;
            JBInit(&b, v->payload, sizeof(v->payload));
            JBPut(&b, "{\"index\":");
            JBNum(&b, idx);
            JBPut(&b, ",\"layer\":{\"aeRef\":");
            e2 = EmitLayerRefInner(&b, utilP, plugin_id, res.memP,
                                   res.itemP, res.itemH, &res, layerP, lh);
            JBPut(&b, "}}");
            if (e2 != A_Err_NONE || b.of)
                oerr = A_Err_STRUCT;
            else
            {
                *b.cur = '\0';
                v->havePayload = 1;
            }
        }
        else if (oerr == A_Err_NONE)
        {
            oerr = A_Err_STRUCT; /* NULL layer handle */
        }
    }

    IntakeReleaseSuite(utilP, basicP,
                       kAEGPCompSuite, kAEGPCompSuiteVersion13);
    IntakeReleaseSuite(utilP, basicP,
                       kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    ReleaseResolution(utilP, basicP, &res);

    GetterTailReadOnly(allow, v, oerr, NULL);
}

/* Layer-handle getters: {projectIndex, layer:<aeRefLayer>} → shared
   resolver chain → typed getter on the resolved layer handle. */
void ExecLayerGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* layerArg = JGet(args, "layer");
    JVal* layerRef = layerArg ? JGet(layerArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    const char* opId = allow->operationId;
    /* GetTrackMatteLayer emits an aeRefLayer — needs the full comp
       descriptor (itemId + project identity) inside it. */
    int wantPI =
        strcmp(opId, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0;
    LayerResolution lr;
    A_Err oerr = A_Err_STRUCT;

    if (!layerRef)
    {
        VerdictRefuse(v, "MALFORMED_REQUEST", "layer.aeRef missing");
        return;
    }
    if (!ResolveLayerRef(utilP, projP, basicP, plugin_id,
                         projIndex, layerRef, wantPI, " (resolve)",
                         &lr, v))
        return;

    if (!LayerGetterEntryPresent(lr.layerP, opId))
    {
        ReleaseLayerResolution(utilP, basicP, &lr);
        VerdictSet(v, "not-sent", "layer suite entry unavailable");
        return;
    }

    if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerIndex") == 0)
    {
        A_long idx = 0;
        oerr = lr.layerP->AEGP_GetLayerIndex(lr.layerH, &idx);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"index\":%ld}", (long)idx);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerName") == 0)
    {
        AEGP_MemHandle lnH = NULL;
        AEGP_MemHandle snH = NULL;
        char lname[LAYER_NAME_MAX + 1];
        char sname[LAYER_NAME_MAX + 1];
        IntakeMemStatus ms1, ms2;
        oerr = lr.layerP->AEGP_GetLayerName(plugin_id, lr.layerH,
                                            &lnH, &snH);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            ms1 = IntakeReadMemHandleUtf8(utilP, lr.res.memP, lnH,
                                          lname, sizeof(lname));
            ms2 = IntakeReadMemHandleUtf8(utilP, lr.res.memP, snH,
                                          sname, sizeof(sname));
            if (ms1 == IMH_OK && ms2 == IMH_OK)
            {
                char e1[LAYER_NAME_MAX * 6 + 16];
                char e2[LAYER_NAME_MAX * 6 + 16];
                JsonEscape(e1, sizeof(e1), lname);
                JsonEscape(e2, sizeof(e2), sname);
                PayloadSet(v, "{\"name\":\"%s\",\"sourceName\":\"%s\"}",
                         e1, e2);
            }
            else
            {
                oerr = A_Err_STRUCT; /* truncated/unreadable name */
            }
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerFlags") == 0)
    {
        AEGP_LayerFlags flags = 0;
        oerr = lr.layerP->AEGP_GetLayerFlags(lr.layerH, &flags);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"flags\":%ld}", (long)flags);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerQuality") == 0)
    {
        AEGP_LayerQuality q = AEGP_LayerQual_BEST;
        oerr = lr.layerP->AEGP_GetLayerQuality(lr.layerH, &q);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"quality\":%d}", (int)q);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerObjectType") == 0)
    {
        AEGP_ObjectType ot = AEGP_ObjectType_NONE;
        oerr = lr.layerP->AEGP_GetLayerObjectType(lr.layerH, &ot);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"objectType\":%ld}", (long)ot);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayer3D") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayer3D(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"is3D\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayer2D") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayer2D(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"is2D\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0 ||
             strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0 ||
             strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerDuration") == 0)
    {
        AEGP_LTimeMode tm =
            (AEGP_LTimeMode)ArgsInt(allow, args, 2);
        A_Time t = {0, 0};
        const char* key =
            strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0
                ? "currentTime"
            : strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0
                ? "inPoint" : "duration";
        if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0)
            oerr = lr.layerP->AEGP_GetLayerCurrentTime(lr.layerH, tm, &t);
        else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0)
            oerr = lr.layerP->AEGP_GetLayerInPoint(lr.layerH, tm, &t);
        else
            oerr = lr.layerP->AEGP_GetLayerDuration(lr.layerH, tm, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"%s\":{\"value\":%ld,\"scale\":%lu}}",
                     key, (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerID") == 0)
    {
        AEGP_LayerIDVal lid = 0;
        oerr = lr.layerP->AEGP_GetLayerID(lr.layerH, &lid);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"layerId\":%ld}", (long)lid);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerLabel") == 0)
    {
        AEGP_LabelID label = AEGP_Label_NO_LABEL;
        oerr = lr.layerP->AEGP_GetLayerLabel(lr.layerH, &label);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"label\":%d}", (int)label);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality") == 0)
    {
        AEGP_LayerSamplingQuality q = AEGP_LayerSamplingQual_BILINEAR;
        oerr = lr.layerP->AEGP_GetLayerSamplingQuality(lr.layerH, &q);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"samplingQuality\":%d}", (int)q);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID") == 0)
    {
        A_long sid = 0;
        oerr = lr.layerP->AEGP_GetLayerSourceItemID(lr.layerH, &sid);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"sourceItemId\":%ld}", (long)sid);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayerVideoReallyOn(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"videoOn\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayerAudioReallyOn(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"audioOn\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_DoesLayerHaveTrackMatte(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"hasTrackMatte\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte") == 0)
    {
        A_Boolean fill = (A_Boolean)ArgsInt(allow, args, 2);
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayerUsedAsTrackMatte(lr.layerH, fill, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"isTrackMatte\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0)
    {
        AEGP_LayerH matteH = NULL;
        JBuf b;
        A_Err e2 = A_Err_NONE;
        oerr = lr.layerP->AEGP_GetTrackMatteLayer(lr.layerH, &matteH);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            JBInit(&b, v->payload, sizeof(v->payload));
            JBPut(&b, "{\"trackMatteLayer\":");
            if (matteH)
            {
                JBPut(&b, "{\"aeRef\":");
                e2 = EmitLayerRefInner(&b, utilP, plugin_id,
                                       lr.res.memP, lr.res.itemP,
                                       lr.res.itemH, &lr.res, lr.layerP,
                                       matteH);
                JBPut(&b, "}");
            }
            else
                JBPut(&b, "null");
            JBPut(&b, "}");
            if (e2 != A_Err_NONE || b.of)
                oerr = A_Err_STRUCT;
            else
            {
                *b.cur = '\0';
                v->havePayload = 1;
            }
        }
    }
    else
    {
        oerr = A_Err_STRUCT;
    }

    ReleaseLayerResolution(utilP, basicP, &lr);

    GetterTailReadOnly(allow, v, oerr, NULL);
}

/* Execute one claimed request file. Always publishes a result when
   publish==1; the caller removes the .claimed file afterwards.
   `mtimeMs` is the claimed file's mtime — the deadline base, matching
   the ae-a8n dispatcher convention (mtime + timeoutMs). */

/* Project-scoped read-only getters (§7e): {"project": <aeRefProject>}
   → resolve → typed getter → typed JSON. */
void ExecProjectGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)plugin_id;
    JVal* projArg = JGet(args, "project");
    JVal* ref = projArg ? JGet(projArg, "aeRef") : NULL;
    AEGP_ProjectH projectH = NULL;
    long index = 0;
    const char* opId = allow->operationId;
    A_Err oerr = A_Err_STRUCT;

    if (!ResolveProjectRef(utilP, projP, basicP, ref, &projectH, &index, v))
        return;

    if (strcmp(opId, "AEGP_ProjSuite6.AEGP_ProjectIsDirty") == 0)
    {
        A_Boolean dirty = FALSE;
        if (!projP->AEGP_ProjectIsDirty) goto notsent;
        oerr = projP->AEGP_ProjectIsDirty(projectH, &dirty);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"dirty\":%s}",
                     dirty ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_ProjSuite6.AEGP_GetProjectBitDepth") == 0)
    {
        AEGP_ProjBitDepth depth = 0;
        if (!projP->AEGP_GetProjectBitDepth) goto notsent;
        oerr = projP->AEGP_GetProjectBitDepth(projectH, &depth);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"bitDepth\":%d}",
                     (int)depth);
        }
    }
    else /* AEGP_GetProjectTimeDisplay */
    {
        AEGP_TimeDisplay3 td;
        if (!projP->AEGP_GetProjectTimeDisplay) goto notsent;
        memset(&td, 0, sizeof(td));
        oerr = projP->AEGP_GetProjectTimeDisplay(projectH, &td);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"timeDisplay\":{\"displayMode\":%d,\"footageDisplayMode\":%d,"
                "\"displayDropFrame\":%s,\"useFeetFrames\":%s,\"timebase\":%d,"
                "\"framesPerFoot\":%d,\"framesDisplayMode\":%d}}",
                (int)td.display_mode, (int)td.footage_display_mode,
                td.display_dropframeB ? "true" : "false",
                td.use_feet_framesB ? "true" : "false",
                (int)td.timebaseC, (int)td.frames_per_footC,
                (int)td.frames_display_mode);
        }
    }

    if (oerr == A_Err_NONE && v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
    }
    else if (oerr == A_Err_STRUCT && !v->havePayload)
    {
        /* unreachable: notsent label handles missing entries */
        VerdictSet(v, "failed", "getter returned no result");
    }
    else
    {
        VerdictSet(v, "failed", "%s err=%ld", opId, (long)oerr);
    }
    return;

notsent:
    VerdictSet(v, "not-sent", "project suite entry unavailable");
}

/* RQ-item read-only getters (§7f): {projectIndex, rqItem} → atomic
   resolve → typed getter → typed JSON. */
void ExecRQItemGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* rqArg = JGet(args, "rqItem");
    JVal* ref = rqArg ? JGet(rqArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    RQResolution r;
    const char* opId = allow->operationId;
    A_Err oerr = A_Err_STRUCT;

    if (!ResolveRQItemRef(utilP, projP, basicP, plugin_id,
                          projIndex, ref, &r, v))
        return;

    if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetRenderState") == 0)
    {
        AEGP_RenderItemStatusType st = 0;
        oerr = r.rqItemP->AEGP_GetRenderState(r.rqH, &st);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"status\":%ld}",
                     (long)st);
        }
    }
    else if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetStartedTime") == 0 ||
             strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetElapsedTime") == 0)
    {
        int isStarted = strcmp(opId,
            "AEGP_RQItemSuite4.AEGP_GetStartedTime") == 0;
        A_Time t = {0, 0};
        oerr = isStarted ? r.rqItemP->AEGP_GetStartedTime(r.rqH, &t)
                         : r.rqItemP->AEGP_GetElapsedTime(r.rqH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            /* {0,1} sentinel = never started/rendered → null */
            if (t.value == 0 && t.scale == 1)
                PayloadSet(v, "{\"%s\":null}", isStarted ? "startedTime" : "elapsedTime");
            else
                PayloadSet(v, "{\"%s\":{\"value\":%ld,\"scale\":%lu}}",
                         isStarted ? "startedTime" : "elapsedTime",
                         (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetLogType") == 0)
    {
        AEGP_LogType lt = 0;
        oerr = r.rqItemP->AEGP_GetLogType(r.rqH, &lt);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"logType\":%ld}",
                     (long)lt);
        }
    }
    else if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetComment") == 0)
    {
        AEGP_MemHandle mh = NULL;
        char cm[1100];
        IntakeMemStatus ms;
        oerr = r.rqItemP->AEGP_GetComment(r.rqH, &mh);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            ms = IntakeReadMemHandleUtf8(utilP, r.item.memP, mh, cm, sizeof(cm));
            if (ms == IMH_OK || ms == IMH_TRUNCATED)
            {
                char esc[6600];
                JsonEscape(esc, sizeof(esc), cm);
                PayloadSet(v, "{\"comment\":\"%s\"}", esc);
            }
            else oerr = A_Err_STRUCT;
        }
    }
    else if (strcmp(opId,
                    "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem") == 0)
    {
        A_long nom = 0;
        oerr = r.rqItemP->AEGP_GetNumOutputModulesForRQItem(r.rqH, &nom);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"numOutputModules\":%ld}", (long)nom);
        }
    }
    else /* AEGP_GetCompFromRQItem — emit comp descriptor, never handle */
    {
        AEGP_CompH boundCompH = NULL;
        AEGP_ItemH boundItemH = NULL;
        A_long boundItemId = 0;
        oerr = r.rqItemP->AEGP_GetCompFromRQItem(r.rqH, &boundCompH);
        IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
                       (long)oerr, oerr == A_Err_NONE ? " (result)" : NULL);
        if (oerr == A_Err_NONE && boundCompH)
        {
            A_Err e2 = r.compP->AEGP_GetItemFromComp(boundCompH, &boundItemH);
            IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetItemFromComp",
                           (long)e2, e2 == A_Err_NONE ? " (result)" : NULL);
            if (e2 == A_Err_NONE && boundItemH)
            {
                A_Err e3 = r.item.itemP->AEGP_GetItemID(boundItemH, &boundItemId);
                IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                               (long)e3, e3 == A_Err_NONE ? " (result)" : NULL);
                if (e3 == A_Err_NONE)
                {
                    /* reuse the resolved comp's own descriptor — it IS
                       the bound comp (identity already proven equal) */
                    JBuf b;
                    JBInit(&b, v->payload, sizeof(v->payload));
                    JBPut(&b, "{\"comp\":{\"aeRef\":{\"type\":\"");
                    JBPut(&b, ItemTypeToAeRefTag(r.item.type));
                    JBPut(&b, "\",\"name\":\""); JBEsc(&b, r.item.name);
                    JBPut(&b, "\",\"path\":[0],\"itemId\":");
                    JBNum(&b, (long)(unsigned int)boundItemId);
                    JBPut(&b, ",\"projectName\":\"");
                    JBEsc(&b, r.item.projectName);
                    JBPut(&b, "\",\"projectPath\":\"");
                    JBEsc(&b, r.item.projectPath);
                    JBPut(&b, "\"}},\"projectIndex\":");
                    JBNum(&b, projIndex);
                    JBPut(&b, "}");
                    if (!b.of)
                    {
                        *b.cur = '\0';
                        v->havePayload = 1;
                    }
                    else oerr = A_Err_STRUCT;
                }
                else oerr = e3;
            }
            else oerr = e2;
        }
    }

    ReleaseRQResolution(utilP, basicP, &r);
    if (v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
    }
    else
    {
        VerdictSet(v, "failed", "%s err=%ld", opId, (long)oerr);
    }
}

/* ---- Issue #328: scalar/zero-arg executors -------------------------
   ProcessClaimed's dispatch chain is pure routing; every op body lives
   in an executor below. Read-only executors keep mayHaveMutated=0;
   the mutation executor (ExecSetItemComment) sets it only once the
   AEGP call is attempted. */

void ExecNumProjects(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)basicP; (void)plugin_id; (void)args;
    A_long num = 0;
    A_Err oerr = projP->AEGP_GetNumProjects
        ? projP->AEGP_GetNumProjects(&num)
        : A_Err_STRUCT;
    char extra[48];
    if (oerr == A_Err_NONE)
        snprintf(extra, sizeof(extra), " value=%ld", (long)num);
    else
        extra[0] = '\0';
    extra[sizeof(extra) - 1] = '\0';
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? extra : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"numProjects\":%ld}", (long)num);
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail), "AEGP_GetNumProjects err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0; /* read-only getter: provably non-mutating */
    }
}

void ExecDriverImplVersion(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)projP; (void)basicP; (void)plugin_id; (void)args;
    A_short maj = 0, min = 0;
    A_Err oerr = utilP->AEGP_GetDriverImplementationVersion
        ? utilP->AEGP_GetDriverImplementationVersion(&maj, &min)
        : A_Err_STRUCT;
    char extra[48];
    if (oerr == A_Err_NONE)
        snprintf(extra, sizeof(extra), " v=%d.%d", (int)maj, (int)min);
    else
        extra[0] = '\0';
    extra[sizeof(extra) - 1] = '\0';
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? extra : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"major\":%d,\"minor\":%d}", (int)maj, (int)min);
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetDriverImplementationVersion err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

/* AEGP_ItemSuite9.AEGP_GetTypeName — {"itemType": int}. The suite is
   acquired and released inside this request's evidence window; a
   missing suite/entry is environment-proven non-dispatch (not-sent),
   an AEGP error is failed with mayHaveMutated=false (read-only). */
void ExecGetTypeName(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)projP; (void)plugin_id;
    AEGP_ItemType itype = (AEGP_ItemType)ArgsInt(allow, args, 0);
    const void* suite = IntakeAcquireSuite(
        utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (!suite)
    {
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP Item Suite unavailable for GetTypeName");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }
    {
        const AEGP_ItemSuite9* itemP = (const AEGP_ItemSuite9*)suite;
        A_Err oerr = A_Err_STRUCT;
        char extra[48];
        A_char nameZ[AEGP_MAX_TYPE_NAME_SIZE + 1];
        if (!itemP->AEGP_GetTypeName)
        {
            IntakeReleaseSuite(utilP, basicP,
                               kAEGPItemSuite, kAEGPItemSuiteVersion9);
            snprintf(v->outcome, sizeof(v->outcome), "not-sent");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetTypeName entry unavailable");
            v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
            return;
        }
        memset(nameZ, 0, sizeof(nameZ));
        oerr = itemP->AEGP_GetTypeName(itype, nameZ);
        snprintf(extra, sizeof(extra), " t=%d", (int)itype);
        extra[sizeof(extra) - 1] = '\0';
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                       oerr == A_Err_NONE ? extra : NULL);
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPItemSuite, kAEGPItemSuiteVersion9);
        if (oerr == A_Err_NONE)
        {
            char esc[AEGP_MAX_TYPE_NAME_SIZE * 2 + 8];
            JsonEscape(esc, sizeof(esc), nameZ);
            snprintf(v->outcome, sizeof(v->outcome), "completed");
            PayloadSet(v, "{\"typeName\":\"%s\"}", esc);
            v->mayHaveMutated = 0;
        }
        else
        {
            snprintf(v->outcome, sizeof(v->outcome), "failed");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetTypeName err=%ld", (long)oerr);
            v->havePayload = 0;
            v->mayHaveMutated = 0; /* read-only getter */
        }
    }
}

/* AEGP_ItemSuite9.AEGP_GetItemName / AEGP_GetItemID — shared aeRef
   resolve (contract §7b). GetItemName resolves only what the
   descriptor asserts; GetItemID additionally fetches project identity
   for the issued descriptor payload (wantProjectIdentity=1). */
void ExecItemNameOrId(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    int isNameOp = strcmp(allow->operationId,
                          "AEGP_ItemSuite9.AEGP_GetItemName") == 0;
    JVal* itemArg = JGet(args, "item");
    JVal* ref = itemArg ? JGet(itemArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, isNameOp ? 0 : 1,
                          isNameOp ? " (resolve+result)" : " (resolve)",
                          &res, v))
        return;             /* v already carries the verdict */

    if (isNameOp)
    {
        char esc[AEREF_NAME_MAX * 6 + 8];
        JsonEscape(esc, sizeof(esc), res.name);
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"name\":\"%s\"}", esc);
        v->mayHaveMutated = 0;
    }
    else
    {
        /* GetItemID = descriptor issuance: read the live id of the
           resolved item, then emit the canonical identity-bearing
           aeRef (project identity included). Emit BEFORE
           ReleaseResolution — release zeroes res. */
        A_long liveId = 0;
        A_Err iderr = res.itemP->AEGP_GetItemID
            ? res.itemP->AEGP_GetItemID(res.itemH, &liveId)
            : A_Err_STRUCT;
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetItemID", (long)iderr,
            iderr == A_Err_NONE ? " (result)" : NULL);
        {
            int emitOk = iderr == A_Err_NONE &&
                EmitIssuedDescriptor(v, &res,
                    (long)(unsigned int)liveId);
            ReleaseResolution(utilP, basicP, &res);
            if (iderr != A_Err_NONE)
            {
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "AEGP_GetItemID err=%ld", (long)iderr);
                v->havePayload = 0; v->mayHaveMutated = 0;
            }
            else if (!emitOk)
            {
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "descriptor payload exceeds result bound");
                v->havePayload = 0; v->mayHaveMutated = 0;
            }
            else
            {
                snprintf(v->outcome, sizeof(v->outcome), "completed");
                v->havePayload = 1;
                v->mayHaveMutated = 0;
            }
        }
    }
    if (isNameOp) ReleaseResolution(utilP, basicP, &res);
}

void ExecDriverPluginInitVersion(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)projP; (void)basicP; (void)plugin_id; (void)args;
    A_short maj = 0, min = 0;
    A_Err oerr = utilP->AEGP_GetDriverPluginInitFuncVersion
        ? utilP->AEGP_GetDriverPluginInitFuncVersion(&maj, &min)
        : A_Err_STRUCT;
    char extra[48];
    if (oerr == A_Err_NONE)
        snprintf(extra, sizeof(extra), " v=%d.%d", (int)maj, (int)min);
    else
        extra[0] = '\0';
    extra[sizeof(extra) - 1] = '\0';
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? extra : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"major\":%d,\"minor\":%d}", (int)maj, (int)min);
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetDriverPluginInitFuncVersion err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

void ExecSuppressUI(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)projP; (void)basicP; (void)plugin_id; (void)args;
    A_Boolean suppressed = FALSE;
    A_Err oerr = utilP->AEGP_GetSuppressInteractiveUI
        ? utilP->AEGP_GetSuppressInteractiveUI(&suppressed)
        : A_Err_STRUCT;
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? (suppressed ? " value=1" : " value=0") : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"interactiveUiSuppressed\":%s}", suppressed ? "true" : "false");
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetSuppressInteractiveUI err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

void ExecHostActivated(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)projP; (void)basicP; (void)plugin_id; (void)args;
    A_Boolean activated = FALSE;
    A_Err oerr = utilP->AEGP_HostIsActivated
        ? utilP->AEGP_HostIsActivated(&activated)
        : A_Err_STRUCT;
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? (activated ? " value=1" : " value=0") : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"hostActivated\":%s}", activated ? "true" : "false");
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_HostIsActivated err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

/* Zero-arg render-queue getters: AEGP_RenderQueueSuite1.
   AEGP_GetRenderQueueState and AEGP_RQItemSuite4.AEGP_GetNumRQItems
   share the acquire-suite-inside-request pattern. */
void ExecRQZeroArg(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    (void)projP; (void)plugin_id; (void)args;
    int isRQState = strcmp(allow->operationId,
                           "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState") == 0;
    const char* suiteName = isRQState ? kAEGPRenderQueueSuite : kAEGPRQItemSuite;
    int suiteVer = isRQState ? kAEGPRenderQueueSuiteVersion1
                             : kAEGPRQItemSuiteVersion4;
    const void* suite = IntakeAcquireSuite(utilP, basicP, suiteName, suiteVer);
    if (!suite)
    {
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail), "render queue suite unavailable");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }
    {
        A_Err oerr = A_Err_STRUCT;
        char extra[48];
        extra[0] = '\0';
        if (isRQState)
        {
            const AEGP_RenderQueueSuite1* rqQueueP = (const AEGP_RenderQueueSuite1*)suite;
            AEGP_RenderQueueState state = 0;
            if (rqQueueP->AEGP_GetRenderQueueState)
                oerr = rqQueueP->AEGP_GetRenderQueueState(&state);
            else
                oerr = A_Err_STRUCT;
            if (oerr == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " value=%lu",
                         (unsigned long)state);
                IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, extra);
                snprintf(v->outcome, sizeof(v->outcome), "completed");
                PayloadSet(v, "{\"state\":%lu}", (unsigned long)state);
                v->mayHaveMutated = 0;
            }
            else
            {
                RecordAllowOp(utilP, allow, oerr);
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "AEGP_GetRenderQueueState err=%ld", (long)oerr);
                v->havePayload = 0;
                v->mayHaveMutated = 0;
            }
        }
        else
        {
            const AEGP_RQItemSuite4* rqItemP = (const AEGP_RQItemSuite4*)suite;
            A_long num = 0;
            if (rqItemP->AEGP_GetNumRQItems)
                oerr = rqItemP->AEGP_GetNumRQItems(&num);
            else
                oerr = A_Err_STRUCT;
            if (oerr == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " value=%ld", (long)num);
                IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, extra);
                snprintf(v->outcome, sizeof(v->outcome), "completed");
                PayloadSet(v, "{\"numRQItems\":%ld}", (long)num);
                v->mayHaveMutated = 0;
            }
            else
            {
                RecordAllowOp(utilP, allow, oerr);
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "AEGP_GetNumRQItems err=%ld", (long)oerr);
                v->havePayload = 0;
                v->mayHaveMutated = 0;
            }
        }
        IntakeReleaseSuite(utilP, basicP, suiteName, suiteVer);
    }
}

#else /* _WIN32 */
#endif
