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
#include "native_state.h"
#include "native_support.h"
#include "native_registry.h"

#define LOG_SUBSYSTEM "ae-a8n"
#define LOG_EVENT "nativeprobe"

/* ---- channel state -------------------------------------------------
   The ONLY translation unit that owns intake mutable state. All former
   file-scope globals live here behind the narrow API in
   native_state.h; other modules never see them. */

#define CHAN_JSON_MAX 16384        /* channel.json bytes */
#define SEEN_IDS 64
#define SEEN_ID_LEN (REQ_ID_MAX + 1)
#define OUTBOX_MAX_AGE_MS (60L * 60L * 1000L)
#define STATE_EVERY_TICKS 8

static char s_channel_root[PATH_MAX_LOCAL]; /* "" = disabled */
static char s_instance[80];
static long s_ticks = 0;
static long s_last_state_tick = -1;
static char s_observed_version[48];          /* "M.m" once attested */
static char s_seen[SEEN_IDS][SEEN_ID_LEN];
static int s_seen_count = 0;
static int s_priv_logged = 0;
static int s_misc_logged = 0;

void IntakeLog(const AEGP_UtilitySuite6* utilP, const char* msgZ)
{
    if (utilP && utilP->AEGP_WriteToDebugLog)
        utilP->AEGP_WriteToDebugLog(LOG_SUBSYSTEM, LOG_EVENT, msgZ);
}

void IntakeLogf(const AEGP_UtilitySuite6* utilP, const char* fmtZ, ...)
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

void IntakeOpRecord(
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


int SeenBefore(const char* idZ)
{
    int i;
    for (i = 0; i < s_seen_count; i++)
        if (strcmp(s_seen[i], idZ) == 0) return 1;
    return 0;
}

void SeenAdd(const char* idZ)
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

int ChannelReady(
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


/* heartbeat state publication (state.json) — channel-state
   output, not routing. */
/* ---- heartbeat -------------------------------------------------------- */

void IntakeWriteHeartbeat(
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

/* ---- state API ---------------------------------------------------- */

void IntakeOpCallsReset(void)
{
    s_opcalls_count = 0;
}

void IntakeCollectingSet(int on)
{
    s_collecting = on;
}

int IntakeOpCallsJson(char* out, size_t cap)
{
    size_t oc = 0;
    int i;
    if (s_opcalls_count == 0) return 0;
    oc += (size_t)snprintf(out + oc, cap - oc, "[");
    for (i = 0; i < s_opcalls_count && oc < cap - 96; i++)
        oc += (size_t)snprintf(out + oc, cap - oc,
                               "%s\"%s\"", i ? "," : "", s_opcalls[i]);
    oc += (size_t)snprintf(out + oc, cap - oc, "]");
    out[cap - 1] = '\0';
    return 1;
}

const char* IntakeInstanceId(void)
{
    return s_instance;
}

const char* IntakeObservedVersion(void)
{
    return s_observed_version;
}

void IntakeNoteObservedVersion(int maj, int min)
{
    snprintf(s_observed_version, sizeof(s_observed_version), "%d.%d", maj, min);
}

void IntakeConfigureChannel(const char* channelRootZ)
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
}

int IntakeEnabled(void)
{
    return s_channel_root[0] != 0;
}

void IntakeAdvanceTick(void)
{
    s_ticks++;
}

int IntakeHeartbeatDue(void)
{
    return s_ticks == 1 || s_ticks - s_last_state_tick >= STATE_EVERY_TICKS;
}

#else /* _WIN32 */
#endif
