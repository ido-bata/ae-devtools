/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — opt-in native intake channel          */
/* (Issue #267 Slice A)                                            */
/*                                                                 */
/* Original code written for this repository. It is NOT derived    */
/* from Adobe SDK sample sources.                                   */
/*                                                                 */
/* CONTRACT: specs/ae-capability-coverage/contracts/               */
/*   native-channel.md (`ae-devtools/native-channel/v1`)           */
/*   native-dispatch.md  (`ae-devtools/native-dispatch/v1` payload)*/
/*                                                                 */
/* This is the VERIFICATION LANE, not the dispatchable gate: a     */
/* fixed read-only allowlist, off by default (AE_DEVTOOLS_NATIVE_  */
/* CHANNEL env opt-in), channel-token gated, one request per idle  */
/* dispatch. It exists so Slice C can gather real-host evidence    */
/* under #223; it promotes nothing by itself.                      */
/*                                                                 */
/* Channel conventions mirror the ae-a8n in-AE dispatcher          */
/* (host/a8n-host.js): private dir perms, token, claim-by-rename,  */
/* deadline-from-mtime, atomic publish, UNKNOWN never resent —     */
/* under a distinct `native/` namespace supplied by the caller.    */
/*                                                                 */
/* The channel token is a shared secret: it is compared verbatim   */
/* and NEVER written to the debug log, result files, or            */
/* state.json.                                                      */
/*                                                                 */
/* POSIX-only for now (dirent/stat/lstat). Windows intake is        */
/* UNVERIFIED and compiled out.                                     */
/*******************************************************************/

#include "native_intake.h"

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

#define LOG_SUBSYSTEM "ae-a8n"
#define LOG_EVENT "nativeprobe"

/* ---- bounds (file-channel implementation limits; see contract §3) */
#define IN_MAX_INPUT 65536        /* request file bytes */
#define CHAN_JSON_MAX 16384        /* channel.json bytes */
#define REQ_ID_MAX 128
#define REQ_TIMEOUT_MAX_MS 3600000L /* 1 h ceiling on request deadline */
#define SEEN_IDS 64
#define SEEN_ID_LEN (REQ_ID_MAX + 1)
#define PATH_MAX_LOCAL 4096
#define RESULT_MAX 16384
#define OUTBOX_MAX_AGE_MS (60L * 60L * 1000L)
#define STATE_EVERY_TICKS 8
#define PUBLISH_ATTEMPTS 3
#define PUBLISH_RETRY_US 50000     /* 50 ms */

/* ---- channel state ------------------------------------------------- */

static char s_channel_root[PATH_MAX_LOCAL]; /* "" = disabled */
static int s_intake_ready = 0;               /* Configure succeeded once */
static char s_instance[80];
static long s_ticks = 0;
static long s_last_state_tick = -1;
static char s_observed_version[48];          /* "M.m" once attested */
static char s_seen[SEEN_IDS][SEEN_ID_LEN];
static int s_seen_count = 0;
static int s_priv_logged = 0;
static int s_misc_logged = 0;

static void IntakeLog(const AEGP_UtilitySuite6* utilP, const char* msgZ)
{
    if (utilP && utilP->AEGP_WriteToDebugLog)
        utilP->AEGP_WriteToDebugLog(LOG_SUBSYSTEM, LOG_EVENT, msgZ);
}

static void IntakeLogf(const AEGP_UtilitySuite6* utilP, const char* fmtZ, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmtZ);
    vsnprintf(buf, sizeof(buf), fmtZ, ap);
    va_end(ap);
    buf[sizeof(buf) - 1] = '\0';
    IntakeLog(utilP, buf);
}

/* op-record emission, intake-private (always direct; intake requests are
   never buffered — they are not probe runs). Also appends the id to the
   per-request opCalls list while s_collecting is set. */
#define OPCALLS_MAX 16
static const char* s_opcalls[OPCALLS_MAX];
static int s_opcalls_count = 0;
static int s_collecting = 0;

static void IntakeOpRecord(
    const AEGP_UtilitySuite6* utilP,
    const char* idZ,
    long errL,
    const char* extraZ)
{
    char line[224];
    snprintf(line, sizeof(line), "op %s err=%ld%s", idZ, errL, extraZ ? extraZ : "");
    line[sizeof(line) - 1] = '\0';
    IntakeLog(utilP, line);
    if (s_collecting && s_opcalls_count < OPCALLS_MAX)
        s_opcalls[s_opcalls_count++] = idZ;
}

static void IntakeLogOnce(int* flagP, const AEGP_UtilitySuite6* utilP, const char* msgZ)
{
    if (!*flagP)
    {
        *flagP = 1;
        IntakeLog(utilP, msgZ);
    }
}

/* ---- small fs helpers ---------------------------------------------- */

static void JoinPath(char* out, size_t cap, const char* a, const char* b)
{
    size_t n = strlen(a);
    snprintf(out, cap, "%s%s%s", a, (n && a[n - 1] == '/') ? "" : "/", b);
    out[cap - 1] = '\0';
}

/* Read a whole regular file, bounded. O_NOFOLLOW refuses symlinks at
   open time; fstat confirms a regular file and caps the read so a
   swapped or grown file is refused rather than truncated. Returns
   length or -1. */
static long ReadFileBounded(const char* pathZ, char* buf, size_t cap)
{
    int fd = open(pathZ, O_RDONLY | O_NOFOLLOW);
    struct stat st;
    long n;
    if (fd < 0) return -1;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) { close(fd); return -1; }
    if (st.st_size < 0 || (unsigned long long)st.st_size >= (unsigned long long)cap) { close(fd); return -1; }
    n = (long)read(fd, buf, (size_t)st.st_size);
    close(fd);
    if (n != st.st_size) return -1;
    buf[n] = '\0';
    return n;
}

/* Publish `textZ` at `finalPathZ` atomically or fail explicitly.
   Contract (native-channel.md §5): the result must never appear
   partially — there is NO non-atomic fallback. The staging file is
   opened O_NOFOLLOW with owner-only perms (a pre-planted symlink
   fails the open), fully written + fsynced, then rename(2)'d into
   place. Any failure removes the staging file and returns -1: the
   caller's outcome is UNKNOWN and the request is never resent. */
static int WriteFileAtomic(const char* finalPathZ, const char* textZ, size_t len)
{
    char part[PATH_MAX_LOCAL];
    size_t base = strlen(finalPathZ);
    int attempt;
    if (base + 6 >= sizeof(part)) return -1;
    memcpy(part, finalPathZ, base);
    memcpy(part + base, ".part", 6);
    part[base + 5] = '\0';

    for (attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++)
    {
        int fd = open(part, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
        if (fd >= 0)
        {
            size_t off = 0;
            int wok = 1;
            while (off < len)
            {
                ssize_t w = write(fd, textZ + off, len - off);
                if (w <= 0) { wok = 0; break; }
                off += (size_t)w;
            }
            if (fsync(fd) != 0) wok = 0;
            close(fd);
            if (wok && rename(part, finalPathZ) == 0)
                return 0;
        }
        /* staging write/rename failed: drop the partial staging file so
           it cannot be mistaken for a published result */
        remove(part);
        if (attempt + 1 < PUBLISH_ATTEMPTS) usleep(PUBLISH_RETRY_US);
    }
    return -1;
}

/* lstat + privacy check: must exist, not be a symlink, and (POSIX)
   not group/other accessible. kind: 0=file 1=dir. */
static int PrivatePathOk(const char* pathZ, int wantDir)
{
    struct stat st;
    if (lstat(pathZ, &st) != 0) return 0;
    if (S_ISLNK(st.st_mode)) return 0;
    if (wantDir ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) return 0;
    if ((st.st_mode & 077) != 0) return 0;
    return 1;
}

static long long FileMtimeMs(const char* pathZ)
{
    struct stat st;
    if (lstat(pathZ, &st) != 0) return -1;
#if defined(__APPLE__)
    return (long long)st.st_mtimespec.tv_sec * 1000LL +
           (long long)st.st_mtimespec.tv_nsec / 1000000LL;
#elif defined(__linux__)
    return (long long)st.st_mtim.tv_sec * 1000LL +
           (long long)st.st_mtim.tv_nsec / 1000000LL;
#else
    return (long long)st.st_mtime * 1000LL;
#endif
}

static long long NowMs(void)
{
    struct timespec ts;
#if defined(__APPLE__) || defined(__linux__)
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
#else
    return (long long)time(NULL) * 1000LL;
#endif
}

/* ---- requestId / instance ------------------------------------------ */

static int ReqIdOk(const char* idZ, size_t len)
{
    size_t i;
    if (len == 0 || len > REQ_ID_MAX) return 0;
    if (!(isalnum((unsigned char)idZ[0]))) return 0;
    for (i = 1; i < len; i++)
    {
        char c = idZ[i];
        if (!(isalnum((unsigned char)c) || c == '.' || c == '_' || c == '-')) return 0;
    }
    return 1;
}

static int TokenOk(const char* tokZ, size_t len)
{
    size_t i;
    if (len != 64) return 0;
    for (i = 0; i < len; i++)
        if (!((tokZ[i] >= '0' && tokZ[i] <= '9') || (tokZ[i] >= 'a' && tokZ[i] <= 'f')))
            return 0;
    return 1;
}

static void MakeInstance(char* out, size_t cap)
{
    long long ms = NowMs();
    unsigned int r;
#if defined(__APPLE__)
    r = arc4random();
#else
    r = (unsigned int)rand();
#endif
    snprintf(out, cap, "n%llx%08x", ms, r);
    out[cap - 1] = '\0';
}

static int SeenBefore(const char* idZ)
{
    int i;
    for (i = 0; i < s_seen_count; i++)
        if (strcmp(s_seen[i], idZ) == 0) return 1;
    return 0;
}

static void SeenAdd(const char* idZ)
{
    if (s_seen_count < SEEN_IDS)
    {
        strncpy(s_seen[s_seen_count], idZ, SEEN_ID_LEN - 1);
        s_seen[s_seen_count][SEEN_ID_LEN - 1] = '\0';
        s_seen_count++;
        return;
    }
    /* ring: drop oldest */
    memmove(s_seen[0], s_seen[1], (SEEN_IDS - 1) * SEEN_ID_LEN);
    strncpy(s_seen[SEEN_IDS - 1], idZ, SEEN_ID_LEN - 1);
    s_seen[SEEN_IDS - 1][SEEN_ID_LEN - 1] = '\0';
}

/* ---- channel readiness ----------------------------------------------
   Returns 1 when the channel is usable this tick, 0 when intake must
   stay idle (missing pieces are normal pre-activation state; privacy
   violations are logged once). Fills inbox/outbox paths, token and the
   optional sessionAeVersion pin. */

static int ChannelReady(
    const AEGP_UtilitySuite6* utilP,
    char* inboxOut, size_t inboxCap,
    char* outboxOut, size_t outboxCap,
    char* stateOut, size_t stateCap,
    char tokenOut[65],
    char pinOut[48], size_t pinCap)
{
    char path[PATH_MAX_LOCAL];
    char buf[CHAN_JSON_MAX];
    long n;
    JVal* doc;
    JVal* v;
    JVal* pin;
    struct stat st;

    /* Missing pieces are normal pre-activation state (silent); present
       but non-private entries are a logged-once violation. */
#define CHAN_ENTRY_OK(p, wantDir)                                            \
    ({                                                                       \
        int _ok = 0;                                                         \
        if (lstat((p), &st) == 0)                                            \
        {                                                                    \
            if (PrivatePathOk((p), (wantDir)))                               \
                _ok = 1;                                                     \
            else                                                             \
                IntakeLogOnce(&s_priv_logged, utilP,                         \
                              "native.error: channel privacy check failed");\
        }                                                                    \
        _ok;                                                                 \
    })

    if (!CHAN_ENTRY_OK(s_channel_root, 1)) return 0;
    JoinPath(path, sizeof(path), s_channel_root, "inbox");
    if (!CHAN_ENTRY_OK(path, 1)) return 0;
    JoinPath(path, sizeof(path), s_channel_root, "outbox");
    if (!CHAN_ENTRY_OK(path, 1)) return 0;
    JoinPath(path, sizeof(path), s_channel_root, "channel.json");
    if (!CHAN_ENTRY_OK(path, 0)) return 0;
#undef CHAN_ENTRY_OK

    n = ReadFileBounded(path, buf, sizeof(buf) - 1);
    if (n <= 0)
    {
        IntakeLogOnce(&s_misc_logged, utilP, "native.error: channel.json unreadable");
        return 0;
    }
    doc = JParseDoc(buf, (size_t)n);
    if (!doc)
    {
        IntakeLogOnce(&s_misc_logged, utilP, "native.error: channel.json malformed");
        return 0;
    }
    v = JGet(doc, "v");
    {
        JVal* tok = JGet(doc, "token");
        int ok = v && v->kind == JK_NUM && v->num == 1.0 &&
                 tok && tok->kind == JK_STR && TokenOk(tok->str, tok->slen);
        if (ok)
        {
            memcpy(tokenOut, tok->str, 64);
            tokenOut[64] = '\0';
            pin = JGet(doc, "sessionAeVersion");
            if (pin && pin->kind == JK_STR && pin->slen > 0 && pin->slen < pinCap)
            {
                memcpy(pinOut, pin->str, pin->slen);
                pinOut[pin->slen] = '\0';
            }
            else
            {
                pinOut[0] = '\0';
            }
        }
        JFree(doc);
        if (!ok)
        {
            IntakeLogOnce(&s_misc_logged, utilP, "native.error: channel.json invalid");
            return 0;
        }
    }

    JoinPath(inboxOut, inboxCap, s_channel_root, "inbox");
    JoinPath(outboxOut, outboxCap, s_channel_root, "outbox");
    JoinPath(stateOut, stateCap, s_channel_root, "state.json");
    return 1;
}

/* ---- result construction -------------------------------------------- */

/* Escape a string for embedding in a JSON string literal. Our own
   strings are charset-safe already; this is defense in depth. */
static void JsonEscape(char* out, size_t cap, const char* inZ)
{
    size_t o = 0;
    const unsigned char* s = (const unsigned char*)inZ;
    while (*s && o + 8 < cap)
    {
        unsigned char c = *s++;
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
        else if (c == '\r') { out[o++] = '\\'; out[o++] = 'r'; }
        else if (c == '\t') { out[o++] = '\\'; out[o++] = 't'; }
        else if (c < 0x20) { o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c); }
        else out[o++] = (char)c;
    }
    out[o] = '\0';
}

/* Build the outbox document: wrapper {v,instance,host,result{DispatchResult}}. */
static int EmitResult(
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
    APP("%s", s_instance);
    APP("\",\"host\":{\"plugin\":\"ae-a8n NativeProbe\",\"pluginId\":%ld,\"aeVersion\":\"%s\"},\"result\":{\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"%s\",\"outcome\":\"%s\"",
        (long)plugin_id,
        s_observed_version[0] ? s_observed_version : "unknown",
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

/* ---- allowlist + per-operation argument schema ----------------------
   Issue #270 Stage 1: each entry declares the exact `args` contract the
   plug-in enforces BEFORE any AEGP call. The devtools-side canonical
   statement is NATIVE_INTAKE_ARG_SCHEMAS in
   packages/native-adapter/src/dispatch.ts — keep the two in sync.

   Args rules (contract native-channel.md §3/§4):
   - zero-arg op (argsSpec NULL): `args` must be absent or null.
   - arg op: `args` must be a JSON object whose key set is EXACTLY the
     spec's names — missing and extra fields both refuse
     MALFORMED_REQUEST. Values must be finite integral numbers inside
     [min, max]. Identity-bearing arguments (AEGP_ItemH etc.) are not
     expressible: external JSON never becomes a host handle. */

typedef struct
{
    const char* name; /* args object key */
    double min;       /* inclusive bounds (integral values only) */
    double max;
} IntakeArgSpec;

typedef struct
{
    const char* operationId;
    const char* opRecordId; /* identical string; kept explicit */
    const IntakeArgSpec* argsSpec;
    int nargs;
} AllowEntry;

/* AEGP_ItemType (AE_GeneralPlug.h): NONE=0 FOLDER=1 COMP=2
   SOLID_defunct=3 FOOTAGE=4, NUM_TYPES1=5. GetTypeName rejects NONE;
   the permitted span is the defined non-NONE values [1, 4]. */
static const IntakeArgSpec S_TYPENAME_ARGS[] = {
    { "itemType", 1.0, 4.0 },
};

static const AllowEntry S_ALLOWLIST[] = {
    { "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ProjSuite6.AEGP_GetNumProjects", NULL, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion", NULL, 0 },
    { "AEGP_ItemSuite9.AEGP_GetTypeName",
      "AEGP_ItemSuite9.AEGP_GetTypeName", S_TYPENAME_ARGS, 1 },
};
static const int S_ALLOWLIST_COUNT =
    (int)(sizeof(S_ALLOWLIST) / sizeof(S_ALLOWLIST[0]));

static const AllowEntry* AllowFind(const char* opIdZ, size_t len)
{
    int i;
    for (i = 0; i < S_ALLOWLIST_COUNT; i++)
    {
        const char* a = S_ALLOWLIST[i].operationId;
        if (strlen(a) == len && memcmp(a, opIdZ, len) == 0) return &S_ALLOWLIST[i];
    }
    return NULL;
}

/* Per-operation args validation (Issue #270 Stage 1). `args` is the
   request envelope's args member: absent (JGet NULL), JK_NULL, or any
   parsed JSON value. Returns 1 when acceptable; on refusal fills
   `detailZ` (bounded) for the MALFORMED_REQUEST verdict. Runs BEFORE
   session attestation and any AEGP call — unpermitted input never
   reaches the host. */
static int ValidateArgs(
    const AllowEntry* allow,
    JVal* args,
    char* detailZ, size_t detailCap)
{
    int i;
    if (allow->nargs == 0)
    {
        if (args && args->kind != JK_NULL)
        {
            snprintf(detailZ, detailCap, "operation takes no arguments");
            return 0;
        }
        return 1;
    }
    if (!args || args->kind != JK_OBJ)
    {
        snprintf(detailZ, detailCap, "args must be an object of named arguments");
        return 0;
    }
    /* exact key set: every spec name present, no extras */
    if ((int)args->npairs != allow->nargs)
    {
        snprintf(detailZ, detailCap, "args field count mismatch");
        return 0;
    }
    for (i = 0; i < allow->nargs; i++)
    {
        const IntakeArgSpec* spec = &allow->argsSpec[i];
        JVal* v = JGet(args, spec->name);
        if (!v)
        {
            snprintf(detailZ, detailCap, "missing argument \"%s\"", spec->name);
            return 0;
        }
        if (v->kind != JK_NUM || !isfinite(v->num) ||
            floor(v->num) != v->num || v->num < spec->min || v->num > spec->max)
        {
            snprintf(detailZ, detailCap,
                     "argument \"%s\" out of permitted range", spec->name);
            return 0;
        }
    }
    /* duplicate spec names would let one field satisfy two slots; the
       table is compile-time constant so this cannot happen, but the
       exact-count check above already bounds the surface. */
    return 1;
}

/* Fetch a validated integer argument (call only after ValidateArgs
   succeeded for this op). */
static long ArgsInt(const AllowEntry* allow, JVal* args, int index)
{
    JVal* v = JGet(args, allow->argsSpec[index].name);
    return v ? (long)v->num : 0;
}

/* ---- per-request suite acquisition (Issue #270 Stage 1) --------------
   Intake runs before the probe's reason-gated item-suite acquisition, so
   an arg-bearing op acquires exactly the suite it needs, inside the
   request window, and releases it before the verdict. Acquire/release
   are op-recorded like every other host call. */

static const void* IntakeAcquireSuite(
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

static void IntakeReleaseSuite(
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

/* ---- request processing ---------------------------------------------- */

typedef struct
{
    char outcome[16];
    char refusal[48];
    char detail[160];
    char payload[256];      /* JSON for `result` member, or "" */
    int havePayload;
    int mayHaveMutated;
    int publish;            /* 0 = no result file (should not happen) */
} ReqVerdict;

static void VerdictRefuse(ReqVerdict* r, const char* codeZ, const char* detailZ)
{
    snprintf(r->outcome, sizeof(r->outcome), "refused");
    snprintf(r->refusal, sizeof(r->refusal), "%s", codeZ);
    snprintf(r->detail, sizeof(r->detail), "%s", detailZ ? detailZ : "");
    r->havePayload = 0;
    r->mayHaveMutated = 0;
    r->publish = 1;
}

/* Execute one claimed request file. Always publishes a result when
   publish==1; the caller removes the .claimed file afterwards.
   `mtimeMs` is the claimed file's mtime — the deadline base, matching
   the ae-a8n dispatcher convention (mtime + timeoutMs). */
static void ProcessClaimed(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const char* claimedPathZ,
    const char* stemZ,
    const char* outboxDirZ,
    const char* tokenZ,
    const char* pinZ,
    long long mtimeMs)
{
    char buf[IN_MAX_INPUT];
    long n;
    JVal* doc = NULL;
    ReqVerdict v;
    char outDoc[RESULT_MAX];
    char opCallsJson[1024];
    size_t oc = 0;
    int i;

    memset(&v, 0, sizeof(v));
    v.publish = 1;
    s_opcalls_count = 0;
    s_collecting = 0;

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
            !(tgt->slen == strlen(s_instance) && memcmp(tgt->str, s_instance, tgt->slen) == 0))
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
        s_collecting = 1;
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
            snprintf(s_observed_version, sizeof(s_observed_version), "%d.%d", (int)maj, (int)min);
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

        /* ---- execute the allowlisted read-only op ---- */
        if (strcmp(allow->operationId,
                   "AEGP_ProjSuite6.AEGP_GetNumProjects") == 0)
        {
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
                snprintf(v.outcome, sizeof(v.outcome), "completed");
                snprintf(v.payload, sizeof(v.payload), "{\"numProjects\":%ld}", (long)num);
                v.havePayload = 1;
                v.mayHaveMutated = 0;
            }
            else
            {
                snprintf(v.outcome, sizeof(v.outcome), "failed");
                snprintf(v.detail, sizeof(v.detail), "AEGP_GetNumProjects err=%ld", (long)oerr);
                v.havePayload = 0;
                v.mayHaveMutated = 0; /* read-only getter: provably non-mutating */
            }
        }
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion") == 0)
        {
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
                snprintf(v.outcome, sizeof(v.outcome), "completed");
                snprintf(v.payload, sizeof(v.payload), "{\"major\":%d,\"minor\":%d}", (int)maj, (int)min);
                v.havePayload = 1;
                v.mayHaveMutated = 0;
            }
            else
            {
                snprintf(v.outcome, sizeof(v.outcome), "failed");
                snprintf(v.detail, sizeof(v.detail),
                         "AEGP_GetDriverImplementationVersion err=%ld", (long)oerr);
                v.havePayload = 0;
                v.mayHaveMutated = 0;
            }
        }
        else if (strcmp(allow->operationId,
                        "AEGP_ItemSuite9.AEGP_GetTypeName") == 0)
        {
            /* args validated above: {"itemType": <int in [1,4]>}.
               The suite is acquired and released inside this request's
               evidence window; a missing suite/entry is environment-
               proven non-dispatch (not-sent), an AEGP error is failed
               with mayHaveMutated=false (read-only getter). */
            AEGP_ItemType itype = (AEGP_ItemType)ArgsInt(allow, args, 0);
            const void* suite = IntakeAcquireSuite(
                utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
            if (!suite)
            {
                snprintf(v.outcome, sizeof(v.outcome), "not-sent");
                snprintf(v.detail, sizeof(v.detail),
                         "AEGP Item Suite unavailable for GetTypeName");
                v.havePayload = 0; v.mayHaveMutated = 0; v.publish = 1;
                goto verdict;
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
                    snprintf(v.outcome, sizeof(v.outcome), "not-sent");
                    snprintf(v.detail, sizeof(v.detail),
                             "AEGP_GetTypeName entry unavailable");
                    v.havePayload = 0; v.mayHaveMutated = 0; v.publish = 1;
                    goto verdict;
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
                    snprintf(v.outcome, sizeof(v.outcome), "completed");
                    snprintf(v.payload, sizeof(v.payload),
                             "{\"typeName\":\"%s\"}", esc);
                    v.payload[sizeof(v.payload) - 1] = '\0';
                    v.havePayload = 1;
                    v.mayHaveMutated = 0;
                }
                else
                {
                    snprintf(v.outcome, sizeof(v.outcome), "failed");
                    snprintf(v.detail, sizeof(v.detail),
                             "AEGP_GetTypeName err=%ld", (long)oerr);
                    v.havePayload = 0;
                    v.mayHaveMutated = 0; /* read-only getter */
                }
            }
        }
        else
        {
            VerdictRefuse(&v, "OPERATION_NOT_DISPATCHABLE", "allowlist entry has no executor");
        }
    verdict:
        ;
    }

tail:
    s_collecting = 0;
    /* opCalls: ids emitted inside this request's window */
    oc = 0;
    opCallsJson[0] = '\0';
    if (s_opcalls_count > 0)
    {
        oc += (size_t)snprintf(opCallsJson + oc, sizeof(opCallsJson) - oc, "[");
        for (i = 0; i < s_opcalls_count && oc < sizeof(opCallsJson) - 96; i++)
        {
            oc += (size_t)snprintf(opCallsJson + oc, sizeof(opCallsJson) - oc,
                                   "%s\"%s\"", i ? "," : "", s_opcalls[i]);
        }
        oc += (size_t)snprintf(opCallsJson + oc, sizeof(opCallsJson) - oc, "]");
    }
    IntakeLogf(utilP, "native.result id=%s outcome=%s%s%s",
               stemZ, v.outcome,
               v.refusal[0] ? " code=" : "",
               v.refusal[0] ? v.refusal : "");
    if (EmitResult(outDoc, sizeof(outDoc), plugin_id, stemZ,
                   v.outcome, v.refusal[0] ? v.refusal : NULL,
                   v.havePayload ? v.payload : NULL,
                   v.mayHaveMutated,
                   s_opcalls_count > 0 ? opCallsJson : NULL,
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

/* ---- heartbeat -------------------------------------------------------- */

static void WriteHeartbeat(
    const AEGP_UtilitySuite6* utilP,
    AEGP_PluginID plugin_id,
    const char* statePathZ,
    const char* outboxDirZ)
{
    char doc[1024];
    char allowJson[512];
    size_t o = 0;
    int i;
    long long now = NowMs();

    allowJson[0] = '\0';
    o = 0;
    o += (size_t)snprintf(allowJson + o, sizeof(allowJson) - o, "[");
    for (i = 0; i < S_ALLOWLIST_COUNT && o < sizeof(allowJson) - 96; i++)
        o += (size_t)snprintf(allowJson + o, sizeof(allowJson) - o,
                              "%s\"%s\"", i ? "," : "", S_ALLOWLIST[i].operationId);
    o += (size_t)snprintf(allowJson + o, sizeof(allowJson) - o, "]");

    o = 0;
    o += (size_t)snprintf(doc + o, sizeof(doc) - o,
        "{\"v\":1,\"instance\":\"%s\",\"pluginId\":%ld,\"lastTick\":%lld",
        s_instance, (long)plugin_id, now);
    if (s_observed_version[0])
        o += (size_t)snprintf(doc + o, sizeof(doc) - o, ",\"aeVersion\":\"%s\"",
                              s_observed_version);
    o += (size_t)snprintf(doc + o, sizeof(doc) - o,
        ",\"allowlist\":%s}", allowJson);
    doc[sizeof(doc) - 1] = '\0';

    if (WriteFileAtomic(statePathZ, doc, strlen(doc)) != 0)
    {
        IntakeLogOnce(&s_misc_logged, utilP, "native.error: state.json publish failed");
    }

    /* sweep stale outbox results (>1h) — deliveries nobody read */
    {
        DIR* d = opendir(outboxDirZ);
        if (d)
        {
            struct dirent* de;
            while ((de = readdir(d)) != NULL)
            {
                char fp[PATH_MAX_LOCAL];
                size_t nl = strlen(de->d_name);
                if (nl < 13 || strcmp(de->d_name + nl - 12, ".result.json") != 0)
                    continue;
                JoinPath(fp, sizeof(fp), outboxDirZ, de->d_name);
                if (FileMtimeMs(fp) >= 0 && now - FileMtimeMs(fp) > OUTBOX_MAX_AGE_MS)
                    remove(fp);
            }
            closedir(d);
        }
    }
    s_last_state_tick = s_ticks;
}

/* ---- per-tick poll ----------------------------------------------------- */

void NativeIntakeTick(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id)
{
    char inboxDir[PATH_MAX_LOCAL], outboxDir[PATH_MAX_LOCAL], statePath[PATH_MAX_LOCAL];
    char token[65], pin[48];
    DIR* d;
    struct dirent* de;
    char names[64][320];
    int count = 0;
    int i, j;

    if (!s_channel_root[0]) return;
    s_ticks++;

    if (!ChannelReady(utilP, inboxDir, sizeof(inboxDir), outboxDir, sizeof(outboxDir),
                      statePath, sizeof(statePath), token, pin, sizeof(pin)))
        return;

    if (s_ticks == 1 || s_ticks - s_last_state_tick >= STATE_EVERY_TICKS)
        WriteHeartbeat(utilP, plugin_id, statePath, outboxDir);

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
                    !(tgt->slen == strlen(s_instance) &&
                      memcmp(tgt->str, s_instance, tgt->slen) == 0))
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
                           outboxDir, token, pin,
                           FileMtimeMs(claimedPath));
            remove(claimedPath);
        }
        break; /* one request per tick */
    }
}

/* ---- lifecycle -------------------------------------------------------- */

void NativeIntakeConfigure(const char* channelRootZ)
{
    memset(s_channel_root, 0, sizeof(s_channel_root));
    s_instance[0] = '\0';
    s_ticks = 0;
    s_last_state_tick = -1;
    s_observed_version[0] = '\0';
    s_seen_count = 0;
    memset(s_seen, 0, sizeof(s_seen));
    s_priv_logged = 0;
    s_misc_logged = 0;
    s_opcalls_count = 0;
    s_collecting = 0;

    if (!channelRootZ || !channelRootZ[0]) return;
    if (strlen(channelRootZ) >= sizeof(s_channel_root) - 8) return;
    /* must be absolute */
    if (channelRootZ[0] != '/') return;
    strncpy(s_channel_root, channelRootZ, sizeof(s_channel_root) - 1);
    s_channel_root[sizeof(s_channel_root) - 1] = '\0';
    MakeInstance(s_instance, sizeof(s_instance));
    s_intake_ready = 1;
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
