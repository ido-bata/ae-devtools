/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — per-request suite lifetime +           */
/* UTF-16 mem-handle codec                                          */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_SUITES_H
#define AE_PROBE_NATIVE_SUITES_H

#include <stddef.h>

#include "native_intake.h" /* AE_GeneralPlug.h types */

typedef enum
{
    IMH_OK = 0,
    IMH_NULL_HANDLE,
    IMH_NOENTRIES,
    IMH_SIZE_ERR,
    IMH_LOCK_ERR,
    IMH_TRUNCATED
} IntakeMemStatus;

/* Acquire/release one AEGP suite inside the request window;
   op-recorded like every other host call. */
const void* IntakeAcquireSuite(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    const char* nameZ,
    int versionL);
void IntakeReleaseSuite(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    const char* nameZ,
    int versionL);

/* AEGP_MemHandle discipline: the handle is ALWAYS freed on every
   path where freeing is possible; every suite call is op-recorded. */
void IntakeFreeMemHandle(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    AEGP_MemHandle handleH);
IntakeMemStatus IntakeReadMemHandleUtf8(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_MemorySuite1* memP,
    AEGP_MemHandle handleH,
    char* dstZ,
    size_t dstSize);

#endif /* AE_PROBE_NATIVE_SUITES_H */
