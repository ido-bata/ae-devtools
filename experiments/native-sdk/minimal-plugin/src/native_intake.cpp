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
#define OPCALLS_MAX 24
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
    /* opCalls is a unique-id set: enumeration/resolution emit the same
       member repeatedly and duplicates carry no extra linkage. */
    if (s_collecting && s_opcalls_count < OPCALLS_MAX)
    {
        int i, dup = 0;
        for (i = 0; i < s_opcalls_count; i++)
            if (strcmp(s_opcalls[i], idZ) == 0) { dup = 1; break; }
        if (!dup) s_opcalls[s_opcalls_count++] = idZ;
    }
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

enum
{
    ARGK_INT = 0,   /* bounded integer: min..max inclusive */
    ARGK_AEREFITEM /* aeRef project-item descriptor (Issue #270 Stage 3) */
};

typedef struct
{
    const char* name; /* args object key */
    int kind;         /* ARGK_* */
    double min;       /* ARGK_INT: inclusive bounds (integral values only) */
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
    { "itemType", ARGK_INT, 1.0, 4.0 },
};

/* AEGP_ItemSuite9.AEGP_GetItemName / AEGP_GetItemID (Issue #270
   identity slice): the item handle is resolved host-side from an aeRef
   descriptor. `projectIndex` selects the project via
   AEGP_GetProjectByIndex (bounds-checked → STALE_REFERENCE); `item` is
   the §7b descriptor — legacy {type,name,path} or identity-bearing
   {type,name,path,itemId?,projectName?,projectPath?}. */
static const IntakeArgSpec S_AEREF_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "item", ARGK_AEREFITEM, 0.0, 0.0 },
};

/* AEGP_ItemSuite9.AEGP_GetFirstProjItem as the discovery/enumeration
   op (Issue #270 identity slice): {projectIndex, offset, limit}. */
static const IntakeArgSpec S_FIRSTITEM_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "offset", ARGK_INT, 0.0, 1000000.0 },
    { "limit", ARGK_INT, 1.0, 32.0 },
};

/* CompSuite13 read-only getters (Issue #318 / #64): the comp handle is
   NEVER taken from the wire — `comp` is the same §7b aeRef item
   descriptor (type must be "comp"); the executor resolves it to an
   itemH via the shared resolver, then maps itemH → compH through
   AEGP_GetCompFromItem inside the request window. */
static const IntakeArgSpec S_COMP_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "comp", ARGK_AEREFITEM, 0.0, 0.0 },
};

static const AllowEntry S_ALLOWLIST[] = {
    { "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ProjSuite6.AEGP_GetNumProjects", NULL, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion", NULL, 0 },
    { "AEGP_ItemSuite9.AEGP_GetTypeName",
      "AEGP_ItemSuite9.AEGP_GetTypeName", S_TYPENAME_ARGS, 1 },
    { "AEGP_ItemSuite9.AEGP_GetItemName",
      "AEGP_ItemSuite9.AEGP_GetItemName", S_AEREF_ARGS, 2 },
    /* Issue #270 identity slice: GetItemID is descriptor issuance
       (resolve → read live id + project identity → canonical aeRef);
       GetFirstProjItem is discovery/enumeration. Both reuse the same
       identity resolver — no per-kind resolver duplication. */
    { "AEGP_ItemSuite9.AEGP_GetItemID",
      "AEGP_ItemSuite9.AEGP_GetItemID", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
      "AEGP_ItemSuite9.AEGP_GetFirstProjItem", S_FIRSTITEM_ARGS, 3 },
    /* Issue #318 / #64: CompSuite13 read-only getters. All share the
       {projectIndex, comp:<aeRefItem type=comp>} contract; the comp
       handle is derived host-side via AEGP_GetCompFromItem — never
       taken from the wire. GetCompShutterFrameRange is excluded: it
       takes an A_Time input argument (arg-bearing ops are a separate
       slice). */
    { "AEGP_CompSuite13.AEGP_GetCompFramerate",
      "AEGP_CompSuite13.AEGP_GetCompFramerate", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompFrameDuration",
      "AEGP_CompSuite13.AEGP_GetCompFrameDuration", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime",
      "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame",
      "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor",
      "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName",
      "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetShowBlendModes",
      "AEGP_CompSuite13.AEGP_GetShowBlendModes", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples",
      "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit",
      "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompBGColor",
      "AEGP_CompSuite13.AEGP_GetCompBGColor", S_COMP_ARGS, 2 },
    { "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase",
      "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase", S_COMP_ARGS, 2 },
    /* Issue #318 / #63: ItemSuite9 read-only detail getters that take
       AEGP_ItemH — same {projectIndex, item:<aeRefItem>} contract as
       GetItemName; the resolved handle is used directly (no derived
       handle). GetItemParentFolder and GetItemMRUView stay out: they
       return host handles of other identity kinds (folder item /
       item-view) that need their own descriptor story first. */
    { "AEGP_ItemSuite9.AEGP_GetItemType",
      "AEGP_ItemSuite9.AEGP_GetItemType", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemFlags",
      "AEGP_ItemSuite9.AEGP_GetItemFlags", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_IsItemSelected",
      "AEGP_ItemSuite9.AEGP_IsItemSelected", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemLabel",
      "AEGP_ItemSuite9.AEGP_GetItemLabel", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemDuration",
      "AEGP_ItemSuite9.AEGP_GetItemDuration", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemCurrentTime",
      "AEGP_ItemSuite9.AEGP_GetItemCurrentTime", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemDimensions",
      "AEGP_ItemSuite9.AEGP_GetItemDimensions", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio",
      "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio", S_AEREF_ARGS, 2 },
    { "AEGP_ItemSuite9.AEGP_GetItemComment",
      "AEGP_ItemSuite9.AEGP_GetItemComment", S_AEREF_ARGS, 2 },
    /* Issue #270 Stage 2: zero-arg read-only getters needing no
       identity resolution. The three UtilitySuite members use the
       already-held utilP; the two render-queue members acquire their
       suite inside the request window like GetTypeName. */
    { "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion", NULL, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
      "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI", NULL, 0 },
    { "AEGP_UtilitySuite6.AEGP_HostIsActivated",
      "AEGP_UtilitySuite6.AEGP_HostIsActivated", NULL, 0 },
    { "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
      "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState", NULL, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
      "AEGP_RQItemSuite4.AEGP_GetNumRQItems", NULL, 0 },
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

static int ValidateAeRefItem(JVal* v, char* detailZ, size_t detailCap);
static int AeRefTypeToItemType(JVal* typeV, AEGP_ItemType* outP);

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
        if (spec->kind == ARGK_AEREFITEM)
        {
            if (!ValidateAeRefItem(v, detailZ, detailCap)) return 0;
            continue;
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

/* aeRef project-item descriptor shape check (Issue #270, identity
   slice; contract native-channel.md §7b). Wire form:
     {"aeRef":{"type":"folder"|"comp"|"footage","name":"<str>",
               "path":[<non-neg int>],
               "itemId"?:<int>,"projectName"?:"<str>","projectPath"?:"<str>"}}
   Required keys: type, name, path (Stage-3 form). Optional identity
   keys: itemId (integer in [0, 4294967295]), projectName/projectPath
   (strings ≤ 4096 UTF-8 bytes; projectPath may be empty). Any other inner
   key — including contentHash — refuses MALFORMED_REQUEST.
   This proves SHAPE only; resolution against live state happens in
   the executor and its failure is STALE_REFERENCE. */
#define AEREF_MAX_STR 4096
#define AEREF_MAX_ITEMID 4294967295.0
#define AEREF_NAME_MAX 1024   /* UTF-8 bytes; longer live names are undescribable */

static int AeRefKeyAllowed(const char* keyZ, size_t klen)
{
    static const char* keys[] = {
        "type", "name", "path", "itemId", "projectName", "projectPath"
    };
    size_t i;
    for (i = 0; i < sizeof(keys) / sizeof(keys[0]); i++)
        if (strlen(keys[i]) == klen && memcmp(keyZ, keys[i], klen) == 0)
            return 1;
    return 0;
}

static int ValidateAeRefItem(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* nameV;
    JVal* pathV;
    JVal* idxV;
    JVal* idV;
    JVal* pnV;
    JVal* ppV;
    size_t i;
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRef arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs < 3 || ref->npairs > 6)
    {
        snprintf(detailZ, detailCap,
                 "aeRef must carry type,name,path plus optional itemId/projectName/projectPath");
        return 0;
    }
    /* every key must be in the permitted set; required keys checked below */
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        if (!AeRefKeyAllowed(p->key, p->klen))
        {
            snprintf(detailZ, detailCap,
                     "aeRef carries unsupported key (contentHash unsupported)");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    nameV = JGet(ref, "name");
    pathV = JGet(ref, "path");
    idV = JGet(ref, "itemId");
    pnV = JGet(ref, "projectName");
    ppV = JGet(ref, "projectPath");
    if (!typeV || !nameV || !pathV)
    {
        snprintf(detailZ, detailCap, "aeRef requires type, name, path");
        return 0;
    }
    if (typeV->kind != JK_STR ||
        !(JStrEq(typeV, "folder") || JStrEq(typeV, "comp") || JStrEq(typeV, "footage")))
    {
        snprintf(detailZ, detailCap, "aeRef.type must be folder|comp|footage");
        return 0;
    }
    if (nameV->kind != JK_STR || nameV->slen == 0 ||
        nameV->slen > AEREF_NAME_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRef.name must be a non-empty string ≤ 1024 UTF-8 bytes");
        return 0;
    }
    if (pathV->kind != JK_ARR || pathV->nitems != 1)
    {
        snprintf(detailZ, detailCap,
                 "aeRef.path must be [<index>] — one top-level item index");
        return 0;
    }
    idxV = pathV->items[0];
    if (!idxV || idxV->kind != JK_NUM || !isfinite(idxV->num) ||
        floor(idxV->num) != idxV->num || idxV->num < 0.0 || idxV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap, "aeRef.path[0] must be a non-negative integer");
        return 0;
    }
    if (idV && (idV->kind != JK_NUM || !isfinite(idV->num) ||
                floor(idV->num) != idV->num || idV->num < 0.0 ||
                idV->num > AEREF_MAX_ITEMID))
    {
        snprintf(detailZ, detailCap,
                 "aeRef.itemId must be an integer in [0, 4294967295]");
        return 0;
    }
    if (pnV && (pnV->kind != JK_STR || pnV->slen > AEREF_MAX_STR))
    {
        snprintf(detailZ, detailCap, "aeRef.projectName must be a string ≤ 4096 chars");
        return 0;
    }
    if (ppV && (ppV->kind != JK_STR || ppV->slen > AEREF_MAX_STR))
    {
        snprintf(detailZ, detailCap, "aeRef.projectPath must be a string ≤ 4096 chars");
        return 0;
    }
    return 1;
}

/* Map the aeRef type tag to the AEGP_ItemType it claims. Only the three
   live item kinds are expressible; SOLID_defunct has no live identity. */
static int AeRefTypeToItemType(JVal* typeV, AEGP_ItemType* outP)
{
    if (JStrEq(typeV, "folder")) { *outP = AEGP_ItemType_FOLDER; return 1; }
    if (JStrEq(typeV, "comp")) { *outP = AEGP_ItemType_COMP; return 1; }
    if (JStrEq(typeV, "footage")) { *outP = AEGP_ItemType_FOOTAGE; return 1; }
    return 0;
}

/* Inverse of AeRefTypeToItemType for payload emission. Returns NULL for
   types with no descriptor tag (NONE, SOLID_defunct, undefined). */
static const char* ItemTypeToAeRefTag(AEGP_ItemType t)
{
    if (t == AEGP_ItemType_FOLDER) return "folder";
    if (t == AEGP_ItemType_COMP) return "comp";
    if (t == AEGP_ItemType_FOOTAGE) return "footage";
    return NULL;
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

/* ---- UTF-16 mem-handle reads (Issue #270 Stage 3) -------------------
   AEGP name/path getters return AEGP_MemHandle blocks of A_UTF16Char.
   Same discipline as probe.cpp's ReadMemHandleUtf8: size comes from
   AEGP_GetMemHandleSize (bytes → code units), every lock is paired
   with unlock, the handle is freed on every path, and every suite
   call is op-recorded into the request window. */

static int IntakeUtf16ToUtf8(
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
        if (cp == 0) break;
        if (cp >= 0xD800 && cp <= 0xDBFF)
        {
            if (i < max_unitsL && srcP[i] >= 0xDC00 && srcP[i] <= 0xDFFF)
                cp = 0x10000 + ((cp - 0xD800) << 10) + (srcP[i++] - 0xDC00);
            else
                cp = 0xFFFD;
        }
        else if (cp >= 0xDC00 && cp <= 0xDFFF)
        {
            cp = 0xFFFD;
        }
        need = (cp < 0x80) ? 1 : (cp < 0x800) ? 2 : (cp < 0x10000) ? 3 : 4;
        if (di + need + 1 > dstSize) { truncatedB = 1; break; }
        if (cp < 0x80) dstP[di++] = (char)cp;
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

typedef enum
{
    IMH_OK = 0,
    IMH_NULL_HANDLE,
    IMH_NOENTRIES,
    IMH_SIZE_ERR,
    IMH_LOCK_ERR,
    IMH_TRUNCATED
} IntakeMemStatus;

static void IntakeFreeMemHandle(
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
static IntakeMemStatus IntakeReadMemHandleUtf8(
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

/* ---- request processing ---------------------------------------------- */

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

static void VerdictRefuse(ReqVerdict* r, const char* codeZ, const char* detailZ)
{
    snprintf(r->outcome, sizeof(r->outcome), "refused");
    snprintf(r->refusal, sizeof(r->refusal), "%s", codeZ);
    snprintf(r->detail, sizeof(r->detail), "%s", detailZ ? detailZ : "");
    r->havePayload = 0;
    r->mayHaveMutated = 0;
    r->publish = 1;
}

/* ---- identity resolution + payload emit (Issue #270 identity slice)
   Contract: native-channel.md §7b. One shared resolver serves every
   identity-bearing intake op — project/comp/layer/RQ-item descriptor
   kinds extend THIS structure later, not parallel resolvers. */

#define PROJ_STR_MAX 4096     /* projectPath fetch bound (= descriptor bound) */
#define RESOLVE_SCAN_MAX 100000L
#define ENUM_LIMIT_MAX 32

typedef struct
{
    AEGP_ProjectH projectH;
    AEGP_ItemH itemH;
    long index;                 /* live top-level iteration position */
    AEGP_ItemType type;
    int nameTruncated;          /* live name exceeded AEREF_NAME_MAX */
    char name[AEREF_NAME_MAX + 1];
    char projectName[AEGP_MAX_PROJ_NAME_SIZE + 1];
    char projectPath[PROJ_STR_MAX + 1];
    int haveProjectName;
    int haveProjectPath;
    const void* itemSuite;
    const void* memSuite;
    const AEGP_ItemSuite9* itemP;
    const AEGP_MemorySuite1* memP;
} ItemResolution;

static void ReleaseResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    ItemResolution* r)
{
    if (r->itemSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (r->memSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    memset(r, 0, sizeof(*r));
}

/* Bounded JSON emit cursor — overflow is flagged, never silently
   truncated mid-token. */
typedef struct
{
    char* cur;
    size_t left;
    int of;
} JBuf;

static void JBInit(JBuf* b, char* buf, size_t cap)
{
    b->cur = buf;
    b->left = cap;
    b->of = 0;
}
static void JBPut(JBuf* b, const char* s)
{
    size_t n = strlen(s);
    if (n >= b->left) { b->of = 1; b->left = 0; return; }
    memcpy(b->cur, s, n);
    b->cur += n;
    b->left -= n;
}
static void JBPutc(JBuf* b, char c)
{
    if (b->left < 2) { b->of = 1; return; }
    *b->cur++ = c;
    b->left--;
}
static void JBNum(JBuf* b, long v)
{
    char t[24];
    snprintf(t, sizeof(t), "%ld", v);
    JBPut(b, t);
}
static void JBEsc(JBuf* b, const char* s)
{
    const unsigned char* u = (const unsigned char*)s;
    while (*u)
    {
        unsigned char c = *u++;
        if (c == '"' || c == '\\') { JBPutc(b, '\\'); JBPutc(b, (char)c); }
        else if (c == '\n') JBPut(b, "\\n");
        else if (c == '\r') JBPut(b, "\\r");
        else if (c == '\t') JBPut(b, "\\t");
        else if (c < 0x20)
        {
            char t[8];
            snprintf(t, sizeof(t), "\\u%04x", c);
            JBPut(b, t);
        }
        else JBPutc(b, (char)c);
    }
}

/* Read the project's display name (A_char, bounded) and file path
   (UTF-16 mem handle → UTF-8). wantName/wantPath select which reads
   run; every call is op-recorded. Returns FPI_* status. */
enum { FPI_OK = 0, FPI_AEGP_ERR, FPI_TRUNCATED };
static int FetchProjectIdentity(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AEGP_MemorySuite1* memP,
    AEGP_ProjectH projectH,
    int wantName, int wantPath,
    char* nameOut, size_t nameCap,
    char* pathOut, size_t pathCap,
    A_Err* errP)
{
    *errP = A_Err_NONE;
    nameOut[0] = '\0';
    pathOut[0] = '\0';
    if (wantName)
    {
        A_char nb[AEGP_MAX_PROJ_NAME_SIZE + 1];
        A_Err e;
        if (!projP->AEGP_GetProjectName) { *errP = A_Err_STRUCT; return FPI_AEGP_ERR; }
        memset(nb, 0, sizeof(nb));
        e = projP->AEGP_GetProjectName(projectH, nb);
        IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectName", (long)e, NULL);
        if (e != A_Err_NONE) { *errP = e; return FPI_AEGP_ERR; }
        strncpy(nameOut, nb, nameCap - 1);
        nameOut[nameCap - 1] = '\0';
    }
    if (wantPath)
    {
        AEGP_MemHandle ph = NULL;
        A_Err e;
        IntakeMemStatus ms;
        if (!projP->AEGP_GetProjectPath || !memP) { *errP = A_Err_STRUCT; return FPI_AEGP_ERR; }
        e = projP->AEGP_GetProjectPath(projectH, &ph);
        IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectPath", (long)e, NULL);
        if (e != A_Err_NONE) { *errP = e; return FPI_AEGP_ERR; }
        ms = IntakeReadMemHandleUtf8(utilP, memP, ph, pathOut, pathCap);
        if (ms == IMH_TRUNCATED) return FPI_TRUNCATED;
        if (ms != IMH_OK) { *errP = A_Err_STRUCT; return FPI_AEGP_ERR; }
    }
    return FPI_OK;
}

/* Exact-match a descriptor string field (JVal, slen bytes — may hold
   embedded NULs) against a NUL-terminated live string. */
static int JStrEqCStr(JVal* v, const char* liveZ)
{
    size_t n = strlen(liveZ);
    return v && v->kind == JK_STR && v->slen == n &&
           memcmp(v->str, liveZ, n) == 0;
}

/* Resolve a validated aeRef descriptor to a live item inside the
   request window (contract §7b). `ref` is the aeRef object; shape was
   proven by ValidateArgs. wantProjectIdentity forces the project
   name/path fetch even when the descriptor does not carry them
   (issuance/enumeration payloads need the values).
   nameCallExtraZ marks the GetItemName record (" (resolve+result)"
   when the consuming op IS GetItemName, " (resolve)" otherwise).
   On success returns 1: r is filled and its suites stay acquired —
   the caller MUST ReleaseResolution before leaving the request.
   On failure returns 0 with `v` already carrying the verdict
   (refused STALE_REFERENCE / failed / not-sent). */
static int ResolveAeRefItem(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* ref,
    int wantProjectIdentity,
    const char* nameCallExtraZ,
    ItemResolution* r,
    ReqVerdict* v)
{
    JVal* typeV = JGet(ref, "type");
    JVal* nameV = JGet(ref, "name");
    JVal* pathV = JGet(ref, "path");
    JVal* idV = JGet(ref, "itemId");
    JVal* pnV = JGet(ref, "projectName");
    JVal* ppV = JGet(ref, "projectPath");
    AEGP_ItemType wantType = AEGP_ItemType_NONE;
    long wantIndex = -1;
    long wantId = -1;
    int haveId = 0;
    int wantName, wantPath;
    const void* itemSuite = NULL;
    const void* memSuite = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    AEGP_ProjectH projectH = NULL;
    AEGP_ItemH itemH = NULL;
    A_Err perr;

    memset(r, 0, sizeof(*r));
    AeRefTypeToItemType(typeV, &wantType); /* shape already validated */
    if (pathV && pathV->kind == JK_ARR && pathV->nitems == 1 &&
        pathV->items[0] && pathV->items[0]->kind == JK_NUM)
        wantIndex = (long)pathV->items[0]->num;
    if (idV) { wantId = (long)idV->num; haveId = 1; }

    /* project selection — projP is the fingerprint-held suite */
    wantName = wantProjectIdentity || pnV != NULL;
    wantPath = wantProjectIdentity || ppV != NULL;
    if (!projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex ||
        (wantName && !projP->AEGP_GetProjectName) ||
        (wantPath && !projP->AEGP_GetProjectPath))
    {
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "project suite entries unavailable for identity resolve");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return 0;
    }
    {
        A_long numProjects = 0;
        perr = projP->AEGP_GetNumProjects(&numProjects);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetNumProjects", (long)perr,
            perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE)
        {
            snprintf(v->outcome, sizeof(v->outcome), "failed");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetNumProjects err=%ld", (long)perr);
            v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
            return 0;
        }
        if (projectIndex < 0 || projectIndex >= (long)numProjects)
        {
            VerdictRefuse(v, "STALE_REFERENCE", "projectIndex out of range");
            return 0;
        }
        perr = projP->AEGP_GetProjectByIndex(projectIndex, &projectH);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetProjectByIndex", (long)perr,
            perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE || !projectH)
        {
            snprintf(v->outcome, sizeof(v->outcome), "failed");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetProjectByIndex err=%ld", (long)perr);
            v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
            return 0;
        }
    }

    /* item + memory suites inside the request window */
    itemSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPItemSuite, kAEGPItemSuiteVersion9);
    memSuite = IntakeAcquireSuite(utilP, basicP,
                                  kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (!itemSuite || !memSuite)
    {
        if (itemSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPItemSuite, kAEGPItemSuiteVersion9);
        if (memSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "item/memory suite unavailable for identity resolve");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return 0;
    }
    itemP = (const AEGP_ItemSuite9*)itemSuite;
    memP = (const AEGP_MemorySuite1*)memSuite;
    r->itemSuite = itemSuite;
    r->memSuite = memSuite;
    r->itemP = itemP;
    r->memP = memP;
    r->projectH = projectH;

#define RESOLVE_NOT_SENT(msg) do { \
        ReleaseResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RESOLVE_FAILED(fmt, err) do { \
        ReleaseResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RESOLVE_STALE(why) do { \
        ReleaseResolution(utilP, basicP, r); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    if (!itemP->AEGP_GetFirstProjItem || !itemP->AEGP_GetNextProjItem ||
        !itemP->AEGP_GetItemType || !itemP->AEGP_GetItemName ||
        (haveId && !itemP->AEGP_GetItemID))
        RESOLVE_NOT_SENT("item suite entries unavailable for identity resolve");

    /* project corroboration + payload identity fields */
    {
        A_Err ferr = A_Err_NONE;
        int fpi = FetchProjectIdentity(utilP, projP, memP, projectH,
                                     wantName, wantPath,
                                     r->projectName, sizeof(r->projectName),
                                     r->projectPath, sizeof(r->projectPath),
                                     &ferr);
        if (fpi == FPI_AEGP_ERR)
            RESOLVE_FAILED("project identity read err=%ld", ferr);
        if (fpi == FPI_TRUNCATED)
            RESOLVE_FAILED("project path exceeds descriptor bound err=%ld", ferr);
        r->haveProjectName = wantName;
        r->haveProjectPath = wantPath;
        if (pnV && !JStrEqCStr(pnV, r->projectName))
            RESOLVE_STALE("project name mismatch");
        if (ppV && !JStrEqCStr(ppV, r->projectPath))
            RESOLVE_STALE("project path mismatch");
    }

    /* item resolution: itemId present → authoritative id scan;
       absent → legacy positional path walk (Stage-3 semantics). */
    {
        A_Err ierr = itemP->AEGP_GetFirstProjItem(projectH, &itemH);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetFirstProjItem", (long)ierr,
            ierr == A_Err_NONE ? " (resolve)" : NULL);
        if (ierr != A_Err_NONE)
            RESOLVE_FAILED("AEGP_GetFirstProjItem err=%ld", ierr);
    }
    if (haveId)
    {
        /* scan every top-level item for exactly one itemId match —
           reorder-tolerant; path is not consulted. */
        AEGP_ItemH matchH = NULL;
        long matchPos = -1;
        long matches = 0;
        long pos = 0;
        while (itemH)
        {
            if (pos >= RESOLVE_SCAN_MAX)
                RESOLVE_FAILED("item scan limit exceeded err=%ld", (long)pos);
            {
                A_long id = 0;
                A_Err iderr = itemP->AEGP_GetItemID(itemH, &id);
                IntakeOpRecord(utilP,
                    "AEGP_ItemSuite9.AEGP_GetItemID", (long)iderr,
                    iderr == A_Err_NONE ? " (resolve)" : NULL);
                if (iderr != A_Err_NONE)
                    RESOLVE_FAILED("AEGP_GetItemID err=%ld", iderr);
                /* A_long is int32; the wire itemId range is u32 —
                   compare bit-exact so ids with the sign bit set still
                   match instead of silently never resolving. */
                if ((unsigned int)id == (unsigned int)wantId)
                { matches++; matchH = itemH; matchPos = pos; }
            }
            {
                AEGP_ItemH nextH = NULL;
                A_Err nerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
                IntakeOpRecord(utilP,
                    "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)nerr,
                    nerr == A_Err_NONE ? " (resolve)" : NULL);
                if (nerr != A_Err_NONE)
                    RESOLVE_FAILED("AEGP_GetNextProjItem err=%ld", nerr);
                itemH = nextH;
                pos++;
            }
        }
        if (matches == 0)
            RESOLVE_STALE("itemId not found");
        if (matches > 1)
            RESOLVE_STALE("itemId ambiguous");
        itemH = matchH;
        r->index = matchPos;
    }
    else
    {
        /* legacy positional walk to path[0] */
        long pos = 0;
        while (itemH && pos < wantIndex)
        {
            AEGP_ItemH nextH = NULL;
            A_Err nerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
            IntakeOpRecord(utilP,
                "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)nerr,
                nerr == A_Err_NONE ? " (resolve)" : NULL);
            if (nerr != A_Err_NONE) { itemH = NULL; break; }
            itemH = nextH;
            pos++;
        }
        if (!itemH || pos != wantIndex)
            RESOLVE_STALE("item path index out of range");
        r->index = wantIndex;
    }
    r->itemH = itemH;

    /* corroboration: type + name must match the descriptor in BOTH
       modes — a renamed item stales its descriptor (client re-issues). */
    {
        AEGP_ItemType actualType = AEGP_ItemType_NONE;
        A_Err terr = itemP->AEGP_GetItemType(itemH, &actualType);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetItemType", (long)terr,
            terr == A_Err_NONE ? " (resolve)" : NULL);
        if (terr != A_Err_NONE)
            RESOLVE_FAILED("AEGP_GetItemType err=%ld", terr);
        if (actualType != wantType)
            RESOLVE_STALE("item type mismatch");
        r->type = actualType;
    }
    {
        AEGP_MemHandle nameH = NULL;
        A_Err nerr = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetItemName", (long)nerr,
            nerr == A_Err_NONE ? nameCallExtraZ : NULL);
        if (nerr != A_Err_NONE)
            RESOLVE_FAILED("AEGP_GetItemName err=%ld", nerr);
        {
            IntakeMemStatus mst =
                IntakeReadMemHandleUtf8(utilP, memP, nameH,
                                        r->name, sizeof(r->name));
            if (mst != IMH_OK && mst != IMH_TRUNCATED)
                RESOLVE_FAILED("item name mem-handle read failed err=%ld", (long)mst);
            r->nameTruncated = (mst == IMH_TRUNCATED);
            if (r->nameTruncated)
                RESOLVE_STALE("item name exceeds identity bound");
            if (nameV->slen != strlen(r->name) ||
                memcmp(nameV->str, r->name, nameV->slen) != 0)
                RESOLVE_STALE("item name mismatch");
        }
    }

#undef RESOLVE_NOT_SENT
#undef RESOLVE_FAILED
#undef RESOLVE_STALE
    return 1;
}

/* Emit the canonical issued descriptor for a resolved item:
   {"itemId":N,"item":{"aeRef":{...}}} — result.item is stored
   verbatim as args.item by the client. Returns 1 on success; 0 when
   the payload would exceed the result bound or the type has no tag. */
static int EmitIssuedDescriptor(
    ReqVerdict* v,
    const ItemResolution* r,
    long itemId)
{
    const char* tag = ItemTypeToAeRefTag(r->type);
    JBuf b;
    if (!tag) return 0;
    JBInit(&b, v->payload, sizeof(v->payload));
    JBPut(&b, "{\"itemId\":");
    JBNum(&b, itemId);
    JBPut(&b, ",\"item\":{\"aeRef\":{\"type\":\"");
    JBPut(&b, tag);
    JBPut(&b, "\",\"name\":\"");
    JBEsc(&b, r->name);
    JBPut(&b, "\",\"path\":[");
    JBNum(&b, r->index);
    JBPut(&b, "],\"itemId\":");
    JBNum(&b, itemId);
    if (r->haveProjectName)
    {
        JBPut(&b, ",\"projectName\":\"");
        JBEsc(&b, r->projectName);
        JBPut(&b, "\"");
    }
    if (r->haveProjectPath)
    {
        JBPut(&b, ",\"projectPath\":\"");
        JBEsc(&b, r->projectPath);
        JBPut(&b, "\"");
    }
    JBPut(&b, "}}}");
    if (b.of) return 0;
    *b.cur = '\0';
    return 1;
}

/* Emit one enumeration item entry. Normal items get a complete usable
   descriptor; names over the identity bound get an honest marker. */
static void EmitEnumItem(
    JBuf* b,
    long index,
    AEGP_ItemType type,
    const char* nameZ,
    int nameTruncated,
    long itemId,
    const char* projectNameZ,
    const char* projectPathZ)
{
    const char* tag = ItemTypeToAeRefTag(type);
    if (!tag)
    {
        /* live item kind with no descriptor tag (e.g. solid): report
           honestly, never emit a partial/invalid aeRef. */
        JBPut(b, "{\"index\":");
        JBNum(b, index);
        JBPut(b, ",\"unsupportedType\":true}");
        return;
    }
    if (nameTruncated)
    {
        JBPut(b, "{\"index\":");
        JBNum(b, index);
        JBPut(b, ",\"type\":\"");
        JBPut(b, tag);
        JBPut(b, "\",\"itemId\":");
        JBNum(b, itemId);
        JBPut(b, ",\"nameTruncated\":true}");
        return;
    }
    JBPut(b, "{\"item\":{\"aeRef\":{\"type\":\"");
    JBPut(b, tag);
    JBPut(b, "\",\"name\":\"");
    JBEsc(b, nameZ);
    JBPut(b, "\",\"path\":[");
    JBNum(b, index);
    JBPut(b, "],\"itemId\":");
    JBNum(b, itemId);
    JBPut(b, ",\"projectName\":\"");
    JBEsc(b, projectNameZ);
    JBPut(b, "\",\"projectPath\":\"");
    JBEsc(b, projectPathZ);
    JBPut(b, "\"}}}");
}

/* AEGP_ItemSuite9.AEGP_GetFirstProjItem as discovery/enumeration
   (Issue #270 identity slice): {projectIndex, offset, limit} →
   ready-to-use aeRef descriptors for the project's top-level items.
   Walks the full list once (total is exact), emits the [offset,
   offset+limit) window, pages via offset. Every call op-recorded;
   failures are typed verdicts, never partial payloads. */
static void EnumerateProjItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const char* opRecordIdZ,
    JVal* args,
    ReqVerdict* v)
{
    long projectIndex = (long)JGet(args, "projectIndex")->num;
    long offset = (long)JGet(args, "offset")->num;
    long limit = (long)JGet(args, "limit")->num;
    AEGP_ProjectH projectH = NULL;
    AEGP_ItemH itemH = NULL;
    const void* itemSuite = NULL;
    const void* memSuite = NULL;
    const AEGP_ItemSuite9* itemP = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    ItemResolution projIds;
    long pos = 0;
    long total = 0;
    int windowStart, windowCount = 0;
    /* window slots: limit ≤ 32, each ~1.1 KB worst case */
    struct EnumSlot
    {
        long index;
        AEGP_ItemType type;
        long itemId;
        int nameTruncated;
        char name[AEREF_NAME_MAX + 1];
    } slots[ENUM_LIMIT_MAX];
    JBuf b;
    int cut = 0;
    A_Err perr;

    memset(&projIds, 0, sizeof(projIds));
    projIds.haveProjectName = 1;
    projIds.haveProjectPath = 1;

    if (!projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex ||
        !projP->AEGP_GetProjectName || !projP->AEGP_GetProjectPath)
    {
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "project suite entries unavailable for enumeration");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }
    {
        A_long numProjects = 0;
        perr = projP->AEGP_GetNumProjects(&numProjects);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetNumProjects", (long)perr,
            perr == A_Err_NONE ? " (enum)" : NULL);
        if (perr != A_Err_NONE)
        {
            snprintf(v->outcome, sizeof(v->outcome), "failed");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetNumProjects err=%ld", (long)perr);
            v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
            return;
        }
        if (projectIndex < 0 || projectIndex >= (long)numProjects)
        {
            VerdictRefuse(v, "STALE_REFERENCE", "projectIndex out of range");
            return;
        }
        perr = projP->AEGP_GetProjectByIndex(projectIndex, &projectH);
        IntakeOpRecord(utilP,
            "AEGP_ProjSuite6.AEGP_GetProjectByIndex", (long)perr,
            perr == A_Err_NONE ? " (enum)" : NULL);
        if (perr != A_Err_NONE || !projectH)
        {
            snprintf(v->outcome, sizeof(v->outcome), "failed");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetProjectByIndex err=%ld", (long)perr);
            v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
            return;
        }
    }

    itemSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPItemSuite, kAEGPItemSuiteVersion9);
    memSuite = IntakeAcquireSuite(utilP, basicP,
                                  kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (!itemSuite || !memSuite)
    {
        if (itemSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPItemSuite, kAEGPItemSuiteVersion9);
        if (memSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "item/memory suite unavailable for enumeration");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }
    itemP = (const AEGP_ItemSuite9*)itemSuite;
    memP = (const AEGP_MemorySuite1*)memSuite;

#define ENUM_NOT_SENT(msg) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9); \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return; } while (0)
#define ENUM_FAILED(fmt, err) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9); \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return; } while (0)

    if (!itemP->AEGP_GetFirstProjItem || !itemP->AEGP_GetNextProjItem ||
        !itemP->AEGP_GetItemType || !itemP->AEGP_GetItemName ||
        !itemP->AEGP_GetItemID)
        ENUM_NOT_SENT("item suite entries unavailable for enumeration");

    {
        A_Err ferr = A_Err_NONE;
        int fpi = FetchProjectIdentity(utilP, projP, memP, projectH,
                                     1, 1,
                                     projIds.projectName, sizeof(projIds.projectName),
                                     projIds.projectPath, sizeof(projIds.projectPath),
                                     &ferr);
        if (fpi == FPI_AEGP_ERR)
            ENUM_FAILED("project identity read err=%ld", ferr);
        if (fpi == FPI_TRUNCATED)
            ENUM_FAILED("project path exceeds descriptor bound err=%ld", ferr);
    }

    /* single walk: count total, capture the [offset, offset+limit)
       window's type/name/id. */
    windowStart = (int)(offset < 0 ? 0 : offset);
    {
        A_Err ierr = itemP->AEGP_GetFirstProjItem(projectH, &itemH);
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetFirstProjItem", (long)ierr,
            ierr == A_Err_NONE ? " (enum)" : NULL);
        if (ierr != A_Err_NONE)
            ENUM_FAILED("AEGP_GetFirstProjItem err=%ld", ierr);
    }
    while (itemH)
    {
        if (pos >= RESOLVE_SCAN_MAX)
            ENUM_FAILED("item scan limit exceeded err=%ld", pos);
        if (pos >= windowStart && pos < windowStart + limit &&
            windowCount < ENUM_LIMIT_MAX)
        {
            struct EnumSlot* s = &slots[windowCount];
            AEGP_ItemType t = AEGP_ItemType_NONE;
            AEGP_MemHandle nh = NULL;
            A_long id = 0;
            A_Err e1, e2, e3;
            IntakeMemStatus ms;
            s->index = pos;
            s->name[0] = '\0';
            s->nameTruncated = 0;
            e1 = itemP->AEGP_GetItemType(itemH, &t);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemType",
                           (long)e1, e1 == A_Err_NONE ? " (enum)" : NULL);
            if (e1 != A_Err_NONE) ENUM_FAILED("AEGP_GetItemType err=%ld", e1);
            s->type = t;
            e2 = itemP->AEGP_GetItemName(plugin_id, itemH, &nh);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemName",
                           (long)e2, e2 == A_Err_NONE ? " (enum)" : NULL);
            if (e2 != A_Err_NONE) ENUM_FAILED("AEGP_GetItemName err=%ld", e2);
            ms = IntakeReadMemHandleUtf8(utilP, memP, nh,
                                         s->name, sizeof(s->name));
            if (ms != IMH_OK && ms != IMH_TRUNCATED)
                ENUM_FAILED("item name mem-handle read failed err=%ld", (long)ms);
            s->nameTruncated = (ms == IMH_TRUNCATED);
            e3 = itemP->AEGP_GetItemID(itemH, &id);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                           (long)e3, e3 == A_Err_NONE ? " (enum)" : NULL);
            if (e3 != A_Err_NONE) ENUM_FAILED("AEGP_GetItemID err=%ld", e3);
            s->itemId = (long)(unsigned int)id; /* emit u32, not sign-extended */
            windowCount++;
        }
        {
            AEGP_ItemH nextH = NULL;
            A_Err nerr = itemP->AEGP_GetNextProjItem(projectH, itemH, &nextH);
            IntakeOpRecord(utilP,
                "AEGP_ItemSuite9.AEGP_GetNextProjItem", (long)nerr,
                nerr == A_Err_NONE ? " (enum)" : NULL);
            if (nerr != A_Err_NONE) ENUM_FAILED("AEGP_GetNextProjItem err=%ld", nerr);
            itemH = nextH;
            pos++;
        }
    }
    total = pos;

    /* emit: project block + window items + paging flags. `truncated`
       is written last so a payload-budget cut can still be reported. */
    JBInit(&b, v->payload, sizeof(v->payload));
    JBPut(&b, "{\"project\":{\"index\":");
    JBNum(&b, projectIndex);
    JBPut(&b, ",\"name\":\"");
    JBEsc(&b, projIds.projectName);
    JBPut(&b, "\",\"path\":\"");
    JBEsc(&b, projIds.projectPath);
    JBPut(&b, "\"},\"total\":");
    JBNum(&b, total);
    JBPut(&b, ",\"offset\":");
    JBNum(&b, offset);
    JBPut(&b, ",\"items\":[");
    {
        int i;
        for (i = 0; i < windowCount && !b.of; i++)
        {
            size_t mark = (size_t)(b.cur - v->payload);
            if (i) JBPut(&b, ",");
            EmitEnumItem(&b, slots[i].index, slots[i].type, slots[i].name,
                         slots[i].nameTruncated, slots[i].itemId,
                         projIds.projectName, projIds.projectPath);
            if (b.of)
            {
                /* roll back the partial item; mark the page cut */
                b.cur = v->payload + mark;
                b.left = sizeof(v->payload) - mark;
                b.of = 0;
                cut = 1;
                break;
            }
        }
    }
    JBPut(&b, "],\"truncated\":");
    JBPut(&b, (cut || total > windowStart + windowCount) ? "true" : "false");
    JBPut(&b, "}");
    if (b.of)
        ENUM_FAILED("enumeration payload exceeds result bound err=%ld", (long)0);
    *b.cur = '\0';

    IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    {
        char eb[48];
        snprintf(eb, sizeof(eb), " value=%ld", total);
        IntakeOpRecord(utilP, opRecordIdZ, A_Err_NONE, eb);
    }
    snprintf(v->outcome, sizeof(v->outcome), "completed");
    v->havePayload = 1;
    v->mayHaveMutated = 0;
    v->publish = 1;

#undef ENUM_NOT_SENT
#undef ENUM_FAILED
}

/* ---- CompSuite13 read-only getters (Issue #318 / #64) ---------------
   Vertical slice of the shared identity resolver: args carry
   {"projectIndex": int, "comp": {"aeRef": {...}}}; ResolveAeRefItem
   resolves the item handle host-side (type+name corroborated, itemId
   authoritative when present), then AEGP_GetCompFromItem derives the
   comp handle inside the request window. The comp handle is borrowed —
   never freed; the comp suite is released before leaving. Missing
   suite/entry → not-sent; AEGP errors → failed with
   mayHaveMutated=false (read-only). The wire never carries a handle. */

/* Entry-presence gate: the specific getter must exist in the acquired
   suite table before any comp call (not-sent = environment-proven
   non-dispatch, same convention as GetTypeName). */
static int CompEntryPresent(const AEGP_CompSuite13* c, const char* opIdZ)
{
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompFramerate") == 0)
        return c->AEGP_GetCompFramerate != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompFrameDuration") == 0)
        return c->AEGP_GetCompFrameDuration != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart") == 0)
        return c->AEGP_GetCompWorkAreaStart != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration") == 0)
        return c->AEGP_GetCompWorkAreaDuration != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime") == 0)
        return c->AEGP_GetCompDisplayStartTime != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame") == 0)
        return c->AEGP_GetCompDisplayDropFrame != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor") == 0)
        return c->AEGP_GetCompDownsampleFactor != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName") == 0)
        return c->AEGP_GetShowLayerNameOrSourceName != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetShowBlendModes") == 0)
        return c->AEGP_GetShowBlendModes != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples") == 0)
        return c->AEGP_GetCompSuggestedMotionBlurSamples != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit") == 0)
        return c->AEGP_GetCompMotionBlurAdaptiveSampleLimit != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompBGColor") == 0)
        return c->AEGP_GetCompBGColor != NULL;
    if (strcmp(opIdZ, "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase") == 0)
        return c->AEGP_GetCompShutterAnglePhase != NULL;
    return 0;
}

static void ExecCompGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* compArg = JGet(args, "comp");
    JVal* ref = compArg ? JGet(compArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;
    const void* compSuite = NULL;
    const AEGP_CompSuite13* compP = NULL;
    AEGP_CompH compH = NULL;
    A_Err cerr, oerr;
    const char* opId = allow->operationId;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, 0, " (resolve)", &res, v))
        return; /* v already carries the verdict */

    compSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPCompSuite, kAEGPCompSuiteVersion13);
    if (!compSuite)
    {
        ReleaseResolution(utilP, basicP, &res);
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP Comp Suite unavailable");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }
    compP = (const AEGP_CompSuite13*)compSuite;

    if (!compP->AEGP_GetCompFromItem || !CompEntryPresent(compP, opId))
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        ReleaseResolution(utilP, basicP, &res);
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "comp suite entry unavailable");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }

    cerr = compP->AEGP_GetCompFromItem(res.itemH, &compH);
    IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem",
                   (long)cerr, NULL);
    if (cerr != A_Err_NONE || !compH)
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        ReleaseResolution(utilP, basicP, &res);
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetCompFromItem err=%ld", (long)cerr);
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }

    oerr = A_Err_STRUCT;
    if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompFramerate") == 0)
    {
        A_FpLong fps = 0;
        oerr = compP->AEGP_GetCompFramerate(compH, &fps);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload), "{\"fps\":%.12g}", fps);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompFrameDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompFrameDuration(compH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"frameDuration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompWorkAreaStart(compH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"workAreaStart\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompWorkAreaDuration(compH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"workAreaDuration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompDisplayStartTime(compH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"displayStartTime\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame") == 0)
    {
        A_Boolean dropB = FALSE;
        oerr = compP->AEGP_GetCompDisplayDropFrame(compH, &dropB);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"displayDropFrame\":%s}", dropB ? "true" : "false");
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor") == 0)
    {
        AEGP_DownsampleFactor dsf;
        dsf.xS = 0; dsf.yS = 0;
        oerr = compP->AEGP_GetCompDownsampleFactor(compH, &dsf);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"downsampleFactor\":{\"x\":%d,\"y\":%d}}",
                     (int)dsf.xS, (int)dsf.yS);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName") == 0)
    {
        A_Boolean shownB = FALSE;
        oerr = compP->AEGP_GetShowLayerNameOrSourceName(compH, &shownB);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"showLayerNameOrSourceName\":%s}",
                     shownB ? "true" : "false");
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetShowBlendModes") == 0)
    {
        A_Boolean shownB = FALSE;
        oerr = compP->AEGP_GetShowBlendModes(compH, &shownB);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"showBlendModes\":%s}", shownB ? "true" : "false");
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples") == 0)
    {
        A_long samplesL = 0;
        oerr = compP->AEGP_GetCompSuggestedMotionBlurSamples(compH, &samplesL);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"suggestedMotionBlurSamples\":%ld}", (long)samplesL);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit") == 0)
    {
        A_long samplesL = 0;
        oerr = compP->AEGP_GetCompMotionBlurAdaptiveSampleLimit(compH, &samplesL);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"motionBlurAdaptiveSampleLimit\":%ld}", (long)samplesL);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompBGColor") == 0)
    {
        AEGP_ColorVal bg;
        memset(&bg, 0, sizeof(bg));
        oerr = compP->AEGP_GetCompBGColor(compH, &bg);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"bgColor\":{\"alpha\":%.12g,\"red\":%.12g,"
                     "\"green\":%.12g,\"blue\":%.12g}}",
                     bg.alphaF, bg.redF, bg.greenF, bg.blueF);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase") == 0)
    {
        A_Ratio angle = {0, 0}, phase = {0, 0};
        oerr = compP->AEGP_GetCompShutterAnglePhase(compH, &angle, &phase);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"shutterAngle\":{\"num\":%ld,\"den\":%lu},"
                     "\"shutterPhase\":{\"num\":%ld,\"den\":%lu}}",
                     (long)angle.num, (unsigned long)angle.den,
                     (long)phase.num, (unsigned long)phase.den);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else
    {
        /* allowlist/entry gate already proved this unreachable; keep
           the verdict honest rather than emitting garbage. */
        oerr = A_Err_STRUCT;
    }

    IntakeReleaseSuite(utilP, basicP,
                       kAEGPCompSuite, kAEGPCompSuiteVersion13);
    ReleaseResolution(utilP, basicP, &res);

    if (oerr == A_Err_NONE && v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
        v->publish = 1;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "%s err=%ld", opId, (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0; /* read-only getter */
        v->publish = 1;
    }
}

/* ---- ItemSuite9 read-only detail getters (Issue #318 / #63) ---------
   Same {projectIndex, item:<aeRefItem>} contract as GetItemName: the
   shared resolver produces the item handle; the getter runs on it
   directly — no derived handle, no extra suite. Missing entry →
   not-sent; AEGP errors → failed with mayHaveMutated=false. */

#define ITEM_COMMENT_MAX 2048  /* UTF-8 bytes; larger comments fail honestly */

static int ItemGetterEntryPresent(const AEGP_ItemSuite9* c, const char* opIdZ)
{
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemType") == 0)
        return c->AEGP_GetItemType != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0)
        return c->AEGP_GetItemFlags != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0)
        return c->AEGP_IsItemSelected != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0)
        return c->AEGP_GetItemLabel != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0)
        return c->AEGP_GetItemDuration != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0)
        return c->AEGP_GetItemCurrentTime != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0)
        return c->AEGP_GetItemDimensions != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0)
        return c->AEGP_GetItemPixelAspectRatio != NULL;
    if (strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0)
        return c->AEGP_GetItemComment != NULL;
    return 0;
}

/* Dispatch router for the #63 item-detail getters — explicit id list
   so a future ItemSuite9 allowlist addition without an executor still
   reaches OPERATION_NOT_DISPATCHABLE instead of being misrouted. */
static int IsItemGetterOpId(const char* opIdZ)
{
    return strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemType") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0 ||
           strcmp(opIdZ, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0;
}

static void ExecItemGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* itemArg = JGet(args, "item");
    JVal* ref = itemArg ? JGet(itemArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;
    A_Err oerr = A_Err_STRUCT;
    const char* opId = allow->operationId;
    int commentStatus = -1;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, 0, " (resolve)", &res, v))
        return; /* v already carries the verdict */

    if (!ItemGetterEntryPresent(res.itemP, opId))
    {
        ReleaseResolution(utilP, basicP, &res);
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "item suite entry unavailable");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }

    if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemType") == 0)
    {
        AEGP_ItemType t = AEGP_ItemType_NONE;
        oerr = res.itemP->AEGP_GetItemType(res.itemH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"itemType\":%d}", (int)t);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0)
    {
        AEGP_ItemFlags flags = 0;
        oerr = res.itemP->AEGP_GetItemFlags(res.itemH, &flags);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"flags\":%ld}", (long)flags);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0)
    {
        A_Boolean selB = FALSE;
        oerr = res.itemP->AEGP_IsItemSelected(res.itemH, &selB);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"selected\":%s}", selB ? "true" : "false");
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0)
    {
        AEGP_LabelID label = AEGP_Label_NO_LABEL;
        oerr = res.itemP->AEGP_GetItemLabel(res.itemH, &label);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"label\":%d}", (int)label);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = res.itemP->AEGP_GetItemDuration(res.itemH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"duration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0)
    {
        A_Time t = {0, 0};
        oerr = res.itemP->AEGP_GetItemCurrentTime(res.itemH, &t);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"currentTime\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0)
    {
        A_long w = 0, hgt = 0;
        oerr = res.itemP->AEGP_GetItemDimensions(res.itemH, &w, &hgt);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"width\":%ld,\"height\":%ld}", (long)w, (long)hgt);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0)
    {
        A_Ratio par = {0, 0};
        oerr = res.itemP->AEGP_GetItemPixelAspectRatio(res.itemH, &par);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            snprintf(v->payload, sizeof(v->payload),
                     "{\"pixelAspectRatio\":{\"num\":%ld,\"den\":%lu}}",
                     (long)par.num, (unsigned long)par.den);
            v->payload[sizeof(v->payload) - 1] = '\0';
            v->havePayload = 1;
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0)
    {
        AEGP_MemHandle commentH = NULL;
        char comment[ITEM_COMMENT_MAX + 1];
        char esc[ITEM_COMMENT_MAX * 2 + 16];
        oerr = res.itemP->AEGP_GetItemComment(res.itemH, &commentH);
        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
        if (oerr == A_Err_NONE)
        {
            IntakeMemStatus ms = IntakeReadMemHandleUtf8(
                utilP, res.memP, commentH, comment, sizeof(comment));
            commentStatus = (int)ms;
            if (ms == IMH_OK)
            {
                JsonEscape(esc, sizeof(esc), comment);
                snprintf(v->payload, sizeof(v->payload),
                         "{\"comment\":\"%s\"}", esc);
                v->payload[sizeof(v->payload) - 1] = '\0';
                v->havePayload = 1;
            }
            else if (ms == IMH_TRUNCATED)
            {
                oerr = A_Err_STRUCT; /* over the declared bound: honest fail */
            }
            else
            {
                oerr = A_Err_STRUCT;
            }
        }
    }
    else
    {
        oerr = A_Err_STRUCT;
    }

    ReleaseResolution(utilP, basicP, &res);

    if (oerr == A_Err_NONE && v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
        v->publish = 1;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        if (commentStatus == (int)IMH_TRUNCATED)
            snprintf(v->detail, sizeof(v->detail),
                     "comment exceeds %d-byte bound", ITEM_COMMENT_MAX);
        else
            snprintf(v->detail, sizeof(v->detail),
                     "%s err=%ld", opId, (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0; /* read-only getter */
        v->publish = 1;
    }
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
        /* ---- Issue #270 identity slice: shared aeRef resolve ------
           AEGP_ItemSuite9.AEGP_GetItemName / AEGP_GetItemID /
           AEGP_GetFirstProjItem. The item handle is NEVER taken from
           the wire: args carry {"projectIndex": int, "item": {"aeRef":
           {...}}} and ResolveAeRefItem resolves it inside the
           host-dispatched context (contract native-channel.md §7b):
             projectIndex → GetNumProjects/GetProjectByIndex → projectH
               (+ optional projectName/projectPath corroboration)
             itemId present → scan top-level items for the live id
             else          → legacy path[0] positional walk
           then verifies type + exact UTF-8 name in BOTH modes. Any
           resolution failure is refused STALE_REFERENCE — a
           well-formed descriptor that no longer matches live state is
           state drift, not a caller-shape bug (trusted-execution.md
           §3/§4). AEGP errors are failed with mayHaveMutated=false
           (read-only). Missing suites/entries are not-sent. */
        else if (strcmp(allow->operationId,
                        "AEGP_ItemSuite9.AEGP_GetItemName") == 0 ||
                 strcmp(allow->operationId,
                        "AEGP_ItemSuite9.AEGP_GetItemID") == 0)
        {
            int isNameOp = strcmp(allow->operationId,
                                  "AEGP_ItemSuite9.AEGP_GetItemName") == 0;
            JVal* itemArg = JGet(args, "item");
            JVal* ref = itemArg ? JGet(itemArg, "aeRef") : NULL;
            long projIndex = ArgsInt(allow, args, 0);
            ItemResolution res;

            /* GetItemName resolves only what the descriptor asserts;
               GetItemID additionally fetches project identity for the
               issued descriptor payload (wantProjectIdentity=1). */
            if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                                  projIndex, ref, isNameOp ? 0 : 1,
                                  isNameOp ? " (resolve+result)" : " (resolve)",
                                  &res, &v))
                goto verdict;   /* v already carries the verdict */

            if (isNameOp)
            {
                char esc[AEREF_NAME_MAX * 6 + 8];
                JsonEscape(esc, sizeof(esc), res.name);
                snprintf(v.outcome, sizeof(v.outcome), "completed");
                snprintf(v.payload, sizeof(v.payload), "{\"name\":\"%s\"}", esc);
                v.payload[sizeof(v.payload) - 1] = '\0';
                v.havePayload = 1;
                v.mayHaveMutated = 0;
            }
            else
            {
                /* GetItemID = descriptor issuance: read the live id of
                   the resolved item, then emit the canonical
                   identity-bearing aeRef (project identity included).
                   Emit BEFORE ReleaseResolution — release zeroes res. */
                A_long liveId = 0;
                A_Err iderr = res.itemP->AEGP_GetItemID
                    ? res.itemP->AEGP_GetItemID(res.itemH, &liveId)
                    : A_Err_STRUCT;
                IntakeOpRecord(utilP,
                    "AEGP_ItemSuite9.AEGP_GetItemID", (long)iderr,
                    iderr == A_Err_NONE ? " (result)" : NULL);
                {
                    int emitOk = iderr == A_Err_NONE &&
                        EmitIssuedDescriptor(&v, &res,
                            (long)(unsigned int)liveId);
                    ReleaseResolution(utilP, basicP, &res);
                    if (iderr != A_Err_NONE)
                    {
                        snprintf(v.outcome, sizeof(v.outcome), "failed");
                        snprintf(v.detail, sizeof(v.detail),
                                 "AEGP_GetItemID err=%ld", (long)iderr);
                        v.havePayload = 0; v.mayHaveMutated = 0;
                    }
                    else if (!emitOk)
                    {
                        snprintf(v.outcome, sizeof(v.outcome), "failed");
                        snprintf(v.detail, sizeof(v.detail),
                                 "descriptor payload exceeds result bound");
                        v.havePayload = 0; v.mayHaveMutated = 0;
                    }
                    else
                    {
                        snprintf(v.outcome, sizeof(v.outcome), "completed");
                        v.havePayload = 1;
                        v.mayHaveMutated = 0;
                    }
                }
            }
            if (isNameOp) ReleaseResolution(utilP, basicP, &res);
        }
        /* ---- Issue #270 identity slice: discovery/enumeration ------
           AEGP_ItemSuite9.AEGP_GetFirstProjItem as a paged enumerator:
           {projectIndex, offset, limit} → ready-to-use aeRef
           descriptors. Read-only; every member call op-recorded. */
        else if (strcmp(allow->operationId,
                        "AEGP_ItemSuite9.AEGP_GetFirstProjItem") == 0)
        {
            EnumerateProjItems(utilP, projP, basicP, plugin_id,
                               allow->opRecordId, args, &v);
        }
        /* ---- Issue #318 / #64: CompSuite13 read-only getters --------
           {projectIndex, comp:<aeRefItem>} → shared resolver →
           AEGP_GetCompFromItem → typed getter → typed JSON. The comp
           handle exists only inside the request window. */
        else if (strncmp(allow->operationId, "AEGP_CompSuite13.", 17) == 0)
        {
            ExecCompGetter(utilP, projP, basicP, plugin_id, allow, args, &v);
        }
        /* ---- Issue #318 / #63: ItemSuite9 read-only detail getters --
           {projectIndex, item:<aeRefItem>} → shared resolver → typed
           getter on the resolved item handle. */
        else if (IsItemGetterOpId(allow->operationId))
        {
            ExecItemGetter(utilP, projP, basicP, plugin_id, allow, args, &v);
        }
        /* ---- Issue #270 Stage 2: zero-arg read-only getters ---------- */
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion") == 0)
        {
            A_short maj = 0, min = 0;
            A_Err oerr = utilP->AEGP_GetDriverPluginInitFuncVersion
                ? utilP->AEGP_GetDriverPluginInitFuncVersion(&maj, &min)
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
                snprintf(v.payload, sizeof(v.payload),
                         "{\"major\":%d,\"minor\":%d}", (int)maj, (int)min);
                v.payload[sizeof(v.payload) - 1] = '\0';
                v.havePayload = 1;
                v.mayHaveMutated = 0;
            }
            else
            {
                snprintf(v.outcome, sizeof(v.outcome), "failed");
                snprintf(v.detail, sizeof(v.detail),
                         "AEGP_GetDriverPluginInitFuncVersion err=%ld", (long)oerr);
                v.havePayload = 0;
                v.mayHaveMutated = 0;
            }
        }
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI") == 0)
        {
            A_Boolean suppressed = FALSE;
            A_Err oerr = utilP->AEGP_GetSuppressInteractiveUI
                ? utilP->AEGP_GetSuppressInteractiveUI(&suppressed)
                : A_Err_STRUCT;
            IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                           oerr == A_Err_NONE ? (suppressed ? " value=1" : " value=0") : NULL);
            if (oerr == A_Err_NONE)
            {
                snprintf(v.outcome, sizeof(v.outcome), "completed");
                snprintf(v.payload, sizeof(v.payload),
                         "{\"interactiveUiSuppressed\":%s}", suppressed ? "true" : "false");
                v.havePayload = 1;
                v.mayHaveMutated = 0;
            }
            else
            {
                snprintf(v.outcome, sizeof(v.outcome), "failed");
                snprintf(v.detail, sizeof(v.detail),
                         "AEGP_GetSuppressInteractiveUI err=%ld", (long)oerr);
                v.havePayload = 0;
                v.mayHaveMutated = 0;
            }
        }
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_HostIsActivated") == 0)
        {
            A_Boolean activated = FALSE;
            A_Err oerr = utilP->AEGP_HostIsActivated
                ? utilP->AEGP_HostIsActivated(&activated)
                : A_Err_STRUCT;
            IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                           oerr == A_Err_NONE ? (activated ? " value=1" : " value=0") : NULL);
            if (oerr == A_Err_NONE)
            {
                snprintf(v.outcome, sizeof(v.outcome), "completed");
                snprintf(v.payload, sizeof(v.payload),
                         "{\"hostActivated\":%s}", activated ? "true" : "false");
                v.havePayload = 1;
                v.mayHaveMutated = 0;
            }
            else
            {
                snprintf(v.outcome, sizeof(v.outcome), "failed");
                snprintf(v.detail, sizeof(v.detail),
                         "AEGP_HostIsActivated err=%ld", (long)oerr);
                v.havePayload = 0;
                v.mayHaveMutated = 0;
            }
        }
        else if (strcmp(allow->operationId,
                        "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState") == 0 ||
                 strcmp(allow->operationId,
                        "AEGP_RQItemSuite4.AEGP_GetNumRQItems") == 0)
        {
            /* zero-arg render-queue getters: acquire the needed suite
               inside the request window (same pattern as GetTypeName) */
            int isRQState = strcmp(allow->operationId,
                                   "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState") == 0;
            const char* suiteName = isRQState ? kAEGPRenderQueueSuite : kAEGPRQItemSuite;
            int suiteVer = isRQState ? kAEGPRenderQueueSuiteVersion1
                                     : kAEGPRQItemSuiteVersion4;
            const void* suite = IntakeAcquireSuite(utilP, basicP, suiteName, suiteVer);
            if (!suite)
            {
                snprintf(v.outcome, sizeof(v.outcome), "not-sent");
                snprintf(v.detail, sizeof(v.detail), "render queue suite unavailable");
                v.havePayload = 0; v.mayHaveMutated = 0; v.publish = 1;
                goto verdict;
            }
            {
                A_Err oerr = A_Err_STRUCT;
                char extra[48];
                extra[0] = '\0';
                if (isRQState)
                {
                    const AEGP_RenderQueueSuite1* rqP = (const AEGP_RenderQueueSuite1*)suite;
                    AEGP_RenderQueueState state = 0;
                    if (rqP->AEGP_GetRenderQueueState)
                        oerr = rqP->AEGP_GetRenderQueueState(&state);
                    else
                        oerr = A_Err_STRUCT;
                    if (oerr == A_Err_NONE)
                    {
                        snprintf(extra, sizeof(extra), " value=%lu",
                                 (unsigned long)state);
                        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, extra);
                        snprintf(v.outcome, sizeof(v.outcome), "completed");
                        snprintf(v.payload, sizeof(v.payload),
                                 "{\"state\":%lu}", (unsigned long)state);
                        v.payload[sizeof(v.payload) - 1] = '\0';
                        v.havePayload = 1;
                        v.mayHaveMutated = 0;
                    }
                    else
                    {
                        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
                        snprintf(v.outcome, sizeof(v.outcome), "failed");
                        snprintf(v.detail, sizeof(v.detail),
                                 "AEGP_GetRenderQueueState err=%ld", (long)oerr);
                        v.havePayload = 0;
                        v.mayHaveMutated = 0;
                    }
                }
                else
                {
                    const AEGP_RQItemSuite4* rqItemP = (const AEGP_RQItemSuite4*)suite;
                    A_long num = 0;
                    if (rqItemP->AEGP_GetNumRQItems)
                        oerr = rqItemP->AEGP_GetNumRQItems(&num);
                    else
                        oerr = A_Err_STRUCT;
                    if (oerr == A_Err_NONE)
                    {
                        snprintf(extra, sizeof(extra), " value=%ld", (long)num);
                        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, extra);
                        snprintf(v.outcome, sizeof(v.outcome), "completed");
                        snprintf(v.payload, sizeof(v.payload),
                                 "{\"numRQItems\":%ld}", (long)num);
                        v.payload[sizeof(v.payload) - 1] = '\0';
                        v.havePayload = 1;
                        v.mayHaveMutated = 0;
                    }
                    else
                    {
                        IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, NULL);
                        snprintf(v.outcome, sizeof(v.outcome), "failed");
                        snprintf(v.detail, sizeof(v.detail),
                                 "AEGP_GetNumRQItems err=%ld", (long)oerr);
                        v.havePayload = 0;
                        v.mayHaveMutated = 0;
                    }
                }
                IntakeReleaseSuite(utilP, basicP, suiteName, suiteVer);
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
