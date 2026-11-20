/**
 * consent.ts — mutation consent proof (Issue #326, contract §7g).
 *
 * Canonical encoder + HMAC-SHA256 for the native-channel per-request
 * authorization MAC. The C++ plug-in (`src/native_consent.cpp`)
 * implements the identical contract; shared test vectors pin both
 * sides to byte-identical output — any divergence is a contract bug.
 *
 * Evidence level: fake/mock only — proves the wire contract, not a
 * real AE host.
 */

import { createHmac } from "node:crypto";

/** Thrown when a value cannot be canonically encoded (non-integer or
 *  out-of-range number — floats are not consent-encodable in v1). */
export class ConsentCanonicalError extends Error {
  constructor(detail: string) {
    super(`value is not consent-canonical: ${detail}`);
    this.name = "ConsentCanonicalError";
  }
}

const MAX_SAFE = 9007199254740991;

/* Lone UTF-16 surrogates have no UTF-8 form: the C++ plug-in's JSON
   parser (native_json.cpp JParseString) maps them to U+FFFD while
   JSON.stringify re-emits them as \uDXXX escapes — the two sides could
   never produce the same canonical bytes, so the value is not
   consent-encodable (contract §7g: canonicalization fails → the
   request refuses CONSENT_INVALID). Rejecting at issuance is the
   fail-closed mirror of that outcome. */
function assertNoLoneSurrogate(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      throw new ConsentCanonicalError("lone surrogate in string");
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ConsentCanonicalError("lone surrogate in string");
    }
  }
}

/**
 * canonicalJson — restricted JSON canonical form (contract §7g):
 * no whitespace; object keys sorted by UTF-8 byte order; strings
 * escaped exactly like JSON.stringify; integers only.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v) || Math.abs(v) > MAX_SAFE) {
      throw new ConsentCanonicalError(`non-canonical number ${v}`);
    }
    return String(v);
  }
  if (typeof v === "string") {
    assertNoLoneSurrogate(v);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map((e) => canonicalJson(e)).join(",")}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    const parts = keys.map((k) => {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) {
        /* JSON.stringify drops undefined object values; the canonical
           form treats them as absent — same semantics. */
        return null;
      }
      assertNoLoneSurrogate(k);
      return `${JSON.stringify(k)}:${canonicalJson(val)}`;
    }).filter((p): p is string => p !== null);
    return `{${parts.join(",")}}`;
  }
  throw new ConsentCanonicalError(`unsupported value type ${typeof v}`);
}

export type ConsentScopeInput = {
  operationId: string;
  requestId: string;
  session: unknown;
  args?: unknown;
  target?: string;
};

/**
 * canonicalConsentString (contract §7g):
 *   "native-consent/v1\n" ++ operationId ++ "\n" ++ requestId ++ "\n"
 *     ++ canonicalJson(session) ++ "\n" ++ canonicalJson(args ?? null)
 *     ++ "\n" ++ (target ?? "")
 */
export function canonicalConsentString(input: ConsentScopeInput): string {
  return (
    "native-consent/v1\n" +
    input.operationId + "\n" +
    input.requestId + "\n" +
    canonicalJson(input.session) + "\n" +
    canonicalJson(input.args ?? null) + "\n" +
    (input.target ?? "")
  );
}

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * Issue a consent MAC: HMAC-SHA256 over the canonical consent string,
 * keyed by the 32-byte consentKey (64 lowercase hex). Returns the
 * 64-char lowercase hex MAC for the request envelope's `consent.mac`.
 */
export function issueConsentMac(
  consentKeyHex: string,
  scope: ConsentScopeInput,
): string {
  if (!HEX64.test(consentKeyHex)) {
    throw new ConsentCanonicalError("consentKey must be 64 lowercase hex chars");
  }
  const msg = canonicalConsentString(scope);
  return createHmac("sha256", Buffer.from(consentKeyHex, "hex"))
    .update(msg, "utf8")
    .digest("hex");
}
