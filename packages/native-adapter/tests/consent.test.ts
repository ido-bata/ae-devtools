import { describe, expect, test } from "bun:test";
import {
  canonicalConsentString,
  canonicalJson,
  ConsentCanonicalError,
  issueConsentMac,
} from "../src/consent.ts";

/* Shared vectors with the C++ plug-in
   (experiments/native-sdk/minimal-plugin/test/test_main.cpp
   TestConsentVectors). Both sides must produce byte-identical canon
   strings and MACs — divergence is a contract bug (Issue #326). */

const KEY = "a".repeat(64);

const VECTORS = [
  {
    scope: {
      operationId: "AEGP_ItemSuite9.AEGP_SetItemComment",
      requestId: "r1",
      session: { sessionId: "s1", aeVersion: "26.5" },
      args: {
        projectIndex: 0,
        item: {
          aeRef: { type: "comp", name: "C", path: [0], itemId: 1 },
        },
        comment: "hi",
      },
    },
    wantCanon:
      "native-consent/v1\nAEGP_ItemSuite9.AEGP_SetItemComment\nr1\n" +
      "{\"aeVersion\":\"26.5\",\"sessionId\":\"s1\"}\n" +
      "{\"comment\":\"hi\",\"item\":{\"aeRef\":{\"itemId\":1,\"name\":\"C\",\"path\":[0],\"type\":\"comp\"}},\"projectIndex\":0}\n",
    wantMac: "6253c53d4af5731e9cbfb96141c66b4d782e0675fc1ef020528a73799200e888",
  },
  {
    scope: {
      operationId: "OP.X",
      requestId: "req-2",
      session: {
        aeVersion: "26.5",
        sdkRelease: { distribution: "macos", identifier: "26.5" },
        sessionId: "s",
      },
      args: null,
      target: "inst-1",
    },
    wantCanon:
      "native-consent/v1\nOP.X\nreq-2\n" +
      "{\"aeVersion\":\"26.5\",\"sdkRelease\":{\"distribution\":\"macos\",\"identifier\":\"26.5\"},\"sessionId\":\"s\"}\n" +
      "null\ninst-1",
    wantMac: "4d2eb82d4d845f24b3e24e544026f306d75d6152f008a0f67cab9c665c902e1f",
  },
  {
    scope: {
      operationId: "OP.Y",
      requestId: "r3",
      session: { aeVersion: "1.0", sessionId: "s\"q" },
      args: { a: [1, -2, 0], b: { k: true, z: "x\ny" }, c: null },
    },
    wantCanon:
      "native-consent/v1\nOP.Y\nr3\n" +
      "{\"aeVersion\":\"1.0\",\"sessionId\":\"s\\\"q\"}\n" +
      "{\"a\":[1,-2,0],\"b\":{\"k\":true,\"z\":\"x\\ny\"},\"c\":null}\n",
    wantMac: "cb89c6ba1fb651081c0b790a02085206dba9fbff80f3fbe748abf672fe34ae67",
  },
];

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
});

describe("consent shared vectors", () => {
  for (const [i, v] of VECTORS.entries()) {
    test(`vector ${i}: canon + MAC match C++`, () => {
      expect(canonicalConsentString(v!.scope)).toBe(v!.wantCanon);
      expect(issueConsentMac(KEY, v!.scope)).toBe(v!.wantMac);
    });
  }

  test("tampered scope field breaks the MAC", () => {
    const v = VECTORS[0]!;
    const mac = issueConsentMac(KEY, { ...v.scope, operationId: "OP.TAMPERED" });
    expect(mac).not.toBe(v.wantMac);
  });

  test("wrong key never verifies the vector MAC", () => {
    /* issueConsentMac only produces; the plug-in verifies. A wrong
       key produces a different MAC — never equal to the pinned one. */
    const v = VECTORS[0]!;
    expect(issueConsentMac("b".repeat(64), v.scope)).not.toBe(v.wantMac);
  });

  test("malformed key shape is rejected", () => {
    expect(() => issueConsentMac("abc", VECTORS[0]!.scope)).toThrow(
      ConsentCanonicalError);
    expect(() => issueConsentMac("A".repeat(64), VECTORS[0]!.scope)).toThrow(
      ConsentCanonicalError);
  });
});
