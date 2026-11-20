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
#include "native_support.h"
#include "native_state.h"
#include "native_request.h"
#include "native_registry.h"
#include "native_identity.h"
#include "native_ops.h"

/* ae-devtools NativeProbe — opt-in native intake channel.
   This TU is the dispatch surface only: request claim/validation
   (ProcessClaimed), the routing table, the per-tick inbox poll, and the
   public lifecycle entry points. Channel state lives in
   native_state.cpp; identity resolution in native_identity.cpp;
   operation bodies in native_ops.cpp; the allowlist/arg schema in
   native_registry.cpp; result encoding in native_request.cpp; suite
   lifetime + mem-handle codec in native_suites.cpp; pure helpers in
   native_support.cpp. */

#define IN_MAX_INPUT 65536        /* request file bytes */
#define REQ_TIMEOUT_MAX_MS 3600000L /* 1 h ceiling on request deadline */
#define RESULT_MAX 16384

/* ---- Issue #328: dispatch routing table -----------------------------
   The allowlist dispatch is data, not code: each row maps an
   operationId (exact, prefix, or prefix-minus-exclusion) or a set
   predicate to its executor. Order is significant — the first match
   wins, preserving the historical if/else precedence exactly. Adding
   an op = allowlist entry + arg spec + executor + one row here. */
typedef enum {
    RM_EXACT,        /* a == operationId */
    RM_PREFIX,       /* operationId starts with a */
    RM_PREFIX_EXCL,  /* starts with a AND != excl */
    RM_CUSTOM        /* custom(operationId) predicate */
} RouteMatchKind;

typedef struct {
    RouteMatchKind kind;
    const char* a;
    const char* excl;
    int (*custom)(const char*);
    IntakeExecFn exec;
} RouteEntry;

static const RouteEntry kRoutes[] = {
    { RM_EXACT, "AEGP_ProjSuite6.AEGP_GetNumProjects", NULL, NULL,
      ExecNumProjects },
    { RM_EXACT,
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      NULL, NULL, ExecDriverImplVersion },
    { RM_EXACT, "AEGP_ItemSuite9.AEGP_GetTypeName", NULL, NULL,
      ExecGetTypeName },
    { RM_EXACT, "AEGP_ItemSuite9.AEGP_GetItemName", NULL, NULL,
      ExecItemNameOrId },
    { RM_EXACT, "AEGP_ItemSuite9.AEGP_GetItemID", NULL, NULL,
      ExecItemNameOrId },
    { RM_EXACT, "AEGP_ItemSuite9.AEGP_GetFirstProjItem", NULL, NULL,
      EnumerateProjItems },
    { RM_PREFIX, "AEGP_CompSuite13.", NULL, NULL, ExecCompGetter },
    { RM_EXACT, "AEGP_ItemSuite9.AEGP_SetItemComment", NULL, NULL,
      ExecSetItemComment },
    { RM_CUSTOM, NULL, NULL, IsItemGetterOpId, ExecItemGetter },
    { RM_CUSTOM, NULL, NULL, IsLayerCompOpId, ExecLayerCompOp },
    { RM_CUSTOM, NULL, NULL, IsLayerGetterOpId, ExecLayerGetter },
    { RM_PREFIX_EXCL, "AEGP_ProjSuite6.",
      "AEGP_ProjSuite6.AEGP_GetNumProjects", NULL, ExecProjectGetter },
    { RM_EXACT, "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex", NULL, NULL,
      EnumerateRQItems },
    { RM_PREFIX_EXCL, "AEGP_RQItemSuite4.",
      "AEGP_RQItemSuite4.AEGP_GetNumRQItems", NULL, ExecRQItemGetter },
    { RM_EXACT,
      "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
      NULL, NULL, ExecDriverPluginInitVersion },
    { RM_EXACT, "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
      NULL, NULL, ExecSuppressUI },
    { RM_EXACT, "AEGP_UtilitySuite6.AEGP_HostIsActivated",
      NULL, NULL, ExecHostActivated },
    { RM_EXACT,
      "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
      NULL, NULL, ExecRQZeroArg },
    { RM_EXACT, "AEGP_RQItemSuite4.AEGP_GetNumRQItems", NULL, NULL,
      ExecRQZeroArg },
};

static int RouteMatches(const RouteEntry* r, const char* opId)
{
    switch (r->kind)
    {
        case RM_EXACT:
            return strcmp(opId, r->a) == 0;
        case RM_PREFIX:
            return strncmp(opId, r->a, strlen(r->a)) == 0;
        case RM_PREFIX_EXCL:
            return strncmp(opId, r->a, strlen(r->a)) == 0 &&
                   strcmp(opId, r->excl) != 0;
        case RM_CUSTOM:
        {
            /* local copy keeps the call site free of an arrow-call —
               the registry-reconcile scanner maps suite receivers by
               name and must not see an unmapped indirect call. */
            int (*fn)(const char*) = r->custom;
            return fn(opId);
        }
    }
    return 0;
}

static void ProcessClaimed(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const char* claimedPathZ,
    const char* stemZ,
    const char* outboxDirZ,
    const char* tokenZ,
    const char* consentKeyZ,
    const char* pinZ,
    long long mtimeMs)
{
    char buf[IN_MAX_INPUT];
    long n;
    JVal* doc = NULL;
    ReqVerdict v;
    char outDoc[RESULT_MAX];
    char opCallsJson[1024];
    int hasOpCalls = 0;

    memset(&v, 0, sizeof(v));
    v.publish = 1;
    IntakeOpCallsReset();
    IntakeCollectingSet(0);

    /* marker: bracket the request window (id is the safe-charset stem) */
    IntakeLogf(utilP, "native.request id=%s", stemZ);

    n = ReadFileBounded(claimedPathZ, buf, sizeof(buf) - 1);
    if (n <= 0)
    {
        VerdictRefuse(&v, "MALFORMED_REQUEST", "request file unreadable or too large");
        goto tail;
    }
    doc = JParseDoc(buf, (size_t)n);
    if (!doc)
    {
        VerdictRefuse(&v, "MALFORMED_REQUEST", "request is not valid JSON");
        goto tail;
    }
    {
        JVal* vv = JGet(doc, "v");
        JVal* tok = JGet(doc, "token");
        JVal* tmo = JGet(doc, "timeoutMs");
        JVal* tgt = JGet(doc, "target");
        JVal* req = JGet(doc, "request");
        JVal* rid = req ? JGet(req, "requestId") : NULL;
        JVal* schema = req ? JGet(req, "schema") : NULL;
        JVal* sess = req ? JGet(req, "session") : NULL;
        JVal* opid = req ? JGet(req, "operationId") : NULL;
        JVal* args = req ? JGet(req, "args") : NULL;
        JVal* aref = req ? JGet(req, "authorizationRef") : NULL;
        JVal* sid = sess ? JGet(sess, "sessionId") : NULL;
        JVal* sae = sess ? JGet(sess, "aeVersion") : NULL;
        JVal* srel = sess ? JGet(sess, "sdkRelease") : NULL;
        const AllowEntry* allow = NULL;

        /* 1. envelope version + token */
        if (!vv || vv->kind != JK_NUM || vv->num != 1.0)
        {
            VerdictRefuse(&v, "MALFORMED_REQUEST", "unsupported channel envelope");
            goto verdict;
        }
        if (!tok || tok->kind != JK_STR || !TokenOk(tok->str, tok->slen) ||
            tok->slen != 64 || memcmp(tok->str, tokenZ, 64) != 0)
        {
            VerdictRefuse(&v, "CHANNEL_TOKEN_MISMATCH", "request token does not match this channel");
            goto verdict;
        }
        /* requestId must equal the file-name stem */
        if (!rid || rid->kind != JK_STR || rid->slen != strlen(stemZ) ||
            memcmp(rid->str, stemZ, rid->slen) != 0)
        {
            VerdictRefuse(&v, "MALFORMED_REQUEST", "requestId does not match its file name");
            goto verdict;
        }
        /* target re-check (defence in depth; pre-claim filter normally wins) */
        if (tgt && tgt->kind == JK_STR &&
            !(tgt->slen == strlen(IntakeInstanceId()) &&
              memcmp(tgt->str, IntakeInstanceId(), tgt->slen) == 0))
        {
            VerdictRefuse(&v, "WRONG_TARGET", "request targets a different native instance");
            goto verdict;
        }
        /* deadline: mtime + timeoutMs (ae-a8n dispatcher convention).
           timeoutMs must be a finite number in [0, REQ_TIMEOUT_MAX_MS];
           the claimed file's mtime must be readable — if it is not,
           the request was never provably fresh, so it is not-sent
           (environment-proven non-dispatch), never executed. */
        if (!tmo || tmo->kind != JK_NUM || !isfinite(tmo->num) ||
            tmo->num < 0.0 || tmo->num > (double)REQ_TIMEOUT_MAX_MS)
        {
            VerdictRefuse(&v, "MALFORMED_REQUEST", "request deadline out of bounds");
            goto verdict;
        }
        if (mtimeMs < 0)
        {
            snprintf(v.outcome, sizeof(v.outcome), "not-sent");
            snprintf(v.detail, sizeof(v.detail), "request mtime unavailable");
            v.havePayload = 0; v.mayHaveMutated = 0; v.publish = 1;
            goto verdict;
        }
        if (NowMs() > mtimeMs + (long long)tmo->num)
        {
            VerdictRefuse(&v, "STALE_REQUEST", "request expired before it was claimed");
            goto verdict;
        }
        /* inner envelope shape */
        if (!req || req->kind != JK_OBJ ||
            !JStrEq(schema, "ae-devtools/native-dispatch/v1") ||
            !JNonEmptyStr(sid) || !JNonEmptyStr(sae) ||
            (srel && !(srel->kind == JK_OBJ &&
                       JNonEmptyStr(JGet(srel, "identifier")) &&
                       JNonEmptyStr(JGet(srel, "distribution")))) ||
            !opid || opid->kind != JK_STR || opid->slen == 0 ||
            (aref && !JNonEmptyStr(aref)))
        {
            VerdictRefuse(&v, "MALFORMED_REQUEST", "dispatch envelope failed shape validation");
            goto verdict;
        }
        /* allowlist */
        allow = AllowFind(opid->str, opid->slen);
        if (!allow)
        {
            VerdictRefuse(&v, "OPERATION_NOT_DISPATCHABLE",
                          "operation is not in the native intake allowlist");
            goto verdict;
        }
        /* per-operation args schema (Issue #270 Stage 1): validated
           here — after allowlist resolution, before the duplicate check,
           session attestation, and any AEGP call. Unpermitted input is
           refused MALFORMED_REQUEST and never reaches the host. */
        {
            char argDetail[160];
            argDetail[0] = '\0';
            if (!ValidateArgs(allow, args, argDetail, sizeof(argDetail)))
            {
                VerdictRefuse(&v, "MALFORMED_REQUEST",
                              argDetail[0] ? argDetail : "args failed schema validation");
                goto verdict;
            }
        }
        /* duplicate requestId */
        if (SeenBefore(stemZ))
        {
            VerdictRefuse(&v, "DUPLICATE_REQUEST", "requestId was already claimed on this channel");
            goto verdict;
        }
        SeenAdd(stemZ);

        /* ---- session attestation (op-recorded, inside the window) ---- */
        IntakeCollectingSet(1);
        {
            A_short maj = 0, min = 0;
            A_Err qerr = utilP->AEGP_GetDriverImplementationVersion
                ? utilP->AEGP_GetDriverImplementationVersion(&maj, &min)
                : A_Err_STRUCT;
            char extra[48];
            if (qerr == A_Err_NONE)
                snprintf(extra, sizeof(extra), " v=%d.%d", (int)maj, (int)min);
            else
                extra[0] = '\0';
            extra[sizeof(extra) - 1] = '\0';
            IntakeOpRecord(utilP,
                "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
                (long)qerr, qerr == A_Err_NONE ? extra : NULL);
            if (qerr != A_Err_NONE)
            {
                snprintf(v.outcome, sizeof(v.outcome), "not-sent");
                snprintf(v.detail, sizeof(v.detail),
                         "driver version attestation unavailable");
                v.havePayload = 0; v.mayHaveMutated = 0; v.publish = 1;
                goto verdict;
            }
            IntakeNoteObservedVersion((int)maj, (int)min);
            /* session.aeVersion must equal the observed "M.m"; a channel
               pin, when present, must agree too. */
            {
                char expect[48];
                snprintf(expect, sizeof(expect), "%d.%d", (int)maj, (int)min);
                if (!(sae->slen == strlen(expect) && memcmp(sae->str, expect, sae->slen) == 0) ||
                    (pinZ[0] && !(strlen(pinZ) == strlen(expect) && strcmp(pinZ, expect) == 0)))
                {
                    VerdictRefuse(&v, "WRONG_TARGET",
                                  "session aeVersion does not match this engine");
                    goto verdict;
                }
            }
        }

        /* ---- consent verification (Issue #326 / contract §7g) ----
           Only requiresConsent allowlist entries verify; read-only ops
           skip entirely and a stray consent field is ignored. Runs
           after session attestation, before any AEGP mutation call —
           a refusal here leaves opCalls with no mutation record. */
        if (allow->requiresConsent)
        {
            JVal* consent = JGet(doc, "consent");
            JVal* cv = consent ? JGet(consent, "v") : NULL;
            JVal* cmac = consent ? JGet(consent, "mac") : NULL;
            int shapeOk = consent && consent->kind == JK_OBJ &&
                          cv && cv->kind == JK_NUM && cv->num == 1.0 &&
                          cmac && cmac->kind == JK_STR && cmac->slen == 64 &&
                          TokenOk(cmac->str, cmac->slen);
            if (!shapeOk)
            {
                VerdictRefuse(&v, "CONSENT_REQUIRED",
                              "consent object missing or malformed");
                goto verdict;
            }
            if (!consentKeyZ[0])
            {
                VerdictRefuse(&v, "CONSENT_REQUIRED",
                              "channel has no consentKey");
                goto verdict;
            }
            {
                /* canonicalConsentString over the PARSED request —
                   the MAC binds operationId, requestId, session, args
                   and target, so tampering any scope field breaks it. */
                char* canon = (char*)malloc(IN_MAX_INPUT * 2 + 1024);
                size_t canonLen = 0;
                const char* tgtZ =
                    (tgt && tgt->kind == JK_STR) ? tgt->str : NULL;
                size_t tgtLen =
                    (tgt && tgt->kind == JK_STR) ? tgt->slen : 0;
                int built = canon &&
                    ConsentBuildString(canon, IN_MAX_INPUT * 2 + 1024, &canonLen,
                                       opid->str, opid->slen,
                                       rid->str, rid->slen,
                                       sess, args, tgtZ, tgtLen) &&
                    ConsentVerifyMac(consentKeyZ, canon, canonLen,
                                     cmac->str, cmac->slen);
                free(canon);
                if (!built)
                {
                    VerdictRefuse(&v, "CONSENT_INVALID",
                                  "consent MAC does not match request scope");
                    goto verdict;
                }
            }
        }

        /* ---- execute the allowlisted op: routing table (Issue #328)
           First matching row wins; rows preserve the historical
           if/else precedence. No match → OPERATION_NOT_DISPATCHABLE. */
        {
            size_t ri;
            int routed = 0;
            for (ri = 0; ri < sizeof(kRoutes) / sizeof(kRoutes[0]); ri++)
            {
                if (RouteMatches(&kRoutes[ri], allow->operationId))
                {
                    kRoutes[ri].exec(utilP, projP, basicP, plugin_id,
                                     allow, args, &v);
                    routed = 1;
                    break;
                }
            }
            if (!routed)
            {
                VerdictRefuse(&v, "OPERATION_NOT_DISPATCHABLE",
                              "allowlist entry has no executor");
            }
        }
    verdict:
        ;
    }

tail:
    IntakeCollectingSet(0);
    /* opCalls: ids emitted inside this request's window */
    opCallsJson[0] = '\0';
    hasOpCalls = IntakeOpCallsJson(opCallsJson, sizeof(opCallsJson));
    IntakeLogf(utilP, "native.result id=%s outcome=%s%s%s",
               stemZ, v.outcome,
               v.refusal[0] ? " code=" : "",
               v.refusal[0] ? v.refusal : "");
    if (EmitResult(outDoc, sizeof(outDoc), plugin_id, stemZ,
                   v.outcome, v.refusal[0] ? v.refusal : NULL,
                   v.havePayload ? v.payload : NULL,
                   v.mayHaveMutated,
                   hasOpCalls ? opCallsJson : NULL,
                   v.detail[0] ? v.detail : NULL) == 0)
    {
        char resultPath[PATH_MAX_LOCAL];
        char name[300];
        snprintf(name, sizeof(name), "%s.result.json", stemZ);
        JoinPath(resultPath, sizeof(resultPath), outboxDirZ, name);
        if (WriteFileAtomic(resultPath, outDoc, strlen(outDoc)) != 0)
        {
            IntakeLogf(utilP, "native.error: result publish failed id=%s", stemZ);
        }
    }
    else
    {
        IntakeLogf(utilP, "native.error: result encode failed id=%s", stemZ);
    }

    if (doc) JFree(doc);
}

/* ---- per-tick poll ----------------------------------------------------- */

void NativeIntakeTick(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id)
{
    char inboxDir[PATH_MAX_LOCAL], outboxDir[PATH_MAX_LOCAL], statePath[PATH_MAX_LOCAL];
    char token[65], consentKey[65], pin[48];
    DIR* d;
    struct dirent* de;
    char names[64][320];
    int count = 0;
    int i, j;

    if (!IntakeEnabled()) return;
    IntakeAdvanceTick();

    if (!ChannelReady(utilP, inboxDir, sizeof(inboxDir), outboxDir, sizeof(outboxDir),
                      statePath, sizeof(statePath), token, consentKey,
                      pin, sizeof(pin)))
        return;

    if (IntakeHeartbeatDue())
        IntakeWriteHeartbeat(utilP, plugin_id, statePath, outboxDir);

    d = opendir(inboxDir);
    if (!d) return;
    while ((de = readdir(d)) != NULL && count < 64)
    {
        size_t nl = strlen(de->d_name);
        const char* suffix = ".request.json";
        size_t sl = strlen(suffix);
        char stem[REQ_ID_MAX + 1];
        if (nl <= sl || strcmp(de->d_name + nl - sl, suffix) != 0) continue;
        if (nl - sl > REQ_ID_MAX || nl - sl == 0) continue;
        memcpy(stem, de->d_name, nl - sl);
        stem[nl - sl] = '\0';
        if (!ReqIdOk(stem, nl - sl)) continue;
        snprintf(names[count], sizeof(names[count]), "%s", de->d_name);
        count++;
    }
    closedir(d);
    if (count == 0) return;

    /* name-sorted, one request per tick */
    for (i = 1; i < count; i++)
    {
        char tmp[320];
        for (j = i; j > 0 && strcmp(names[j], names[j - 1]) < 0; j--)
        {
            memcpy(tmp, names[j], sizeof(tmp));
            memcpy(names[j], names[j - 1], sizeof(tmp));
            memcpy(names[j - 1], tmp, sizeof(tmp));
        }
    }

    for (i = 0; i < count; i++)
    {
        const char* fname = names[i];
        size_t nl = strlen(fname);
        const char* suffix = ".request.json";
        size_t sl = strlen(suffix);
        char stem[REQ_ID_MAX + 1];
        char reqPath[PATH_MAX_LOCAL];
        char peek[IN_MAX_INPUT];
        long pn;
        JVal* pdoc = NULL;
        int skip = 0;

        memcpy(stem, fname, nl - sl);
        stem[nl - sl] = '\0';

        /* only regular files are claimable: a symlink/FIFO/device with a
           request-shaped name is left untouched (client times out
           UNKNOWN — malformed channel usage is never executed) */
        JoinPath(reqPath, sizeof(reqPath), inboxDir, fname);
        {
            struct stat rst;
            if (lstat(reqPath, &rst) != 0 || !S_ISREG(rst.st_mode)) continue;
        }

        /* pre-claim target filter: leave requests for other instances */
        pn = ReadFileBounded(reqPath, peek, sizeof(peek) - 1);
        if (pn > 0)
        {
            pdoc = JParseDoc(peek, (size_t)pn);
            if (pdoc)
            {
                JVal* tgt = JGet(pdoc, "target");
                if (tgt && tgt->kind == JK_STR &&
                    !(tgt->slen == strlen(IntakeInstanceId()) &&
                      memcmp(tgt->str, IntakeInstanceId(), tgt->slen) == 0))
                    skip = 1;
                JFree(pdoc);
            }
        }
        if (skip) continue;

        /* claim by rename; a claimed request is never replayed */
        {
            char claimedRel[REQ_ID_MAX + 16];
            char claimedPath[PATH_MAX_LOCAL];
            snprintf(claimedRel, sizeof(claimedRel), "%s.claimed", stem);
            JoinPath(claimedPath, sizeof(claimedPath), inboxDir, claimedRel);
            if (rename(reqPath, claimedPath) != 0) continue;
            {
                struct stat cst;
                if (lstat(claimedPath, &cst) != 0 || !S_ISREG(cst.st_mode))
                {
                    remove(claimedPath);
                    continue;
                }
            }

            ProcessClaimed(utilP, projP, basicP, plugin_id, claimedPath, stem,
                           outboxDir, token, consentKey, pin,
                           FileMtimeMs(claimedPath));
            remove(claimedPath);
        }
        break; /* one request per tick */
    }
}

/* ---- lifecycle -------------------------------------------------------- */

void NativeIntakeConfigure(const char* channelRootZ)
{
    IntakeConfigureChannel(channelRootZ);
}

#else /* _WIN32: intake compiled out — UNVERIFIED platform */

void NativeIntakeConfigure(const char* channelRootZ)
{
    (void)channelRootZ;
}

void NativeIntakeTick(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id)
{
    (void)utilP; (void)projP; (void)basicP; (void)plugin_id;
}

#endif /* !_WIN32 */
