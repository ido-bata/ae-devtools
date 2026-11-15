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
/*   and registers an AEGP idle hook via AEGP_RegisterIdleHook.    */
/*   It never queries project state at init: no project may be     */
/*   open when the plug-in loads, and "no project open" is a       */
/*   normal host state, not a plug-in error.                       */
/*                                                                 */
/*   ProbeIdleHook is dispatched by the host on the AE main        */
/*   thread — the SDK-sanctioned execution context for AEGP        */
/*   suite calls (the same context in which the SDK samples run    */
/*   their command/update-menu/idle hooks; see ProjDumper and      */
/*   Commando under Examples/AEGP/). All project/item queries      */
/*   run there, once per observed project-count change.            */
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
/* Cap on projects inspected per run (AE normally has <= 1 open). */
#define MAX_PROJECTS_SCANNED 4L

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
/* Last project count observed by the idle hook; -1 = never probed.
   The probe re-runs only when this count changes, so a steady-state
   idle loop does not spam the debug log. */
static A_long s_last_num_projectsL = -1;
/* Log-once guard for a persistent AEGP_GetNumProjects failure so a
   broken host cannot spam the debug log every idle tick. */
static A_Boolean s_count_err_loggedB = FALSE;

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

/* Log the contents of an AEGP mem handle holding a UTF-16 string,
   then release the handle.

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
static void LogMemHandleUtf16(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    const char* labelZ,
    AEGP_MemHandle handleH)
{
    void* ptr = NULL;
    AEGP_MemSize size_bytesL = 0;
    char utf8[1024];

    if (!handleH)
    {
        LogFormatted(utilP, "%s: <null handle>", labelZ);
        return;
    }
    /* The caller validates suite entries up front; these guards are
       defense-in-depth so a partial suite can never cause a wild call. */
    if (!memP->AEGP_GetMemHandleSize || !memP->AEGP_LockMemHandle ||
        !memP->AEGP_UnlockMemHandle || !memP->AEGP_FreeMemHandle)
    {
        LogFormatted(utilP, "%s: memory suite entries missing", labelZ);
        return;
    }

    if (memP->AEGP_GetMemHandleSize(handleH, &size_bytesL) != A_Err_NONE)
    {
        LogFormatted(utilP, "%s: size query failed", labelZ);
        memP->AEGP_FreeMemHandle(handleH);
        return;
    }

    if (memP->AEGP_LockMemHandle(handleH, &ptr) != A_Err_NONE || !ptr)
    {
        LogFormatted(utilP, "%s: lock failed", labelZ);
    }
    else
    {
        AEGP_MemSize unitsL = size_bytesL / sizeof(A_UTF16Char);
        int n = Utf16ToUtf8Bounded((const A_UTF16Char*)ptr, unitsL, utf8, sizeof(utf8));
        memP->AEGP_UnlockMemHandle(handleH);
        if (n < 0)
        {
            LogFormatted(utilP, "%s: <truncated>", labelZ);
        }
        else
        {
            LogFormatted(utilP, "%s: %s", labelZ, utf8);
        }
    }

    /* Frees the handle on every path above that reached this point.
       (The early "size query failed" return frees before returning.) */
    memP->AEGP_FreeMemHandle(handleH);
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
    if (err != A_Err_NONE || !root_itemH)
    {
        LogFormatted(utilP, "AEGP_GetProjectRootFolder err=%ld", (long)err);
        return;
    }

    {
        AEGP_MemHandle nameH = NULL;
        err = itemP->AEGP_GetItemName(plugin_id, root_itemH, &nameH);
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
            itemP->AEGP_GetItemType(itemH, &type);
            LogFormatted(utilP, "project.items.firstType=%d", (int)type);
        }
        if (named < MAX_ITEM_NAMES)
        {
            AEGP_MemHandle nameH = NULL;
            if (itemP->AEGP_GetItemName(plugin_id, itemH, &nameH) == A_Err_NONE)
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
            if (itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH) != A_Err_NONE)
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

        if (projP->AEGP_GetProjectByIndex(i, &projectH) != A_Err_NONE || !projectH)
        {
            LogFormatted(utilP, "AEGP_GetProjectByIndex(%ld) failed", i);
            continue;
        }

        memset(nameZ, 0, sizeof(nameZ));
        if (projP->AEGP_GetProjectName(projectH, nameZ) == A_Err_NONE)
        {
            LogFormatted(utilP, "project[%ld].name=%s", i, nameZ);
        }
        if (projP->AEGP_ProjectIsDirty(projectH, &dirtyB) == A_Err_NONE)
        {
            LogFormatted(utilP, "project[%ld].isDirty=%d", i, (int)dirtyB);
        }
        if (projP->AEGP_GetProjectBitDepth(projectH, &bit_depth) == A_Err_NONE)
        {
            LogFormatted(utilP, "project[%ld].bitDepth=%d", i, (int)bit_depth);
        }

        ProbeRootFolderName(utilP, projP, itemP, memP, plugin_id, projectH);
        ProbeProjectItems(utilP, itemP, memP, plugin_id, projectH);
    }
}

/* ---- suite acquisition / release ---------------------------------- */

static A_Err AcquireSuite(
    struct SPBasicSuite* basicP,
    const char* nameZ,
    int versionL,
    const void** suitePP)
{
    if (!basicP || !suitePP)
    {
        return A_Err_STRUCT;
    }
    *suitePP = NULL;
    if (basicP->AcquireSuite(nameZ, versionL, suitePP) != 0 || !*suitePP)
    {
        *suitePP = NULL;
        return A_Err_STRUCT;
    }
    return A_Err_NONE;
}

static void ReleaseSuiteSafe(
    struct SPBasicSuite* basicP, const char* nameZ, int versionL)
{
    if (basicP && basicP->ReleaseSuite)
    {
        basicP->ReleaseSuite(nameZ, versionL);
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
           p->AEGP_GetProjectName && p->AEGP_ProjectIsDirty &&
           p->AEGP_GetProjectBitDepth && p->AEGP_GetProjectRootFolder;
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

/* ---- idle hook: the host-guaranteed query context -----------------
   Dispatched by AE on the main thread while the application is idle.
   This is the same class of context in which the SDK AEGP samples run
   their hooks (ProjDumper's CommandHook, Commando's IdleHook), and
   the only context in which this plug-in issues project queries.
   A_Err_WRONG_THREAD exists in A.h precisely because AEGP calls have
   thread affinity; we never call them from anywhere else. */

static A_Err ProbeIdleHook(
    AEGP_GlobalRefcon plugin_refconP, /* >> unused */
    AEGP_IdleRefcon refconP,          /* >> unused */
    A_long* max_sleepPL)              /* <> left untouched */
{
    const AEGP_UtilitySuite6* utilP = NULL;
    const AEGP_ProjSuite6* projP = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    A_Err first_err = A_Err_NONE;
    A_long num_projectsL = 0;

    (void)plugin_refconP;
    (void)refconP;
    (void)max_sleepPL;

    if (!s_basicP)
    {
        return A_Err_STRUCT;
    }

    /* Acquire all four suites up front; any failure aborts the probe
       (fail closed). Acquired suites are always released below. */
    if (AcquireSuite(s_basicP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6,
                     (const void**)&utilP) != A_Err_NONE ||
        AcquireSuite(s_basicP, kAEGPProjSuite, kAEGPProjSuiteVersion6,
                     (const void**)&projP) != A_Err_NONE ||
        AcquireSuite(s_basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9,
                     (const void**)&itemP) != A_Err_NONE ||
        AcquireSuite(s_basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1,
                     (const void**)&memP) != A_Err_NONE)
    {
        first_err = A_Err_STRUCT;
        goto done;
    }

    if (!UtilityProbeEntriesOk(utilP) || !ProjEntriesOk(projP) ||
        !ItemEntriesOk(itemP) || !MemoryEntriesOk(memP))
    {
        LogLine(utilP, "probe.aborted: required suite entry missing");
        first_err = A_Err_STRUCT;
        goto done;
    }

    if (projP->AEGP_GetNumProjects(&num_projectsL) != A_Err_NONE)
    {
        /* A failed count query is a query-level error: logged (once),
           and the probe simply does not run this tick. */
        if (!s_count_err_loggedB)
        {
            s_count_err_loggedB = TRUE;
            LogLine(utilP, "probe.error: AEGP_GetNumProjects failed");
        }
    }
    else if (num_projectsL != s_last_num_projectsL)
    {
        s_count_err_loggedB = FALSE;
        A_short maj = 0, min = 0;
        A_Boolean ui_suppressedB = FALSE;
        A_Boolean activatedB = FALSE;

        s_last_num_projectsL = num_projectsL;
        LogLine(utilP, "probe.start");

        if (utilP->AEGP_GetDriverPluginInitFuncVersion(&maj, &min) == A_Err_NONE)
        {
            LogFormatted(utilP, "driver.pluginInitVersion=%d.%d", (int)maj, (int)min);
        }
        if (utilP->AEGP_GetDriverImplementationVersion(&maj, &min) == A_Err_NONE)
        {
            LogFormatted(utilP, "driver.implementationVersion=%d.%d", (int)maj, (int)min);
        }
        if (utilP->AEGP_GetSuppressInteractiveUI(&ui_suppressedB) == A_Err_NONE)
        {
            LogFormatted(utilP, "host.suppressInteractiveUI=%d", (int)ui_suppressedB);
        }
        if (utilP->AEGP_HostIsActivated(&activatedB) == A_Err_NONE)
        {
            LogFormatted(utilP, "host.isActivated=%d", (int)activatedB);
        }

        /* num_projectsL == 0 is a NORMAL host state (no project open),
           not an error: ProbeProject logs app.numProjects=0 and skips
           per-project queries. */
        ProbeProject(utilP, projP, itemP, memP, s_aegp_plugin_id, num_projectsL);

        LogLine(utilP, "probe.end");
    }
    /* Unchanged project count: stay silent — the idle hook fires
       repeatedly and must not spam the debug log. */

done:
    if (memP)
    {
        ReleaseSuiteSafe(s_basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    }
    if (itemP)
    {
        ReleaseSuiteSafe(s_basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    }
    if (projP)
    {
        ReleaseSuiteSafe(s_basicP, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    }
    if (utilP)
    {
        ReleaseSuiteSafe(s_basicP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
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
    s_last_num_projectsL = -1;
    s_count_err_loggedB = FALSE;

    /* Registration-safe work ONLY. Suite-acquisition failure aborts
       plug-in init (fail closed): a partially registered plug-in is
       worse than a refused load. No project/item query is legal or
       meaningful here — the host guarantees no particular project
       state at plug-in load time. */
    if (AcquireSuite(pica_basicP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6,
                     (const void**)&utilP) != A_Err_NONE)
    {
        return A_Err_STRUCT;
    }
    if (AcquireSuite(pica_basicP, kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5,
                     (const void**)&regP) != A_Err_NONE)
    {
        ReleaseSuiteSafe(pica_basicP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
        return A_Err_STRUCT;
    }

    /* Register the plug-in identity for AEGP calls that require one
       (AEGP_GetItemName). This registers name → AEGP_PluginID; it does
       not touch project contents. Fall back to the entry-point id if
       registration is unavailable or fails. */
    if (utilP->AEGP_RegisterWithAEGP)
    {
        AEGP_PluginID registered_id = 0;
        if (utilP->AEGP_RegisterWithAEGP(NULL, PROBE_PLUGIN_NAME, &registered_id) == A_Err_NONE &&
            registered_id != 0)
        {
            s_aegp_plugin_id = registered_id;
        }
    }

    /* Register the idle hook — the deferred, host-dispatched context in
       which the read-only project queries will run. If the host cannot
       take the registration, the probe can never execute: fail closed. */
    if (regP->AEGP_RegisterIdleHook &&
        regP->AEGP_RegisterIdleHook(s_hook_plugin_id, ProbeIdleHook, NULL) == A_Err_NONE)
    {
        /* registered */
    }
    else
    {
        first_err = A_Err_STRUCT;
    }

    ReleaseSuiteSafe(pica_basicP, kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5);
    ReleaseSuiteSafe(pica_basicP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);

    return first_err;
}
