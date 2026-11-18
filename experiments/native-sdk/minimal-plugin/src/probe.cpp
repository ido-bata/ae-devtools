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

#include <stdarg.h>
#include <stdio.h>
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

/* Walk the top-level project item list read-only: count items, log the
   type and (up to MAX_ITEM_NAMES) names of the first items. */
static void ProbeProjectItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
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
        AEGP_ItemType type = AEGP_ItemType_NONE;

        if (named == 0)
        {
            A_Err terr = itemP->AEGP_GetItemType(itemH, &type);
            {
                char extra[32];
                snprintf(extra, sizeof(extra), " value=%d", (int)type);
                extra[sizeof(extra) - 1] = '\0';
                OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemType", (long)terr, extra);
            }
            LogFormatted(utilP, "project.items.firstType=%d", (int)type);
        }
        if (named < MAX_ITEM_NAMES)
        {
            AEGP_MemHandle nameH = NULL;
            A_Err nerr = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
            OpRecordV(utilP, "AEGP_ItemSuite9.AEGP_GetItemName", (long)nerr, NULL);
            if (nerr == A_Err_NONE)
            {
                char label[64];
                snprintf(label, sizeof(label), "project.items[%ld].name", (long)named);
                LogMemHandleUtf16(utilP, memP, label, nameH);
            }
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

/* Per-project read-only queries. num_projectsL comes from the caller's
   single AEGP_GetNumProjects call so the count and the iteration agree. */
static void ProbeProject(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
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
        ProbeProjectItems(utilP, itemP, memP, plugin_id, projectH);
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
           p->AEGP_GetProjectRootFolder;
}

static A_Boolean ItemEntriesOk(const AEGP_ItemSuite9* i)
{
    return i && i->AEGP_GetFirstProjItem && i->AEGP_GetNextProjItem &&
           i->AEGP_GetItemType && i->AEGP_GetItemName;
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

        /* num_projectsL == 0 is a NORMAL host state (no project open),
           not an error: ProbeProject logs app.numProjects=0 and skips
           per-project queries. */
        ProbeProject(utilP, projP, itemP, memP, s_aegp_plugin_id, num_projectsL);

        LogLine(utilP, "probe.end");
    }
    /* Unchanged fingerprint: stay silent — the idle hook fires
       repeatedly and must not spam the debug log. */

done:
    /* Suite releases are op-recorded too: on probe ticks the mode is
       still DIRECT so they land inside this execution's evidence;
       on quiet ticks they stay buffered and are discarded. */
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
