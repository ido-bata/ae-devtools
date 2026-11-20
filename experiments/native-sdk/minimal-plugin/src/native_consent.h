/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — mutation consent proof (Issue #326)    */
/*                                                                 */
/* Contract: native-channel.md §7g. Self-contained: libc +           */
/* native_json.h only. Implements SHA-256/HMAC-SHA256, the           */
/* restricted canonicalJson form, the canonicalConsentString        */
/* assembly, and constant-time MAC verification.                    */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_CONSENT_H
#define AE_PROBE_NATIVE_CONSENT_H

#include <stddef.h>

#include "native_json.h"

/* Append the canonicalJson form of v (contract §7g) to out.
   Returns 1 on success; 0 when v holds a non-canonical value
   (non-integer/out-of-range number) or the buffer would overflow —
   *len always reflects bytes written so far. */
int ConsentCanonJson(char* out, size_t cap, size_t* len, const JVal* v);

/* Build the canonicalConsentString for one request:
   "native-consent/v1\n" ++ opId ++ "\n" ++ reqId ++ "\n"
     ++ canonicalJson(session) ++ "\n" ++ canonicalJson(args) ++ "\n"
     ++ target
   session/args are JVal trees (args==NULL → "null"). opId/reqId/target
   are length-delimited byte strings (JVal strings are NOT NUL-
   terminated); targetZ==NULL contributes the empty tail field.
   Returns 1 on success; 0 on canonicalization failure or overflow. */
int ConsentBuildString(char* out, size_t cap, size_t* len,
                       const char* opIdZ, size_t opIdLen,
                       const char* reqIdZ, size_t reqIdLen,
                       const JVal* session, const JVal* args,
                       const char* targetZ, size_t targetLen);

/* HMAC-SHA256: 32-byte tag over msg under key (any length). */
void ConsentHmacSha256(const unsigned char* key, size_t keyLen,
                       const unsigned char* msg, size_t msgLen,
                       unsigned char out[32]);

/* Decode a 64-char lowercase-hex key into 32 bytes.
   Returns 1 on success; 0 on any shape violation. */
int ConsentHexKeyDecode(const char* hex64, unsigned char out[32]);

/* Verify a presented 64-hex MAC (length-delimited bytes — JVal strings
   are not NUL-terminated): recompute HMAC-SHA256 over canon under the
   hex-encoded consentKey and compare constant-time. Returns 1 only on
   an exact match; 0 on bad key/mac shape or mismatch. */
int ConsentVerifyMac(const char* consentKeyHex64,
                     const char* canon, size_t canonLen,
                     const char* macHex, size_t macLen);

#endif /* AE_PROBE_NATIVE_CONSENT_H */
