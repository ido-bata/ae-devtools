/*******************************************************************/
/*                                                                 */
/* ae-a8n minimal read-only AEGP probe — Issue #17 (CAP038)        */
/*                                                                 */
/* Original code written for this repository. It is NOT derived    */
/* from Adobe SDK sample sources.                                   */
/*                                                                 */
/* LIFECYCLE (see README.md "Execution context"):                  */
/*                                                                 */
/*   AEProbePluginEntry (PiPL entry point) performs ONLY           */
/*   registration-safe work: it stores the host SPBasicSuite,      */
/*   registers the plug-in identity via AEGP_RegisterWithAEGP      */
/*   and registers an AEGP idle hook via AEGP_RegisterSuite5's     */
/*   AEGP_RegisterIdleHook. It never queries project state at      */
/*   init: no project may be open when the plug-in loads, and      */
/*   "no project open" is a normal host state, not a plug-in       */
/*   error.                                                        */
/*                                                                 */
/*   ProbeIdleHook is dispatched by the host on the AE main        */
/*   thread — the SDK-sanctioned execution context for AEGP        */
/*   suite calls (the same context in which the SDK samples run    */
/*   their command/update-menu/idle hooks; see ProjDumper and      */
/*   Commando under Examples/AEGP/). All project/item queries      */
/*   run there.                                                    */
/*                                                                 */
/* TRIGGER: each idle dispatch computes a cheap project-set        */
/* fingerprint — project count plus, for up to MAX_PROJECTS_SCANNED */
/* projects, name and path — and runs the full probe only when     */
/* the fingerprint differs from the last successful one (or when   */
/* no valid fingerprint exists: first dispatch, or recovery from   */
/* a query failure). A same-count project switch therefore        */
/* re-probes; a steady-state idle loop stays silent. Fingerprint   */
/* queries are trigger machinery: their per-call op records are    */
/* buffered and only flushed when a probe actually runs, so        */
/* non-probe ticks emit nothing.                                   */
/*                                                                 */
/* FINGERPRINT LIMITS (documented, accepted): the identity is      */
/* count + name + path of the first MAX_PROJECTS_SCANNED projects. */
/* A swap beyond index 3, or a swap between two untitled projects  */
/* sharing name and empty path, is invisible to the trigger — the  */
/* probe simply does not re-run. AE normally keeps <= 1 project    */
/* open, so the residual risk is a >4-project edge case. The        */
/* fingerprint string itself is never logged; only the probe.run    */
/* data lines (which the contract already marks redact-before-      */
/* share) carry name/path.                                         */
/*                                                                 */
/* STEADY-STATE LOAD: the hook asks the host for at most one       */
/* dispatch per second via max_sleepPL (1/60 s units); the        */
/* fingerprint queries are the only recurring SDK traffic.         */
/*                                                                 */
/* EVIDENCE: every AEGP/SPBasicSuite call emits one               */
/*   op <Suite>.<member> err=<A_Err> [k=v ...]                     */
/* record through AEGP_WriteToDebugLog. Records made outside a     */
/* probe run are buffered and discarded unless a run flushes them; */
/* inside a run they are written in call order between             */
/* probe.start and the matching suite releases. AEGP_WriteToDebugLog*/
/* itself cannot self-evidence: its evidence is the existence of   */
/* the run's output. See                                              */
/* specs/ae-capability-coverage/contracts/native-probe-result.md   */
/* (branch 19) for the result contract these lines feed.           */
/*                                                                 */
/* READ-ONLY CONTRACT: every AEGP call is a query/getter or a      */
/* registration call. No setter, no undoable call, no project      */
/* mutation is performed. Results are reported through             */
/* AEGP_WriteToDebugLog only. See README.md for the per-call        */
/* justification.                                                   */
/*******************************************************************/

#include <AE_GeneralPlug.h>

#include "native_intake.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PROBE_PLUGIN_NAME "ae-a8n NativeProbe"
#define LOG_SUBSYSTEM "ae-a8n"
#define LOG_EVENT "nativeprobe"

/* Cap on project-item iteration so a pathological project cannot
   stall the idle hook. */
#define MAX_ITEMS_SCANNED 4096L
/* Cap on item names logged per run. */
#define MAX_ITEM_NAMES 8L
/* Cap on projects inspected per run (AE normally has <= 1 open).
   The fingerprint covers the same prefix. */
#define MAX_PROJECTS_SCANNED 4L
/* Cap on render-queue items inspected per run. */
#define MAX_RQ_ITEMS_SCANNED 16L

/* ---- op-record ring buffer --------------------------------------
   Every suite call produces one "op <id> err=<n> [k=v]" record.
   Outside a probe run records accumulate in a per-tick buffer and
   are discarded; a probe run flushes the buffer (trigger-phase calls
   of the same idle dispatch) then records live until the suites are
   released. The buffer is cleared at the top of every idle dispatch
   and at plugin entry, so a flushed record always belongs to the
   execution that follows it. */
#define OP_LINE_MAX 224
#define OP_BUF_SIZE 192
#define OP_MODE_BUFFER 0
#define OP_MODE_DIRECT 1

/* Fingerprint bounds: 4 projects x (48-byte name + 2048-byte path)
   plus separators fits comfortably. */
#define FP_BUF_SIZE 8192
#define FP_PATH_UTF8_MAX 2048

/* Host state kept between the entry point and idle-hook dispatch.
   AEGPs are not unloaded by AE, so static lifetime is safe (same
   convention as the SDK samples). */
static struct SPBasicSuite* s_basicP = NULL;
/* Entry-point AEGP_PluginID: used to register the idle hook. */
static AEGP_PluginID s_hook_plugin_id = 0;
/* ID returned by AEGP_RegisterWithAEGP (or the entry-point id as
   fallback): used for queries that take a plugin id, e.g.
   AEGP_GetItemName. */
static AEGP_PluginID s_aegp_plugin_id = 0;

/* Project-set fingerprint state. FP_NEVER = no successful
   fingerprint yet (first dispatch probes); FP_VALID = s_last_fp
   holds the fingerprint of the last observed project set;
   FP_INVALID = the last fingerprint attempt failed, so the next
   successful computation must probe (recovery). */
typedef enum { FP_NEVER = 0, FP_VALID = 1, FP_INVALID = 2 } ProbeFpState;
static ProbeFpState s_fp_state = FP_NEVER;
static char s_last_fp[FP_BUF_SIZE];
/* Log-once guards: a persistent host failure must not spam the
   debug log every idle tick. Each resets on the next success. */
static A_Boolean s_count_err_loggedB = FALSE;
static A_Boolean s_fp_err_loggedB = FALSE;
static A_Boolean s_abort_loggedB = FALSE;

/* Op-record state. */
static int s_op_mode = OP_MODE_BUFFER;
static char s_op_buf[OP_BUF_SIZE][OP_LINE_MAX];
static int s_op_buf_count = 0;
static A_Boolean s_op_overflowB = FALSE;

static void LogLine(const AEGP_UtilitySuite6* utilP, const char* msgZ)
{
    if (utilP && utilP->AEGP_WriteToDebugLog)
    {
        utilP->AEGP_WriteToDebugLog(LOG_SUBSYSTEM, LOG_EVENT, msgZ);
    }
}

static void LogFormatted(const AEGP_UtilitySuite6* utilP, const char* fmtZ, ...)
{
    char buf[512];
    va_list args;
    va_start(args, fmtZ);
    vsnprintf(buf, sizeof(buf), fmtZ, args);
    va_end(args);
    buf[sizeof(buf) - 1] = '\0';
    LogLine(utilP, buf);
}

/* Emit one op record for a suite call. In BUFFER mode the formatted
   line is stored in the per-tick ring (utilP unused); in DIRECT mode
   it is written immediately. extraZ is an optional pre-formatted
   " k=v ..." suffix (e.g. " value=1", " suite=\"AEGP Proj Suite\""). */
static void OpRecordV(
    const AEGP_UtilitySuite6* utilP,
    const char* idZ,
    long errL,
    const char* extraZ)
{
    char line[OP_LINE_MAX];
    snprintf(line, sizeof(line), "op %s err=%ld%s", idZ, errL,
             extraZ ? extraZ : "");
    line[sizeof(line) - 1] = '\0';

    if (s_op_mode == OP_MODE_DIRECT)
    {
        LogLine(utilP, line);
    }
    else if (s_op_buf_count < OP_BUF_SIZE)
    {
        strncpy(s_op_buf[s_op_buf_count], line, OP_LINE_MAX - 1);
        s_op_buf[s_op_buf_count][OP_LINE_MAX - 1] = '\0';
        s_op_buf_count++;
    }
    else
    {
        s_op_overflowB = TRUE;
    }
}

static void ClearOpBuffer(void)
{
    s_op_buf_count = 0;
    s_op_overflowB = FALSE;
}

/* Write every buffered record (this tick's trigger-phase calls) to the
   debug log, in order, then empty the buffer. */
static void FlushOpBuffer(const AEGP_UtilitySuite6* utilP)
{
    int i;
    if (s_op_overflowB)
    {
        LogLine(utilP, "op __overflow err=-1");
        s_op_overflowB = FALSE;
    }
    for (i = 0; i < s_op_buf_count; i++)
    {
        LogLine(utilP, s_op_buf[i]);
    }
    s_op_buf_count = 0;
}

/* Convert a UTF-16 buffer to UTF-8, bounded by BOTH the number of
   A_UTF16Char code units available (max_unitsL, derived from
   AEGP_GetMemHandleSize — never read past the AE-allocated block)
   and the destination capacity. Handles BMP code points and surrogate
   pairs; lone surrogates become U+FFFD. Returns bytes written
   (excluding NUL), or -1 on destination truncation. */
static int Utf16ToUtf8Bounded(
    const A_UTF16Char* srcP,
    AEGP_MemSize max_unitsL,
    char* dstP,
    size_t dstSize)
{
    size_t di = 0;
    AEGP_MemSize i = 0;
    int truncatedB = 0;

    while (i < max_unitsL)
    {
        unsigned int cp = srcP[i++];
        size_t need;

        if (cp == 0)
        {
            break; /* embedded NUL terminator */
        }
        if (cp >= 0xD800 && cp <= 0xDBFF)
        {
            if (i < max_unitsL && srcP[i] >= 0xDC00 && srcP[i] <= 0xDFFF)
            {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (srcP[i++] - 0xDC00);
            }
            else
            {
                cp = 0xFFFD; /* lone high surrogate */
            }
        }
        else if (cp >= 0xDC00 && cp <= 0xDFFF)
        {
            cp = 0xFFFD; /* lone low surrogate */
        }

        need = (cp < 0x80) ? 1 : (cp < 0x800) ? 2 : (cp < 0x10000) ? 3 : 4;
        if (di + need + 1 > dstSize)
        {
            truncatedB = 1;
            break;
        }

        if (cp < 0x80)
        {
            dstP[di++] = (char)cp;
        }
        else if (cp < 0x800)
        {
            dstP[di++] = (char)(0xC0 | (cp >> 6));
            dstP[di++] = (char)(0x80 | (cp & 0x3F));
        }
        else if (cp < 0x10000)
        {
            dstP[di++] = (char)(0xE0 | (cp >> 12));
            dstP[di++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            dstP[di++] = (char)(0x80 | (cp & 0x3F));
        }
        else
        {
            dstP[di++] = (char)(0xF0 | (cp >> 18));
            dstP[di++] = (char)(0x80 | ((cp >> 12) & 0x3F));
            dstP[di++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            dstP[di++] = (char)(0x80 | (cp & 0x3F));
        }
    }
    dstP[di] = '\0';
    return truncatedB ? -1 : (int)di;
}

/* ---- mem-handle plumbing ----------------------------------------
   Memory discipline (AEGP_MemorySuite1, AE_GeneralPlug.h):
   - AEGP_GetMemHandleSize reports the allocation size in BYTES;
     only size/sizeof(A_UTF16Char) code units may be read, and the
     payload is documented as null-terminated but we do not rely on
     that — the bound comes from the size, not from scanning.
   - AEGP_LockMemHandle is nestable; every successful lock is paired
     with AEGP_UnlockMemHandle before the handle is freed.
   - AEGP_FreeMemHandle disposes the AE-allocated handle and is called
     on EVERY exit path once we own the handle — success, size-query
     failure and lock failure alike (no leak, no double-free: each
     call site passes a handle obtained exactly once). */

typedef enum
{
    MH_OK = 0,
    MH_NULL_HANDLE,
    MH_NOENTRIES,
    MH_SIZE_ERR,
    MH_LOCK_ERR,
    MH_TRUNCATED
} MemHandleStatus;

/* Free an AE-allocated handle and record the call. */
static void FreeMemHandleTracked(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    AEGP_MemHandle handleH)
{
    A_Err err = memP->AEGP_FreeMemHandle(handleH);
    OpRecordV(utilP, "AEGP_MemorySuite1.AEGP_FreeMemHandle", (long)err, NULL);
}

/* Lock/size/convert/unlock/free an AEGP mem handle holding a UTF-16
   string into dstZ (NUL-terminated UTF-8, truncated at dstSize).
   The handle is ALWAYS freed on every path where freeing is possible
   (MH_NOENTRIES excepted: the free entry itself is missing). Every
   suite call is op-recorded. dstZ is written on MH_OK and
   MH_TRUNCATED. */
static MemHandleStatus ReadMemHandleUtf8(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    AEGP_MemHandle handleH,
    char* dstZ,
    size_t dstSize)
{
    void* ptr = NULL;
    AEGP_MemSize size_bytesL = 0;
    A_Err err;

    dstZ[0] = '\0';
    if (!handleH)
    {
        return MH_NULL_HANDLE;
    }
    /* The caller validates suite entries up front; these guards are
       defense-in-depth so a partial suite can never cause a wild call. */
    if (!memP->AEGP_GetMemHandleSize || !memP->AEGP_LockMemHandle ||
        !memP->AEGP_UnlockMemHandle || !memP->AEGP_FreeMemHandle)
    {
        return MH_NOENTRIES;
    }

    err = memP->AEGP_GetMemHandleSize(handleH, &size_bytesL);
    OpRecordV(utilP, "AEGP_MemorySuite1.AEGP_GetMemHandleSize", (long)err, NULL);
    if (err != A_Err_NONE)
    {
        FreeMemHandleTracked(utilP, memP, handleH);
        return MH_SIZE_ERR;
    }

    err = memP->AEGP_LockMemHandle(handleH, &ptr);
    OpRecordV(utilP, "AEGP_MemorySuite1.AEGP_LockMemHandle", (long)err, NULL);
    if (err != A_Err_NONE || !ptr)
    {
        FreeMemHandleTracked(utilP, memP, handleH);
        return MH_LOCK_ERR;
    }

    {
        AEGP_MemSize unitsL = size_bytesL / sizeof(A_UTF16Char);
        int n = Utf16ToUtf8Bounded((const A_UTF16Char*)ptr, unitsL, dstZ, dstSize);
        A_Err uerr = memP->AEGP_UnlockMemHandle(handleH);
        OpRecordV(utilP, "AEGP_MemorySuite1.AEGP_UnlockMemHandle", (long)uerr, NULL);
        FreeMemHandleTracked(utilP, memP, handleH);
        return n < 0 ? MH_TRUNCATED : MH_OK;
    }
}

/* Log the contents of an AEGP mem handle holding a UTF-16 string.
   Human-readable companion to ReadMemHandleUtf8 for probe output;
   the op records are emitted by the shared plumbing. */
static void LogMemHandleUtf16(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    const char* labelZ,
    AEGP_MemHandle handleH)
{
    char utf8[1024];
    MemHandleStatus st;

    if (!handleH)
    {
        LogFormatted(utilP, "%s: <null handle>", labelZ);
        return;
    }
    st = ReadMemHandleUtf8(utilP, memP, handleH, utf8, sizeof(utf8));
    switch (st)
    {
        case MH_OK:
            LogFormatted(utilP, "%s: %s", labelZ, utf8);
            break;
        case MH_TRUNCATED:
            LogFormatted(utilP, "%s: <truncated>", labelZ);
            break;
        case MH_SIZE_ERR:
            LogFormatted(utilP, "%s: size query failed", labelZ);
            break;
        case MH_LOCK_ERR:
            LogFormatted(utilP, "%s: lock failed", labelZ);
            break;
        case MH_NOENTRIES:
            LogFormatted(utilP, "%s: memory suite entries missing", labelZ);
            break;
        default:
            break;
    }
}

/* ---- project-set fingerprint -------------------------------------
   Cheap per-tick identity probe: project count plus, for each of the
   first MAX_PROJECTS_SCANNED projects, name and path. Any query
   failure makes the fingerprint unavailable (caller invalidates
   state and retries next tick). Silent by design: op records go to
   the per-tick buffer and are only flushed if a probe run follows. */

static A_Boolean ComputeProjectFingerprint(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_MemorySuite1* memP,
    A_long num_projectsL,
    char* outZ,
    size_t outSize)
{
    size_t off = 0;
    A_long i;
    A_long limit = num_projectsL < MAX_PROJECTS_SCANNED
                       ? num_projectsL
                       : MAX_PROJECTS_SCANNED;

    /* snprintf returns the WOULD-BE length, so `off` can run past
       outSize; clamp after every append. Writes stay bounded by
       snprintf itself, and a truncated fingerprint is still
       deterministic for identical inputs. */
    off += (size_t)snprintf(outZ + off, outSize - off, "%ld;", (long)num_projectsL);
    if (off >= outSize)
    {
        off = outSize - 1;
    }

    for (i = 0; i < limit && off < outSize - 1; i++)
    {
        AEGP_ProjectH projectH = NULL;
        char nameZ[AEGP_MAX_PROJ_NAME_SIZE + 1];
        AEGP_MemHandle pathH = NULL;
        char pathZ[FP_PATH_UTF8_MAX];
        A_Err err;
        MemHandleStatus st;
        int path_len;

        err = projP->AEGP_GetProjectByIndex(i, &projectH);
        {
            char extra[32];
            snprintf(extra, sizeof(extra), " i=%ld", (long)i);
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex", (long)err, extra);
        }
        if (err != A_Err_NONE || !projectH)
        {
            return FALSE;
        }

        memset(nameZ, 0, sizeof(nameZ));
        err = projP->AEGP_GetProjectName(projectH, nameZ);
        OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectName", (long)err, NULL);
        if (err != A_Err_NONE)
        {
            return FALSE;
        }

        err = projP->AEGP_GetProjectPath(projectH, &pathH);
        OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectPath", (long)err, NULL);
        if (err != A_Err_NONE)
        {
            return FALSE;
        }
        /* Untitled projects report an empty-string handle; a NULL
           handle is treated the same way. Real read errors fail the
           fingerprint so the next tick retries. */
        st = ReadMemHandleUtf8(utilP, memP, pathH, pathZ, sizeof(pathZ));
        if (st == MH_NULL_HANDLE)
        {
            pathZ[0] = '\0';
        }
        else if (st != MH_OK && st != MH_TRUNCATED)
        {
            return FALSE;
        }
        path_len = (int)strlen(pathZ);

        off += (size_t)snprintf(outZ + off, outSize - off, "%ld:%s|%d:%s;",
                                (long)i, nameZ, path_len, pathZ);
        if (off >= outSize)
        {
            off = outSize - 1;
            break; /* truncated fingerprint is still deterministic */
        }
    }
    outZ[outSize - 1] = '\0';
    return TRUE;
}

/* Query the AEGP item bound to the project root folder and log its
   name. Read-only: AEGP_GetProjectRootFolder returns a handle;
   AEGP_GetItemName allocates a mem handle we dispose. */
static void ProbeRootFolderName(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
    AEGP_PluginID plugin_id,
    AEGP_ProjectH projectH)
{
    A_Err err;
    AEGP_ItemH root_itemH = NULL;

    err = projP->AEGP_GetProjectRootFolder(projectH, &root_itemH);
    OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectRootFolder", (long)err, NULL);
    if (err != A_Err_NONE || !root_itemH)
    {
        LogFormatted(utilP, "AEGP_GetProjectRootFolder err=%ld", (long)err);
        return;
    }

    {
        AEGP_MemHandle nameH = NULL;
        err = itemP->AEGP_GetItemName(plugin_id, root_itemH, &nameH);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemName", (long)err, NULL);
        if (err == A_Err_NONE)
        {
            LogMemHandleUtf16(utilP, memP, "project.rootFolder.name", nameH);
        }
        else
        {
            LogFormatted(utilP, "AEGP_GetItemName(root) err=%ld", (long)err);
        }
    }
}

/* Read-only view-detail getters for one open item view (Issue #63).
   itemViewP is the AEGP_ItemViewSuite2 table; item_viewP is the
   opaque view handle returned by AEGP_GetItemMRUView. Every call is
   op-recorded; failures are logged and skipped. */
static void ProbeItemViewDetails(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ItemViewSuite2* itemViewP,
    AEGP_ItemViewP item_viewP,
    long item_indexL)
{
    char idx[32];
    A_Err err;
    snprintf(idx, sizeof(idx), " i=%ld", item_indexL);
    idx[sizeof(idx) - 1] = '\0';

    {
        A_Boolean previewingB = FALSE;
        A_Time t = {0, 0};
        err = itemViewP->AEGP_GetItemViewPlaybackTime(item_viewP, &previewingB, &t);
        OpRecordV(utilP, "AEGP_ItemViewSuite2.AEGP_GetItemViewPlaybackTime",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].view.previewing=%d playback=%ld/%lu",
                         item_indexL, (int)previewingB, (long)t.value,
                         (unsigned long)t.scale);
        }
    }
    {
        A_Boolean visibleB = FALSE;
        err = itemViewP->AEGP_GetItemViewGuidesVisible(item_viewP, &visibleB);
        OpRecordV(utilP, "AEGP_ItemViewSuite2.AEGP_GetItemViewGuidesVisible",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].view.guidesVisible=%d",
                         item_indexL, (int)visibleB);
        }
    }
    {
        A_Boolean snapB = FALSE;
        err = itemViewP->AEGP_GetItemViewGuidesSnap(item_viewP, &snapB);
        OpRecordV(utilP, "AEGP_ItemViewSuite2.AEGP_GetItemViewGuidesSnap",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].view.guidesSnap=%d",
                         item_indexL, (int)snapB);
        }
    }
    {
        A_Boolean lockedB = FALSE;
        err = itemViewP->AEGP_GetItemViewGuidesLocked(item_viewP, &lockedB);
        OpRecordV(utilP, "AEGP_ItemViewSuite2.AEGP_GetItemViewGuidesLocked",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].view.guidesLocked=%d",
                         item_indexL, (int)lockedB);
        }
    }
}

static void ProbeCompLayers(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_LayerSuite9* layerP,
    const AEGP_MemorySuite1* memP,
    AEGP_PluginID plugin_id,
    AEGP_CompH compH,
    long item_indexL);

/* Read-only comp-detail getters for one comp item (Issue #64).
   compP is the AEGP_CompSuite13 table; compH is the opaque comp
   handle returned by AEGP_GetCompFromItem (borrowed — never freed).
   Every call is op-recorded; per-call failures are logged and
   skipped, never aborting the item walk. */
static void ProbeCompDetails(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_CompSuite13* compP,
    const AEGP_LayerSuite9* layerP,   /* NULL when suite unavailable */
    const AEGP_MemorySuite1* memP,
    AEGP_PluginID plugin_id,
    AEGP_ItemH itemH,
    long item_indexL)
{
    char idx[32];
    A_Err err;
    AEGP_CompH compH = NULL;
    snprintf(idx, sizeof(idx), " i=%ld", item_indexL);
    idx[sizeof(idx) - 1] = '\0';

    err = compP->AEGP_GetCompFromItem(itemH, &compH);
    OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem", (long)err, idx);
    if (err != A_Err_NONE || !compH)
    {
        LogFormatted(utilP, "project.items[%ld].comp: unavailable err=%ld",
                     item_indexL, (long)err);
        return;
    }
    LogFormatted(utilP, "project.items[%ld].comp=present", item_indexL);

    {
        AEGP_ItemH backH = NULL;
        err = compP->AEGP_GetItemFromComp(compH, &backH);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetItemFromComp", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.itemFromComp=%s",
                         item_indexL, backH ? "present" : "none");
        }
    }
    {
        A_FpLong fps = 0;
        err = compP->AEGP_GetCompFramerate(compH, &fps);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompFramerate", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.fps=%g",
                         item_indexL, fps);
        }
    }
    {
        A_Time t = {0, 0};
        err = compP->AEGP_GetCompFrameDuration(compH, &t);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompFrameDuration", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.frameDuration=%ld/%lu",
                         item_indexL, (long)t.value, (unsigned long)t.scale);
        }
    }
    {
        AEGP_DownsampleFactor dsf;
        dsf.xS = 0; dsf.yS = 0;
        err = compP->AEGP_GetCompDownsampleFactor(compH, &dsf);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.downsample=%dx%d",
                         item_indexL, (int)dsf.xS, (int)dsf.yS);
        }
    }
    {
        AEGP_ColorVal bg;
        memset(&bg, 0, sizeof(bg));
        err = compP->AEGP_GetCompBGColor(compH, &bg);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompBGColor", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP,
                         "project.items[%ld].comp.bgColor a=%g r=%g g=%g b=%g",
                         item_indexL, bg.alphaF, bg.redF, bg.greenF, bg.blueF);
        }
    }
    {
        AEGP_CompFlags flags = 0;
        err = compP->AEGP_GetCompFlags(compH, &flags);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompFlags", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.flags=%ld",
                         item_indexL, (long)flags);
        }
    }
    {
        A_Boolean shownB = FALSE;
        err = compP->AEGP_GetShowLayerNameOrSourceName(compH, &shownB);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.showLayerNames=%d",
                         item_indexL, (int)shownB);
        }
    }
    {
        A_Boolean shownB = FALSE;
        err = compP->AEGP_GetShowBlendModes(compH, &shownB);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetShowBlendModes", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.showBlendModes=%d",
                         item_indexL, (int)shownB);
        }
    }
    {
        A_Ratio angle = {0, 0}, phase = {0, 0};
        err = compP->AEGP_GetCompShutterAnglePhase(compH, &angle, &phase);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP,
                         "project.items[%ld].comp.shutterAngle=%ld/%lu phase=%ld/%lu",
                         item_indexL, (long)angle.num, (unsigned long)angle.den,
                         (long)phase.num, (unsigned long)phase.den);
        }
    }
    {
        /* Shutter frame range evaluated at comp time zero. */
        A_Time at = {0, 30};
        A_Time start = {0, 0}, duration = {0, 0};
        err = compP->AEGP_GetCompShutterFrameRange(compH, &at, &start, &duration);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompShutterFrameRange",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP,
                         "project.items[%ld].comp.shutterRange start=%ld/%lu duration=%ld/%lu",
                         item_indexL, (long)start.value, (unsigned long)start.scale,
                         (long)duration.value, (unsigned long)duration.scale);
        }
    }
    {
        A_long samplesL = 0;
        err = compP->AEGP_GetCompSuggestedMotionBlurSamples(compH, &samplesL);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.mbSamples=%ld",
                         item_indexL, (long)samplesL);
        }
    }
    {
        A_long samplesL = 0;
        err = compP->AEGP_GetCompMotionBlurAdaptiveSampleLimit(compH, &samplesL);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.mbAdaptiveLimit=%ld",
                         item_indexL, (long)samplesL);
        }
    }
    {
        A_Time t = {0, 0};
        err = compP->AEGP_GetCompWorkAreaStart(compH, &t);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.workAreaStart=%ld/%lu",
                         item_indexL, (long)t.value, (unsigned long)t.scale);
        }
    }
    {
        A_Time t = {0, 0};
        err = compP->AEGP_GetCompWorkAreaDuration(compH, &t);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.workAreaDuration=%ld/%lu",
                         item_indexL, (long)t.value, (unsigned long)t.scale);
        }
    }
    {
        A_Time t = {0, 0};
        err = compP->AEGP_GetCompDisplayStartTime(compH, &t);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.displayStart=%ld/%lu",
                         item_indexL, (long)t.value, (unsigned long)t.scale);
        }
    }
    {
        A_Boolean dropB = FALSE;
        err = compP->AEGP_GetCompDisplayDropFrame(compH, &dropB);
        OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame",
                  (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].comp.displayDropFrame=%d",
                         item_indexL, (int)dropB);
        }
    }

    if (layerP != NULL)
    {
        ProbeCompLayers(utilP, layerP, memP, plugin_id, compH, item_indexL);
    }
}


/* Read-only layer enumeration + per-layer getters for one comp
   (Issue #64 layer slice). layerH values are opaque borrowed handles —
   never freed. Every call is op-recorded; per-call failures are
   logged and skipped. Runs only when the Layer suite was acquired
   and its entries validated; suite-level failure is non-fatal. */
static void ProbeCompLayers(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_LayerSuite9* layerP,
    const AEGP_MemorySuite1* memP,
    AEGP_PluginID plugin_id,
    AEGP_CompH compH,
    long item_indexL)
{
    char idx[32];
    A_Err err;
    A_long num_layersL = 0;
    A_long li;
    snprintf(idx, sizeof(idx), " i=%ld", item_indexL);
    idx[sizeof(idx) - 1] = '\0';

    err = layerP->AEGP_GetCompNumLayers(compH, &num_layersL);
    OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetCompNumLayers", (long)err, idx);
    if (err != A_Err_NONE)
    {
        LogFormatted(utilP, "project.items[%ld].comp.numLayers err=%ld",
                     item_indexL, (long)err);
        return;
    }
    LogFormatted(utilP, "project.items[%ld].comp.numLayers=%ld",
                 item_indexL, num_layersL);

    for (li = 0; li < num_layersL; li++)
    {
        AEGP_LayerH layerH = NULL;
        char lidx[48];
        snprintf(lidx, sizeof(lidx), " i=%ld l=%ld", item_indexL, (long)li);
        lidx[sizeof(lidx) - 1] = '\0';

        err = layerP->AEGP_GetCompLayerByIndex(compH, li, &layerH);
        OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex",
                  (long)err, lidx);
        if (err != A_Err_NONE || !layerH)
        {
            LogFormatted(utilP,
                         "project.items[%ld].comp.layers[%ld]: unavailable err=%ld",
                         item_indexL, li, (long)err);
            continue;
        }

        {
            A_long layer_indexL = -1;
            err = layerP->AEGP_GetLayerIndex(layerH, &layer_indexL);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerIndex",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].index=%ld",
                             item_indexL, li, layer_indexL);
            }
        }
        {
            AEGP_MemHandle nameH = NULL;
            AEGP_MemHandle srcH = NULL;
            err = layerP->AEGP_GetLayerName(plugin_id, layerH, &nameH, &srcH);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerName",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                char label[96];
                snprintf(label, sizeof(label),
                         "project.items[%ld].comp.layers[%ld].name", item_indexL, (long)li);
                label[sizeof(label) - 1] = '\0';
                LogMemHandleUtf16(utilP, memP, label, nameH);
                snprintf(label, sizeof(label),
                         "project.items[%ld].comp.layers[%ld].sourceName", item_indexL, (long)li);
                label[sizeof(label) - 1] = '\0';
                LogMemHandleUtf16(utilP, memP, label, srcH);
            }
        }
        {
            AEGP_LayerFlags flags = 0;
            err = layerP->AEGP_GetLayerFlags(layerH, &flags);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerFlags",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].flags=%ld",
                             item_indexL, li, (long)flags);
            }
        }
        {
            AEGP_LayerQuality quality = AEGP_LayerQual_NONE;
            err = layerP->AEGP_GetLayerQuality(layerH, &quality);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerQuality",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].quality=%d",
                             item_indexL, li, (int)quality);
            }
        }
        {
            AEGP_ObjectType obj = AEGP_ObjectType_NONE;
            err = layerP->AEGP_GetLayerObjectType(layerH, &obj);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerObjectType",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].objectType=%ld",
                             item_indexL, li, (long)obj);
            }
        }
        {
            A_Boolean is3dB = FALSE;
            err = layerP->AEGP_IsLayer3D(layerH, &is3dB);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_IsLayer3D",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].is3D=%d",
                             item_indexL, li, (int)is3dB);
            }
        }
        {
            A_Boolean is2dB = FALSE;
            err = layerP->AEGP_IsLayer2D(layerH, &is2dB);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_IsLayer2D",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].is2D=%d",
                             item_indexL, li, (int)is2dB);
            }
        }
        {
            A_Time t = {0, 0};
            err = layerP->AEGP_GetLayerCurrentTime(layerH,
                                                   AEGP_LTimeMode_CompTime, &t);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].currentTime=%ld/%lu",
                             item_indexL, li, (long)t.value,
                             (unsigned long)t.scale);
            }
        }
        {
            A_Time t = {0, 0};
            err = layerP->AEGP_GetLayerInPoint(layerH,
                                               AEGP_LTimeMode_CompTime, &t);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerInPoint",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].inPoint=%ld/%lu",
                             item_indexL, li, (long)t.value,
                             (unsigned long)t.scale);
            }
        }
        {
            A_Time t = {0, 0};
            err = layerP->AEGP_GetLayerDuration(layerH,
                                                AEGP_LTimeMode_CompTime, &t);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerDuration",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].duration=%ld/%lu",
                             item_indexL, li, (long)t.value,
                             (unsigned long)t.scale);
            }
        }
        {
            AEGP_LayerIDVal idv = AEGP_LayerIDVal_NONE;
            err = layerP->AEGP_GetLayerID(layerH, &idv);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerID",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].id=%ld",
                             item_indexL, li, (long)idv);
            }
        }
        {
            AEGP_LabelID label = 0;
            err = layerP->AEGP_GetLayerLabel(layerH, &label);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerLabel",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].label=%d",
                             item_indexL, li, (int)label);
            }
        }
        {
            AEGP_LayerSamplingQuality sq = 0;
            err = layerP->AEGP_GetLayerSamplingQuality(layerH, &sq);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].samplingQuality=%d",
                             item_indexL, li, (int)sq);
            }
        }
        {
            A_long src_idL = 0;
            err = layerP->AEGP_GetLayerSourceItemID(layerH, &src_idL);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].sourceItemID=%ld",
                             item_indexL, li, src_idL);
            }
        }
        {
            AEGP_CompH parentH = NULL;
            err = layerP->AEGP_GetLayerParentComp(layerH, &parentH);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetLayerParentComp",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].parentComp=%s",
                             item_indexL, li, parentH ? "present" : "none");
            }
        }
        {
            A_Boolean onB = FALSE;
            err = layerP->AEGP_IsLayerVideoReallyOn(layerH, &onB);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].videoOn=%d",
                             item_indexL, li, (int)onB);
            }
        }
        {
            A_Boolean onB = FALSE;
            err = layerP->AEGP_IsLayerAudioReallyOn(layerH, &onB);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].audioOn=%d",
                             item_indexL, li, (int)onB);
            }
        }
        {
            A_Boolean hasB = FALSE;
            err = layerP->AEGP_DoesLayerHaveTrackMatte(layerH, &hasB);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].hasTrackMatte=%d",
                             item_indexL, li, (int)hasB);
            }
        }
        {
            A_Boolean isB = FALSE;
            err = layerP->AEGP_IsLayerUsedAsTrackMatte(layerH, TRUE, &isB);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].isTrackMatte=%d",
                             item_indexL, li, (int)isB);
            }
        }
        {
            AEGP_LayerH matteH = NULL;
            err = layerP->AEGP_GetTrackMatteLayer(layerH, &matteH);
            OpRecordV(utilP, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer",
                      (long)err, lidx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project.items[%ld].comp.layers[%ld].trackMatteLayer=%s",
                             item_indexL, li, matteH ? "present" : "none");
            }
        }
    }
}

/* Most-recently-used comp, once per probe run (app-level). A NULL
   comp is a normal state (no comp has been opened this session). */
static void ProbeMostRecentComp(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_CompSuite13* compP)
{
    AEGP_CompH compH = NULL;
    A_Err err = compP->AEGP_GetMostRecentlyUsedComp(&compH);
    OpRecordV(utilP, "AEGP_CompSuite13.AEGP_GetMostRecentlyUsedComp",
              (long)err, err == A_Err_NONE ? (compH ? " hasComp=1" : " hasComp=0") : NULL);
    if (err != A_Err_NONE)
    {
        LogFormatted(utilP, "AEGP_GetMostRecentlyUsedComp err=%ld", (long)err);
        return;
    }
    LogFormatted(utilP, "app.mruComp=%s", compH ? "present" : "none");
}

/* Extended read-only metadata for one top-level item (Issue #63):
   type, name, id, flags, selection, label, duration/current time,
   dimensions, pixel aspect, parent folder, comment, and — when the
   Item View suite is available — the MRU view's read-only getters.
   Every call is op-recorded; per-call failures are logged and
   skipped, never aborting the walk. */
static void ProbeNamedItem(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
    const AEGP_ItemViewSuite2* itemViewP, /* NULL when suite unavailable */
    const AEGP_CompSuite13* compP,        /* NULL when suite unavailable */
    const AEGP_LayerSuite9* layerP,       /* NULL when suite unavailable */
    AEGP_PluginID plugin_id,
    AEGP_ItemH itemH,
    long item_indexL)
{
    char idx[32];
    A_Err err;
    AEGP_ItemType type = AEGP_ItemType_NONE;
    snprintf(idx, sizeof(idx), " i=%ld", item_indexL);
    idx[sizeof(idx) - 1] = '\0';

    err = itemP->AEGP_GetItemType(itemH, &type);
    {
        char extra[48];
        if (err == A_Err_NONE)
        {
            snprintf(extra, sizeof(extra), " i=%ld value=%d", item_indexL, (int)type);
        }
        else
        {
            snprintf(extra, sizeof(extra), "%s", idx);
        }
        extra[sizeof(extra) - 1] = '\0';
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemType", (long)err, extra);
    }
    if (err == A_Err_NONE)
    {
        LogFormatted(utilP, "project.items[%ld].type=%d", item_indexL, (int)type);
        if (item_indexL == 0)
        {
            LogFormatted(utilP, "project.items.firstType=%d", (int)type);
        }

        /* Type name is only meaningful for a successfully queried
           type; AEGP_ItemType_NONE is not a valid GetTypeName input. */
        {
            char type_nameZ[AEGP_MAX_TYPE_NAME_SIZE + 1];
            memset(type_nameZ, 0, sizeof(type_nameZ));
            err = itemP->AEGP_GetTypeName(type, type_nameZ);
            OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetTypeName", (long)err, idx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP, "project.items[%ld].typeName=%s", item_indexL, type_nameZ);
            }
        }
    }

    {
        AEGP_MemHandle nameH = NULL;
        A_Err nerr = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemName", (long)nerr, NULL);
        if (nerr == A_Err_NONE)
        {
            char label[64];
            snprintf(label, sizeof(label), "project.items[%ld].name", item_indexL);
            label[sizeof(label) - 1] = '\0';
            LogMemHandleUtf16(utilP, memP, label, nameH);
        }
    }

    {
        A_long item_idL = 0;
        err = itemP->AEGP_GetItemID(itemH, &item_idL);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemID", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].id=%ld", item_indexL, (long)item_idL);
        }
    }
    {
        AEGP_ItemFlags flags = 0;
        err = itemP->AEGP_GetItemFlags(itemH, &flags);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemFlags", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].flags=%ld", item_indexL, (long)flags);
        }
    }
    {
        A_Boolean selectedB = FALSE;
        err = itemP->AEGP_IsItemSelected(itemH, &selectedB);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_IsItemSelected", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].selected=%d", item_indexL, (int)selectedB);
        }
    }
    {
        AEGP_LabelID label = AEGP_Label_NO_LABEL;
        err = itemP->AEGP_GetItemLabel(itemH, &label);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemLabel", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].label=%d", item_indexL, (int)label);
        }
    }
    {
        A_Time duration = {0, 0};
        err = itemP->AEGP_GetItemDuration(itemH, &duration);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemDuration", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].duration=%ld/%lu",
                         item_indexL, (long)duration.value, (unsigned long)duration.scale);
        }
    }
    {
        A_Time current = {0, 0};
        err = itemP->AEGP_GetItemCurrentTime(itemH, &current);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].currentTime=%ld/%lu",
                         item_indexL, (long)current.value, (unsigned long)current.scale);
        }
    }
    {
        A_long widthL = 0, heightL = 0;
        err = itemP->AEGP_GetItemDimensions(itemH, &widthL, &heightL);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemDimensions", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].dimensions=%ldx%ld",
                         item_indexL, (long)widthL, (long)heightL);
        }
    }
    {
        A_Ratio par = {0, 0};
        err = itemP->AEGP_GetItemPixelAspectRatio(itemH, &par);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].pixelAspect=%ld/%lu",
                         item_indexL, (long)par.num, (unsigned long)par.den);
        }
    }
    {
        AEGP_ItemH parentH = NULL;
        err = itemP->AEGP_GetItemParentFolder(itemH, &parentH);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemParentFolder", (long)err, idx);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].parentFolder=%s",
                         item_indexL, parentH ? "present" : "none");
        }
    }
    {
        AEGP_MemHandle commentH = NULL;
        err = itemP->AEGP_GetItemComment(itemH, &commentH);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemComment", (long)err, idx);
        if (err == A_Err_NONE)
        {
            char label[64];
            snprintf(label, sizeof(label), "project.items[%ld].comment", item_indexL);
            label[sizeof(label) - 1] = '\0';
            LogMemHandleUtf16(utilP, memP, label, commentH); /* consumes handle */
        }
    }

    /* MRU view slice: only when the Item View suite was acquired and
       its entries validated. A NULL view is a normal state (item has
       no open viewer), not an error. */
    if (itemViewP != NULL)
    {
        AEGP_ItemViewP viewP = NULL;
        err = itemP->AEGP_GetItemMRUView(itemH, &viewP);
        {
            char extra[48];
            if (err == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), "%s hasView=%d", idx, viewP ? 1 : 0);
            }
            else
            {
                snprintf(extra, sizeof(extra), "%s", idx);
            }
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemMRUView", (long)err, extra);
        }
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project.items[%ld].mruView=%d",
                         item_indexL, viewP ? 1 : 0);
            if (viewP)
            {
                ProbeItemViewDetails(utilP, itemViewP, viewP, item_indexL);
            }
        }
    }

    /* Comp slice (Issue #64): only for items whose type query
       succeeded as COMP and only when the comp suite is usable. */
    if (compP != NULL && type == AEGP_ItemType_COMP)
    {
        ProbeCompDetails(utilP, compP, layerP, memP, plugin_id, itemH, item_indexL);
    }
}

/* Walk the top-level project item list read-only: count items, log the
   type and (up to MAX_ITEM_NAMES) names plus extended metadata of
   the first items. */
static void ProbeProjectItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
    const AEGP_ItemViewSuite2* itemViewP, /* NULL when suite unavailable */
    const AEGP_CompSuite13* compP,        /* NULL when suite unavailable */
    const AEGP_LayerSuite9* layerP,       /* NULL when suite unavailable */
    AEGP_PluginID plugin_id,
    AEGP_ProjectH projectH)
{
    A_Err err;
    AEGP_ItemH itemH = NULL;
    A_long count = 0;
    A_long named = 0;

    err = itemP->AEGP_GetFirstProjItem(projectH, &itemH);
    OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetFirstProjItem", (long)err, NULL);
    if (err != A_Err_NONE)
    {
        LogFormatted(utilP, "AEGP_GetFirstProjItem err=%ld", (long)err);
        return;
    }

    while (itemH && count < MAX_ITEMS_SCANNED)
    {
        if (named < MAX_ITEM_NAMES)
        {
            ProbeNamedItem(utilP, itemP, memP, itemViewP, compP, layerP, plugin_id, itemH, named);
            named++;
        }
        count++;

        {
            AEGP_ItemH nextH = NULL;
            A_Err gerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
            OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)gerr, NULL);
            if (gerr != A_Err_NONE)
            {
                break;
            }
            itemH = nextH;
        }
    }
    LogFormatted(utilP, "project.items.count=%ld%s", count,
                 (count >= MAX_ITEMS_SCANNED) ? " (capped)" : "");
}

/* Active-item query, once per probe run (app-level, not per-project).
   A NULL item is a normal state. When present, its name is resolved
   through the same bounded mem-handle plumbing as item names. */
static void ProbeActiveItem(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
    AEGP_PluginID plugin_id)
{
    AEGP_ItemH itemH = NULL;
    A_Err err = itemP->AEGP_GetActiveItem(&itemH);
    OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetActiveItem", (long)err,
              err == A_Err_NONE ? (itemH ? " hasItem=1" : " hasItem=0") : NULL);
    if (err != A_Err_NONE)
    {
        LogFormatted(utilP, "AEGP_GetActiveItem err=%ld", (long)err);
        return;
    }
    if (!itemH)
    {
        LogFormatted(utilP, "app.activeItem=none");
        return;
    }
    LogFormatted(utilP, "app.activeItem=present");
    {
        AEGP_MemHandle nameH = NULL;
        A_Err nerr = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
        OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemName", (long)nerr, NULL);
        if (nerr == A_Err_NONE)
        {
            LogMemHandleUtf16(utilP, memP, "app.activeItem.name", nameH);
        }
    }
}

/* Per-project read-only queries. num_projectsL comes from the caller's
   single AEGP_GetNumProjects call so the count and the iteration agree. */
static void ProbeProject(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
    const AEGP_ItemViewSuite2* itemViewP, /* NULL when suite unavailable */
    const AEGP_CompSuite13* compP,        /* NULL when suite unavailable */
    const AEGP_LayerSuite9* layerP,       /* NULL when suite unavailable */
    AEGP_PluginID plugin_id,
    A_long num_projectsL)
{
    A_long i;

    LogFormatted(utilP, "app.numProjects=%ld", num_projectsL);

    for (i = 0; i < num_projectsL && i < MAX_PROJECTS_SCANNED; i++)
    {
        AEGP_ProjectH projectH = NULL;
        char nameZ[AEGP_MAX_PROJ_NAME_SIZE + 1];
        A_Boolean dirtyB = FALSE;
        AEGP_ProjBitDepth bit_depth = 0;
        A_Err err;

        err = projP->AEGP_GetProjectByIndex(i, &projectH);
        {
            char extra[32];
            snprintf(extra, sizeof(extra), " i=%ld", (long)i);
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex", (long)err, extra);
        }
        if (err != A_Err_NONE || !projectH)
        {
            LogFormatted(utilP, "AEGP_GetProjectByIndex(%ld) failed", i);
            continue;
        }

        memset(nameZ, 0, sizeof(nameZ));
        err = projP->AEGP_GetProjectName(projectH, nameZ);
        OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectName", (long)err, NULL);
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project[%ld].name=%s", i, nameZ);
        }

        err = projP->AEGP_ProjectIsDirty(projectH, &dirtyB);
        {
            char extra[32];
            if (err == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " value=%d", (int)dirtyB);
            }
            else
            {
                extra[0] = '\0';
            }
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_ProjectIsDirty", (long)err,
                      err == A_Err_NONE ? extra : NULL);
        }
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project[%ld].isDirty=%d", i, (int)dirtyB);
        }

        err = projP->AEGP_GetProjectBitDepth(projectH, &bit_depth);
        {
            char extra[32];
            if (err == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " value=%d", (int)bit_depth);
            }
            else
            {
                extra[0] = '\0';
            }
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", (long)err,
                      err == A_Err_NONE ? extra : NULL);
        }
        if (err == A_Err_NONE)
        {
            LogFormatted(utilP, "project[%ld].bitDepth=%d", i, (int)bit_depth);
        }

        /* Project time display: read-only snapshot of the project's
           timecode/frames display settings (Issue #63). */
        {
            AEGP_TimeDisplay3 time_display;
            memset(&time_display, 0, sizeof(time_display));
            err = projP->AEGP_GetProjectTimeDisplay(projectH, &time_display);
            OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay", (long)err, NULL);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP,
                             "project[%ld].timeDisplay displayMode=%d footageMode=%d "
                             "dropFrame=%d feetFrames=%d timebase=%d framesPerFoot=%d framesMode=%d",
                             i, (int)time_display.display_mode,
                             (int)time_display.footage_display_mode,
                             (int)time_display.display_dropframeB,
                             (int)time_display.use_feet_framesB,
                             (int)time_display.timebaseC,
                             (int)time_display.frames_per_footC,
                             (int)time_display.frames_display_mode);
            }
        }

        /* Project path: empty string for untitled projects; disposed
           through the shared mem-handle plumbing. */
        {
            AEGP_MemHandle pathH = NULL;
            char label[64];
            err = projP->AEGP_GetProjectPath(projectH, &pathH);
            OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetProjectPath", (long)err, NULL);
            snprintf(label, sizeof(label), "project[%ld].path", (long)i);
            label[sizeof(label) - 1] = '\0';
            if (err == A_Err_NONE)
            {
                LogMemHandleUtf16(utilP, memP, label, pathH);
            }
            else
            {
                LogFormatted(utilP, "AEGP_GetProjectPath(%ld) err=%ld", (long)i, (long)err);
            }
        }

        ProbeRootFolderName(utilP, projP, itemP, memP, plugin_id, projectH);
        ProbeProjectItems(utilP, itemP, memP, itemViewP, compP, layerP, plugin_id, projectH);
    }
}

/* ---- suite acquisition / release ---------------------------------- */

static A_Err AcquireSuite(
    struct SPBasicSuite* basicP,
    const AEGP_UtilitySuite6* utilP,
    const char* nameZ,
    int versionL,
    const void** suitePP)
{
    SPErr src;
    char extra[192];

    if (!basicP || !suitePP)
    {
        return A_Err_STRUCT;
    }
    *suitePP = NULL;
    src = basicP->AcquireSuite(nameZ, versionL, suitePP);
    snprintf(extra, sizeof(extra), " suite=\"%s\" version=%d", nameZ, (int)versionL);
    extra[sizeof(extra) - 1] = '\0';
    OpRecordV(utilP, "SPBasicSuite.AcquireSuite", (long)src, extra);
    if (src != 0 || !*suitePP)
    {
        *suitePP = NULL;
        return A_Err_STRUCT;
    }
    return A_Err_NONE;
}

static void ReleaseSuiteSafe(
    struct SPBasicSuite* basicP,
    const AEGP_UtilitySuite6* utilP,
    const char* nameZ,
    int versionL)
{
    SPErr src;
    char extra[192];

    if (basicP && basicP->ReleaseSuite)
    {
        snprintf(extra, sizeof(extra), " suite=\"%s\" version=%d", nameZ, (int)versionL);
        extra[sizeof(extra) - 1] = '\0';
        src = basicP->ReleaseSuite(nameZ, versionL);
        OpRecordV(utilP, "SPBasicSuite.ReleaseSuite", (long)src, extra);
    }
}

/* ---- suite-entry validation ---------------------------------------
   Every function-table entry actually dereferenced below is checked
   before use. A missing entry is an infrastructure failure (fail
   closed), never a silent skip. */

static A_Boolean UtilityProbeEntriesOk(const AEGP_UtilitySuite6* u)
{
    return u && u->AEGP_WriteToDebugLog &&
           u->AEGP_GetDriverPluginInitFuncVersion &&
           u->AEGP_GetDriverImplementationVersion &&
           u->AEGP_GetSuppressInteractiveUI && u->AEGP_HostIsActivated;
}

static A_Boolean ProjEntriesOk(const AEGP_ProjSuite6* p)
{
    return p && p->AEGP_GetNumProjects && p->AEGP_GetProjectByIndex &&
           p->AEGP_GetProjectName && p->AEGP_GetProjectPath &&
           p->AEGP_ProjectIsDirty && p->AEGP_GetProjectBitDepth &&
           p->AEGP_GetProjectRootFolder && p->AEGP_GetProjectTimeDisplay;
}

static A_Boolean ItemEntriesOk(const AEGP_ItemSuite9* i)
{
    return i && i->AEGP_GetFirstProjItem && i->AEGP_GetNextProjItem &&
           i->AEGP_GetItemType && i->AEGP_GetItemName &&
           i->AEGP_GetActiveItem && i->AEGP_IsItemSelected &&
           i->AEGP_GetTypeName && i->AEGP_GetItemID &&
           i->AEGP_GetItemFlags && i->AEGP_GetItemParentFolder &&
           i->AEGP_GetItemDuration && i->AEGP_GetItemCurrentTime &&
           i->AEGP_GetItemDimensions && i->AEGP_GetItemPixelAspectRatio &&
           i->AEGP_GetItemComment && i->AEGP_GetItemLabel &&
           i->AEGP_GetItemMRUView;
}

static A_Boolean MemoryEntriesOk(const AEGP_MemorySuite1* m)
{
    return m && m->AEGP_GetMemHandleSize && m->AEGP_LockMemHandle &&
           m->AEGP_UnlockMemHandle && m->AEGP_FreeMemHandle;
}

/* Render-queue slice (Issue #64): only the entries the probe actually
   calls are required; missing entries degrade to "suite unavailable"
   for this section, not a whole-run abort. */
static A_Boolean RQEntriesOk(const AEGP_RenderQueueSuite1* r)
{
    return r && r->AEGP_GetRenderQueueState;
}

static A_Boolean RQItemEntriesOk(const AEGP_RQItemSuite4* r)
{
    return r && r->AEGP_GetNumRQItems && r->AEGP_GetRQItemByIndex &&
           r->AEGP_GetRenderState && r->AEGP_GetStartedTime &&
           r->AEGP_GetElapsedTime && r->AEGP_GetLogType &&
           r->AEGP_GetNumOutputModulesForRQItem && r->AEGP_GetComment &&
           r->AEGP_GetCompFromRQItem;
}

/* Item-view slice (Issue #63): only the read-only getters the probe
   calls are required; like the render-queue slice this is auxiliary
   evidence — a missing entry degrades the section, not the run. */
static A_Boolean ItemViewEntriesOk(const AEGP_ItemViewSuite2* v)
{
    return v && v->AEGP_GetItemViewPlaybackTime &&
           v->AEGP_GetItemViewGuidesVisible && v->AEGP_GetItemViewGuidesSnap &&
           v->AEGP_GetItemViewGuidesLocked;
}

/* Comp slice (Issue #64): only the read-only entries the probe calls
   are required; like the render-queue and item-view slices this is
   auxiliary evidence — a missing entry degrades the section, not
   the run. */
static A_Boolean CompEntriesOk(const AEGP_CompSuite13* c)
{
    return c && c->AEGP_GetCompFromItem && c->AEGP_GetItemFromComp &&
           c->AEGP_GetCompDownsampleFactor && c->AEGP_GetCompBGColor &&
           c->AEGP_GetCompFlags && c->AEGP_GetShowLayerNameOrSourceName &&
           c->AEGP_GetShowBlendModes && c->AEGP_GetCompFramerate &&
           c->AEGP_GetCompShutterAnglePhase && c->AEGP_GetCompShutterFrameRange &&
           c->AEGP_GetCompSuggestedMotionBlurSamples &&
           c->AEGP_GetCompMotionBlurAdaptiveSampleLimit &&
           c->AEGP_GetCompWorkAreaStart && c->AEGP_GetCompWorkAreaDuration &&
           c->AEGP_GetCompDisplayStartTime && c->AEGP_GetCompFrameDuration &&
           c->AEGP_GetMostRecentlyUsedComp && c->AEGP_GetCompDisplayDropFrame;
}

/* Layer slice (Issue #64): only the read-only entries the probe calls
   are required; like the comp slice this is auxiliary evidence — a
   missing entry degrades the section, not the run. */
static A_Boolean LayerEntriesOk(const AEGP_LayerSuite9* l)
{
    return l && l->AEGP_GetCompNumLayers && l->AEGP_GetCompLayerByIndex &&
           l->AEGP_GetLayerIndex && l->AEGP_GetLayerName &&
           l->AEGP_GetLayerFlags && l->AEGP_GetLayerQuality &&
           l->AEGP_GetLayerObjectType && l->AEGP_IsLayer3D &&
           l->AEGP_IsLayer2D && l->AEGP_GetLayerCurrentTime &&
           l->AEGP_GetLayerInPoint && l->AEGP_GetLayerDuration &&
           l->AEGP_GetLayerID && l->AEGP_GetLayerLabel &&
           l->AEGP_GetLayerSamplingQuality && l->AEGP_GetLayerSourceItemID &&
           l->AEGP_GetLayerParentComp && l->AEGP_IsLayerVideoReallyOn &&
           l->AEGP_IsLayerAudioReallyOn && l->AEGP_DoesLayerHaveTrackMatte &&
           l->AEGP_IsLayerUsedAsTrackMatte && l->AEGP_GetTrackMatteLayer;
}

/* Read-only render-queue observation. Every call is op-recorded; the
   only handle we dereference is the comment mem handle (freed via
   the memory suite). RQItemRefH values are opaque — we never store
   them past this call. */
static void ProbeRenderQueue(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_RenderQueueSuite1* rqP,
    const AEGP_RQItemSuite4* rqItemP,
    const AEGP_MemorySuite1* memP)
{
    A_Err err;
    AEGP_RenderQueueState state = AEGP_RenderQueueState_STOPPED;
    A_long num_itemsL = 0;
    A_long i;

    err = rqP->AEGP_GetRenderQueueState(&state);
    OpRecordV(utilP, "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
              (long)err, err == A_Err_NONE ? " value" : NULL);
    if (err == A_Err_NONE)
    {
        LogFormatted(utilP, "renderQueue.state=%ld", (long)state);
    }

    err = rqItemP->AEGP_GetNumRQItems(&num_itemsL);
    OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetNumRQItems", (long)err, NULL);
    if (err == A_Err_NONE)
    {
        LogFormatted(utilP, "renderQueue.numItems=%ld", num_itemsL);
    }
    else
    {
        return;
    }

    for (i = 0; i < num_itemsL && i < MAX_RQ_ITEMS_SCANNED; i++)
    {
        AEGP_RQItemRefH rq_itemH = NULL;
        char idx[32];
        snprintf(idx, sizeof(idx), " i=%ld", (long)i);
        idx[sizeof(idx) - 1] = '\0';

        err = rqItemP->AEGP_GetRQItemByIndex(i, &rq_itemH);
        OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
                  (long)err, idx);
        if (err != A_Err_NONE || !rq_itemH)
        {
            LogFormatted(utilP, "rq[%ld]: get failed", i);
            continue;
        }

        {
            AEGP_RenderItemStatusType status = 0;
            err = rqItemP->AEGP_GetRenderState(rq_itemH, &status);
            OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetRenderState",
                      (long)err, idx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP, "rq[%ld].renderState=%ld", i, (long)status);
            }
        }
        {
            A_Time t = {0, 0};
            err = rqItemP->AEGP_GetStartedTime(rq_itemH, &t);
            OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetStartedTime",
                      (long)err, idx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP, "rq[%ld].started=%ld/%lu", i, t.value,
                             (unsigned long)t.scale);
            }
        }
        {
            A_Time t = {0, 0};
            err = rqItemP->AEGP_GetElapsedTime(rq_itemH, &t);
            OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetElapsedTime",
                      (long)err, idx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP, "rq[%ld].elapsed=%ld/%lu", i, t.value,
                             (unsigned long)t.scale);
            }
        }
        {
            AEGP_LogType logtype = AEGP_LogType_NONE;
            err = rqItemP->AEGP_GetLogType(rq_itemH, &logtype);
            OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetLogType",
                      (long)err, idx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP, "rq[%ld].logType=%ld", i, (long)logtype);
            }
        }
        {
            A_long nout = 0;
            err = rqItemP->AEGP_GetNumOutputModulesForRQItem(rq_itemH, &nout);
            OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
                      (long)err, idx);
            if (err == A_Err_NONE)
            {
                LogFormatted(utilP, "rq[%ld].numOutputModules=%ld", i, nout);
            }
        }
        {
            AEGP_MemHandle commentH = NULL;
            err = rqItemP->AEGP_GetComment(rq_itemH, &commentH);
            OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetComment",
                      (long)err, idx);
            if (err == A_Err_NONE && commentH)
            {
                char label[64];
                snprintf(label, sizeof(label), "rq[%ld].comment", (long)i);
                label[sizeof(label) - 1] = '\0';
                LogMemHandleUtf16(utilP, memP, label, commentH); /* consumes handle */
            }
        }
        {
            AEGP_CompH compH = NULL;
            err = rqItemP->AEGP_GetCompFromRQItem(rq_itemH, &compH);
            {
                char extra[48];
                snprintf(extra, sizeof(extra), "%s hasComp=%d", idx,
                         compH != NULL ? 1 : 0);
                extra[sizeof(extra) - 1] = '\0';
                OpRecordV(utilP, "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
                          (long)err, err == A_Err_NONE ? extra : idx);
            }
        }
    }
}

/* ---- idle hook: the host-guaranteed query context -----------------
   Dispatched by AE on the main thread while the application is idle.
   This is the same class of context in which the SDK AEGP samples run
   their hooks (ProjDumper's CommandHook, Commando's IdleHook), and
   the only context in which this plug-in issues project queries.
   A_Err_WRONG_THREAD exists in A.h precisely because AEGP calls have
   thread affinity; we never call them from anywhere else.

   Each dispatch: acquire the fingerprint suites (utility/project/
   memory), validate entries, compute the project-set fingerprint,
   and only when it changed — or no valid fingerprint exists —
   acquire the item suite and run the full read-only probe. */

static A_Err ProbeIdleHook(
    AEGP_GlobalRefcon plugin_refconP, /* >> unused */
    AEGP_IdleRefcon refconP,          /* >> unused */
    A_long* max_sleepPL)              /* <> throttle hint (1/60 s units) */
{
    const AEGP_UtilitySuite6* utilP = NULL;
    const AEGP_ProjSuite6* projP = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    const AEGP_RenderQueueSuite1* rqP = NULL;
    const AEGP_RQItemSuite4* rqItemP = NULL;
    const AEGP_ItemViewSuite2* itemViewP = NULL;
    const AEGP_ItemViewSuite2* usableItemViewP = NULL;
    const AEGP_CompSuite13* compP = NULL;
    const AEGP_CompSuite13* usableCompP = NULL;
    const AEGP_LayerSuite9* layerP = NULL;
    const AEGP_LayerSuite9* usableLayerP = NULL;
    A_Err first_err = A_Err_NONE;
    A_long num_projectsL = 0;
    const char* reasonZ = NULL;
    char fp[FP_BUF_SIZE];

    (void)plugin_refconP;
    (void)refconP;

    /* Steady-state load control: the fingerprint queries below are the
       plug-in's only recurring SDK traffic, and the host may dispatch
       the idle hook every idle tick. Ask for at most one dispatch per
       second (units are 1/60 s per the AEGP_IdleHook contract). A host
       that ignores the hint keeps the old frequency — still correct,
       just more queries; the hint can never change probe semantics. */
    if (max_sleepPL)
    {
        *max_sleepPL = 60;
    }

    if (!s_basicP)
    {
        return A_Err_STRUCT;
    }

    /* This tick's op records accumulate in the buffer; only a probe
       run flushes them to the debug log. */
    ClearOpBuffer();
    s_op_mode = OP_MODE_BUFFER;

    /* Stage 1: acquire only the suites the fingerprint needs
       (utility for the log sink, project for the queries, memory for
       the path mem handle). The item suite is deferred to the probe
       branch so steady-state ticks do not churn it. Any failure aborts
       the tick (fail closed). */
    if (AcquireSuite(s_basicP, utilP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6,
                     (const void**)&utilP) != A_Err_NONE ||
        AcquireSuite(s_basicP, utilP, kAEGPProjSuite, kAEGPProjSuiteVersion6,
                     (const void**)&projP) != A_Err_NONE ||
        AcquireSuite(s_basicP, utilP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1,
                     (const void**)&memP) != A_Err_NONE)
    {
        first_err = A_Err_STRUCT;
        goto done;
    }

    if (!UtilityProbeEntriesOk(utilP) || !ProjEntriesOk(projP) ||
        !MemoryEntriesOk(memP))
    {
        /* Persistent entry-missing is an infrastructure failure:
           log once per streak, not every idle tick. */
        if (!s_abort_loggedB)
        {
            s_abort_loggedB = TRUE;
            LogLine(utilP, "probe.aborted: required suite entry missing");
        }
        first_err = A_Err_STRUCT;
        goto done;
    }
    s_abort_loggedB = FALSE;

    /* Native intake (Issue #267 Slice A): opt-in via
       AE_DEVTOOLS_NATIVE_CHANNEL, off by default. Runs inside the same
       host-dispatched context with the fingerprint suites already
       held; it never disturbs the probe trigger state. */
    NativeIntakeTick(utilP, projP, s_basicP, s_aegp_plugin_id);

    /* Stage 2: project-set fingerprint. A failed count query or a
       failed fingerprint component invalidates the stored fingerprint
       so the next successful tick re-probes (recovery); it does not
       itself trigger a probe — the host is already erroring and the
       probe would hit the same failures. */
    {
        A_Err err = projP->AEGP_GetNumProjects(&num_projectsL);
        char extra[48];
        if (err == A_Err_NONE)
        {
            snprintf(extra, sizeof(extra), " value=%ld", (long)num_projectsL);
        }
        else
        {
            extra[0] = '\0';
        }
        extra[sizeof(extra) - 1] = '\0';
        OpRecordV(utilP, "AEGP_ProjSuite6.AEGP_GetNumProjects", (long)err,
                  err == A_Err_NONE ? extra : NULL);

        if (err != A_Err_NONE)
        {
            s_fp_state = FP_INVALID;
            if (!s_count_err_loggedB)
            {
                s_count_err_loggedB = TRUE;
                LogLine(utilP, "probe.error: AEGP_GetNumProjects failed");
            }
            goto done;
        }
    }
    s_count_err_loggedB = FALSE;

    if (!ComputeProjectFingerprint(utilP, projP, memP, num_projectsL,
                                   fp, sizeof(fp)))
    {
        s_fp_state = FP_INVALID;
        if (!s_fp_err_loggedB)
        {
            s_fp_err_loggedB = TRUE;
            LogLine(utilP, "probe.error: project fingerprint failed");
        }
        goto done;
    }
    s_fp_err_loggedB = FALSE;

    /* Stage 3: probe only on identity change, first observation, or
       recovery from a failure window. */
    if (s_fp_state == FP_NEVER)
    {
        reasonZ = "initial";
    }
    else if (s_fp_state == FP_INVALID)
    {
        reasonZ = "recovery";
    }
    else if (strcmp(fp, s_last_fp) != 0)
    {
        reasonZ = "identity-change";
    }

    if (reasonZ != NULL)
    {
        /* Acquire the item suite only now — its acquire/release become
           part of this run's recorded evidence. */
        if (AcquireSuite(s_basicP, utilP, kAEGPItemSuite, kAEGPItemSuiteVersion9,
                         (const void**)&itemP) != A_Err_NONE)
        {
            LogLine(utilP, "probe.error: AEGP Item Suite acquire failed");
            first_err = A_Err_STRUCT;
            goto done;
        }
        if (!ItemEntriesOk(itemP))
        {
            if (!s_abort_loggedB)
            {
                s_abort_loggedB = TRUE;
                LogLine(utilP, "probe.aborted: required suite entry missing");
            }
            first_err = A_Err_STRUCT;
            goto done;
        }

        s_fp_state = FP_VALID;
        strncpy(s_last_fp, fp, sizeof(s_last_fp) - 1);
        s_last_fp[sizeof(s_last_fp) - 1] = '\0';

        s_op_mode = OP_MODE_DIRECT;

        LogLine(utilP, "probe.start");
        LogFormatted(utilP, "probe.reason=%s", reasonZ);
        /* Flush this tick's trigger-phase calls (suite acquires,
           AEGP_GetNumProjects, fingerprint queries) into the run. */
        FlushOpBuffer(utilP);

        {
            A_short maj = 0, min = 0;
            A_Boolean ui_suppressedB = FALSE;
            A_Boolean activatedB = FALSE;
            A_Err qerr;
            char extra[48];

            qerr = utilP->AEGP_GetDriverPluginInitFuncVersion(&maj, &min);
            if (qerr == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " v=%d.%d", (int)maj, (int)min);
            }
            else
            {
                extra[0] = '\0';
            }
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
                      (long)qerr, qerr == A_Err_NONE ? extra : NULL);
            if (qerr == A_Err_NONE)
            {
                LogFormatted(utilP, "driver.pluginInitVersion=%d.%d", (int)maj, (int)min);
            }

            qerr = utilP->AEGP_GetDriverImplementationVersion(&maj, &min);
            if (qerr == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " v=%d.%d", (int)maj, (int)min);
            }
            else
            {
                extra[0] = '\0';
            }
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
                      (long)qerr, qerr == A_Err_NONE ? extra : NULL);
            if (qerr == A_Err_NONE)
            {
                LogFormatted(utilP, "driver.implementationVersion=%d.%d", (int)maj, (int)min);
            }

            qerr = utilP->AEGP_GetSuppressInteractiveUI(&ui_suppressedB);
            {
                char extra[32];
                if (qerr == A_Err_NONE)
                {
                    snprintf(extra, sizeof(extra), " value=%d", (int)ui_suppressedB);
                }
                else
                {
                    extra[0] = '\0';
                }
                extra[sizeof(extra) - 1] = '\0';
                OpRecordV(utilP, "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
                          (long)qerr, qerr == A_Err_NONE ? extra : NULL);
            }
            if (qerr == A_Err_NONE)
            {
                LogFormatted(utilP, "host.suppressInteractiveUI=%d", (int)ui_suppressedB);
            }

            qerr = utilP->AEGP_HostIsActivated(&activatedB);
            {
                char extra[32];
                if (qerr == A_Err_NONE)
                {
                    snprintf(extra, sizeof(extra), " value=%d", (int)activatedB);
                }
                else
                {
                    extra[0] = '\0';
                }
                extra[sizeof(extra) - 1] = '\0';
                OpRecordV(utilP, "AEGP_UtilitySuite6.AEGP_HostIsActivated",
                          (long)qerr, qerr == A_Err_NONE ? extra : NULL);
            }
            if (qerr == A_Err_NONE)
            {
                LogFormatted(utilP, "host.isActivated=%d", (int)activatedB);
            }
        }

        /* Render-queue slice (Issue #64): read-only getters only.
           Acquisition failure is NON-fatal — the queue is auxiliary
           evidence, not core project/item data; log and continue. */
        if (AcquireSuite(s_basicP, utilP, kAEGPRenderQueueSuite,
                         kAEGPRenderQueueSuiteVersion1,
                         (const void**)&rqP) == A_Err_NONE &&
            AcquireSuite(s_basicP, utilP, kAEGPRQItemSuite,
                         kAEGPRQItemSuiteVersion4,
                         (const void**)&rqItemP) == A_Err_NONE &&
            RQEntriesOk(rqP) && RQItemEntriesOk(rqItemP))
        {
            ProbeRenderQueue(utilP, rqP, rqItemP, memP);
        }
        else
        {
            LogLine(utilP, "probe.error: AEGP Render Queue suite unavailable");
        }

        /* Item-view slice (Issue #63): auxiliary viewer-state getters.
           Acquisition/entry failure is NON-fatal like the render-queue
           slice — the acquired table is still released in done:. */
        if (AcquireSuite(s_basicP, utilP, kAEGPItemViewSuite,
                         kAEGPItemViewSuiteVersion2,
                         (const void**)&itemViewP) == A_Err_NONE &&
            ItemViewEntriesOk(itemViewP))
        {
            usableItemViewP = itemViewP;
        }
        else
        {
            LogLine(utilP, "probe.error: AEGP Item View suite unavailable");
        }

        /* Comp slice (Issue #64): auxiliary read-only comp getters.
           Acquisition/entry failure is NON-fatal like the item-view
           slice — the acquired table is still released in done:. */
        if (AcquireSuite(s_basicP, utilP, kAEGPCompSuite,
                         kAEGPCompSuiteVersion13,
                         (const void**)&compP) == A_Err_NONE &&
            CompEntriesOk(compP))
        {
            usableCompP = compP;
        }
        else
        {
            LogLine(utilP, "probe.error: AEGP Comp suite unavailable");
        }

        /* Layer slice (Issue #64): auxiliary read-only layer getters
           inside comps. Same non-fatal degradation model as comp. */
        if (AcquireSuite(s_basicP, utilP, kAEGPLayerSuite,
                         kAEGPLayerSuiteVersion9,
                         (const void**)&layerP) == A_Err_NONE &&
            LayerEntriesOk(layerP))
        {
            usableLayerP = layerP;
        }
        else
        {
            LogLine(utilP, "probe.error: AEGP Layer suite unavailable");
        }

        ProbeActiveItem(utilP, itemP, memP, s_aegp_plugin_id);
        if (usableCompP)
        {
            ProbeMostRecentComp(utilP, usableCompP);
        }

        /* num_projectsL == 0 is a NORMAL host state (no project open),
           not an error: ProbeProject logs app.numProjects=0 and skips
           per-project queries. */
        ProbeProject(utilP, projP, itemP, memP, usableItemViewP,
                     usableCompP, usableLayerP, s_aegp_plugin_id, num_projectsL);

        LogLine(utilP, "probe.end");
    }
    /* Unchanged fingerprint: stay silent — the idle hook fires
       repeatedly and must not spam the debug log. */

done:
    /* Suite releases are op-recorded too: on probe ticks the mode is
       still DIRECT so they land inside this execution's evidence;
       on quiet ticks they stay buffered and are discarded. */
    if (layerP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    }
    if (compP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
    }
    if (itemViewP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPItemViewSuite, kAEGPItemViewSuiteVersion2);
    }
    if (rqItemP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    }
    if (rqP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPRenderQueueSuite, kAEGPRenderQueueSuiteVersion1);
    }
    if (itemP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    }
    if (memP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    }
    if (projP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    }
    if (utilP)
    {
        ReleaseSuiteSafe(s_basicP, utilP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    }

    return first_err;
}

/* Entry point exported through the PiPL resource's CodeMac* entries.
   Signature: AEGP_PluginInitFuncPrototype (AE_GeneralPlug.h).
   extern "C" is required: the PiPL entry-point name resolves against
   the unmangled symbol table. */
extern "C" __attribute__((visibility("default"))) A_Err AEProbePluginEntry(
    struct SPBasicSuite* pica_basicP, /* >> host callback suite table */
    A_long driver_major_versionL,     /* >> AE plug-in API major */
    A_long driver_minor_versionL,     /* >> AE plug-in API minor */
    AEGP_PluginID aegp_plugin_id,     /* >> host-assigned plugin id */
    AEGP_GlobalRefcon* global_refconP) /* << unused: no hooks need it */
{
    const AEGP_UtilitySuite6* utilP = NULL;
    const AEGP_RegisterSuite5* regP = NULL;
    A_Err first_err = A_Err_NONE;

    (void)driver_major_versionL;
    (void)driver_minor_versionL;
    (void)global_refconP;

    if (!pica_basicP)
    {
        return A_Err_STRUCT;
    }

    s_basicP = pica_basicP;
    s_hook_plugin_id = aegp_plugin_id;
    s_aegp_plugin_id = aegp_plugin_id;
    s_fp_state = FP_NEVER;
    s_last_fp[0] = '\0';
    s_count_err_loggedB = FALSE;
    s_fp_err_loggedB = FALSE;
    s_abort_loggedB = FALSE;

    /* Native intake channel (Issue #267): enabled only when the operator
       exports AE_DEVTOOLS_NATIVE_CHANNEL pointing at a prepared channel
       root; absent/empty disables intake entirely. */
    NativeIntakeConfigure(getenv("AE_DEVTOOLS_NATIVE_CHANNEL"));

    /* Entry-phase op records are buffered and flushed once at the end
       so a failed utility-suite acquisition (no log sink yet) simply
       produces no records — plug-in load failure is itself the
       observable outcome. */
    ClearOpBuffer();
    s_op_mode = OP_MODE_BUFFER;

    /* Registration-safe work ONLY. Suite-acquisition failure aborts
       plug-in init (fail closed): a partially registered plug-in is
       worse than a refused load. No project/item query is legal or
       meaningful here — the host guarantees no particular project
       state at plug-in load time. */
    if (AcquireSuite(pica_basicP, utilP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6,
                     (const void**)&utilP) != A_Err_NONE)
    {
        return A_Err_STRUCT;
    }
    if (AcquireSuite(pica_basicP, utilP, kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5,
                     (const void**)&regP) != A_Err_NONE)
    {
        ReleaseSuiteSafe(pica_basicP, utilP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
        FlushOpBuffer(utilP);
        return A_Err_STRUCT;
    }

    /* Register the plug-in identity for AEGP calls that require one
       (AEGP_GetItemName). This registers name → AEGP_PluginID; it does
       not touch project contents. Fall back to the entry-point id if
       registration is unavailable or fails. */
    if (utilP->AEGP_RegisterWithAEGP)
    {
        AEGP_PluginID registered_id = 0;
        A_Err rerr = utilP->AEGP_RegisterWithAEGP(NULL, PROBE_PLUGIN_NAME, &registered_id);
        {
            char extra[48];
            if (rerr == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " value=%ld", (long)registered_id);
            }
            else
            {
                extra[0] = '\0';
            }
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_UtilitySuite6.AEGP_RegisterWithAEGP", (long)rerr,
                      rerr == A_Err_NONE ? extra : NULL);
        }
        if (rerr == A_Err_NONE && registered_id != 0)
        {
            s_aegp_plugin_id = registered_id;
        }
    }

    /* Register the idle hook — the deferred, host-dispatched context in
       which the read-only project queries will run. If the host cannot
       take the registration, the probe can never execute: fail closed. */
    if (regP->AEGP_RegisterIdleHook)
    {
        A_Err herr = regP->AEGP_RegisterIdleHook(s_hook_plugin_id, ProbeIdleHook, NULL);
        {
            char extra[48];
            snprintf(extra, sizeof(extra), " value=%ld", (long)s_hook_plugin_id);
            extra[sizeof(extra) - 1] = '\0';
            OpRecordV(utilP, "AEGP_RegisterSuite5.AEGP_RegisterIdleHook", (long)herr, extra);
        }
        if (herr != A_Err_NONE)
        {
            first_err = A_Err_STRUCT;
        }
    }
    else
    {
        first_err = A_Err_STRUCT;
    }

    ReleaseSuiteSafe(pica_basicP, utilP, kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5);
    /* Flush while the utility suite (the log sink) is still held; the
       utility ReleaseSuite record stays buffered and is covered by
       idle-run releases instead — the sink cannot record its own
       release. */
    FlushOpBuffer(utilP);
    ReleaseSuiteSafe(pica_basicP, utilP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);

    return first_err;
}
