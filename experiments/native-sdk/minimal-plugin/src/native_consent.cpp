/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — mutation consent proof (Issue #326)    */
/*                                                                 */
/* Contract: native-channel.md §7g. Original code written for this   */
/* repository; SHA-256 is the standard FIPS 180-4 construction.      */
/*******************************************************************/

#include "native_consent.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- SHA-256 ---------------------------------------------------- */

typedef struct
{
    uint32_t h[8];
    uint64_t len;
    unsigned char buf[64];
    size_t buflen;
} Sha256;

static const uint32_t S256_K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

static uint32_t Ror32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void Sha256Block(Sha256* s, const unsigned char* p)
{
    uint32_t w[64];
    int i;
    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    for (i = 16; i < 64; i++)
    {
        uint32_t s0 = Ror32(w[i - 15], 7) ^ Ror32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = Ror32(w[i - 2], 17) ^ Ror32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    {
        uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3];
        uint32_t e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
        for (i = 0; i < 64; i++)
        {
            uint32_t S1 = Ror32(e, 6) ^ Ror32(e, 11) ^ Ror32(e, 25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = h + S1 + ch + S256_K[i] + w[i];
            uint32_t S0 = Ror32(a, 2) ^ Ror32(a, 13) ^ Ror32(a, 22);
            uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + maj;
            h = g; g = f; f = e; e = d + t1;
            d = c; c = b; b = a; a = t1 + t2;
        }
        s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d;
        s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
    }
}

static void Sha256Init(Sha256* s)
{
    static const uint32_t H0[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
    };
    memcpy(s->h, H0, sizeof(H0));
    s->len = 0;
    s->buflen = 0;
}

static void Sha256Update(Sha256* s, const unsigned char* p, size_t n)
{
    s->len += n;
    while (n > 0)
    {
        size_t take = 64 - s->buflen;
        if (take > n) take = n;
        memcpy(s->buf + s->buflen, p, take);
        s->buflen += take;
        p += take;
        n -= take;
        if (s->buflen == 64)
        {
            Sha256Block(s, s->buf);
            s->buflen = 0;
        }
    }
}

static void Sha256Final(Sha256* s, unsigned char out[32])
{
    uint64_t bits = s->len * 8;
    unsigned char pad = 0x80;
    unsigned char zero = 0;
    unsigned char lenbuf[8];
    int i;
    for (i = 0; i < 8; i++) lenbuf[i] = (unsigned char)(bits >> (56 - i * 8));
    Sha256Update(s, &pad, 1);
    while (s->buflen != 56) Sha256Update(s, &zero, 1);
    Sha256Update(s, lenbuf, 8);
    for (i = 0; i < 8; i++)
    {
        out[i * 4] = (unsigned char)(s->h[i] >> 24);
        out[i * 4 + 1] = (unsigned char)(s->h[i] >> 16);
        out[i * 4 + 2] = (unsigned char)(s->h[i] >> 8);
        out[i * 4 + 3] = (unsigned char)(s->h[i]);
    }
}

/* ---- HMAC-SHA256 ------------------------------------------------- */

void ConsentHmacSha256(const unsigned char* key, size_t keyLen,
                       const unsigned char* msg, size_t msgLen,
                       unsigned char out[32])
{
    unsigned char kbuf[64];
    unsigned char ipad[64], opad[64];
    Sha256 s;
    size_t i;

    memset(kbuf, 0, sizeof(kbuf));
    if (keyLen > 64)
    {
        Sha256 ks;
        Sha256Init(&ks);
        Sha256Update(&ks, key, keyLen);
        Sha256Final(&ks, kbuf);
    }
    else
    {
        memcpy(kbuf, key, keyLen);
    }
    for (i = 0; i < 64; i++)
    {
        ipad[i] = (unsigned char)(kbuf[i] ^ 0x36);
        opad[i] = (unsigned char)(kbuf[i] ^ 0x5c);
    }
    Sha256Init(&s);
    Sha256Update(&s, ipad, 64);
    Sha256Update(&s, msg, msgLen);
    {
        unsigned char inner[32];
        Sha256Final(&s, inner);
        Sha256Init(&s);
        Sha256Update(&s, opad, 64);
        Sha256Update(&s, inner, 32);
        Sha256Final(&s, out);
    }
}

/* ---- hex --------------------------------------------------------- */

static int HexNibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

int ConsentHexKeyDecode(const char* hex64, unsigned char out[32])
{
    int i;
    if (strlen(hex64) != 64) return 0;
    for (i = 0; i < 32; i++)
    {
        int hi = HexNibble(hex64[i * 2]);
        int lo = HexNibble(hex64[i * 2 + 1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 1;
}

/* ---- canonicalJson ----------------------------------------------- */

/* Append helper: returns remaining capacity or 0 on overflow. */
static int CanonPut(char* out, size_t cap, size_t* len, const char* s, size_t n)
{
    if (*len + n > cap) return 0;
    memcpy(out + *len, s, n);
    *len += n;
    return 1;
}

static int CanonPutCh(char* out, size_t cap, size_t* len, char c)
{
    return CanonPut(out, cap, len, &c, 1);
}

/* JSON string escaping per contract §7g: iterate raw bytes (slen —
   embedded NULs are possible via \u0000 and must escape). */
static int CanonStr(char* out, size_t cap, size_t* len,
                    const char* s, size_t slen)
{
    size_t i;
    static const char HEXD[] = "0123456789abcdef";
    if (!CanonPutCh(out, cap, len, '"')) return 0;
    for (i = 0; i < slen; i++)
    {
        unsigned char c = (unsigned char)s[i];
        char esc[8];
        const char* e = NULL;
        size_t el = 0;
        switch (c)
        {
            case '"': e = "\\\""; el = 2; break;
            case '\\': e = "\\\\"; el = 2; break;
            case '\b': e = "\\b"; el = 2; break;
            case '\f': e = "\\f"; el = 2; break;
            case '\n': e = "\\n"; el = 2; break;
            case '\r': e = "\\r"; el = 2; break;
            case '\t': e = "\\t"; el = 2; break;
            default:
                if (c < 0x20)
                {
                    esc[0] = '\\'; esc[1] = 'u'; esc[2] = '0'; esc[3] = '0';
                    esc[4] = HEXD[c >> 4]; esc[5] = HEXD[c & 15];
                    e = esc; el = 6;
                }
                break;
        }
        if (e)
        {
            if (!CanonPut(out, cap, len, e, el)) return 0;
        }
        else
        {
            if (!CanonPutCh(out, cap, len, (char)c)) return 0;
        }
    }
    return CanonPutCh(out, cap, len, '"');
}

static int CanonNum(char* out, size_t cap, size_t* len, double d)
{
    char tmp[40];
    /* Integers only, |v| <= 2^53 — the only canonical numbers in v1. */
    if (!isfinite(d) || d != floor(d) || fabs(d) > 9007199254740991.0)
        return 0;
    snprintf(tmp, sizeof(tmp), "%lld", (long long)d);
    return CanonPut(out, cap, len, tmp, strlen(tmp));
}

/* Object keys sorted by UTF-8 byte order (memcmp, shorter-first on
   shared prefix — UTF-8 preserves code-point order). */
static int PairCmp(const void* a, const void* b)
{
    const JPair* pa = (const JPair*)a;
    const JPair* pb = (const JPair*)b;
    size_t n = pa->klen < pb->klen ? pa->klen : pb->klen;
    int c = memcmp(pa->key, pb->key, n);
    if (c) return c;
    if (pa->klen < pb->klen) return -1;
    if (pa->klen > pb->klen) return 1;
    return 0;
}

int ConsentCanonJson(char* out, size_t cap, size_t* len, const JVal* v)
{
    size_t i;
    if (!v) return CanonPut(out, cap, len, "null", 4);
    switch (v->kind)
    {
        case JK_NULL: return CanonPut(out, cap, len, "null", 4);
        case JK_FALSE: return CanonPut(out, cap, len, "false", 5);
        case JK_TRUE: return CanonPut(out, cap, len, "true", 4);
        case JK_NUM: return CanonNum(out, cap, len, v->num);
        case JK_STR: return CanonStr(out, cap, len, v->str ? v->str : "", v->slen);
        case JK_ARR:
            if (!CanonPutCh(out, cap, len, '[')) return 0;
            for (i = 0; i < v->nitems; i++)
            {
                if (i && !CanonPutCh(out, cap, len, ',')) return 0;
                if (!ConsentCanonJson(out, cap, len, v->items[i])) return 0;
            }
            return CanonPutCh(out, cap, len, ']');
        case JK_OBJ:
        {
            JPair* sorted;
            size_t j;
            int ok = 1;
            if (v->npairs == 0)
                return CanonPut(out, cap, len, "{}", 2);
            sorted = (JPair*)malloc(v->npairs * sizeof(JPair));
            if (!sorted) return 0;
            memcpy(sorted, v->pairs, v->npairs * sizeof(JPair));
            qsort(sorted, v->npairs, sizeof(JPair), PairCmp);
            if (!CanonPutCh(out, cap, len, '{')) { free(sorted); return 0; }
            for (j = 0; j < v->npairs && ok; j++)
            {
                if (j && !CanonPutCh(out, cap, len, ',')) { ok = 0; break; }
                if (!CanonStr(out, cap, len, sorted[j].key, sorted[j].klen)) { ok = 0; break; }
                if (!CanonPutCh(out, cap, len, ':')) { ok = 0; break; }
                if (!ConsentCanonJson(out, cap, len, sorted[j].val)) { ok = 0; break; }
            }
            if (ok && !CanonPutCh(out, cap, len, '}')) ok = 0;
            free(sorted);
            return ok;
        }
    }
    return 0;
}

/* ---- canonicalConsentString -------------------------------------- */

int ConsentBuildString(char* out, size_t cap, size_t* len,
                       const char* opIdZ, size_t opIdLen,
                       const char* reqIdZ, size_t reqIdLen,
                       const JVal* session, const JVal* args,
                       const char* targetZ, size_t targetLen)
{
    static const char TAG[] = "native-consent/v1\n";
    *len = 0;
    if (!CanonPut(out, cap, len, TAG, sizeof(TAG) - 1)) return 0;
    if (!CanonPut(out, cap, len, opIdZ, opIdLen)) return 0;
    if (!CanonPutCh(out, cap, len, '\n')) return 0;
    if (!CanonPut(out, cap, len, reqIdZ, reqIdLen)) return 0;
    if (!CanonPutCh(out, cap, len, '\n')) return 0;
    if (!ConsentCanonJson(out, cap, len, session)) return 0;
    if (!CanonPutCh(out, cap, len, '\n')) return 0;
    if (!ConsentCanonJson(out, cap, len, args)) return 0;
    if (!CanonPutCh(out, cap, len, '\n')) return 0;
    if (targetZ && targetLen)
        if (!CanonPut(out, cap, len, targetZ, targetLen)) return 0;
    return 1;
}

/* ---- MAC verify --------------------------------------------------- */

/* Decode exactly 64 lowercase-hex chars into 32 bytes. */
static int Hex64DecodeN(const char* hex, size_t len, unsigned char out[32])
{
    int i;
    if (len != 64) return 0;
    for (i = 0; i < 32; i++)
    {
        int hi = HexNibble(hex[i * 2]);
        int lo = HexNibble(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 1;
}

int ConsentVerifyMac(const char* consentKeyHex64,
                     const char* canon, size_t canonLen,
                     const char* macHex, size_t macLen)
{
    unsigned char key[32], expect[32];
    unsigned char mac[32];
    size_t i;
    int diff = 0;

    if (strlen(consentKeyHex64) != 64) return 0;
    if (!ConsentHexKeyDecode(consentKeyHex64, key)) return 0;
    if (!Hex64DecodeN(macHex, macLen, mac)) return 0;
    ConsentHmacSha256(key, sizeof(key),
                      (const unsigned char*)canon, canonLen, expect);
    /* constant-time compare over the decoded 32-byte tags */
    for (i = 0; i < 32; i++) diff |= expect[i] ^ mac[i];
    return diff == 0;
}
