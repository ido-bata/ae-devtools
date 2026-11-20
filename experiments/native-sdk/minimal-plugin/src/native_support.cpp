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

#define PUBLISH_ATTEMPTS 3
#define PUBLISH_RETRY_US 50000     /* 50 ms */

/* Pure helpers shared by the intake modules: bounded file IO, path
   joins, request-id/token shape checks, instance id generation, JSON
   string escaping, the bounded JSON emit cursor, and the UTF-16 <->
   UTF-8 codecs. No channel state, no AEGP calls. */

/* ---- small fs helpers ---------------------------------------------- */

void JoinPath(char* out, size_t cap, const char* a, const char* b)
{
    size_t n = strlen(a);
    snprintf(out, cap, "%s%s%s", a, (n && a[n - 1] == '/') ? "" : "/", b);
    out[cap - 1] = '\0';
}

/* Read a whole regular file, bounded. O_NOFOLLOW refuses symlinks at
   open time; fstat confirms a regular file and caps the read so a
   swapped or grown file is refused rather than truncated. Returns
   length or -1. */
long ReadFileBounded(const char* pathZ, char* buf, size_t cap)
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
int WriteFileAtomic(const char* finalPathZ, const char* textZ, size_t len)
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
int PrivatePathOk(const char* pathZ, int wantDir)
{
    struct stat st;
    if (lstat(pathZ, &st) != 0) return 0;
    if (S_ISLNK(st.st_mode)) return 0;
    if (wantDir ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) return 0;
    if ((st.st_mode & 077) != 0) return 0;
    return 1;
}

long long FileMtimeMs(const char* pathZ)
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

long long NowMs(void)
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

int ReqIdOk(const char* idZ, size_t len)
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

int TokenOk(const char* tokZ, size_t len)
{
    size_t i;
    if (len != 64) return 0;
    for (i = 0; i < len; i++)
        if (!((tokZ[i] >= '0' && tokZ[i] <= '9') || (tokZ[i] >= 'a' && tokZ[i] <= 'f')))
            return 0;
    return 1;
}

void MakeInstance(char* out, size_t cap)
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

/* JSON string escaping — defense in depth for our own
   charset-safe strings (see native_request.cpp). */
void JsonEscape(char* out, size_t cap, const char* inZ)
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

/* UTF-16 <-> UTF-8 codecs. The mem-handle readers that
   op-record every suite call live in native_suites.cpp. */
int IntakeUtf16ToUtf8(
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
int IntakeUtf8ToUtf16(
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


void JBInit(JBuf* b, char* buf, size_t cap)
{
    b->cur = buf;
    b->left = cap;
    b->of = 0;
}
void JBPut(JBuf* b, const char* s)
{
    size_t n = strlen(s);
    if (n >= b->left) { b->of = 1; b->left = 0; return; }
    memcpy(b->cur, s, n);
    b->cur += n;
    b->left -= n;
}
void JBPutc(JBuf* b, char c)
{
    if (b->left < 2) { b->of = 1; return; }
    *b->cur++ = c;
    b->left--;
}
void JBNum(JBuf* b, long v)
{
    char t[24];
    snprintf(t, sizeof(t), "%ld", v);
    JBPut(b, t);
}
void JBEsc(JBuf* b, const char* s)
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

#else /* _WIN32 */
#endif
