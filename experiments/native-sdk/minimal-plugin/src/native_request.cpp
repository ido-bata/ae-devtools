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
#include "native_request.h"
#include "native_support.h"
#include "native_state.h"

/* ---- result construction + request verdicts -------------------------
   ReqVerdict is the per-request outcome accumulator every executor
   writes; EmitResult renders the final native-dispatch/v1 document. */

/* ---- result construction -------------------------------------------- */
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
    const char* detailZ)
{
    size_t o = 0;
    char escReq[256], escDetail[512];
    int n;
    JsonEscape(escReq, sizeof(escReq), requestIdZ);
    JsonEscape(escDetail, sizeof(escDetail), detailZ ? detailZ : "");

#define APP(...) do { n = snprintf(out + o, cap - o, __VA_ARGS__); \
    if (n < 0 || (size_t)n >= cap - o) return -1; o += (size_t)n; } while (0)

    APP("{\"v\":1,\"instance\":\"");
    APP("%s", IntakeInstanceId());
    APP("\",\"host\":{\"plugin\":\"ae-a8n NativeProbe\",\"pluginId\":%ld,\"aeVersion\":\"%s\"},\"result\":{\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"%s\",\"outcome\":\"%s\"",
        (long)plugin_id,
        IntakeObservedVersion()[0] ? IntakeObservedVersion() : "unknown",
        escReq, outcomeZ);
    if (refusalCodeZ)
        APP(",\"refusalCode\":\"%s\"", refusalCodeZ);
    if (payloadJsonZ)
        APP(",\"result\":%s", payloadJsonZ);
    if (mayHaveMutated)
        APP(",\"mayHaveMutated\":true");
    else if (strcmp(outcomeZ, "failed") == 0)
        APP(",\"mayHaveMutated\":false");
    if (opCallsJsonZ)
        APP(",\"opCalls\":%s", opCallsJsonZ);
    if (detailZ && detailZ[0])
        APP(",\"detail\":\"%s\"", escDetail);
    APP("}}");
    return 0;
#undef APP
}

/* ---- request processing ---------------------------------------------- */

void VerdictRefuse(ReqVerdict* r, const char* codeZ, const char* detailZ)
{
    snprintf(r->outcome, sizeof(r->outcome), "refused");
    snprintf(r->refusal, sizeof(r->refusal), "%s", codeZ);
    snprintf(r->detail, sizeof(r->detail), "%s", detailZ ? detailZ : "");
    r->havePayload = 0;
    r->publish = 1;
}

/* Terminal verdict helper: outcome + bounded detail, and the fixed
   flag pair (no payload, always publish). mayHaveMutated is NOT a
   verdict field — it lives in ProcessClaimed's frame and reaches the
   wire only via EmitResult, so no executor can set it (Issue #328). */
void VerdictSet(ReqVerdict* v, const char* outcomeZ,
                       const char* detailFmt, ...)
{
    va_list ap;
    va_start(ap, detailFmt);
    snprintf(v->outcome, sizeof(v->outcome), "%s", outcomeZ);
    vsnprintf(v->detail, sizeof(v->detail), detailFmt, ap);
    va_end(ap);
    v->detail[sizeof(v->detail) - 1] = '\0';
    v->havePayload = 0;
    v->publish = 1;
}

/* Typed result payload with guaranteed NUL termination and the
   havePayload flag — replaces the snprintf + manual-NUL + flag
   triple repeated per getter (Issue #328). */
void PayloadSet(ReqVerdict* v, const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(v->payload, sizeof(v->payload), fmt, ap);
    va_end(ap);
    v->payload[sizeof(v->payload) - 1] = '\0';
    v->havePayload = 1;
}

/* Uniform read-only getter tail (Issue #328): completed iff the AEGP
   call succeeded AND a payload was emitted; otherwise failed with the
   op's error detail. `detailOverride` (may be NULL) replaces the
   default "<opId> err=<n>" detail for codec-level failures. */
void GetterTailReadOnly(
    const AllowEntry* allow,
    ReqVerdict* v,
    A_Err oerr,
    const char* detailOverride)
{
    if (oerr == A_Err_NONE && v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->publish = 1;
    }
    else if (detailOverride)
    {
        VerdictSet(v, "failed", "%s", detailOverride);
    }
    else
    {
        VerdictSet(v, "failed", "%s err=%ld",
                   allow->operationId, (long)oerr);
    }
}


#else /* _WIN32 */
#endif
