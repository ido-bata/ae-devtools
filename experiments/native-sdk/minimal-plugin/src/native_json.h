/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — bounded JSON DOM parser                */
/* (extracted from native_intake.cpp for Issue #267 auditability)   */
/*                                                                 */
/* Original code written for this repository. Self-contained:      */
/* libc only, no AE SDK types. One document at a time; every        */
/* allocation is owned by the returned JVal tree and released by    */
/* JFree. Bounds: input/depth/node caps, duplicate keys rejected,   */
/* trailing garbage rejected, non-finite numbers rejected.          */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_JSON_H
#define AE_PROBE_NATIVE_JSON_H

#include <stddef.h>

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
    char* str;    /* JK_STR: malloc'd, slen bytes (not NUL-required) */
    size_t slen;
    JVal** items; /* JK_ARR */
    size_t nitems;
    JPair* pairs; /* JK_OBJ */
    size_t npairs;
};

/* Parse a whole document; returns a JVal tree or NULL. */
JVal* JParseDoc(const char* text, size_t len);
void JFree(JVal* v);
JVal* JGet(JVal* obj, const char* key);
int JStrEq(JVal* v, const char* s);
int JNonEmptyStr(JVal* v);

#endif /* AE_PROBE_NATIVE_JSON_H */
