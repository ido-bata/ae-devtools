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
#include "native_suites.h"
#include "native_state.h"
#include "native_support.h"

/* ---- per-request suite acquisition (Issue #270 Stage 1) --------------
   Intake runs before the probe's reason-gated item-suite acquisition, so
   an arg-bearing op acquires exactly the suite it needs, inside the
   request window, and releases it before the verdict. Acquire/release
   are op-recorded like every other host call. */

const void* IntakeAcquireSuite(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    const char* nameZ,
    int versionL)
{
    const void* suite = NULL;
    SPErr src = A_Err_STRUCT;
    char extra[96];
    if (basicP && basicP->AcquireSuite)
        src = basicP->AcquireSuite(nameZ, versionL, &suite);
    snprintf(extra, sizeof(extra), " suite=\"%s\" version=%d",
             nameZ, (int)versionL);
    extra[sizeof(extra) - 1] = '\0';
    IntakeOpRecord(utilP, "SPBasicSuite.AcquireSuite", (long)src,
                   src == 0 ? extra : NULL);
    if (src != 0 || !suite) return NULL;
    return suite;
}

void IntakeReleaseSuite(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    const char* nameZ,
    int versionL)
{
    SPErr src = A_Err_STRUCT;
    char extra[96];
    if (basicP && basicP->ReleaseSuite)
        src = basicP->ReleaseSuite(nameZ, versionL);
    snprintf(extra, sizeof(extra), " suite=\"%s\" version=%d",
             nameZ, (int)versionL);
    extra[sizeof(extra) - 1] = '\0';
    IntakeOpRecord(utilP, "SPBasicSuite.ReleaseSuite", (long)src,
                   src == 0 ? extra : NULL);
}


/* ---- UTF-16 mem-handle reads (Issue #270 Stage 3) -------------------
   AEGP name/path getters return AEGP_MemHandle blocks of A_UTF16Char.
   Same discipline as probe.cpp's ReadMemHandleUtf8: size comes from
   AEGP_GetMemHandleSize (bytes → code units), every lock is paired
   with unlock, the handle is freed on every path, and every suite
   call is op-recorded into the request window. */

void IntakeFreeMemHandle(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    AEGP_MemHandle handleH)
{
    A_Err err = memP->AEGP_FreeMemHandle(handleH);
    IntakeOpRecord(utilP, "AEGP_MemorySuite1.AEGP_FreeMemHandle", (long)err, NULL);
}

/* Read an AEGP UTF-16 mem handle into dstZ (NUL-terminated UTF-8).
   The handle is ALWAYS freed on every path where freeing is possible.
   Returns IMH_* status; dstZ written on IMH_OK/IMH_TRUNCATED. */
IntakeMemStatus IntakeReadMemHandleUtf8(
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
    if (!handleH) return IMH_NULL_HANDLE;
    if (!memP->AEGP_GetMemHandleSize || !memP->AEGP_LockMemHandle ||
        !memP->AEGP_UnlockMemHandle || !memP->AEGP_FreeMemHandle)
        return IMH_NOENTRIES;
    err = memP->AEGP_GetMemHandleSize(handleH, &size_bytesL);
    IntakeOpRecord(utilP, "AEGP_MemorySuite1.AEGP_GetMemHandleSize",
                   (long)err, NULL);
    if (err != A_Err_NONE)
    {
        IntakeFreeMemHandle(utilP, memP, handleH);
        return IMH_SIZE_ERR;
    }
    err = memP->AEGP_LockMemHandle(handleH, &ptr);
    IntakeOpRecord(utilP, "AEGP_MemorySuite1.AEGP_LockMemHandle",
                   (long)err, NULL);
    if (err != A_Err_NONE || !ptr)
    {
        IntakeFreeMemHandle(utilP, memP, handleH);
        return IMH_LOCK_ERR;
    }
    {
        AEGP_MemSize unitsL = size_bytesL / sizeof(A_UTF16Char);
        int n = IntakeUtf16ToUtf8((const A_UTF16Char*)ptr, unitsL, dstZ, dstSize);
        A_Err uerr = memP->AEGP_UnlockMemHandle(handleH);
        IntakeOpRecord(utilP, "AEGP_MemorySuite1.AEGP_UnlockMemHandle",
                       (long)uerr, NULL);
        IntakeFreeMemHandle(utilP, memP, handleH);
        return n < 0 ? IMH_TRUNCATED : IMH_OK;
    }
}


#else /* _WIN32 */
#endif
