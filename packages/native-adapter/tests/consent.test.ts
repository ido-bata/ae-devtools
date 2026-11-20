import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalConsentString,
  canonicalJson,
  ConsentCanonicalError,
  issueConsentMac,
} from "../src/consent.ts";
import { DISPATCH_SCHEMA, validateDispatchResult } from "../src/dispatch.ts";

/* Shared consent contract fixture (Issue #337). The SAME file is read
   by the C++ fake-host suite
   (experiments/native-sdk/minimal-plugin/test/test_main.cpp via
   -DCONSENT_VECTORS_PATH) — divergence on either side is a contract
   bug. ae-a8n consumes it for consent issuance (ae-a8n#245). */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "native-consent-vectors.json");

type CanonicalVector = {
  name: string;
  operationId: string;
  requestId: string;
  sessionJson: string;
  argsJson?: string;
  target?: string;
  canonicalString: string;
  mac: string;
};

type WireExpect = {
  outcome: string;
  refusalCode?: string;
  mayHaveMutated?: "true" | "false" | "absent";
  payload?: Record<string, unknown>;
  opCallsInclude?: string[];
  opCallsExclude?: string[];
};

type WireConsent =
  | { mode: "absent" }
  | { mode: "invalid"; mac: string }
  | { mode: "raw"; raw: string }
  | {
      mode: "valid" | "macFor";
      macFor?: {
        requestId?: string;
        operationId?: string;
        sessionJson?: string;
        argsJson?: string | null;
        target?: string;
      };
      expectedMac: string;
    };

type WireCase = {
  name: string;
  requestId: string;
  argsJson?: string;
  channelConsentKey: boolean;
  consent: WireConsent;
  hostSetCommentError?: boolean;
  nullItemEntry?: boolean;
  expect: WireExpect;
};

type Fixture = {
  v: number;
  consentKey: string;
  channelToken: string;
  operationId: string;
  session: { sessionId: string; aeVersion: string };
  argsJson: string;
  canonicalVectors: CanonicalVector[];
  wireCases: WireCase[];
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const KEY = fixture.consentKey;

function vectorScope(v: CanonicalVector) {
  return {
    operationId: v.operationId,
    requestId: v.requestId,
    session: JSON.parse(v.sessionJson),
    args: v.argsJson === undefined ? undefined : JSON.parse(v.argsJson),
    target: v.target,
  };
}

/* The scope a presented consent MAC was computed over: the request's
   own fields, overridden by consent.macFor where present. */
function presentedMacScope(c: WireCase) {
  const over =
    c.consent.mode === "valid" || c.consent.mode === "macFor"
      ? c.consent.macFor
      : undefined;
  const argsJson =
    over?.argsJson !== undefined ? over.argsJson : (c.argsJson ?? fixture.argsJson);
  return {
    operationId: over?.operationId ?? fixture.operationId,
    requestId: over?.requestId ?? c.requestId,
    session: JSON.parse(over?.sessionJson ?? JSON.stringify(fixture.session)),
    args: argsJson === null || argsJson === undefined ? null : JSON.parse(argsJson),
    target: over?.target,
  };
}

describe("consent canonicalJson", () => {
  test("sorts object keys by UTF-8 byte order, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x\"y"] })).toBe(
      '{"a":[true,null,"x\\"y"],"b":1}');
  });

  test("rejects non-integer and out-of-range numbers", () => {
    expect(() => canonicalJson({ n: 1.5 })).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      ConsentCanonicalError);
    expect(canonicalJson(-0)).toBe("0");
  });

  test("undefined object values are dropped like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });

  test("rejects lone surrogates — the C++ parser maps them to U+FFFD, so no shared canonical form exists", () => {
    expect(() => canonicalJson("lone\ud800")).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson("lone\udc00")).toThrow(ConsentCanonicalError);
    expect(() => canonicalJson({ "\ud800": 1 })).toThrow(ConsentCanonicalError);
    /* valid surrogate pairs remain encodable */
    expect(canonicalJson("😀")).toBe('"😀"');
    expect(canonicalJson({ "\ud83d\ude00": "ok" })).toBe('{"😀":"ok"}');
  });
});

describe("consent shared vectors (fixture)", () => {
  test("fixture shape is sane", () => {
    expect(fixture.v).toBe(1);
    expect(fixture.canonicalVectors.length).toBeGreaterThanOrEqual(8);
    expect(fixture.wireCases.length).toBeGreaterThanOrEqual(10);
    for (const v of fixture.canonicalVectors) {
      expect(v.canonicalString.startsWith("native-consent/v1\n")).toBe(true);
      expect(v.mac).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  for (const v of fixture.canonicalVectors) {
    test(`vector ${v.name}: canon + MAC match C++`, () => {
      const scope = vectorScope(v);
      expect(canonicalConsentString(scope)).toBe(v.canonicalString);
      expect(issueConsentMac(KEY, scope)).toBe(v.mac);
    });
  }

  test("tampered scope field breaks the MAC", () => {
    const v = fixture.canonicalVectors[0]!;
    const mac = issueConsentMac(KEY, {
      ...vectorScope(v),
      operationId: "OP.TAMPERED",
    });
    expect(mac).not.toBe(v.mac);
  });

  test("wrong key never verifies the vector MAC", () => {
    const v = fixture.canonicalVectors[0]!;
    expect(issueConsentMac("b".repeat(64), vectorScope(v))).not.toBe(v.mac);
  });

  test("malformed key shape is rejected", () => {
    const v = fixture.canonicalVectors[0]!;
    expect(() => issueConsentMac("abc", vectorScope(v))).toThrow(
      ConsentCanonicalError);
    expect(() => issueConsentMac("A".repeat(64), vectorScope(v))).toThrow(
      ConsentCanonicalError);
  });
});

describe("consent wire cases (fixture)", () => {
  /* The plug-in-side verdicts are executed by the C++ fake-host suite;
     here we pin the REQUEST side ae-a8n must produce (envelope consent
     shape + scope-bound MAC) and that every expected verdict is a
     legal DispatchResult. */

  test("envelope consent member is exactly {v:1,mac:<64hex>} for MAC-bearing cases", () => {
    for (const c of fixture.wireCases) {
      if (c.consent.mode === "valid" || c.consent.mode === "macFor") {
        const mac = issueConsentMac(KEY, presentedMacScope(c));
        expect(c.consent.expectedMac).toBe(mac);
        expect(mac).toMatch(/^[a-f0-9]{64}$/);
        /* the envelope member ae-a8n publishes is exactly this shape */
        expect({ consent: { v: 1, mac } }).toEqual({
          consent: { v: 1, mac: c.consent.expectedMac },
        });
      }
    }
  });

  test("every expected verdict is a schema-valid DispatchResult", () => {
    for (const c of fixture.wireCases) {
      const e = c.expect;
      const doc: Record<string, unknown> = {
        schema: DISPATCH_SCHEMA,
        requestId: c.requestId,
        outcome: e.outcome,
      };
      if (e.refusalCode !== undefined) doc.refusalCode = e.refusalCode;
      if (e.outcome === "completed") doc.result = e.payload ?? { commentSet: true };
      if (e.mayHaveMutated === "true") doc.mayHaveMutated = true;
      if (e.mayHaveMutated === "false") doc.mayHaveMutated = false;
      const errors = validateDispatchResult(doc);
      expect({ case: c.name, errors }).toEqual({ case: c.name, errors: [] });
    }
  });

  test("case matrix covers the contract denial/tamper/replay/UNKNOWN-adjacent cases", () => {
    const byName = new Map(fixture.wireCases.map((c) => [c.name, c]));
    const refused = (n: string, code: string) => {
      const c = byName.get(n);
      expect(c?.expect.outcome).toBe("refused");
      expect(c?.expect.refusalCode).toBe(code);
    };
    refused("consent-absent", "CONSENT_REQUIRED");
    refused("consent-malformed-version", "CONSENT_REQUIRED");
    refused("consent-malformed-mac", "CONSENT_REQUIRED");
    refused("consent-no-channel-key", "CONSENT_REQUIRED");
    refused("consent-wrong-mac", "CONSENT_INVALID");
    refused("consent-mac-other-args", "CONSENT_INVALID");
    refused("consent-mac-other-request-id", "CONSENT_INVALID");
    refused("consent-mac-other-session", "CONSENT_INVALID");
    refused("consent-mac-other-target", "CONSENT_INVALID");
    refused("consent-valid-stale-descriptor", "STALE_REFERENCE");
    refused("consent-duplicate-request-id", "DUPLICATE_REQUEST");
    /* replay: the duplicate case reuses the valid case's requestId and
       MUST come after it in execution order */
    const names = fixture.wireCases.map((c) => c.name);
    expect(names.indexOf("consent-duplicate-request-id")).toBeGreaterThan(
      names.indexOf("consent-valid-mutation"));
    expect(byName.get("consent-duplicate-request-id")?.requestId).toBe(
      byName.get("consent-valid-mutation")?.requestId);
    /* mayHaveMutated semantics: attempted mutation → true on
       completed AND failed; pre-execution outcomes → absent */
    expect(byName.get("consent-valid-mutation")?.expect.mayHaveMutated).toBe("true");
    expect(byName.get("consent-valid-aegp-error")?.expect).toMatchObject({
      outcome: "failed",
      mayHaveMutated: "true",
    });
    expect(byName.get("consent-valid-missing-suite-entry")?.expect.outcome).toBe(
      "not-sent");
    for (const c of fixture.wireCases) {
      if (c.expect.outcome === "refused" || c.expect.outcome === "not-sent") {
        expect(c.expect.mayHaveMutated).toBe("absent");
      }
    }
  });
});
