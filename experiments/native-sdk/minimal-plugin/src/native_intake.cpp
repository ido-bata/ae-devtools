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
    char consentKeyOut[65],
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
            JVal* ckey = JGet(doc, "consentKey");
            memcpy(tokenOut, tok->str, 64);
            tokenOut[64] = '\0';
            /* Issue #326: optional consent MAC key. A present-but-
               malformed key is treated as absent — consent-requiring
               ops then refuse CONSENT_REQUIRED (fail closed) while
               read-only ops are unaffected. */
            if (ckey && ckey->kind == JK_STR && TokenOk(ckey->str, ckey->slen))
            {
                memcpy(consentKeyOut, ckey->str, 64);
                consentKeyOut[64] = '\0';
            }
            else
            {
                consentKeyOut[0] = '\0';
            }
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
    ARGK_AEREFITEM, /* aeRef project-item descriptor (Issue #270 Stage 3) */
    ARGK_AEREFLAYER, /* aeRef layer descriptor embedding its comp aeRef
                        (Issue #318 layer slice) */
    ARGK_AEREFPROJECT, /* aeRef project descriptor (Issue #318 §7e) */
    ARGK_AEREFRQITEM,  /* aeRef render-queue-item descriptor (§7f) */
    ARGK_STR           /* bounded UTF-8 string: slen <= max bytes */
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
    /* Issue #326: 1 = mutating op — the request must carry a valid
       §7g consent MAC verified after session attestation and before
       any AEGP call. Read-only entries are 0 and skip consent
       entirely (a stray consent field is ignored, never an error). */
    int requiresConsent;
} AllowEntry;

/* Record the dispatched op's own AEGP call under its allowlist id —
   the common case (no extra evidence string). */
static void RecordAllowOp(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    A_Err err)
{
    IntakeOpRecord(utilP, allow->opRecordId, (long)err, NULL);
}

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

/* AEGP_ItemSuite9.AEGP_SetItemComment (Issue #327): the first
   mutating op. Same aeRef resolution as the getters plus a bounded
   UTF-8 `comment` string (2048 bytes, matching ITEM_COMMENT_MAX). */
static const IntakeArgSpec S_SETCOMMENT_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "item", ARGK_AEREFITEM, 0.0, 0.0 },
    { "comment", ARGK_STR, 0.0, 2048.0 },
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

/* AEGP_LayerSuite9 comp-scoped enumeration (Issue #318 layer slice):
   GetCompLayerByIndex is layer-descriptor ISSUANCE — it resolves the
   comp aeRef, derives compH, reads the layer's live id+name and emits
   a ready-to-use aeRefLayer descriptor. `layerIndex` is the
   GetCompLayerByIndex position (0-based). */
static const IntakeArgSpec S_COMP_INDEX_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "comp", ARGK_AEREFITEM, 0.0, 0.0 },
    { "layerIndex", ARGK_INT, 0.0, 1000000.0 },
};

/* AEGP_LayerSuite9 layer-handle getters (Issue #318 layer slice): the
   layer handle is NEVER taken from the wire — `layer` is an aeRefLayer
   descriptor {type:"layer", name, layerId, comp:{aeRef:<comp item
   descriptor>}}; the executor resolves the comp descriptor through the
   shared item resolver, derives compH via AEGP_GetCompFromItem, then
   scans the comp's layers for the live AEGP_GetLayerID match with
   name corroboration — reorder-tolerant, fail-closed. */
static const IntakeArgSpec S_LAYER_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "layer", ARGK_AEREFLAYER, 0.0, 0.0 },
};

/* Time-mode variants: AEGP_LTimeMode is {LayerTime=0, CompTime=1} —
   exposed as a bounded integer, never defaulted silently. */
static const IntakeArgSpec S_LAYER_TIME_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "layer", ARGK_AEREFLAYER, 0.0, 0.0 },
    { "timeMode", ARGK_INT, 0.0, 1.0 },
};

/* IsLayerUsedAsTrackMatte's fill_must_be_active flag — same bounded
   boolean-as-integer convention. */
static const IntakeArgSpec S_LAYER_MATTE_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "layer", ARGK_AEREFLAYER, 0.0, 0.0 },
    { "fillMustBeActive", ARGK_INT, 0.0, 1.0 },
};

/* Issue #318 §7e: project-scoped getters take the aeRefProject
   descriptor alone — the descriptor carries the project index. */
static const IntakeArgSpec S_PROJECT_ARGS[] = {
    { "project", ARGK_AEREFPROJECT, 0.0, 0.0 },
};

/* Issue #318 §7f: RQ-item getters take the comp's projectIndex plus
   the aeRefRQItem descriptor (index + comp aeRef + fingerprint). */
static const IntakeArgSpec S_RQITEM_ARGS[] = {
    { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
    { "rqItem", ARGK_AEREFRQITEM, 0.0, 0.0 },
};

/* AEGP_GetRQItemByIndex doubles as RQ descriptor issuance/enumeration:
   {offset, limit} pages the queue. */
static const IntakeArgSpec S_RQENUM_ARGS[] = {
    { "offset", ARGK_INT, 0.0, 1000000.0 },
    { "limit", ARGK_INT, 1.0, 32.0 },
};

static const AllowEntry S_ALLOWLIST[] = {
    { "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ProjSuite6.AEGP_GetNumProjects", NULL, 0, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion", NULL, 0, 0 },
    { "AEGP_ItemSuite9.AEGP_GetTypeName",
      "AEGP_ItemSuite9.AEGP_GetTypeName", S_TYPENAME_ARGS, 1, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemName",
      "AEGP_ItemSuite9.AEGP_GetItemName", S_AEREF_ARGS, 2, 0 },
    /* Issue #270 identity slice: GetItemID is descriptor issuance
       (resolve → read live id + project identity → canonical aeRef);
       GetFirstProjItem is discovery/enumeration. Both reuse the same
       identity resolver — no per-kind resolver duplication. */
    { "AEGP_ItemSuite9.AEGP_GetItemID",
      "AEGP_ItemSuite9.AEGP_GetItemID", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
      "AEGP_ItemSuite9.AEGP_GetFirstProjItem", S_FIRSTITEM_ARGS, 3, 0 },
    /* Issue #318 / #64: CompSuite13 read-only getters. All share the
       {projectIndex, comp:<aeRefItem type=comp>} contract; the comp
       handle is derived host-side via AEGP_GetCompFromItem — never
       taken from the wire. GetCompShutterFrameRange is excluded: it
       takes an A_Time input argument (arg-bearing ops are a separate
       slice). */
    { "AEGP_CompSuite13.AEGP_GetCompFramerate",
      "AEGP_CompSuite13.AEGP_GetCompFramerate", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompFrameDuration",
      "AEGP_CompSuite13.AEGP_GetCompFrameDuration", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration",
      "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime",
      "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame",
      "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor",
      "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName",
      "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetShowBlendModes",
      "AEGP_CompSuite13.AEGP_GetShowBlendModes", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples",
      "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit",
      "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompBGColor",
      "AEGP_CompSuite13.AEGP_GetCompBGColor", S_COMP_ARGS, 2, 0 },
    { "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase",
      "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase", S_COMP_ARGS, 2, 0 },
    /* Issue #318 / #63: ItemSuite9 read-only detail getters that take
       AEGP_ItemH — same {projectIndex, item:<aeRefItem>} contract as
       GetItemName; the resolved handle is used directly (no derived
       handle). GetItemParentFolder and GetItemMRUView stay out: they
       return host handles of other identity kinds (folder item /
       item-view) that need their own descriptor story first. */
    { "AEGP_ItemSuite9.AEGP_GetItemType",
      "AEGP_ItemSuite9.AEGP_GetItemType", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemFlags",
      "AEGP_ItemSuite9.AEGP_GetItemFlags", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_IsItemSelected",
      "AEGP_ItemSuite9.AEGP_IsItemSelected", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemLabel",
      "AEGP_ItemSuite9.AEGP_GetItemLabel", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemDuration",
      "AEGP_ItemSuite9.AEGP_GetItemDuration", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemCurrentTime",
      "AEGP_ItemSuite9.AEGP_GetItemCurrentTime", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemDimensions",
      "AEGP_ItemSuite9.AEGP_GetItemDimensions", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio",
      "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio", S_AEREF_ARGS, 2, 0 },
    { "AEGP_ItemSuite9.AEGP_GetItemComment",
      "AEGP_ItemSuite9.AEGP_GetItemComment", S_AEREF_ARGS, 2, 0 },
    /* Issue #327: first mutating op — AEGP_ItemSuite9.AEGP_SetItemComment
       (UNDOABLE). requiresConsent=1: the §7g MAC is verified after
       session attestation and before the AEGP call; the aeRef item is
       resolved host-side exactly like the read-only getters. `comment`
       is bounded UTF-8 (same 2048-byte bound as the getter payload);
       empty string clears the comment. */
    { "AEGP_ItemSuite9.AEGP_SetItemComment",
      "AEGP_ItemSuite9.AEGP_SetItemComment", S_SETCOMMENT_ARGS, 3, 1 },
    /* Issue #318 / #64 layer slice: AEGP_LayerSuite9. The layer handle
       is never taken from the wire — `layer` is an aeRefLayer descriptor
       embedding its parent comp's aeRef item descriptor; resolution is
       comp aeRef → itemH → compH (AEGP_GetCompFromItem) → layer scan by
       live AEGP_GetLayerID + name corroboration. GetCompNumLayers and
       GetCompLayerByIndex are comp-scoped: the latter is descriptor
       ISSUANCE (emits a ready-to-use aeRefLayer). Deferred members:
       GetActiveLayer (no comp binding arg), GetLayerSourceItem /
       GetLayerParentComp / GetTrackMatteLayer-returning-handle paths
       that would put a raw handle on the wire (GetTrackMatteLayer is
       handled by emitting an aeRefLayer instead), all mutating members,
       and members needing A_Time/A_FloatRect/stream arguments. */
    { "AEGP_LayerSuite9.AEGP_GetCompNumLayers",
      "AEGP_LayerSuite9.AEGP_GetCompNumLayers", S_COMP_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex",
      "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex", S_COMP_INDEX_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerIndex",
      "AEGP_LayerSuite9.AEGP_GetLayerIndex", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerName",
      "AEGP_LayerSuite9.AEGP_GetLayerName", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerFlags",
      "AEGP_LayerSuite9.AEGP_GetLayerFlags", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerQuality",
      "AEGP_LayerSuite9.AEGP_GetLayerQuality", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerObjectType",
      "AEGP_LayerSuite9.AEGP_GetLayerObjectType", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayer3D",
      "AEGP_LayerSuite9.AEGP_IsLayer3D", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayer2D",
      "AEGP_LayerSuite9.AEGP_IsLayer2D", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime",
      "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime", S_LAYER_TIME_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerInPoint",
      "AEGP_LayerSuite9.AEGP_GetLayerInPoint", S_LAYER_TIME_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerDuration",
      "AEGP_LayerSuite9.AEGP_GetLayerDuration", S_LAYER_TIME_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerID",
      "AEGP_LayerSuite9.AEGP_GetLayerID", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerLabel",
      "AEGP_LayerSuite9.AEGP_GetLayerLabel", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality",
      "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID",
      "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn",
      "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn",
      "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte",
      "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte", S_LAYER_ARGS, 2, 0 },
    { "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte",
      "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte", S_LAYER_MATTE_ARGS, 3, 0 },
    { "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer",
      "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer", S_LAYER_ARGS, 2, 0 },
    /* Issue #270 Stage 2: zero-arg read-only getters needing no
       identity resolution. The three UtilitySuite members use the
       already-held utilP; the two render-queue members acquire their
       suite inside the request window like GetTypeName. */
    { "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion", NULL, 0, 0 },
    { "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
      "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI", NULL, 0, 0 },
    { "AEGP_UtilitySuite6.AEGP_HostIsActivated",
      "AEGP_UtilitySuite6.AEGP_HostIsActivated", NULL, 0, 0 },
    { "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
      "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState", NULL, 0, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
      "AEGP_RQItemSuite4.AEGP_GetNumRQItems", NULL, 0, 0 },
    /* Issue #318 §7e: project-scoped read-only getters on the
       aeRefProject descriptor (§7e). GetProjectRootFolder stays out —
       the root folder is not a top-level item, so its itemId is outside
       the GetFirstProjItem scan and an emitted aeRef could never
       resolve. */
    { "AEGP_ProjSuite6.AEGP_ProjectIsDirty",
      "AEGP_ProjSuite6.AEGP_ProjectIsDirty", S_PROJECT_ARGS, 1, 0 },
    { "AEGP_ProjSuite6.AEGP_GetProjectBitDepth",
      "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", S_PROJECT_ARGS, 1, 0 },
    { "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay",
      "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay", S_PROJECT_ARGS, 1, 0 },
    /* Issue #318 §7f: RQ-item read-only getters on the aeRefRQItem
       descriptor — index + bound-comp aeRef + (status,
       numOutputModules) fingerprint, all re-verified atomically inside
       the request window. GetRQItemByIndex doubles as descriptor
       issuance/enumeration ({offset, limit}). GetNextRQItem stays out:
       it takes a borrowed RQItemRefH which cannot cross the wire.
       Mutating members (SetRenderState, SetLogType, SetComment,
       AddDefaultOutputModule, RemoveOutputModule, DeleteRQItem) are
       out of scope. */
    { "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
      "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex", S_RQENUM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetRenderState",
      "AEGP_RQItemSuite4.AEGP_GetRenderState", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetStartedTime",
      "AEGP_RQItemSuite4.AEGP_GetStartedTime", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetElapsedTime",
      "AEGP_RQItemSuite4.AEGP_GetElapsedTime", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetLogType",
      "AEGP_RQItemSuite4.AEGP_GetLogType", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetComment",
      "AEGP_RQItemSuite4.AEGP_GetComment", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
      "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem", S_RQITEM_ARGS, 2, 0 },
    { "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
      "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem", S_RQITEM_ARGS, 2, 0 },
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
static int ValidateAeRefLayer(JVal* v, char* detailZ, size_t detailCap);
static int ValidateAeRefProject(JVal* v, char* detailZ, size_t detailCap);
static int ValidateAeRefRQItem(JVal* v, char* detailZ, size_t detailCap);
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
        if (spec->kind == ARGK_AEREFLAYER)
        {
            if (!ValidateAeRefLayer(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_AEREFPROJECT)
        {
            if (!ValidateAeRefProject(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_AEREFRQITEM)
        {
            if (!ValidateAeRefRQItem(v, detailZ, detailCap)) return 0;
            continue;
        }
        if (spec->kind == ARGK_STR)
        {
            /* Bounded UTF-8 string (Issue #327): slen is the byte
               count; empty string is permitted (clears the field). */
            if (v->kind != JK_STR || v->slen > (size_t)spec->max)
            {
                snprintf(detailZ, detailCap,
                         "argument \"%s\" out of permitted range", spec->name);
                return 0;
            }
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

/* aeRefLayer descriptor shape check (Issue #318 layer slice; contract
   native-channel.md §7d). Wire form:
     {"aeRef":{"type":"layer","name":"<str>","layerId":<int32>,
               "comp":{"aeRef":{<item descriptor>}}}}
   All four keys are required — the parent comp binding is part of the
   layer's identity, so a layer descriptor can never resolve against
   the wrong comp. `layerId` is the live AEGP_GetLayerID value
   (AEGP_LayerIDVal = A_long, full int32 range); `name` corroborates.
   Shape only — resolution is host-side and failure is
   STALE_REFERENCE. */
#define AEREF_LAYER_ID_MIN (-2147483648.0)
#define AEREF_LAYER_ID_MAX 2147483647.0

static int ValidateAeRefLayer(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* nameV;
    JVal* idV;
    JVal* compV;
    size_t i;
    static const char* keys[] = { "type", "name", "layerId", "comp" };
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRefLayer arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs != 4)
    {
        snprintf(detailZ, detailCap,
                 "aeRefLayer must carry exactly type,name,layerId,comp");
        return 0;
    }
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        size_t k;
        int ok = 0;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++)
            if (strlen(keys[k]) == p->klen && memcmp(keys[k], p->key, p->klen) == 0)
            { ok = 1; break; }
        if (!ok)
        {
            snprintf(detailZ, detailCap, "aeRefLayer carries unsupported key");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    nameV = JGet(ref, "name");
    idV = JGet(ref, "layerId");
    compV = JGet(ref, "comp");
    if (!typeV || !nameV || !idV || !compV)
    {
        snprintf(detailZ, detailCap, "aeRefLayer requires type, name, layerId, comp");
        return 0;
    }
    if (typeV->kind != JK_STR || !JStrEq(typeV, "layer"))
    {
        snprintf(detailZ, detailCap, "aeRefLayer.type must be \"layer\"");
        return 0;
    }
    if (nameV->kind != JK_STR || nameV->slen == 0 ||
        nameV->slen > AEREF_NAME_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRefLayer.name must be a non-empty string ≤ 1024 UTF-8 bytes");
        return 0;
    }
    if (idV->kind != JK_NUM || !isfinite(idV->num) ||
        floor(idV->num) != idV->num ||
        idV->num < AEREF_LAYER_ID_MIN || idV->num > AEREF_LAYER_ID_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRefLayer.layerId must be an integer in [-2147483648, 2147483647]");
        return 0;
    }
    /* comp is the same {"aeRef":{...}} item-descriptor arg shape —
       recursive shape check; its type must corroborate "comp" at
       resolution time. */
    if (!ValidateAeRefItem(compV, detailZ, detailCap)) return 0;
    return 1;
}

/* aeRefProject descriptor shape check (Issue #318 §7e; contract
   native-channel.md §7e). Wire form:
     {"aeRef":{"type":"project","index":<int>,"name":"<str>","path":"<str>"}}
   Exactly these four keys; index is the 0-based GetProjectByIndex
   position; name non-empty ≤1024 UTF-8 bytes; path may be empty
   (unsaved project). Shape only — resolution is host-side. */
static int ValidateAeRefProject(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* idxV;
    JVal* nameV;
    JVal* pathV;
    size_t i;
    static const char* keys[] = { "type", "index", "name", "path" };
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRefProject arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs != 4)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject must carry exactly type,index,name,path");
        return 0;
    }
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        size_t k;
        int ok = 0;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++)
            if (strlen(keys[k]) == p->klen && memcmp(keys[k], p->key, p->klen) == 0)
            { ok = 1; break; }
        if (!ok)
        {
            snprintf(detailZ, detailCap, "aeRefProject carries unsupported key");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    idxV = JGet(ref, "index");
    nameV = JGet(ref, "name");
    pathV = JGet(ref, "path");
    if (!typeV || !idxV || !nameV || !pathV)
    {
        snprintf(detailZ, detailCap, "aeRefProject requires type, index, name, path");
        return 0;
    }
    if (typeV->kind != JK_STR || !JStrEq(typeV, "project"))
    {
        snprintf(detailZ, detailCap, "aeRefProject.type must be \"project\"");
        return 0;
    }
    if (idxV->kind != JK_NUM || !isfinite(idxV->num) ||
        floor(idxV->num) != idxV->num || idxV->num < 0.0 || idxV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject.index must be an integer in [0, 1000000]");
        return 0;
    }
    if (nameV->kind != JK_STR || nameV->slen == 0 ||
        nameV->slen > AEREF_NAME_MAX)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject.name must be a non-empty string ≤ 1024 UTF-8 bytes");
        return 0;
    }
    if (pathV->kind != JK_STR || pathV->slen > AEREF_MAX_STR)
    {
        snprintf(detailZ, detailCap,
                 "aeRefProject.path must be a string ≤ 4096 UTF-8 bytes (may be empty)");
        return 0;
    }
    return 1;
}

/* aeRefRQItem descriptor shape check (Issue #318 §7f; contract
   native-channel.md §7f). Wire form:
     {"aeRef":{"type":"rqItem","index":<int>,
               "comp":{"aeRef":{<item descriptor>}},
               "status":<int>,"numOutputModules":<int>}}
   Exactly these five keys. index is the 0-based GetRQItemByIndex
   position; comp is the bound composition's §7b item descriptor
   (recursive shape check); status is AEGP_RenderItemStatusType
   (int32 range); numOutputModules is a non-negative count. Shape
   only — resolution re-verifies every pin atomically. */
static int ValidateAeRefRQItem(JVal* v, char* detailZ, size_t detailCap)
{
    JVal* ref;
    JVal* typeV;
    JVal* idxV;
    JVal* compV;
    JVal* statusV;
    JVal* nomV;
    size_t i;
    static const char* keys[] = { "type", "index", "comp", "status", "numOutputModules" };
    if (!v || v->kind != JK_OBJ || v->npairs != 1)
    {
        snprintf(detailZ, detailCap, "aeRefRQItem arg must be an object with exactly \"aeRef\"");
        return 0;
    }
    ref = JGet(v, "aeRef");
    if (!ref || ref->kind != JK_OBJ || ref->npairs != 5)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem must carry exactly type,index,comp,status,numOutputModules");
        return 0;
    }
    for (i = 0; i < ref->npairs; i++)
    {
        JPair* p = &ref->pairs[i];
        size_t k;
        int ok = 0;
        for (k = 0; k < sizeof(keys) / sizeof(keys[0]); k++)
            if (strlen(keys[k]) == p->klen && memcmp(keys[k], p->key, p->klen) == 0)
            { ok = 1; break; }
        if (!ok)
        {
            snprintf(detailZ, detailCap, "aeRefRQItem carries unsupported key");
            return 0;
        }
    }
    typeV = JGet(ref, "type");
    idxV = JGet(ref, "index");
    compV = JGet(ref, "comp");
    statusV = JGet(ref, "status");
    nomV = JGet(ref, "numOutputModules");
    if (!typeV || !idxV || !compV || !statusV || !nomV)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem requires type, index, comp, status, numOutputModules");
        return 0;
    }
    if (typeV->kind != JK_STR || !JStrEq(typeV, "rqItem"))
    {
        snprintf(detailZ, detailCap, "aeRefRQItem.type must be \"rqItem\"");
        return 0;
    }
    if (idxV->kind != JK_NUM || !isfinite(idxV->num) ||
        floor(idxV->num) != idxV->num || idxV->num < 0.0 || idxV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem.index must be an integer in [0, 1000000]");
        return 0;
    }
    if (!ValidateAeRefItem(compV, detailZ, detailCap)) return 0;
    if (statusV->kind != JK_NUM || !isfinite(statusV->num) ||
        floor(statusV->num) != statusV->num ||
        statusV->num < -2147483648.0 || statusV->num > 2147483647.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem.status must be an integer in int32 range");
        return 0;
    }
    if (nomV->kind != JK_NUM || !isfinite(nomV->num) ||
        floor(nomV->num) != nomV->num || nomV->num < 0.0 || nomV->num > 1000000.0)
    {
        snprintf(detailZ, detailCap,
                 "aeRefRQItem.numOutputModules must be a non-negative integer");
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

/* UTF-8 → A_UTF16Char encoder (Issue #327): the wire args carry UTF-8
   (JParseString already validated the encoding); AEGP_SetItemComment
   wants NUL-terminated UTF-16. `dstUnits` bounds the OUTPUT buffer in
   code units; returns units written (excluding NUL) or -1 on malformed
   UTF-8 / insufficient space. Surrogate pairs are emitted for
   codepoints > U+FFFF. */
static int IntakeUtf8ToUtf16(
    const char* srcP,
    size_t srcLen,
    A_UTF16Char* dstP,
    size_t dstUnits)
{
    size_t si = 0, di = 0;
    while (si < srcLen)
    {
        unsigned char c = (unsigned char)srcP[si];
        unsigned int cp;
        size_t need;
        if (c < 0x80) { cp = c; need = 1; }
        else if ((c & 0xE0) == 0xC0)
        {
            if (si + 1 >= srcLen ||
                ((unsigned char)srcP[si + 1] & 0xC0) != 0x80) return -1;
            cp = ((unsigned int)(c & 0x1F) << 6) |
                 ((unsigned int)(unsigned char)srcP[si + 1] & 0x3F);
            if (cp < 0x80) return -1; /* overlong */
            need = 2;
        }
        else if ((c & 0xF0) == 0xE0)
        {
            if (si + 2 >= srcLen ||
                ((unsigned char)srcP[si + 1] & 0xC0) != 0x80 ||
                ((unsigned char)srcP[si + 2] & 0xC0) != 0x80) return -1;
            cp = ((unsigned int)(c & 0x0F) << 12) |
                 (((unsigned int)(unsigned char)srcP[si + 1] & 0x3F) << 6) |
                 ((unsigned int)(unsigned char)srcP[si + 2] & 0x3F);
            if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) return -1;
            need = 3;
        }
        else if ((c & 0xF8) == 0xF0)
        {
            if (si + 3 >= srcLen ||
                ((unsigned char)srcP[si + 1] & 0xC0) != 0x80 ||
                ((unsigned char)srcP[si + 2] & 0xC0) != 0x80 ||
                ((unsigned char)srcP[si + 3] & 0xC0) != 0x80) return -1;
            cp = ((unsigned int)(c & 0x07) << 18) |
                 (((unsigned int)(unsigned char)srcP[si + 1] & 0x3F) << 12) |
                 (((unsigned int)(unsigned char)srcP[si + 2] & 0x3F) << 6) |
                 ((unsigned int)(unsigned char)srcP[si + 3] & 0x3F);
            if (cp < 0x10000 || cp > 0x10FFFF) return -1;
            need = 4;
        }
        else return -1;
        si += need;
        if (cp < 0x10000)
        {
            if (di + 1 >= dstUnits) return -1;
            dstP[di++] = (A_UTF16Char)cp;
        }
        else
        {
            unsigned int v = cp - 0x10000;
            if (di + 2 >= dstUnits) return -1;
            dstP[di++] = (A_UTF16Char)(0xD800 + (v >> 10));
            dstP[di++] = (A_UTF16Char)(0xDC00 + (v & 0x3FF));
        }
    }
    if (di + 1 > dstUnits) return -1;
    dstP[di] = 0;
    return (int)di;
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

/* Terminal verdict for a dispatched read-only request: outcome +
   bounded detail, and the fixed flag triple (no payload, never
   mutated, always publish). Every intake op is read-only, so the
   flags live here once instead of being re-typed at ~30 sites where
   a typo could silently flip mayHaveMutated. */
static void VerdictSet(ReqVerdict* v, const char* outcomeZ,
                       const char* detailFmt, ...)
{
    va_list ap;
    va_start(ap, detailFmt);
    snprintf(v->outcome, sizeof(v->outcome), "%s", outcomeZ);
    vsnprintf(v->detail, sizeof(v->detail), detailFmt, ap);
    va_end(ap);
    v->detail[sizeof(v->detail) - 1] = '\0';
    v->havePayload = 0;
    v->mayHaveMutated = 0;
    v->publish = 1;
}

/* Typed result payload with guaranteed NUL termination and the
   havePayload flag — replaces the snprintf + manual-NUL + flag
   triple repeated per getter (Issue #328). */
static void PayloadSet(ReqVerdict* v, const char* fmt, ...)
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
static void GetterTailReadOnly(
    const AllowEntry* allow,
    ReqVerdict* v,
    A_Err oerr,
    const char* detailOverride)
{
    if (oerr == A_Err_NONE && v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
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
        VerdictSet(v, "not-sent", "project suite entries unavailable for identity resolve");
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
            VerdictSet(v, "failed", "AEGP_GetNumProjects err=%ld", (long)perr);
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
            VerdictSet(v, "failed", "AEGP_GetProjectByIndex err=%ld", (long)perr);
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
        VerdictSet(v, "not-sent", "item/memory suite unavailable for identity resolve");
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
        VerdictSet(v, "not-sent", "project suite entries unavailable for enumeration");
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
            VerdictSet(v, "failed", "AEGP_GetNumProjects err=%ld", (long)perr);
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
            VerdictSet(v, "failed", "AEGP_GetProjectByIndex err=%ld", (long)perr);
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
        VerdictSet(v, "not-sent", "item/memory suite unavailable for enumeration");
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
        VerdictSet(v, "not-sent", "AEGP Comp Suite unavailable");
        return;
    }
    compP = (const AEGP_CompSuite13*)compSuite;

    if (!compP->AEGP_GetCompFromItem || !CompEntryPresent(compP, opId))
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "comp suite entry unavailable");
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
        VerdictSet(v, "failed", "AEGP_GetCompFromItem err=%ld", (long)cerr);
        return;
    }

    oerr = A_Err_STRUCT;
    if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompFramerate") == 0)
    {
        A_FpLong fps = 0;
        oerr = compP->AEGP_GetCompFramerate(compH, &fps);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"fps\":%.12g}", fps);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompFrameDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompFrameDuration(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"frameDuration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompWorkAreaStart") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompWorkAreaStart(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"workAreaStart\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompWorkAreaDuration(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"workAreaDuration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDisplayStartTime") == 0)
    {
        A_Time t = {0, 0};
        oerr = compP->AEGP_GetCompDisplayStartTime(compH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"displayStartTime\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDisplayDropFrame") == 0)
    {
        A_Boolean dropB = FALSE;
        oerr = compP->AEGP_GetCompDisplayDropFrame(compH, &dropB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"displayDropFrame\":%s}", dropB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompDownsampleFactor") == 0)
    {
        AEGP_DownsampleFactor dsf;
        dsf.xS = 0; dsf.yS = 0;
        oerr = compP->AEGP_GetCompDownsampleFactor(compH, &dsf);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"downsampleFactor\":{\"x\":%d,\"y\":%d}}",
                     (int)dsf.xS, (int)dsf.yS);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetShowLayerNameOrSourceName") == 0)
    {
        A_Boolean shownB = FALSE;
        oerr = compP->AEGP_GetShowLayerNameOrSourceName(compH, &shownB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"showLayerNameOrSourceName\":%s}",
                     shownB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetShowBlendModes") == 0)
    {
        A_Boolean shownB = FALSE;
        oerr = compP->AEGP_GetShowBlendModes(compH, &shownB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"showBlendModes\":%s}", shownB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompSuggestedMotionBlurSamples") == 0)
    {
        A_long samplesL = 0;
        oerr = compP->AEGP_GetCompSuggestedMotionBlurSamples(compH, &samplesL);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"suggestedMotionBlurSamples\":%ld}", (long)samplesL);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompMotionBlurAdaptiveSampleLimit") == 0)
    {
        A_long samplesL = 0;
        oerr = compP->AEGP_GetCompMotionBlurAdaptiveSampleLimit(compH, &samplesL);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"motionBlurAdaptiveSampleLimit\":%ld}", (long)samplesL);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompBGColor") == 0)
    {
        AEGP_ColorVal bg;
        memset(&bg, 0, sizeof(bg));
        oerr = compP->AEGP_GetCompBGColor(compH, &bg);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"bgColor\":{\"alpha\":%.12g,\"red\":%.12g,"
                     "\"green\":%.12g,\"blue\":%.12g}}",
                     bg.alphaF, bg.redF, bg.greenF, bg.blueF);
        }
    }
    else if (strcmp(opId, "AEGP_CompSuite13.AEGP_GetCompShutterAnglePhase") == 0)
    {
        A_Ratio angle = {0, 0}, phase = {0, 0};
        oerr = compP->AEGP_GetCompShutterAnglePhase(compH, &angle, &phase);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"shutterAngle\":{\"num\":%ld,\"den\":%lu},"
                     "\"shutterPhase\":{\"num\":%ld,\"den\":%lu}}",
                     (long)angle.num, (unsigned long)angle.den,
                     (long)phase.num, (unsigned long)phase.den);
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

    GetterTailReadOnly(allow, v, oerr, NULL);
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
        VerdictSet(v, "not-sent", "item suite entry unavailable");
        return;
    }

    if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemType") == 0)
    {
        AEGP_ItemType t = AEGP_ItemType_NONE;
        oerr = res.itemP->AEGP_GetItemType(res.itemH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"itemType\":%d}", (int)t);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemFlags") == 0)
    {
        AEGP_ItemFlags flags = 0;
        oerr = res.itemP->AEGP_GetItemFlags(res.itemH, &flags);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"flags\":%ld}", (long)flags);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_IsItemSelected") == 0)
    {
        A_Boolean selB = FALSE;
        oerr = res.itemP->AEGP_IsItemSelected(res.itemH, &selB);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"selected\":%s}", selB ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemLabel") == 0)
    {
        AEGP_LabelID label = AEGP_Label_NO_LABEL;
        oerr = res.itemP->AEGP_GetItemLabel(res.itemH, &label);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"label\":%d}", (int)label);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemDuration") == 0)
    {
        A_Time t = {0, 0};
        oerr = res.itemP->AEGP_GetItemDuration(res.itemH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"duration\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemCurrentTime") == 0)
    {
        A_Time t = {0, 0};
        oerr = res.itemP->AEGP_GetItemCurrentTime(res.itemH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"currentTime\":{\"value\":%ld,\"scale\":%lu}}",
                     (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemDimensions") == 0)
    {
        A_long w = 0, hgt = 0;
        oerr = res.itemP->AEGP_GetItemDimensions(res.itemH, &w, &hgt);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"width\":%ld,\"height\":%ld}", (long)w, (long)hgt);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio") == 0)
    {
        A_Ratio par = {0, 0};
        oerr = res.itemP->AEGP_GetItemPixelAspectRatio(res.itemH, &par);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"pixelAspectRatio\":{\"num\":%ld,\"den\":%lu}}",
                     (long)par.num, (unsigned long)par.den);
        }
    }
    else if (strcmp(opId, "AEGP_ItemSuite9.AEGP_GetItemComment") == 0)
    {
        AEGP_MemHandle commentH = NULL;
        char comment[ITEM_COMMENT_MAX + 1];
        char esc[ITEM_COMMENT_MAX * 2 + 16];
        oerr = res.itemP->AEGP_GetItemComment(res.itemH, &commentH);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            IntakeMemStatus ms = IntakeReadMemHandleUtf8(
                utilP, res.memP, commentH, comment, sizeof(comment));
            commentStatus = (int)ms;
            if (ms == IMH_OK)
            {
                JsonEscape(esc, sizeof(esc), comment);
                PayloadSet(v, "{\"comment\":\"%s\"}", esc);
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

    {
        char cdetail[96];
        const char* ov = NULL;
        if (commentStatus == (int)IMH_TRUNCATED)
        {
            snprintf(cdetail, sizeof(cdetail),
                     "comment exceeds %d-byte bound", ITEM_COMMENT_MAX);
            ov = cdetail;
        }
        GetterTailReadOnly(allow, v, oerr, ov);
    }
}

/* ---- Issue #327: first mutating op -------------------------------
   AEGP_ItemSuite9.AEGP_SetItemComment (UNDOABLE). Consent was already
   verified in ProcessClaimed before dispatch; this executor resolves
   the aeRef item host-side exactly like the read-only getters, then
   performs the single mutating AEGP call. mayHaveMutated semantics
   (contract §7g / trusted-execution §8): false until the AEGP call is
   actually attempted — once invoked, ANY outcome (success or error)
   sets mayHaveMutated=1 because the host may have applied the change
   before reporting failure. Pre-execution refusals (stale identity,
   missing suite entry, arg/codec failure) keep mayHaveMutated=0. */
static void ExecSetItemComment(
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
    JVal* commentV = JGet(args, "comment");
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;
    A_Err oerr = A_Err_STRUCT;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, 0, " (resolve)", &res, v))
        return; /* v already carries the verdict */

    if (!res.itemP->AEGP_SetItemComment)
    {
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "item suite entry unavailable");
        return;
    }

    {
        /* comment is bounded UTF-8 (ARGK_STR, ≤ ITEM_COMMENT_MAX
           bytes); AEGP wants NUL-terminated UTF-16. Worst case the
           UTF-16 unit count equals the byte count (all-ASCII), plus
           the NUL — allocate slen+1 units. */
        size_t u16cap = (commentV ? commentV->slen : 0) + 1;
        A_UTF16Char* u16 = (A_UTF16Char*)malloc(u16cap * sizeof(A_UTF16Char));
        int units = -1;
        if (u16 && commentV && commentV->kind == JK_STR)
            units = IntakeUtf8ToUtf16(commentV->str, commentV->slen,
                                      u16, u16cap);
        if (!u16 || units < 0)
        {
            free(u16);
            ReleaseResolution(utilP, basicP, &res);
            VerdictSet(v, "failed", "comment is not valid UTF-8");
            return;
        }
        oerr = res.itemP->AEGP_SetItemComment(res.itemH, u16);
        RecordAllowOp(utilP, allow, oerr);
        free(u16);
    }

    ReleaseResolution(utilP, basicP, &res);

    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"commentSet\":true}");
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "%s err=%ld", allow->operationId, (long)oerr);
        v->havePayload = 0;
        v->publish = 1;
    }
    /* Reaching here means the AEGP entry was invoked (every earlier
       path returned): the mutation may have been applied even when
       the call reported an error. */
    v->mayHaveMutated = 1;
}

/* ---- AEGP_LayerSuite9 (Issue #318 / #64 layer slice) -----------------
   Vertical slice of the shared identity resolver, one level deeper:
   the wire carries an aeRefLayer descriptor
     {"aeRef":{"type":"layer","name":..,"layerId":N,
               "comp":{"aeRef":{<comp item descriptor>}}}}
   — the parent comp binding is part of the layer's identity. Resolution:
   comp aeRef → ResolveAeRefItem → itemH → AEGP_GetCompFromItem →
   compH → scan AEGP_GetCompNumLayers/GetCompLayerByIndex for the live
   AEGP_GetLayerID match, then AEGP_GetLayerName corroboration. Layer
   and comp handles are borrowed — never freed, never on the wire; both
   suites are released before the request completes. Missing
   suite/entry → not-sent; AEGP errors → failed; identity mismatch →
   refused STALE_REFERENCE; all read-only → mayHaveMutated=false. */

#define LAYER_NAME_MAX 1024
#define LAYER_SCAN_MAX 100000L

typedef struct
{
    ItemResolution res;          /* resolved parent comp item */
    const void* compSuite;
    const void* layerSuite;
    const AEGP_CompSuite13* compP;
    const AEGP_LayerSuite9* layerP;
    AEGP_CompH compH;            /* borrowed, request-window only */
    AEGP_LayerH layerH;          /* borrowed, request-window only */
} LayerResolution;

static void ReleaseLayerResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    LayerResolution* lr)
{
    if (lr->compSuite)
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
    if (lr->layerSuite)
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    ReleaseResolution(utilP, basicP, &lr->res);
    memset(lr, 0, sizeof(*lr));
}

/* Resolve a validated aeRefLayer descriptor to a live layer inside the
   request window. On success returns 1 with lr filled — caller MUST
   ReleaseLayerResolution. On failure returns 0 with `v` carrying the
   verdict. */
static int ResolveLayerRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* layerRef,
    int wantProjectIdentity,
    const char* nameCallExtraZ,
    LayerResolution* lr,
    ReqVerdict* v)
{
    JVal* nameV = JGet(layerRef, "name");
    JVal* idV = JGet(layerRef, "layerId");
    JVal* compObj = JGet(layerRef, "comp");
    JVal* compRef = compObj ? JGet(compObj, "aeRef") : NULL;
    long wantId = 0;
    const void* compSuite = NULL;
    const void* layerSuite = NULL;
    const AEGP_CompSuite13* compP = NULL;
    const AEGP_LayerSuite9* layerP = NULL;
    AEGP_CompH compH = NULL;
    AEGP_LayerH matchH = NULL;
    A_long numLayers = 0;
    long matches = 0;
    long i;
    A_Err perr;

    memset(lr, 0, sizeof(*lr));
    if (idV) wantId = (long)idV->num;
    if (!nameV || !idV || !compRef)
    {
        VerdictRefuse(v, "MALFORMED_REQUEST",
                      "aeRefLayer requires name, layerId, comp.aeRef");
        return 0;
    }

    /* parent comp first — full §7b item resolution + corroboration */
    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projectIndex, compRef, wantProjectIdentity,
                          nameCallExtraZ, &lr->res, v))
        return 0;
    if (lr->res.type != AEGP_ItemType_COMP)
    {
        ReleaseResolution(utilP, basicP, &lr->res);
        VerdictRefuse(v, "STALE_REFERENCE",
                      "parent comp descriptor does not resolve to a comp item");
        return 0;
    }

    compSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPCompSuite, kAEGPCompSuiteVersion13);
    layerSuite = IntakeAcquireSuite(utilP, basicP,
                                    kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    if (!compSuite || !layerSuite)
    {
        if (compSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPCompSuite, kAEGPCompSuiteVersion13);
        if (layerSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
        ReleaseResolution(utilP, basicP, &lr->res);
        VerdictSet(v, "not-sent", "comp/layer suite unavailable for layer resolve");
        return 0;
    }
    compP = (const AEGP_CompSuite13*)compSuite;
    layerP = (const AEGP_LayerSuite9*)layerSuite;
    lr->compSuite = compSuite;
    lr->layerSuite = layerSuite;
    lr->compP = compP;
    lr->layerP = layerP;

#define LRES_NOT_SENT(msg) do { \
        ReleaseLayerResolution(utilP, basicP, lr); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define LRES_FAILED(fmt, err) do { \
        ReleaseLayerResolution(utilP, basicP, lr); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define LRES_STALE(why) do { \
        ReleaseLayerResolution(utilP, basicP, lr); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    if (!compP->AEGP_GetCompFromItem || !layerP->AEGP_GetCompNumLayers ||
        !layerP->AEGP_GetCompLayerByIndex || !layerP->AEGP_GetLayerID ||
        !layerP->AEGP_GetLayerName)
        LRES_NOT_SENT("comp/layer suite entries unavailable for layer resolve");

    perr = compP->AEGP_GetCompFromItem(lr->res.itemH, &compH);
    IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE || !compH)
        LRES_FAILED("AEGP_GetCompFromItem err=%ld", perr);
    lr->compH = compH;

    perr = layerP->AEGP_GetCompNumLayers(compH, &numLayers);
    IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetCompNumLayers",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE)
        LRES_FAILED("AEGP_GetCompNumLayers err=%ld", perr);
    if (numLayers < 0 || numLayers > LAYER_SCAN_MAX)
        LRES_FAILED("layer count exceeds scan bound err=%ld", numLayers);

    /* layerId-authoritative scan — reorder-tolerant like the item
       resolver; every candidate's live id is compared bit-exact. */
    for (i = 0; i < (long)numLayers; i++)
    {
        AEGP_LayerH lh = NULL;
        AEGP_LayerIDVal lid = 0;
        perr = layerP->AEGP_GetCompLayerByIndex(compH, (A_long)i, &lh);
        IntakeOpRecord(utilP,
            "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex", (long)perr,
            perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE || !lh)
            LRES_FAILED("AEGP_GetCompLayerByIndex err=%ld", perr);
        perr = layerP->AEGP_GetLayerID(lh, &lid);
        IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerID",
                       (long)perr,
                       perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE)
            LRES_FAILED("AEGP_GetLayerID err=%ld", perr);
        if ((long)lid == wantId) { matches++; matchH = lh; }
    }
    if (matches == 0) LRES_STALE("layerId not found");
    if (matches > 1) LRES_STALE("layerId ambiguous");
    lr->layerH = matchH;

    /* name corroboration — a renamed layer stales its descriptor
       (client re-issues via GetCompLayerByIndex). GetLayerName returns
       TWO mem handles; both are freed (the reader frees the layer
       name, the source name is freed explicitly). */
    {
        AEGP_MemHandle lnH = NULL;
        AEGP_MemHandle snH = NULL;
        char lname[LAYER_NAME_MAX + 1];
        IntakeMemStatus ms;
        perr = layerP->AEGP_GetLayerName(plugin_id, matchH, &lnH, &snH);
        IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerName",
                       (long)perr,
                       perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE)
        {
            if (snH) IntakeFreeMemHandle(utilP, lr->res.memP, snH);
            LRES_FAILED("AEGP_GetLayerName err=%ld", perr);
        }
        ms = IntakeReadMemHandleUtf8(utilP, lr->res.memP, lnH,
                                     lname, sizeof(lname));
        if (snH) IntakeFreeMemHandle(utilP, lr->res.memP, snH);
        if (ms == IMH_TRUNCATED)
            LRES_STALE("layer name exceeds identity bound");
        if (ms != IMH_OK)
            LRES_FAILED("layer name mem-handle read failed err=%ld", (long)ms);
        if (nameV->slen != strlen(lname) ||
            memcmp(nameV->str, lname, nameV->slen) != 0)
            LRES_STALE("layer name mismatch");
    }

#undef LRES_NOT_SENT
#undef LRES_FAILED
#undef LRES_STALE
    return 1;
}

/* Entry-presence gate for the layer-scoped getters. */
static int LayerGetterEntryPresent(const AEGP_LayerSuite9* c, const char* opIdZ)
{
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerIndex") == 0)
        return c->AEGP_GetLayerIndex != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerName") == 0)
        return c->AEGP_GetLayerName != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerFlags") == 0)
        return c->AEGP_GetLayerFlags != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerQuality") == 0)
        return c->AEGP_GetLayerQuality != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerObjectType") == 0)
        return c->AEGP_GetLayerObjectType != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer3D") == 0)
        return c->AEGP_IsLayer3D != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer2D") == 0)
        return c->AEGP_IsLayer2D != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0)
        return c->AEGP_GetLayerCurrentTime != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0)
        return c->AEGP_GetLayerInPoint != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerDuration") == 0)
        return c->AEGP_GetLayerDuration != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerID") == 0)
        return c->AEGP_GetLayerID != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerLabel") == 0)
        return c->AEGP_GetLayerLabel != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality") == 0)
        return c->AEGP_GetLayerSamplingQuality != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID") == 0)
        return c->AEGP_GetLayerSourceItemID != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn") == 0)
        return c->AEGP_IsLayerVideoReallyOn != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn") == 0)
        return c->AEGP_IsLayerAudioReallyOn != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte") == 0)
        return c->AEGP_DoesLayerHaveTrackMatte != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte") == 0)
        return c->AEGP_IsLayerUsedAsTrackMatte != NULL;
    if (strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0)
        return c->AEGP_GetTrackMatteLayer != NULL;
    return 0;
}

/* Dispatch routers — explicit id lists so a future LayerSuite9
   allowlist addition without an executor still reaches
   OPERATION_NOT_DISPATCHABLE instead of being misrouted. */
static int IsLayerCompOpId(const char* opIdZ)
{
    return strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetCompNumLayers") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex") == 0;
}

static int IsLayerGetterOpId(const char* opIdZ)
{
    return strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerIndex") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerName") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerFlags") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerQuality") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerObjectType") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer3D") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayer2D") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerDuration") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerID") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerLabel") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte") == 0 ||
           strcmp(opIdZ, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0;
}

/* Emit one aeRefLayer descriptor object {"type":"layer",...} into the
   JBuf — used by GetCompLayerByIndex (issuance) and GetTrackMatteLayer
   (derived-handle → descriptor). Reads the layer's live id+name and
   the comp item's live id; the comp aeRef is rebuilt from the resolved
   ItemResolution (which carries the live name/index and, when
   wantProjectIdentity was set, project name/path). Returns A_Err_NONE
   on success; A_Err_STRUCT on payload overflow or unreadable identity
   data (caller maps to `failed` — never a partial descriptor). */
static A_Err EmitLayerRefInner(
    JBuf* b,
    const AEGP_UtilitySuite6* utilP,
    AEGP_PluginID plugin_id,
    const AEGP_MemorySuite1* memP,
    const AEGP_ItemSuite9* itemP,
    AEGP_ItemH compItemH,
    const ItemResolution* compRes,
    const AEGP_LayerSuite9* layerP,
    AEGP_LayerH layerH)
{
    AEGP_LayerIDVal lid = 0;
    A_long compId = 0;
    AEGP_MemHandle lnH = NULL;
    AEGP_MemHandle snH = NULL;
    char lname[LAYER_NAME_MAX + 1];
    IntakeMemStatus ms;
    A_Err err;

    err = layerP->AEGP_GetLayerID(layerH, &lid);
    IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerID", (long)err,
                   err == A_Err_NONE ? " (issuance)" : NULL);
    if (err != A_Err_NONE) return err;
    err = layerP->AEGP_GetLayerName(plugin_id, layerH, &lnH, &snH);
    IntakeOpRecord(utilP, "AEGP_LayerSuite9.AEGP_GetLayerName", (long)err,
                   err == A_Err_NONE ? " (issuance)" : NULL);
    if (err != A_Err_NONE)
    {
        if (snH) IntakeFreeMemHandle(utilP, memP, snH);
        return err;
    }
    ms = IntakeReadMemHandleUtf8(utilP, memP, lnH, lname, sizeof(lname));
    if (snH) IntakeFreeMemHandle(utilP, memP, snH);
    if (ms != IMH_OK) return A_Err_STRUCT; /* truncated or unreadable */
    if (!itemP->AEGP_GetItemID) return A_Err_STRUCT;
    err = itemP->AEGP_GetItemID(compItemH, &compId);
    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID", (long)err,
                   err == A_Err_NONE ? " (issuance)" : NULL);
    if (err != A_Err_NONE) return err;

    JBPut(b, "{\"type\":\"layer\",\"name\":\"");
    JBEsc(b, lname);
    JBPut(b, "\",\"layerId\":");
    JBNum(b, (long)lid);
    JBPut(b, ",\"comp\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"");
    JBEsc(b, compRes->name);
    JBPut(b, "\",\"path\":[");
    JBNum(b, compRes->index);
    JBPut(b, "],\"itemId\":");
    JBNum(b, (long)(unsigned int)compId);
    if (compRes->haveProjectName)
    {
        JBPut(b, ",\"projectName\":\"");
        JBEsc(b, compRes->projectName);
        JBPut(b, "\"");
    }
    if (compRes->haveProjectPath)
    {
        JBPut(b, ",\"projectPath\":\"");
        JBEsc(b, compRes->projectPath);
        JBPut(b, "\"");
    }
    JBPut(b, "}}}");
    return b->of ? A_Err_STRUCT : A_Err_NONE;
}

/* Comp-scoped layer ops: GetCompNumLayers (count) and
   GetCompLayerByIndex (descriptor issuance). Args carry the comp aeRef
   (+ layerIndex for the latter). */
static void ExecLayerCompOp(
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
    int isIndexOp =
        strcmp(allow->operationId,
               "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex") == 0;
    ItemResolution res;
    const void* compSuite = NULL;
    const void* layerSuite = NULL;
    const AEGP_CompSuite13* compP = NULL;
    const AEGP_LayerSuite9* layerP = NULL;
    AEGP_CompH compH = NULL;
    A_Err oerr = A_Err_STRUCT;
    const char* opId = allow->operationId;

    /* issuance needs the full comp descriptor (itemId + project
       identity) embedded in the emitted aeRefLayer */
    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, isIndexOp, " (resolve)",
                          &res, v))
        return;
    if (res.type != AEGP_ItemType_COMP)
    {
        ReleaseResolution(utilP, basicP, &res);
        VerdictRefuse(v, "STALE_REFERENCE",
                      "comp descriptor does not resolve to a comp item");
        return;
    }

    compSuite = IntakeAcquireSuite(utilP, basicP,
                                   kAEGPCompSuite, kAEGPCompSuiteVersion13);
    layerSuite = IntakeAcquireSuite(utilP, basicP,
                                    kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    if (!compSuite || !layerSuite)
    {
        if (compSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPCompSuite, kAEGPCompSuiteVersion13);
        if (layerSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "comp/layer suite unavailable");
        return;
    }
    compP = (const AEGP_CompSuite13*)compSuite;
    layerP = (const AEGP_LayerSuite9*)layerSuite;

    if (!compP->AEGP_GetCompFromItem || !layerP->AEGP_GetCompNumLayers ||
        !layerP->AEGP_GetCompLayerByIndex || !layerP->AEGP_GetLayerID ||
        !layerP->AEGP_GetLayerName)
    {
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPCompSuite, kAEGPCompSuiteVersion13);
        IntakeReleaseSuite(utilP, basicP,
                           kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
        ReleaseResolution(utilP, basicP, &res);
        VerdictSet(v, "not-sent", "comp/layer suite entry unavailable");
        return;
    }

    {
        A_Err cerr = compP->AEGP_GetCompFromItem(res.itemH, &compH);
        IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetCompFromItem",
                       (long)cerr, NULL);
        if (cerr != A_Err_NONE || !compH)
        {
            IntakeReleaseSuite(utilP, basicP,
                               kAEGPCompSuite, kAEGPCompSuiteVersion13);
            IntakeReleaseSuite(utilP, basicP,
                               kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
            ReleaseResolution(utilP, basicP, &res);
            VerdictSet(v, "failed", "AEGP_GetCompFromItem err=%ld", (long)cerr);
            return;
        }
    }

    if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetCompNumLayers") == 0)
    {
        A_long n = 0;
        oerr = layerP->AEGP_GetCompNumLayers(compH, &n);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"numLayers\":%ld}", (long)n);
        }
    }
    else
    {
        long idx = ArgsInt(allow, args, 2);
        AEGP_LayerH lh = NULL;
        oerr = layerP->AEGP_GetCompLayerByIndex(compH, (A_long)idx, &lh);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE && lh)
        {
            JBuf b;
            A_Err e2;
            JBInit(&b, v->payload, sizeof(v->payload));
            JBPut(&b, "{\"index\":");
            JBNum(&b, idx);
            JBPut(&b, ",\"layer\":{\"aeRef\":");
            e2 = EmitLayerRefInner(&b, utilP, plugin_id, res.memP,
                                   res.itemP, res.itemH, &res, layerP, lh);
            JBPut(&b, "}}");
            if (e2 != A_Err_NONE || b.of)
                oerr = A_Err_STRUCT;
            else
            {
                *b.cur = '\0';
                v->havePayload = 1;
            }
        }
        else if (oerr == A_Err_NONE)
        {
            oerr = A_Err_STRUCT; /* NULL layer handle */
        }
    }

    IntakeReleaseSuite(utilP, basicP,
                       kAEGPCompSuite, kAEGPCompSuiteVersion13);
    IntakeReleaseSuite(utilP, basicP,
                       kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    ReleaseResolution(utilP, basicP, &res);

    GetterTailReadOnly(allow, v, oerr, NULL);
}

/* Layer-handle getters: {projectIndex, layer:<aeRefLayer>} → shared
   resolver chain → typed getter on the resolved layer handle. */
static void ExecLayerGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* layerArg = JGet(args, "layer");
    JVal* layerRef = layerArg ? JGet(layerArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    const char* opId = allow->operationId;
    /* GetTrackMatteLayer emits an aeRefLayer — needs the full comp
       descriptor (itemId + project identity) inside it. */
    int wantPI =
        strcmp(opId, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0;
    LayerResolution lr;
    A_Err oerr = A_Err_STRUCT;

    if (!layerRef)
    {
        VerdictRefuse(v, "MALFORMED_REQUEST", "layer.aeRef missing");
        return;
    }
    if (!ResolveLayerRef(utilP, projP, basicP, plugin_id,
                         projIndex, layerRef, wantPI, " (resolve)",
                         &lr, v))
        return;

    if (!LayerGetterEntryPresent(lr.layerP, opId))
    {
        ReleaseLayerResolution(utilP, basicP, &lr);
        VerdictSet(v, "not-sent", "layer suite entry unavailable");
        return;
    }

    if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerIndex") == 0)
    {
        A_long idx = 0;
        oerr = lr.layerP->AEGP_GetLayerIndex(lr.layerH, &idx);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"index\":%ld}", (long)idx);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerName") == 0)
    {
        AEGP_MemHandle lnH = NULL;
        AEGP_MemHandle snH = NULL;
        char lname[LAYER_NAME_MAX + 1];
        char sname[LAYER_NAME_MAX + 1];
        IntakeMemStatus ms1, ms2;
        oerr = lr.layerP->AEGP_GetLayerName(plugin_id, lr.layerH,
                                            &lnH, &snH);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            ms1 = IntakeReadMemHandleUtf8(utilP, lr.res.memP, lnH,
                                          lname, sizeof(lname));
            ms2 = IntakeReadMemHandleUtf8(utilP, lr.res.memP, snH,
                                          sname, sizeof(sname));
            if (ms1 == IMH_OK && ms2 == IMH_OK)
            {
                char e1[LAYER_NAME_MAX * 6 + 16];
                char e2[LAYER_NAME_MAX * 6 + 16];
                JsonEscape(e1, sizeof(e1), lname);
                JsonEscape(e2, sizeof(e2), sname);
                PayloadSet(v, "{\"name\":\"%s\",\"sourceName\":\"%s\"}",
                         e1, e2);
            }
            else
            {
                oerr = A_Err_STRUCT; /* truncated/unreadable name */
            }
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerFlags") == 0)
    {
        AEGP_LayerFlags flags = 0;
        oerr = lr.layerP->AEGP_GetLayerFlags(lr.layerH, &flags);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"flags\":%ld}", (long)flags);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerQuality") == 0)
    {
        AEGP_LayerQuality q = AEGP_LayerQual_BEST;
        oerr = lr.layerP->AEGP_GetLayerQuality(lr.layerH, &q);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"quality\":%d}", (int)q);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerObjectType") == 0)
    {
        AEGP_ObjectType ot = AEGP_ObjectType_NONE;
        oerr = lr.layerP->AEGP_GetLayerObjectType(lr.layerH, &ot);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"objectType\":%ld}", (long)ot);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayer3D") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayer3D(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"is3D\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayer2D") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayer2D(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"is2D\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0 ||
             strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0 ||
             strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerDuration") == 0)
    {
        AEGP_LTimeMode tm =
            (AEGP_LTimeMode)ArgsInt(allow, args, 2);
        A_Time t = {0, 0};
        const char* key =
            strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0
                ? "currentTime"
            : strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0
                ? "inPoint" : "duration";
        if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime") == 0)
            oerr = lr.layerP->AEGP_GetLayerCurrentTime(lr.layerH, tm, &t);
        else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerInPoint") == 0)
            oerr = lr.layerP->AEGP_GetLayerInPoint(lr.layerH, tm, &t);
        else
            oerr = lr.layerP->AEGP_GetLayerDuration(lr.layerH, tm, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"%s\":{\"value\":%ld,\"scale\":%lu}}",
                     key, (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerID") == 0)
    {
        AEGP_LayerIDVal lid = 0;
        oerr = lr.layerP->AEGP_GetLayerID(lr.layerH, &lid);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"layerId\":%ld}", (long)lid);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerLabel") == 0)
    {
        AEGP_LabelID label = AEGP_Label_NO_LABEL;
        oerr = lr.layerP->AEGP_GetLayerLabel(lr.layerH, &label);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"label\":%d}", (int)label);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality") == 0)
    {
        AEGP_LayerSamplingQuality q = AEGP_LayerSamplingQual_BILINEAR;
        oerr = lr.layerP->AEGP_GetLayerSamplingQuality(lr.layerH, &q);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"samplingQuality\":%d}", (int)q);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID") == 0)
    {
        A_long sid = 0;
        oerr = lr.layerP->AEGP_GetLayerSourceItemID(lr.layerH, &sid);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"sourceItemId\":%ld}", (long)sid);
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayerVideoReallyOn(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"videoOn\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayerAudioReallyOn(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"audioOn\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte") == 0)
    {
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_DoesLayerHaveTrackMatte(lr.layerH, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"hasTrackMatte\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte") == 0)
    {
        A_Boolean fill = (A_Boolean)ArgsInt(allow, args, 2);
        A_Boolean b = FALSE;
        oerr = lr.layerP->AEGP_IsLayerUsedAsTrackMatte(lr.layerH, fill, &b);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"isTrackMatte\":%s}", b ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer") == 0)
    {
        AEGP_LayerH matteH = NULL;
        JBuf b;
        A_Err e2 = A_Err_NONE;
        oerr = lr.layerP->AEGP_GetTrackMatteLayer(lr.layerH, &matteH);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            JBInit(&b, v->payload, sizeof(v->payload));
            JBPut(&b, "{\"trackMatteLayer\":");
            if (matteH)
            {
                JBPut(&b, "{\"aeRef\":");
                e2 = EmitLayerRefInner(&b, utilP, plugin_id,
                                       lr.res.memP, lr.res.itemP,
                                       lr.res.itemH, &lr.res, lr.layerP,
                                       matteH);
                JBPut(&b, "}");
            }
            else
                JBPut(&b, "null");
            JBPut(&b, "}");
            if (e2 != A_Err_NONE || b.of)
                oerr = A_Err_STRUCT;
            else
            {
                *b.cur = '\0';
                v->havePayload = 1;
            }
        }
    }
    else
    {
        oerr = A_Err_STRUCT;
    }

    ReleaseLayerResolution(utilP, basicP, &lr);

    GetterTailReadOnly(allow, v, oerr, NULL);
}

/* Execute one claimed request file. Always publishes a result when
   publish==1; the caller removes the .claimed file afterwards.
   `mtimeMs` is the claimed file's mtime — the deadline base, matching
   the ae-a8n dispatcher convention (mtime + timeoutMs). */
/* ================= Issue #318 Stage 4: project + RQ-item identity ====
   §7e aeRefProject: the SDK has no project id — identity is
   index + name + path corroboration with a collision scan (§7e).
   §7f aeRefRQItem: no RQ-item id and RQItemRefH dies on any queue
   change — identity is index + bound-comp itemId + (status,
   numOutputModules) fingerprint, all re-verified inside ONE dispatch
   (atomic select+read; the handle never leaves the request window). */

/* Resolve an aeRefProject descriptor to a borrowed projectH inside the
   request window. projP is the fingerprint-held suite; the memory suite
   is acquired/released internally for the path read. On success
   returns 1 with *projectHOut set (borrowed — caller must NOT free);
   name/path are re-fetched into out params for payload use. On failure
   returns 0 with `v` carrying the verdict. */
static int ResolveProjectRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    JVal* ref,
    AEGP_ProjectH* projectHOut,
    long* indexOut,
    ReqVerdict* v)
{
    JVal* idxV = JGet(ref, "index");
    JVal* nameV = JGet(ref, "name");
    JVal* pathV = JGet(ref, "path");
    long wantIndex = (long)idxV->num;
    const void* memSuite = NULL;
    const AEGP_MemorySuite1* memP = NULL;
    AEGP_ProjectH projectH = NULL;
    A_long numProjects = 0;
    A_Err perr;
    char liveName[AEGP_MAX_PROJ_NAME_SIZE + 1];
    char livePath[PROJ_STR_MAX + 1];
    A_Err ferr = A_Err_NONE;

    *projectHOut = NULL;
    *indexOut = wantIndex;

    if (!projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex ||
        !projP->AEGP_GetProjectName || !projP->AEGP_GetProjectPath)
    {
        VerdictSet(v, "not-sent", "project suite entries unavailable for identity resolve");
        return 0;
    }
    memSuite = IntakeAcquireSuite(utilP, basicP,
                                  kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (!memSuite)
    {
        VerdictSet(v, "not-sent", "memory suite unavailable for project identity resolve");
        return 0;
    }
    memP = (const AEGP_MemorySuite1*)memSuite;

#define PROJRES_NOT_SENT(msg) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define PROJRES_FAILED(fmt, err) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define PROJRES_STALE(why) do { \
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    perr = projP->AEGP_GetNumProjects(&numProjects);
    IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetNumProjects",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE)
        PROJRES_FAILED("AEGP_GetNumProjects err=%ld", perr);
    if (wantIndex < 0 || wantIndex >= (long)numProjects)
        PROJRES_STALE("project index out of range");
    perr = projP->AEGP_GetProjectByIndex(wantIndex, &projectH);
    IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE || !projectH)
        PROJRES_FAILED("AEGP_GetProjectByIndex err=%ld", perr);

    /* corroborate name + path against live identity */
    {
        int fpi = FetchProjectIdentity(utilP, projP, memP, projectH,
                                     1, 1, liveName, sizeof(liveName),
                                     livePath, sizeof(livePath), &ferr);
        if (fpi == FPI_AEGP_ERR)
            PROJRES_FAILED("project identity read err=%ld", ferr);
        if (fpi == FPI_TRUNCATED)
            PROJRES_FAILED("project path exceeds descriptor bound err=%ld", ferr);
    }
    if (!JStrEqCStr(nameV, liveName))
        PROJRES_STALE("project name mismatch");
    /* path: descriptor empty → accept any live path (save tolerance);
       non-empty → exact match required. */
    if (pathV->slen > 0 && !JStrEqCStr(pathV, livePath))
        PROJRES_STALE("project path mismatch");

    /* collision scan: count open projects satisfying the same
       (name, path) corroboration. >1 → ambiguous → fail closed (§7e). */
    {
        long matches = 0;
        long pi;
        for (pi = 0; pi < (long)numProjects && matches <= 1; pi++)
        {
            AEGP_ProjectH ph2 = NULL;
            char n2[AEGP_MAX_PROJ_NAME_SIZE + 1];
            char p2[PROJ_STR_MAX + 1];
            A_Err e2;
            int f2;
            perr = projP->AEGP_GetProjectByIndex(pi, &ph2);
            IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                           (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
            if (perr != A_Err_NONE || !ph2) continue;
            f2 = FetchProjectIdentity(utilP, projP, memP, ph2,
                                    1, 1, n2, sizeof(n2), p2, sizeof(p2), &e2);
            if (f2 != FPI_OK) continue;
            if (!JStrEqCStr(nameV, n2)) continue;
            if (pathV->slen > 0 && !JStrEqCStr(pathV, p2)) continue;
            matches++;
        }
        if (matches > 1)
            PROJRES_STALE("project identity ambiguous");
    }

#undef PROJRES_NOT_SENT
#undef PROJRES_FAILED
#undef PROJRES_STALE
    IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    *projectHOut = projectH;
    return 1;
}

/* Project-scoped read-only getters (§7e): {"project": <aeRefProject>}
   → resolve → typed getter → typed JSON. */
static void ExecProjectGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* projArg = JGet(args, "project");
    JVal* ref = projArg ? JGet(projArg, "aeRef") : NULL;
    AEGP_ProjectH projectH = NULL;
    long index = 0;
    const char* opId = allow->operationId;
    A_Err oerr = A_Err_STRUCT;

    if (!ResolveProjectRef(utilP, projP, basicP, ref, &projectH, &index, v))
        return;

    if (strcmp(opId, "AEGP_ProjSuite6.AEGP_ProjectIsDirty") == 0)
    {
        A_Boolean dirty = FALSE;
        if (!projP->AEGP_ProjectIsDirty) goto notsent;
        oerr = projP->AEGP_ProjectIsDirty(projectH, &dirty);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"dirty\":%s}",
                     dirty ? "true" : "false");
        }
    }
    else if (strcmp(opId, "AEGP_ProjSuite6.AEGP_GetProjectBitDepth") == 0)
    {
        AEGP_ProjBitDepth depth = 0;
        if (!projP->AEGP_GetProjectBitDepth) goto notsent;
        oerr = projP->AEGP_GetProjectBitDepth(projectH, &depth);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"bitDepth\":%d}",
                     (int)depth);
        }
    }
    else /* AEGP_GetProjectTimeDisplay */
    {
        AEGP_TimeDisplay3 td;
        if (!projP->AEGP_GetProjectTimeDisplay) goto notsent;
        memset(&td, 0, sizeof(td));
        oerr = projP->AEGP_GetProjectTimeDisplay(projectH, &td);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"timeDisplay\":{\"displayMode\":%d,\"footageDisplayMode\":%d,"
                "\"displayDropFrame\":%s,\"useFeetFrames\":%s,\"timebase\":%d,"
                "\"framesPerFoot\":%d,\"framesDisplayMode\":%d}}",
                (int)td.display_mode, (int)td.footage_display_mode,
                td.display_dropframeB ? "true" : "false",
                td.use_feet_framesB ? "true" : "false",
                (int)td.timebaseC, (int)td.frames_per_footC,
                (int)td.frames_display_mode);
        }
    }

    if (oerr == A_Err_NONE && v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
    }
    else if (oerr == A_Err_STRUCT && !v->havePayload)
    {
        /* unreachable: notsent label handles missing entries */
        VerdictSet(v, "failed", "getter returned no result");
    }
    else
    {
        VerdictSet(v, "failed", "%s err=%ld", opId, (long)oerr);
    }
    return;

notsent:
    VerdictSet(v, "not-sent", "project suite entry unavailable");
}

/* ---- §7f RQ-item resolution -------------------------------------- */

typedef struct
{
    ItemResolution item;          /* comp item resolution (suites held) */
    const void* compSuite;
    const void* rqItemSuite;
    const AEGP_CompSuite13* compP;
    const AEGP_RQItemSuite4* rqItemP;
    AEGP_RQItemRefH rqH;          /* borrowed — never freed, never leaves window */
    long rqIndex;
    long wantItemId;              /* descriptor comp's live itemId (-1 = legacy) */
    long wantStatus;
    long wantNumOM;
} RQResolution;

static void ReleaseRQResolution(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    RQResolution* r)
{
    if (r->rqItemSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    if (r->compSuite)
        IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
    ReleaseResolution(utilP, basicP, &r->item);
    memset(r, 0, sizeof(*r));
}

/* Resolve an aeRefRQItem descriptor + projectIndex to a live
   AEGP_RQItemRefH inside ONE dispatch (§7f): comp aeRef → shared item
   resolver → comp's live itemId; queue index → RQItemByIndex →
   GetCompFromRQItem → GetItemFromComp → live itemId must match;
   (status, numOutputModules) fingerprint must match. All pins
   re-verified before the caller's getter runs. */
static int ResolveRQItemRef(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    long projectIndex,
    JVal* ref,
    RQResolution* r,
    ReqVerdict* v)
{
    JVal* idxV = JGet(ref, "index");
    JVal* compArg = JGet(ref, "comp");
    JVal* compRef = compArg ? JGet(compArg, "aeRef") : NULL;
    JVal* statusV = JGet(ref, "status");
    JVal* nomV = JGet(ref, "numOutputModules");
    long rqIndex = (long)idxV->num;
    AEGP_RQItemRefH rqH = NULL;
    AEGP_CompH boundCompH = NULL;
    AEGP_ItemH boundItemH = NULL;
    A_long boundItemId = 0;
    A_long numRQ = 0;
    AEGP_RenderItemStatusType liveStatus = 0;
    A_long liveNumOM = 0;
    A_Err e;

    memset(r, 0, sizeof(*r));
    r->rqIndex = rqIndex;
    r->wantStatus = (long)statusV->num;
    r->wantNumOM = (long)nomV->num;
    r->wantItemId = -1;

    /* 1. bound comp via the shared item resolver (project identity
       fetched so callers can emit descriptors). */
    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projectIndex, compRef, 1, " (resolve)",
                          &r->item, v))
        return 0;
    if (r->item.type != AEGP_ItemType_COMP)
    {
        ReleaseResolution(utilP, basicP, &r->item);
        VerdictRefuse(v, "STALE_REFERENCE", "rqItem comp binding is not a comp");
        return 0;
    }
    e = r->item.itemP->AEGP_GetItemID
        ? r->item.itemP->AEGP_GetItemID(r->item.itemH, &boundItemId)
        : A_Err_STRUCT;
    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
    {
        ReleaseResolution(utilP, basicP, &r->item);
        VerdictSet(v, "failed", "AEGP_GetItemID err=%ld", (long)e);
        return 0;
    }
    r->wantItemId = (long)(unsigned int)boundItemId;

    /* 2. RQ-item + comp suites inside the window */
    r->rqItemSuite = IntakeAcquireSuite(utilP, basicP,
                                        kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    r->compSuite = IntakeAcquireSuite(utilP, basicP,
                                      kAEGPCompSuite, kAEGPCompSuiteVersion13);
    if (!r->rqItemSuite || !r->compSuite)
    {
        ReleaseRQResolution(utilP, basicP, r);
        VerdictSet(v, "not-sent", "RQ-item/comp suite unavailable for identity resolve");
        return 0;
    }
    r->rqItemP = (const AEGP_RQItemSuite4*)r->rqItemSuite;
    r->compP = (const AEGP_CompSuite13*)r->compSuite;

#define RQRES_NOT_SENT(msg) do { \
        ReleaseRQResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "not-sent"); \
        snprintf(v->detail, sizeof(v->detail), "%s", msg); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RQRES_FAILED(fmt, err) do { \
        ReleaseRQResolution(utilP, basicP, r); \
        snprintf(v->outcome, sizeof(v->outcome), "failed"); \
        snprintf(v->detail, sizeof(v->detail), fmt, (long)(err)); \
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1; \
        return 0; } while (0)
#define RQRES_STALE(why) do { \
        ReleaseRQResolution(utilP, basicP, r); \
        VerdictRefuse(v, "STALE_REFERENCE", why); \
        return 0; } while (0)

    if (!r->rqItemP->AEGP_GetNumRQItems || !r->rqItemP->AEGP_GetRQItemByIndex ||
        !r->rqItemP->AEGP_GetCompFromRQItem ||
        !r->rqItemP->AEGP_GetRenderState ||
        !r->rqItemP->AEGP_GetNumOutputModulesForRQItem ||
        !r->compP->AEGP_GetItemFromComp ||
        !r->item.itemP->AEGP_GetItemID)
        RQRES_NOT_SENT("RQ-item suite entries unavailable for identity resolve");

    e = r->rqItemP->AEGP_GetNumRQItems(&numRQ);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetNumRQItems err=%ld", e);
    if (rqIndex < 0 || rqIndex >= (long)numRQ)
        RQRES_STALE("rqItem index out of range");

    e = r->rqItemP->AEGP_GetRQItemByIndex(rqIndex, &rqH);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE || !rqH)
        RQRES_FAILED("AEGP_GetRQItemByIndex err=%ld", e);
    r->rqH = rqH;

    /* 3. bound comp identity: rqH → compH → itemH → live itemId */
    e = r->rqItemP->AEGP_GetCompFromRQItem(rqH, &boundCompH);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE || !boundCompH)
        RQRES_STALE("rqItem has no bound comp");
    e = r->compP->AEGP_GetItemFromComp(boundCompH, &boundItemH);
    IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetItemFromComp",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE || !boundItemH)
        RQRES_FAILED("AEGP_GetItemFromComp err=%ld", e);
    e = r->item.itemP->AEGP_GetItemID(boundItemH, &boundItemId);
    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetItemID err=%ld", e);
    if ((long)(unsigned int)boundItemId != r->wantItemId)
        RQRES_STALE("rqItem comp binding mismatch");

    /* 4. fingerprint: status + numOutputModules */
    e = r->rqItemP->AEGP_GetRenderState(rqH, &liveStatus);
    IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRenderState",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetRenderState err=%ld", e);
    if ((long)liveStatus != r->wantStatus)
        RQRES_STALE("rqItem status changed");
    e = r->rqItemP->AEGP_GetNumOutputModulesForRQItem(rqH, &liveNumOM);
    IntakeOpRecord(utilP,
                   "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
                   (long)e, e == A_Err_NONE ? " (resolve)" : NULL);
    if (e != A_Err_NONE)
        RQRES_FAILED("AEGP_GetNumOutputModulesForRQItem err=%ld", e);
    if ((long)liveNumOM != r->wantNumOM)
        RQRES_STALE("rqItem output-module count changed");

#undef RQRES_NOT_SENT
#undef RQRES_FAILED
#undef RQRES_STALE
    return 1;
}

/* RQ-item read-only getters (§7f): {projectIndex, rqItem} → atomic
   resolve → typed getter → typed JSON. */
static void ExecRQItemGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    JVal* rqArg = JGet(args, "rqItem");
    JVal* ref = rqArg ? JGet(rqArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    RQResolution r;
    const char* opId = allow->operationId;
    A_Err oerr = A_Err_STRUCT;

    if (!ResolveRQItemRef(utilP, projP, basicP, plugin_id,
                          projIndex, ref, &r, v))
        return;

    if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetRenderState") == 0)
    {
        AEGP_RenderItemStatusType st = 0;
        oerr = r.rqItemP->AEGP_GetRenderState(r.rqH, &st);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"status\":%ld}",
                     (long)st);
        }
    }
    else if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetStartedTime") == 0 ||
             strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetElapsedTime") == 0)
    {
        int isStarted = strcmp(opId,
            "AEGP_RQItemSuite4.AEGP_GetStartedTime") == 0;
        A_Time t = {0, 0};
        oerr = isStarted ? r.rqItemP->AEGP_GetStartedTime(r.rqH, &t)
                         : r.rqItemP->AEGP_GetElapsedTime(r.rqH, &t);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            /* {0,1} sentinel = never started/rendered → null */
            if (t.value == 0 && t.scale == 1)
                PayloadSet(v, "{\"%s\":null}", isStarted ? "startedTime" : "elapsedTime");
            else
                PayloadSet(v, "{\"%s\":{\"value\":%ld,\"scale\":%lu}}",
                         isStarted ? "startedTime" : "elapsedTime",
                         (long)t.value, (unsigned long)t.scale);
        }
    }
    else if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetLogType") == 0)
    {
        AEGP_LogType lt = 0;
        oerr = r.rqItemP->AEGP_GetLogType(r.rqH, &lt);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"logType\":%ld}",
                     (long)lt);
        }
    }
    else if (strcmp(opId, "AEGP_RQItemSuite4.AEGP_GetComment") == 0)
    {
        AEGP_MemHandle mh = NULL;
        char cm[1100];
        IntakeMemStatus ms;
        oerr = r.rqItemP->AEGP_GetComment(r.rqH, &mh);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            ms = IntakeReadMemHandleUtf8(utilP, r.item.memP, mh, cm, sizeof(cm));
            if (ms == IMH_OK || ms == IMH_TRUNCATED)
            {
                char esc[6600];
                JsonEscape(esc, sizeof(esc), cm);
                PayloadSet(v, "{\"comment\":\"%s\"}", esc);
            }
            else oerr = A_Err_STRUCT;
        }
    }
    else if (strcmp(opId,
                    "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem") == 0)
    {
        A_long nom = 0;
        oerr = r.rqItemP->AEGP_GetNumOutputModulesForRQItem(r.rqH, &nom);
        RecordAllowOp(utilP, allow, oerr);
        if (oerr == A_Err_NONE)
        {
            PayloadSet(v, "{\"numOutputModules\":%ld}", (long)nom);
        }
    }
    else /* AEGP_GetCompFromRQItem — emit comp descriptor, never handle */
    {
        AEGP_CompH boundCompH = NULL;
        AEGP_ItemH boundItemH = NULL;
        A_long boundItemId = 0;
        oerr = r.rqItemP->AEGP_GetCompFromRQItem(r.rqH, &boundCompH);
        IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem",
                       (long)oerr, oerr == A_Err_NONE ? " (result)" : NULL);
        if (oerr == A_Err_NONE && boundCompH)
        {
            A_Err e2 = r.compP->AEGP_GetItemFromComp(boundCompH, &boundItemH);
            IntakeOpRecord(utilP, "AEGP_CompSuite13.AEGP_GetItemFromComp",
                           (long)e2, e2 == A_Err_NONE ? " (result)" : NULL);
            if (e2 == A_Err_NONE && boundItemH)
            {
                A_Err e3 = r.item.itemP->AEGP_GetItemID(boundItemH, &boundItemId);
                IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                               (long)e3, e3 == A_Err_NONE ? " (result)" : NULL);
                if (e3 == A_Err_NONE)
                {
                    /* reuse the resolved comp's own descriptor — it IS
                       the bound comp (identity already proven equal) */
                    JBuf b;
                    JBInit(&b, v->payload, sizeof(v->payload));
                    JBPut(&b, "{\"comp\":{\"aeRef\":{\"type\":\"");
                    JBPut(&b, ItemTypeToAeRefTag(r.item.type));
                    JBPut(&b, "\",\"name\":\""); JBEsc(&b, r.item.name);
                    JBPut(&b, "\",\"path\":[0],\"itemId\":");
                    JBNum(&b, (long)(unsigned int)boundItemId);
                    JBPut(&b, ",\"projectName\":\"");
                    JBEsc(&b, r.item.projectName);
                    JBPut(&b, "\",\"projectPath\":\"");
                    JBEsc(&b, r.item.projectPath);
                    JBPut(&b, "\"}},\"projectIndex\":");
                    JBNum(&b, projIndex);
                    JBPut(&b, "}");
                    if (!b.of)
                    {
                        *b.cur = '\0';
                        v->havePayload = 1;
                    }
                    else oerr = A_Err_STRUCT;
                }
                else oerr = e3;
            }
            else oerr = e2;
        }
    }

    ReleaseRQResolution(utilP, basicP, &r);
    if (v->havePayload)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        v->mayHaveMutated = 0;
    }
    else
    {
        VerdictSet(v, "failed", "%s err=%ld", opId, (long)oerr);
    }
}

/* Locate the open project that owns a top-level item by live itemId.
   Returns 1 with *projIndexOut set, or 0. Bounded scan; used by RQ
   enumeration to recover the projectIndex a descriptor needs. */
static int FindProjectForItemId(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    unsigned int wantId,
    long* projIndexOut)
{
    const void* itemSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPItemSuite, kAEGPItemSuiteVersion9);
    const AEGP_ItemSuite9* itemP = itemSuite
        ? (const AEGP_ItemSuite9*)itemSuite : NULL;
    A_long numProjects = 0;
    A_Err perr;
    long pi;
    int found = 0;
    *projIndexOut = -1;
    if (!itemP || !itemP->AEGP_GetFirstProjItem ||
        !itemP->AEGP_GetNextProjItem || !itemP->AEGP_GetItemID ||
        !projP->AEGP_GetNumProjects || !projP->AEGP_GetProjectByIndex)
    {
        if (itemSuite) IntakeReleaseSuite(utilP, basicP,
            kAEGPItemSuite, kAEGPItemSuiteVersion9);
        return 0;
    }
    perr = projP->AEGP_GetNumProjects(&numProjects);
    IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetNumProjects",
                   (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
    if (perr != A_Err_NONE) { found = -1; goto done; }
    for (pi = 0; pi < (long)numProjects && !found; pi++)
    {
        AEGP_ProjectH ph = NULL;
        AEGP_ItemH ih = NULL;
        perr = projP->AEGP_GetProjectByIndex(pi, &ph);
        IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                       (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE || !ph) continue;
        perr = itemP->AEGP_GetFirstProjItem(ph, &ih);
        IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetFirstProjItem",
                       (long)perr, perr == A_Err_NONE ? " (resolve)" : NULL);
        if (perr != A_Err_NONE) continue;
        while (ih)
        {
            A_long id = 0;
            AEGP_ItemH nextH = NULL;
            A_Err e2 = itemP->AEGP_GetItemID(ih, &id);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemID",
                           (long)e2, e2 == A_Err_NONE ? " (resolve)" : NULL);
            if (e2 == A_Err_NONE && (unsigned int)id == wantId)
            { found = 1; *projIndexOut = pi; break; }
            e2 = itemP->AEGP_GetNextProjItem(ph, ih, &nextH);
            IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetNextProjItem",
                           (long)e2, e2 == A_Err_NONE ? " (resolve)" : NULL);
            if (e2 != A_Err_NONE) break;
            ih = nextH;
        }
    }
done:
    IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    return found == 1;
}

/* AEGP_GetRQItemByIndex as RQ descriptor issuance/enumeration (§7f):
   {offset, limit} → per-slot aeRefRQItem descriptors + the projectIndex
   each bound comp lives in. Slots whose comp cannot be resolved are
   emitted with "rqItem":null — never a fabricated descriptor. */
static void EnumerateRQItems(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    long offset = ArgsInt(allow, args, 0);
    long limit = ArgsInt(allow, args, 1);
    const void* rqSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    const void* compSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPCompSuite, kAEGPCompSuiteVersion13);
    const void* memSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    const AEGP_RQItemSuite4* rqP = rqSuite
        ? (const AEGP_RQItemSuite4*)rqSuite : NULL;
    const AEGP_CompSuite13* compP = compSuite
        ? (const AEGP_CompSuite13*)compSuite : NULL;
    const AEGP_MemorySuite1* memP = memSuite
        ? (const AEGP_MemorySuite1*)memSuite : NULL;
    const void* itemSuite = IntakeAcquireSuite(utilP, basicP,
        kAEGPItemSuite, kAEGPItemSuiteVersion9);
    const AEGP_ItemSuite9* itemP = itemSuite
        ? (const AEGP_ItemSuite9*)itemSuite : NULL;
    A_long numRQ = 0;
    A_Err e;
    long i;
    JBuf b;
    int of = 0;

    if (!rqP || !compP || !memP || !itemP ||
        !rqP->AEGP_GetNumRQItems || !rqP->AEGP_GetRQItemByIndex ||
        !rqP->AEGP_GetCompFromRQItem || !rqP->AEGP_GetRenderState ||
        !rqP->AEGP_GetNumOutputModulesForRQItem ||
        !compP->AEGP_GetItemFromComp ||
        !itemP->AEGP_GetItemID || !itemP->AEGP_GetItemType ||
        !itemP->AEGP_GetItemName || !itemP->AEGP_GetFirstProjItem ||
        !itemP->AEGP_GetNextProjItem)
    {
        if (rqSuite) IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
        if (compSuite) IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
        if (memSuite) IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        if (itemSuite) IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
        VerdictSet(v, "not-sent", "RQ-item suite entries unavailable for enumeration");
        return;
    }

    e = rqP->AEGP_GetNumRQItems(&numRQ);
    RecordAllowOp(utilP, allow, e);
    if (e != A_Err_NONE)
    {
        IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
        IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
        IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
        IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
        VerdictSet(v, "failed", "AEGP_GetNumRQItems err=%ld", (long)e);
        return;
    }

    JBInit(&b, v->payload, sizeof(v->payload));
    JBPut(&b, "{\"items\":[");
    {
        long emitted = 0;
        for (i = offset; i < offset + limit && i < (long)numRQ; i++)
        {
            AEGP_RQItemRefH rqH = NULL;
            AEGP_CompH compH = NULL;
            AEGP_ItemH itemH = NULL;
            A_long itemId = 0;
            AEGP_ItemType itype = AEGP_ItemType_NONE;
            AEGP_RenderItemStatusType st = 0;
            A_long nom = 0;
            int describable = 0;
            long projIndex = -1;
            char nm[AEREF_NAME_MAX + 1];
            char pn[AEGP_MAX_PROJ_NAME_SIZE + 1];
            char pp[PROJ_STR_MAX + 1];
            AEGP_MemHandle nameH = NULL;

            e = rqP->AEGP_GetRQItemByIndex(i, &rqH);
            IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex",
                           (long)e, NULL);
            if (e != A_Err_NONE || !rqH) continue;
            if (emitted) JBPut(&b, ",");
            JBPut(&b, "{\"index\":"); JBNum(&b, i);
            /* fingerprint */
            e = rqP->AEGP_GetRenderState(rqH, &st);
            IntakeOpRecord(utilP, "AEGP_RQItemSuite4.AEGP_GetRenderState",
                           (long)e, NULL);
            e = rqP->AEGP_GetNumOutputModulesForRQItem(rqH, &nom);
            IntakeOpRecord(utilP,
                "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
                (long)e, NULL);
            /* bound comp → item → id */
            if (e == A_Err_NONE &&
                rqP->AEGP_GetCompFromRQItem(rqH, &compH) == A_Err_NONE &&
                compH &&
                compP->AEGP_GetItemFromComp(compH, &itemH) == A_Err_NONE &&
                itemH &&
                itemP->AEGP_GetItemID(itemH, &itemId) == A_Err_NONE &&
                itemP->AEGP_GetItemType(itemH, &itype) == A_Err_NONE &&
                ItemTypeToAeRefTag(itype) != NULL &&
                FindProjectForItemId(utilP, projP, basicP,
                                     (unsigned int)itemId, &projIndex))
            {
                /* project identity for the comp's aeRef */
                AEGP_ProjectH ph = NULL;
                A_Err pe = projP->AEGP_GetProjectByIndex(projIndex, &ph);
                IntakeOpRecord(utilP, "AEGP_ProjSuite6.AEGP_GetProjectByIndex",
                               (long)pe, NULL);
                if (pe == A_Err_NONE && ph)
                {
                    A_Err fe = A_Err_NONE;
                    int fpi = FetchProjectIdentity(utilP, projP, memP, ph,
                        1, 1, pn, sizeof(pn), pp, sizeof(pp), &fe);
                    e = itemP->AEGP_GetItemName(plugin_id, itemH, &nameH);
                    IntakeOpRecord(utilP, "AEGP_ItemSuite9.AEGP_GetItemName",
                                   (long)e, e == A_Err_NONE ? " (result)" : NULL);
                    if (fpi == FPI_OK && e == A_Err_NONE && nameH)
                    {
                        IntakeMemStatus ms = IntakeReadMemHandleUtf8(
                            utilP, memP, nameH, nm, sizeof(nm));
                        if (ms == IMH_OK && strlen(nm) <= AEREF_NAME_MAX)
                            describable = 1;
                    }
                }
            }
            if (describable)
            {
                JBPut(&b, ",\"projectIndex\":"); JBNum(&b, projIndex);
                JBPut(&b, ",\"rqItem\":{\"aeRef\":{\"type\":\"rqItem\",");
                JBPut(&b, "\"index\":"); JBNum(&b, i);
                JBPut(&b, ",\"comp\":{\"aeRef\":{\"type\":\"");
                JBPut(&b, ItemTypeToAeRefTag(itype));
                JBPut(&b, "\",\"name\":\""); JBEsc(&b, nm);
                JBPut(&b, "\",\"path\":[0],\"itemId\":");
                JBNum(&b, (long)(unsigned int)itemId);
                JBPut(&b, ",\"projectName\":\""); JBEsc(&b, pn);
                JBPut(&b, "\",\"projectPath\":\""); JBEsc(&b, pp);
                JBPut(&b, "\"}},\"status\":"); JBNum(&b, (long)st);
                JBPut(&b, ",\"numOutputModules\":"); JBNum(&b, (long)nom);
                JBPut(&b, "}}}");
            }
            else
            {
                JBPut(&b, ",\"projectIndex\":null,\"rqItem\":null}");
            }
            emitted++;
        }
    }
    JBPut(&b, "],\"numRQItems\":"); JBNum(&b, (long)numRQ); JBPut(&b, "}");
    of = b.of;
    IntakeReleaseSuite(utilP, basicP, kAEGPRQItemSuite, kAEGPRQItemSuiteVersion4);
    IntakeReleaseSuite(utilP, basicP, kAEGPCompSuite, kAEGPCompSuiteVersion13);
    IntakeReleaseSuite(utilP, basicP, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    IntakeReleaseSuite(utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (of)
    {
        VerdictSet(v, "failed", "enumeration payload exceeds result bound");
        return;
    }
    *b.cur = '\0';
    snprintf(v->outcome, sizeof(v->outcome), "completed");
    v->havePayload = 1;
    v->mayHaveMutated = 0;
}

/* ---- Issue #328: scalar/zero-arg executors -------------------------
   ProcessClaimed's dispatch chain is pure routing; every op body lives
   in an executor below. Read-only executors keep mayHaveMutated=0;
   the mutation executor (ExecSetItemComment) sets it only once the
   AEGP call is attempted. */

static void ExecNumProjects(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    const AllowEntry* allow,
    ReqVerdict* v)
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
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"numProjects\":%ld}", (long)num);
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail), "AEGP_GetNumProjects err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0; /* read-only getter: provably non-mutating */
    }
}

static void ExecDriverImplVersion(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    ReqVerdict* v)
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
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"major\":%d,\"minor\":%d}", (int)maj, (int)min);
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetDriverImplementationVersion err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

/* AEGP_ItemSuite9.AEGP_GetTypeName — {"itemType": int}. The suite is
   acquired and released inside this request's evidence window; a
   missing suite/entry is environment-proven non-dispatch (not-sent),
   an AEGP error is failed with mayHaveMutated=false (read-only). */
static void ExecGetTypeName(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    AEGP_ItemType itype = (AEGP_ItemType)ArgsInt(allow, args, 0);
    const void* suite = IntakeAcquireSuite(
        utilP, basicP, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (!suite)
    {
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP Item Suite unavailable for GetTypeName");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
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
            snprintf(v->outcome, sizeof(v->outcome), "not-sent");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetTypeName entry unavailable");
            v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
            return;
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
            snprintf(v->outcome, sizeof(v->outcome), "completed");
            PayloadSet(v, "{\"typeName\":\"%s\"}", esc);
            v->mayHaveMutated = 0;
        }
        else
        {
            snprintf(v->outcome, sizeof(v->outcome), "failed");
            snprintf(v->detail, sizeof(v->detail),
                     "AEGP_GetTypeName err=%ld", (long)oerr);
            v->havePayload = 0;
            v->mayHaveMutated = 0; /* read-only getter */
        }
    }
}

/* AEGP_ItemSuite9.AEGP_GetItemName / AEGP_GetItemID — shared aeRef
   resolve (contract §7b). GetItemName resolves only what the
   descriptor asserts; GetItemID additionally fetches project identity
   for the issued descriptor payload (wantProjectIdentity=1). */
static void ExecItemNameOrId(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v)
{
    int isNameOp = strcmp(allow->operationId,
                          "AEGP_ItemSuite9.AEGP_GetItemName") == 0;
    JVal* itemArg = JGet(args, "item");
    JVal* ref = itemArg ? JGet(itemArg, "aeRef") : NULL;
    long projIndex = ArgsInt(allow, args, 0);
    ItemResolution res;

    if (!ResolveAeRefItem(utilP, projP, basicP, plugin_id,
                          projIndex, ref, isNameOp ? 0 : 1,
                          isNameOp ? " (resolve+result)" : " (resolve)",
                          &res, v))
        return;             /* v already carries the verdict */

    if (isNameOp)
    {
        char esc[AEREF_NAME_MAX * 6 + 8];
        JsonEscape(esc, sizeof(esc), res.name);
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"name\":\"%s\"}", esc);
        v->mayHaveMutated = 0;
    }
    else
    {
        /* GetItemID = descriptor issuance: read the live id of the
           resolved item, then emit the canonical identity-bearing
           aeRef (project identity included). Emit BEFORE
           ReleaseResolution — release zeroes res. */
        A_long liveId = 0;
        A_Err iderr = res.itemP->AEGP_GetItemID
            ? res.itemP->AEGP_GetItemID(res.itemH, &liveId)
            : A_Err_STRUCT;
        IntakeOpRecord(utilP,
            "AEGP_ItemSuite9.AEGP_GetItemID", (long)iderr,
            iderr == A_Err_NONE ? " (result)" : NULL);
        {
            int emitOk = iderr == A_Err_NONE &&
                EmitIssuedDescriptor(v, &res,
                    (long)(unsigned int)liveId);
            ReleaseResolution(utilP, basicP, &res);
            if (iderr != A_Err_NONE)
            {
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "AEGP_GetItemID err=%ld", (long)iderr);
                v->havePayload = 0; v->mayHaveMutated = 0;
            }
            else if (!emitOk)
            {
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "descriptor payload exceeds result bound");
                v->havePayload = 0; v->mayHaveMutated = 0;
            }
            else
            {
                snprintf(v->outcome, sizeof(v->outcome), "completed");
                v->havePayload = 1;
                v->mayHaveMutated = 0;
            }
        }
    }
    if (isNameOp) ReleaseResolution(utilP, basicP, &res);
}

static void ExecDriverPluginInitVersion(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    ReqVerdict* v)
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
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"major\":%d,\"minor\":%d}", (int)maj, (int)min);
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetDriverPluginInitFuncVersion err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

static void ExecSuppressUI(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    ReqVerdict* v)
{
    A_Boolean suppressed = FALSE;
    A_Err oerr = utilP->AEGP_GetSuppressInteractiveUI
        ? utilP->AEGP_GetSuppressInteractiveUI(&suppressed)
        : A_Err_STRUCT;
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? (suppressed ? " value=1" : " value=0") : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"interactiveUiSuppressed\":%s}", suppressed ? "true" : "false");
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_GetSuppressInteractiveUI err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

static void ExecHostActivated(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    ReqVerdict* v)
{
    A_Boolean activated = FALSE;
    A_Err oerr = utilP->AEGP_HostIsActivated
        ? utilP->AEGP_HostIsActivated(&activated)
        : A_Err_STRUCT;
    IntakeOpRecord(utilP, allow->opRecordId, (long)oerr,
                   oerr == A_Err_NONE ? (activated ? " value=1" : " value=0") : NULL);
    if (oerr == A_Err_NONE)
    {
        snprintf(v->outcome, sizeof(v->outcome), "completed");
        PayloadSet(v, "{\"hostActivated\":%s}", activated ? "true" : "false");
        v->mayHaveMutated = 0;
    }
    else
    {
        snprintf(v->outcome, sizeof(v->outcome), "failed");
        snprintf(v->detail, sizeof(v->detail),
                 "AEGP_HostIsActivated err=%ld", (long)oerr);
        v->havePayload = 0;
        v->mayHaveMutated = 0;
    }
}

/* Zero-arg render-queue getters: AEGP_RenderQueueSuite1.
   AEGP_GetRenderQueueState and AEGP_RQItemSuite4.AEGP_GetNumRQItems
   share the acquire-suite-inside-request pattern. */
static void ExecRQZeroArg(
    const AEGP_UtilitySuite6* utilP,
    struct SPBasicSuite* basicP,
    const AllowEntry* allow,
    ReqVerdict* v)
{
    int isRQState = strcmp(allow->operationId,
                           "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState") == 0;
    const char* suiteName = isRQState ? kAEGPRenderQueueSuite : kAEGPRQItemSuite;
    int suiteVer = isRQState ? kAEGPRenderQueueSuiteVersion1
                             : kAEGPRQItemSuiteVersion4;
    const void* suite = IntakeAcquireSuite(utilP, basicP, suiteName, suiteVer);
    if (!suite)
    {
        snprintf(v->outcome, sizeof(v->outcome), "not-sent");
        snprintf(v->detail, sizeof(v->detail), "render queue suite unavailable");
        v->havePayload = 0; v->mayHaveMutated = 0; v->publish = 1;
        return;
    }
    {
        A_Err oerr = A_Err_STRUCT;
        char extra[48];
        extra[0] = '\0';
        if (isRQState)
        {
            const AEGP_RenderQueueSuite1* rqQueueP = (const AEGP_RenderQueueSuite1*)suite;
            AEGP_RenderQueueState state = 0;
            if (rqQueueP->AEGP_GetRenderQueueState)
                oerr = rqQueueP->AEGP_GetRenderQueueState(&state);
            else
                oerr = A_Err_STRUCT;
            if (oerr == A_Err_NONE)
            {
                snprintf(extra, sizeof(extra), " value=%lu",
                         (unsigned long)state);
                IntakeOpRecord(utilP, allow->opRecordId, (long)oerr, extra);
                snprintf(v->outcome, sizeof(v->outcome), "completed");
                PayloadSet(v, "{\"state\":%lu}", (unsigned long)state);
                v->mayHaveMutated = 0;
            }
            else
            {
                RecordAllowOp(utilP, allow, oerr);
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "AEGP_GetRenderQueueState err=%ld", (long)oerr);
                v->havePayload = 0;
                v->mayHaveMutated = 0;
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
                snprintf(v->outcome, sizeof(v->outcome), "completed");
                PayloadSet(v, "{\"numRQItems\":%ld}", (long)num);
                v->mayHaveMutated = 0;
            }
            else
            {
                RecordAllowOp(utilP, allow, oerr);
                snprintf(v->outcome, sizeof(v->outcome), "failed");
                snprintf(v->detail, sizeof(v->detail),
                         "AEGP_GetNumRQItems err=%ld", (long)oerr);
                v->havePayload = 0;
                v->mayHaveMutated = 0;
            }
        }
        IntakeReleaseSuite(utilP, basicP, suiteName, suiteVer);
    }
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

        /* ---- execute the allowlisted op ---- */
        if (strcmp(allow->operationId,
                   "AEGP_ProjSuite6.AEGP_GetNumProjects") == 0)
        {
            ExecNumProjects(utilP, projP, allow, &v);
        }
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion") == 0)
        {
            ExecDriverImplVersion(utilP, allow, &v);
        }
        else if (strcmp(allow->operationId,
                        "AEGP_ItemSuite9.AEGP_GetTypeName") == 0)
        {
            ExecGetTypeName(utilP, basicP, allow, args, &v);
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
            ExecItemNameOrId(utilP, projP, basicP, plugin_id,
                             allow, args, &v);
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
        /* ---- Issue #327: first mutating op ------------------------
           requiresConsent=1 — the §7g MAC was verified above, before
           any AEGP call. The executor owns mayHaveMutated=1 once the
           mutation entry is invoked. */
        else if (strcmp(allow->operationId,
                        "AEGP_ItemSuite9.AEGP_SetItemComment") == 0)
        {
            ExecSetItemComment(utilP, projP, basicP, plugin_id,
                               allow, args, &v);
        }
        /* ---- Issue #318 / #63: ItemSuite9 read-only detail getters --
           {projectIndex, item:<aeRefItem>} → shared resolver → typed
           getter on the resolved item handle. */
        else if (IsItemGetterOpId(allow->operationId))
        {
            ExecItemGetter(utilP, projP, basicP, plugin_id, allow, args, &v);
        }
        /* ---- Issue #318 / #64: AEGP_LayerSuite9 ---------------------
           Comp-scoped ops take {projectIndex, comp:<aeRefItem>}
           (+layerIndex for issuance); layer getters take
           {projectIndex, layer:<aeRefLayer>} — the descriptor embeds
           its parent comp's aeRef. Handles never cross the wire. */
        else if (IsLayerCompOpId(allow->operationId))
        {
            ExecLayerCompOp(utilP, projP, basicP, plugin_id, allow, args, &v);
        }
        else if (IsLayerGetterOpId(allow->operationId))
        {
            ExecLayerGetter(utilP, projP, basicP, plugin_id, allow, args, &v);
        }
        /* ---- Issue #318 §7e: project-scoped getters -----------------
           {project:<aeRefProject>} → index+name+path corroboration +
           collision scan → borrowed projectH → typed getter. */
        else if (strncmp(allow->operationId, "AEGP_ProjSuite6.", 16) == 0 &&
                 strcmp(allow->operationId,
                        "AEGP_ProjSuite6.AEGP_GetNumProjects") != 0)
        {
            ExecProjectGetter(utilP, projP, basicP, allow, args, &v);
        }
        /* ---- Issue #318 §7f: RQ-item identity ----------------------
           GetRQItemByIndex is enumeration/issuance ({offset,limit});
           the remaining RQItemSuite4 members resolve the aeRefRQItem
           descriptor atomically (index + bound-comp itemId +
           fingerprint) inside this dispatch. */
        else if (strcmp(allow->operationId,
                        "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex") == 0)
        {
            EnumerateRQItems(utilP, projP, basicP, plugin_id,
                             allow, args, &v);
        }
        else if (strncmp(allow->operationId, "AEGP_RQItemSuite4.", 18) == 0 &&
                 strcmp(allow->operationId,
                        "AEGP_RQItemSuite4.AEGP_GetNumRQItems") != 0)
        {
            ExecRQItemGetter(utilP, projP, basicP, plugin_id,
                             allow, args, &v);
        }
        /* ---- Issue #270 Stage 2: zero-arg read-only getters ---------- */
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion") == 0)
        {
            ExecDriverPluginInitVersion(utilP, allow, &v);
        }
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI") == 0)
        {
            ExecSuppressUI(utilP, allow, &v);
        }
        else if (strcmp(allow->operationId,
                        "AEGP_UtilitySuite6.AEGP_HostIsActivated") == 0)
        {
            ExecHostActivated(utilP, allow, &v);
        }
        else if (strcmp(allow->operationId,
                        "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState") == 0 ||
                 strcmp(allow->operationId,
                        "AEGP_RQItemSuite4.AEGP_GetNumRQItems") == 0)
        {
            ExecRQZeroArg(utilP, basicP, allow, &v);
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
    char token[65], consentKey[65], pin[48];
    DIR* d;
    struct dirent* de;
    char names[64][320];
    int count = 0;
    int i, j;

    if (!s_channel_root[0]) return;
    s_ticks++;

    if (!ChannelReady(utilP, inboxDir, sizeof(inboxDir), outboxDir, sizeof(outboxDir),
                      statePath, sizeof(statePath), token, consentKey,
                      pin, sizeof(pin)))
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
