/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — bounded JSON DOM parser                */
/* See native_json.h for the contract.                              */
/*******************************************************************/

#include "native_json.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define IN_MAX_DEPTH 32
#define IN_MAX_NODES 8192

typedef struct
{
    const char* cur;
    const char* end;
    int nodes;
    int failed;
} JParser;

void JFree(JVal* v)
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
JVal* JParseDoc(const char* text, size_t len)
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

JVal* JGet(JVal* obj, const char* key)
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

int JStrEq(JVal* v, const char* s)
{
    size_t n = strlen(s);
    return v && v->kind == JK_STR && v->slen == n && memcmp(v->str, s, n) == 0;
}

int JNonEmptyStr(JVal* v)
{
    return v && v->kind == JK_STR && v->slen > 0;
}

