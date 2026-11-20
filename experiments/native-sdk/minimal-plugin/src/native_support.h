/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — intake shared pure helpers             */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/* Self-contained: libc + AE SDK types only. No channel state,     */
/* no AEGP calls — safe to use from every intake module.           */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_SUPPORT_H
#define AE_PROBE_NATIVE_SUPPORT_H

#include <stddef.h>

#include "native_intake.h" /* AE_GeneralPlug.h types */

/* Channel implementation bound (contract native-channel.md §3). */
#define PATH_MAX_LOCAL 4096
#define REQ_ID_MAX 128

/* Bounded JSON emit cursor — overflow is flagged, never silently
   truncated mid-token. */
typedef struct
{
    char* cur;
    size_t left;
    int of;
} JBuf;

void JoinPath(char* out, size_t cap, const char* a, const char* b);
long ReadFileBounded(const char* pathZ, char* buf, size_t cap);
int WriteFileAtomic(const char* finalPathZ, const char* textZ, size_t len);
int PrivatePathOk(const char* pathZ, int wantDir);
long long FileMtimeMs(const char* pathZ);
long long NowMs(void);
int ReqIdOk(const char* idZ, size_t len);
int TokenOk(const char* tokZ, size_t len);
void MakeInstance(char* out, size_t cap);
void JsonEscape(char* out, size_t cap, const char* inZ);
void JBInit(JBuf* b, char* buf, size_t cap);
void JBPut(JBuf* b, const char* s);
void JBPutc(JBuf* b, char c);
void JBNum(JBuf* b, long v);
void JBEsc(JBuf* b, const char* s);
int IntakeUtf16ToUtf8(
    const A_UTF16Char* srcP,
    AEGP_MemSize max_unitsL,
    char* dstP,
    size_t dstSize);
int IntakeUtf8ToUtf16(
    const char* srcP,
    size_t srcLen,
    A_UTF16Char* dstP,
    size_t dstUnits);

#endif /* AE_PROBE_NATIVE_SUPPORT_H */
