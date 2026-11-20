/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — request verdicts + result encoding     */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_REQUEST_H
#define AE_PROBE_NATIVE_REQUEST_H

#include <stddef.h>

#include "native_intake.h"  /* AE_GeneralPlug.h types */
#include "native_registry.h" /* AllowEntry */

typedef struct
{
    char outcome[16];
    char refusal[48];
    char detail[160];
    char payload[14000];    /* JSON for `result` member, or "" — identity-slice payloads (issuance/enumeration) need real headroom under RESULT_MAX */
    int havePayload;
    int mayHaveMutated;
    int publish;            /* 0 = no result file (should not happen) */
} ReqVerdict;

void VerdictRefuse(ReqVerdict* r, const char* codeZ, const char* detailZ);
void VerdictSet(ReqVerdict* v, const char* outcomeZ,
                const char* detailFmt, ...);
void PayloadSet(ReqVerdict* v, const char* fmt, ...);
/* Uniform read-only getter tail: completed iff the AEGP call
   succeeded AND a payload was emitted; otherwise failed. */
void GetterTailReadOnly(
    const AllowEntry* allow,
    ReqVerdict* v,
    A_Err oerr,
    const char* detailOverride);

/* Build the outbox document: wrapper {v,instance,host,result{DispatchResult}}. */
int EmitResult(
    char* out, size_t cap,
    AEGP_PluginID plugin_id,
    const char* requestIdZ,
    const char* outcomeZ,
    const char* refusalCodeZ,
    const char* payloadJsonZ,
    int mayHaveMutated,
    const char* opCallsJsonZ,
    const char* detailZ);

#endif /* AE_PROBE_NATIVE_REQUEST_H */
