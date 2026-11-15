/*******************************************************************/
/*                                                                 */
/* ae-a8n minimal read-only AEGP probe — Issue #17 (CAP038)        */
/*                                                                 */
/* Original code written for this repository. It is NOT derived    */
/* from Adobe SDK sample sources.                                   */
/*                                                                 */
/* READ-ONLY CONTRACT: every AEGP call below is a query/getter.    */
/* No setter, no undoable call, no command/menu hook, no project   */
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
   stall plug-in load. */
#define MAX_ITEMS_SCANNED 4096L
/* Cap on item names logged per run. */
#define MAX_ITEM_NAMES 8L

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

/* Convert a null-terminated UTF-16 buffer (AEGP mem-handle payloads)
   to UTF-8. Returns the number of bytes written (excluding NUL), or -1
   on truncation. ASCII fast path; BMP + surrogate pairs handled. */
static int Utf16ToUtf8(const A_UTF16Char* srcP, char* dstP, size_t dstSize)
{
    size_t di = 0;
    const A_UTF16Char* p = srcP;

    while (*p && di + 4 < dstSize)
    {
        unsigned int cp = *p++;
        if (cp >= 0xD800 && cp <= 0xDBFF && *p >= 0xDC00 && *p <= 0xDFFF)
        {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (*p++ - 0xDC00);
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
    return (int)di;
}

/* Log the contents of an AEGP mem handle holding a null-terminated
   UTF-16 string, then release the handle. All operations are reads
   plus the mandatory AEGP_FreeMemHandle disposal of AE-allocated
   memory. */
static void LogMemHandleUtf16(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    const char* labelZ,
    AEGP_MemHandle handleH)
{
    void* ptr = NULL;
    char utf8[1024];

    if (!handleH)
    {
        LogFormatted(utilP, "%s: <null handle>", labelZ);
        return;
    }
    if (memP->AEGP_LockMemHandle(handleH, &ptr) != A_Err_NONE || !ptr)
    {
        LogFormatted(utilP, "%s: lock failed", labelZ);
        return;
    }
    Utf16ToUtf8((const A_UTF16Char*)ptr, utf8, sizeof(utf8));
    memP->AEGP_UnlockMemHandle(handleH);
    memP->AEGP_FreeMemHandle(handleH);
    LogFormatted(utilP, "%s: %s", labelZ, utf8);
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

static A_Err ProbeProject(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_ItemSuite9* itemP,
    const AEGP_MemorySuite1* memP,
    AEGP_PluginID plugin_id)
{
    A_Err err;
    A_long num_projects = 0;
    A_long i;

    err = projP->AEGP_GetNumProjects(&num_projects);
    if (err != A_Err_NONE)
    {
        LogFormatted(utilP, "AEGP_GetNumProjects err=%ld", (long)err);
        return err;
    }
    LogFormatted(utilP, "app.numProjects=%ld", num_projects);

    for (i = 0; i < num_projects && i < 4; i++)
    {
        AEGP_ProjectH projectH = NULL;
        char nameZ[AEGP_MAX_PROJ_NAME_SIZE + 1];
        A_Boolean dirtyB = FALSE;
        AEGP_ProjBitDepth bit_depth = 0;

        err = projP->AEGP_GetProjectByIndex(i, &projectH);
        if (err != A_Err_NONE || !projectH)
        {
            LogFormatted(utilP, "AEGP_GetProjectByIndex(%ld) err=%ld", i, (long)err);
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
    return A_Err_NONE;
}

static void ReleaseSuiteSafe(
    struct SPBasicSuite* basicP, const char* nameZ, int versionL)
{
    basicP->ReleaseSuite(nameZ, versionL);
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
    AEGP_GlobalRefcon* global_refconP) /* << unused: no hooks registered */
{
    const AEGP_UtilitySuite6* utilP = NULL;
    const AEGP_ProjSuite6* projP = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    AEGP_PluginID my_plugin_id = 0;
    A_Err err = A_Err_NONE;
    A_Err first_err = A_Err_NONE;

    (void)driver_major_versionL;
    (void)driver_minor_versionL;
    (void)global_refconP;

    /* Suite acquisition is demand-loaded through SPBasicSuite. Any
       failure aborts the probe (fail closed): a partially acquired
       suite set is never used. */
    if (pica_basicP->AcquireSuite(kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6,
                                  (const void**)&utilP) != 0 || !utilP)
    {
        return A_Err_STRUCT;
    }
    if (pica_basicP->AcquireSuite(kAEGPProjSuite, kAEGPProjSuiteVersion6,
                                  (const void**)&projP) != 0 || !projP)
    {
        first_err = A_Err_STRUCT;
        goto done;
    }
    if (pica_basicP->AcquireSuite(kAEGPItemSuite, kAEGPItemSuiteVersion9,
                                  (const void**)&itemP) != 0 || !itemP)
    {
        first_err = A_Err_STRUCT;
        goto done;
    }
    if (pica_basicP->AcquireSuite(kAEGPMemorySuite, kAEGPMemorySuiteVersion1,
                                  (const void**)&memP) != 0 || !memP)
    {
        first_err = A_Err_STRUCT;
        goto done;
    }

    /* Register a plugin identity for AEGP calls that require one
       (AEGP_GetItemName). This registers the plug-in's name with AEGP;
       it does not touch project contents. Fall back to the host-passed
       id if registration is unavailable. */
    if (utilP->AEGP_RegisterWithAEGP(NULL, PROBE_PLUGIN_NAME, &my_plugin_id) != A_Err_NONE
        || my_plugin_id == 0)
    {
        my_plugin_id = aegp_plugin_id;
        LogLine(utilP, "AEGP_RegisterWithAEGP unavailable; using entry-point plugin id");
    }

    LogLine(utilP, "probe.start");

    {
        A_short maj = 0, min = 0;
        A_Boolean ui_suppressedB = FALSE;
        A_Boolean activatedB = FALSE;

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
    }

    err = ProbeProject(utilP, projP, itemP, memP, my_plugin_id);
    if (err != A_Err_NONE && first_err == A_Err_NONE)
    {
        first_err = err;
    }

    LogLine(utilP, "probe.end");

done:
    if (memP)
    {
        ReleaseSuiteSafe(pica_basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    }
    if (itemP)
    {
        ReleaseSuiteSafe(pica_basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    }
    if (projP)
    {
        ReleaseSuiteSafe(pica_basicP, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    }
    if (utilP)
    {
        ReleaseSuiteSafe(pica_basicP, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    }

    /* Query-level errors are logged but do not fail plug-in load; only
       suite-acquisition failure (above) returns an error. */
    return first_err;
}
