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

#if !defined(_WIN32)

#include <ctype.h>
#include <dirent.h>
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
#define IN_MAX_DEPTH 32
#define IN_MAX_NODES 8192
#define CHAN_JSON_MAX 16384        /* channel.json bytes */
#define REQ_ID_MAX 128
#define SEEN_IDS 64
#define SEEN_ID_LEN (REQ_ID_MAX + 1)
#define PATH_MAX_LOCAL 4096
#define RESULT_MAX 16384
#define OUTBOX_MAX_AGE_MS (60L * 60L * 1000L)
#define STATE_EVERY_TICKS 8
#define PUBLISH_ATTEMPTS 3
#define PUBLISH_RETRY_US 50000     /* 50 ms */

/* ---- tiny JSON DOM ------------------------------------------------
   One document at a time; every allocation is freed before return.
   Bounds mirror the contract: depth/nodes/input caps, duplicate keys
   rejected, trailing garbage rejected, non-finite numbers rejected. */

typedef enum
{
    JK_NULL = 0,
    JK_FALSE,
    JK_TRUE,
    JK_NUM,
    JK_STR,
    JK_ARR,
    JK_OBJ
} JKind;

typedef struct JVal JVal;
typedef struct
{
    char* key;
    size_t klen;
    JVal* val;
} JPair;

struct JVal
{
    JKind kind;
    double num;
    char* str;   /* JK_STR: malloc'd, slen bytes (not NUL-required) */
    size_t slen;
    JVal** items; /* JK_ARR */
    size_t nitems;
    JPair* pairs; /* JK_OBJ */
    size_t npairs;
};

typedef struct
{
    const char* cur;
    const char* end;
    int nodes;
    int failed;
} JParser;

static void JFree(JVal* v)
{
    size_t i;
    if (!v) return;
    if (v->kind == JK_ARR)
    {
        for (i = 0; i < v->nitems; i++) JFree(v->items[i]);
        free(v->items);
    }
    else if (v->kind == JK_OBJ)
    {
        for (i = 0; i < v->npairs; i++)
        {
            JFree(v->pairs[i].val);
            free(v->pairs[i].key);
        }
        free(v->pairs);
    }
    free(v->str);
    free(v);
}

static JVal* JNew(JParser* p, JKind kind)
{
    JVal* v;
    if (p->failed || p->nodes >= IN_MAX_NODES) { p->failed = 1; return NULL; }
    p->nodes++;
    v = (JVal*)calloc(1, sizeof(JVal));
    if (!v) { p->failed = 1; return NULL; }
    v->kind = kind;
    return v;
}

static void JSkipWs(JParser* p)
{
    while (p->cur < p->end &&
           (*p->cur == ' ' || *p->cur == '\t' || *p->cur == '\n' || *p->cur == '\r'))
        p->cur++;
}

static int JHex4(JParser* p, unsigned int* cp)
{
    unsigned int v = 0;
    int i;
    if (p->end - p->cur < 4) return 0;
    for (i = 0; i < 4; i++)
    {
        char c = p->cur[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    p->cur += 4;
    *cp = v;
    return 1;
}

/* Parse a JSON string body (opening quote already consumed). Returns
   malloc'd bytes or NULL on malformed input / arena overflow. */
static char* JParseString(JParser* p, size_t* outLen)
{
    size_t cap = 256, len = 0;
    char* buf = (char*)malloc(cap);
    char* w;
    if (!buf) { p->failed = 1; return NULL; }
    w = buf;
    for (;;)
    {
        char c;
        if (p->cur >= p->end) { free(buf); p->failed = 1; return NULL; }
        c = *p->cur++;
        if (c == '"') break;
        if ((unsigned char)c < 0x20) { free(buf); p->failed = 1; return NULL; }
        if (c == '\\')
        {
            char e;
            if (p->cur >= p->end) { free(buf); p->failed = 1; return NULL; }
            e = *p->cur++;
            switch (e)
            {
                case '"': case '\\': case '/':
                    if (len + 2 > cap) goto grow;
                    *w++ = e; len++; break;
                case 'b': if (len + 2 > cap) goto grow; *w++ = '\b'; len++; break;
                case 'f': if (len + 2 > cap) goto grow; *w++ = '\f'; len++; break;
                case 'n': if (len + 2 > cap) goto grow; *w++ = '\n'; len++; break;
                case 'r': if (len + 2 > cap) goto grow; *w++ = '\r'; len++; break;
                case 't': if (len + 2 > cap) goto grow; *w++ = '\t'; len++; break;
                case 'u':
                {
                    unsigned int cp;
                    if (!JHex4(p, &cp)) { free(buf); p->failed = 1; return NULL; }
                    if (cp >= 0xD800 && cp <= 0xDBFF)
                    {
                        unsigned int lo;
                        if (p->end - p->cur >= 6 && p->cur[0] == '\\' && p->cur[1] == 'u')
                        {
                            p->cur += 2;
                            if (JHex4(p, &lo) && lo >= 0xDC00 && lo <= 0xDFFF)
                            {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            }
                            else
                            {
                                cp = 0xFFFD; /* lone high surrogate */
                            }
                        }
                        else cp = 0xFFFD;
                    }
                    else if (cp >= 0xDC00 && cp <= 0xDFFF) cp = 0xFFFD;
                    if (len + 5 > cap) goto grow;
                    {
                        /* inline UTF-8 emit (bounded) */
                        size_t need = (cp < 0x80) ? 1 : (cp < 0x800) ? 2 : (cp < 0x10000) ? 3 : 4;
                        if (len + need > cap)
                        {
                            char* nb = (char*)realloc(buf, cap * 2);
                            if (!nb) { free(buf); p->failed = 1; return NULL; }
                            buf = nb; cap *= 2; w = buf + len;
                            if (len + need > cap) { free(buf); p->failed = 1; return NULL; }
                        }
                        if (cp < 0x80) { *w++ = (char)cp; }
                        else if (cp < 0x800)
                        {
                            *w++ = (char)(0xC0 | (cp >> 6));
                            *w++ = (char)(0x80 | (cp & 0x3F));
                        }
                        else if (cp < 0x10000)
                        {
                            *w++ = (char)(0xE0 | (cp >> 12));
                            *w++ = (char)(0x80 | ((cp >> 6) & 0x3F));
                            *w++ = (char)(0x80 | (cp & 0x3F));
                        }
                        else
                        {
                            *w++ = (char)(0xF0 | (cp >> 18));
                            *w++ = (char)(0x80 | ((cp >> 12) & 0x3F));
                            *w++ = (char)(0x80 | ((cp >> 6) & 0x3F));
                            *w++ = (char)(0x80 | (cp & 0x3F));
                        }
                        len += need;
                    }
                    break;
                }
                default:
                    free(buf); p->failed = 1; return NULL;
            }
        }
        else
        {
            if (len + 2 > cap) goto grow;
            *w++ = c; len++;
        }
        continue;
    grow:
        {
            char* nb = (char*)realloc(buf, cap * 2);
            if (!nb) { free(buf); p->failed = 1; return NULL; }
            w = nb + len;
            buf = nb; cap *= 2;
        }
    }
    *outLen = len;
    return buf;
}

static JVal* JParseValue(JParser* p, int depth);

static JVal* JParseArray(JParser* p, int depth)
{
    JVal* v = JNew(p, JK_ARR);
    size_t cap = 0;
    if (!v) return NULL;
    JSkipWs(p);
    if (p->cur < p->end && *p->cur == ']') { p->cur++; return v; }
    for (;;)
    {
        JVal* item;
        if (depth + 1 > IN_MAX_DEPTH) { p->failed = 1; JFree(v); return NULL; }
        JSkipWs(p);
        item = JParseValue(p, depth + 1);
        if (!item) { JFree(v); return NULL; }
        if (v->nitems >= 1024) { JFree(item); JFree(v); p->failed = 1; return NULL; }
        if (v->nitems == cap)
        {
            size_t ncap = cap ? cap * 2 : 8;
            JVal** ni = (JVal**)realloc(v->items, ncap * sizeof(JVal*));
            if (!ni) { JFree(item); JFree(v); p->failed = 1; return NULL; }
            v->items = ni; cap = ncap;
        }
        v->items[v->nitems++] = item;
        JSkipWs(p);
        if (p->cur >= p->end) { JFree(v); p->failed = 1; return NULL; }
        if (*p->cur == ',') { p->cur++; continue; }
        if (*p->cur == ']') { p->cur++; return v; }
        JFree(v); p->failed = 1; return NULL;
    }
}

static JVal* JParseObject(JParser* p, int depth)
{
    JVal* v = JNew(p, JK_OBJ);
    size_t cap = 0;
    if (!v) return NULL;
    JSkipWs(p);
    if (p->cur < p->end && *p->cur == '}') { p->cur++; return v; }
    for (;;)
    {
        char* key;
        size_t klen;
        JVal* val;
        size_t i;
        if (depth + 1 > IN_MAX_DEPTH) { p->failed = 1; JFree(v); return NULL; }
        JSkipWs(p);
        if (p->cur >= p->end || *p->cur != '"') { JFree(v); p->failed = 1; return NULL; }
        p->cur++;
        key = JParseString(p, &klen);
        if (!key) { JFree(v); return NULL; }
        /* duplicate keys rejected */
        for (i = 0; i < v->npairs; i++)
        {
            if (v->pairs[i].klen == klen && memcmp(v->pairs[i].key, key, klen) == 0)
            {
                free(key); JFree(v); p->failed = 1; return NULL;
            }
        }
        JSkipWs(p);
        if (p->cur >= p->end || *p->cur != ':') { free(key); JFree(v); p->failed = 1; return NULL; }
        p->cur++;
        val = JParseValue(p, depth + 1);
        if (!val) { free(key); JFree(v); return NULL; }
        if (v->npairs >= 64) { free(key); JFree(val); JFree(v); p->failed = 1; return NULL; }
        if (v->npairs == cap)
        {
            size_t ncap = cap ? cap * 2 : 8;
            JPair* np = (JPair*)realloc(v->pairs, ncap * sizeof(JPair));
            if (!np) { free(key); JFree(val); JFree(v); p->failed = 1; return NULL; }
            v->pairs = np; cap = ncap;
        }
        v->pairs[v->npairs].key = key;
        v->pairs[v->npairs].klen = klen;
        v->pairs[v->npairs].val = val;
        v->npairs++;
        JSkipWs(p);
        if (p->cur >= p->end) { JFree(v); p->failed = 1; return NULL; }
        if (*p->cur == ',') { p->cur++; continue; }
        if (*p->cur == '}') { p->cur++; return v; }
        JFree(v); p->failed = 1; return NULL;
    }
}

static JVal* JParseValue(JParser* p, int depth)
{
    JVal* v;
    JSkipWs(p);
    if (p->cur >= p->end || p->failed) { p->failed = 1; return NULL; }
    if (depth > IN_MAX_DEPTH) { p->failed = 1; return NULL; }
    switch (*p->cur)
    {
        case 'n':
            if (p->end - p->cur >= 4 && memcmp(p->cur, "null", 4) == 0)
            { p->cur += 4; return JNew(p, JK_NULL); }
            break;
        case 't':
            if (p->end - p->cur >= 4 && memcmp(p->cur, "true", 4) == 0)
            { p->cur += 4; return JNew(p, JK_TRUE); }
            break;
        case 'f':
            if (p->end - p->cur >= 5 && memcmp(p->cur, "false", 5) == 0)
            { p->cur += 5; return JNew(p, JK_FALSE); }
            break;
        case '"':
        {
            size_t slen;
            char* s;
            p->cur++;
            s = JParseString(p, &slen);
            if (!s) return NULL;
            v = JNew(p, JK_STR);
            if (!v) { free(s); return NULL; }
            v->str = s; v->slen = slen;
            return v;
        }
        case '[': p->cur++; return JParseArray(p, depth);
        case '{': p->cur++; return JParseObject(p, depth);
        default:
            if (*p->cur == '-' || (*p->cur >= '0' && *p->cur <= '9'))
            {
                char* e = NULL;
                double d;
                /* strict JSON number: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)? */
                const char* save = p->cur;
                if (*p->cur == '-') p->cur++;
                if (p->cur >= p->end) { p->failed = 1; return NULL; }
                if (*p->cur == '0') p->cur++;
                else if (*p->cur >= '1' && *p->cur <= '9') { while (p->cur < p->end && isdigit((unsigned char)*p->cur)) p->cur++; }
                else { p->cur = save; break; }
                if (p->cur < p->end && *p->cur == '.')
                {
                    p->cur++;
                    if (p->cur >= p->end || !isdigit((unsigned char)*p->cur)) { p->failed = 1; return NULL; }
                    while (p->cur < p->end && isdigit((unsigned char)*p->cur)) p->cur++;
                }
                if (p->cur < p->end && (*p->cur == 'e' || *p->cur == 'E'))
                {
                    p->cur++;
                    if (p->cur < p->end && (*p->cur == '+' || *p->cur == '-')) p->cur++;
                    if (p->cur >= p->end || !isdigit((unsigned char)*p->cur)) { p->failed = 1; return NULL; }
                    while (p->cur < p->end && isdigit((unsigned char)*p->cur)) p->cur++;
                }
                /* strtod over the consumed span */
                {
                    size_t n = (size_t)(p->cur - save);
                    char tmp[64];
                    if (n >= sizeof(tmp)) { p->failed = 1; return NULL; }
                    memcpy(tmp, save, n); tmp[n] = '\0';
                    d = strtod(tmp, &e);
                    if (e != tmp + n || !isfinite(d)) { p->failed = 1; return NULL; }
                }
                v = JNew(p, JK_NUM);
                if (!v) return NULL;
                v->num = d;
                return v;
            }
            break;
    }
    p->failed = 1;
    return NULL;
}

/* Parse a whole document; *outLen bytes at text. Returns DOM or NULL. */
static JVal* JParseDoc(const char* text, size_t len)
{
    JParser p;
    JVal* v;
    memset(&p, 0, sizeof(p));
    p.cur = text;
    p.end = text + len;
    v = JParseValue(&p, 0);
    if (!v || p.failed) { if (v) JFree(v); return NULL; }
    JSkipWs(&p);
    if (p.cur != p.end) { JFree(v); return NULL; }
    return v;
}

static JVal* JGet(JVal* obj, const char* key)
{
    size_t i, klen = strlen(key);
    if (!obj || obj->kind != JK_OBJ) return NULL;
    for (i = 0; i < obj->npairs; i++)
    {
        if (obj->pairs[i].klen == klen && memcmp(obj->pairs[i].key, key, klen) == 0)
            return obj->pairs[i].val;
    }
    return NULL;
}

static int JStrEq(JVal* v, const char* s)
{
    size_t n = strlen(s);
    return v && v->kind == JK_STR && v->slen == n && memcmp(v->str, s, n) == 0;
}

static int JNonEmptyStr(JVal* v)
{
    return v && v->kind == JK_STR && v->slen > 0;
}

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

/* Read a whole file, bounded. Returns length or -1. */
static long ReadFileBounded(const char* pathZ, char* buf, size_t cap)
{
    FILE* f = fopen(pathZ, "rb");
    long n;
    if (!f) return -1;
    n = (long)fread(buf, 1, cap, f);
    fclose(f);
    if (n < 0) return -1;
    if ((size_t)n >= cap) return -1; /* too large: refuse rather than truncate */
    buf[n] = '\0';
    return n;
}

static int WriteFileAtomic(const char* finalPathZ, const char* textZ, size_t len)
{
    char part[PATH_MAX_LOCAL];
    FILE* f;
    size_t base = strlen(finalPathZ);
    int attempt;
    if (base + 6 >= sizeof(part)) return -1;
    memcpy(part, finalPathZ, base);
    memcpy(part + base, ".part", 6);
    part[base + 5] = '\0';

    for (attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++)
    {
        f = fopen(part, "wb");
        if (f)
        {
            size_t w = fwrite(textZ, 1, len, f);
            fclose(f);
            if (w == len && rename(part, finalPathZ) == 0)
                return 0;
        }
        if (attempt + 1 < PUBLISH_ATTEMPTS) usleep(PUBLISH_RETRY_US);
    }
    /* Every atomic attempt failed: write in place rather than lose the
       result (same posture as the ae-a8n publishResult fallback), then
       drop the staging copy. */
    f = fopen(finalPathZ, "wb");
    if (f)
    {
        size_t w = fwrite(textZ, 1, len, f);
        fclose(f);
        if (w == len)
        {
            remove(part);
            return 0;
        }
    }
    remove(part);
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
    if (stat(pathZ, &st) != 0) return -1;
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
    APP("}}}");
    return 0;
#undef APP
}

/* ---- allowlist ------------------------------------------------------- */

typedef struct
{
    const char* operationId;
    const char* opRecordId; /* identical string; kept explicit */
} AllowEntry;

static const AllowEntry S_ALLOWLIST[] = {
    { "AEGP_ProjSuite6.AEGP_GetNumProjects",
      "AEGP_ProjSuite6.AEGP_GetNumProjects" },
    { "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
      "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion" },
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
        /* deadline: mtime + timeoutMs (ae-a8n dispatcher convention) */
        if (!tmo || tmo->kind != JK_NUM || !isfinite(tmo->num))
        {
            VerdictRefuse(&v, "MALFORMED_REQUEST", "request carries no usable deadline");
            goto verdict;
        }
        if (mtimeMs >= 0 && NowMs() > mtimeMs + (long long)tmo->num)
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
            (args && args->kind != JK_NULL) ||
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

        /* pre-claim target filter: leave requests for other instances */
        JoinPath(reqPath, sizeof(reqPath), inboxDir, fname);
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

            ProcessClaimed(utilP, projP, plugin_id, claimedPath, stem,
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
    AEGP_PluginID plugin_id)
{
    (void)utilP; (void)projP; (void)plugin_id;
}

#endif /* !_WIN32 */
