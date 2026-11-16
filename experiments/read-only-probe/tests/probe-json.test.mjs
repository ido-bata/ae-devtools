/**
 * probe-json differential test — the read-only-probe's ES3 codec must agree
 * with Node's native JSON over the probe's own envelope corpus.
 *
 * Mirrors ae-a8n's differential approach (test/host-json.test.ts): the codec
 * runs in a node:vm with the native JSON removed, so the code path under
 * test is the one the ES3 host takes when ExtendScript has no JSON.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const codecSource = readFileSync(
  join(here, "..", "host", "probe-json.js"),
  "utf8",
);

function loadCodec() {
  const ctx = vm.createContext({
    Object, Array, String, Number, Boolean, Date, RegExp,
    isFinite, parseInt, parseFloat, Error,
  });
  vm.runInContext("var JSON = undefined;", ctx);
  return vm.runInContext(`${codecSource}\nProbeJson`, ctx, { filename: "probe-json.js" });
}

/** Envelope-like corpus: exactly the shapes the probe exchanges. */
const CORPUS = [
  { v: 1, id: "a".repeat(32), token: "T".repeat(8), method: "probe.echo", params: { message: "ping-01ab" } },
  {
    ok: true, hostClock: "2026-11-12T09:00:00.123Z", hostEvalMs: 2,
    result: {
      aeVersion: "27.0.0", aeBuildName: "27.0x55", scriptingVersion: "27.0",
      isoLanguage: "ja_JP", locale: "ja_JP", userName: "",
      sessionId: "sess-x", channelId: "chan-x", dispatchId: "disp-x",
    },
  },
  { ok: false, refusal: { code: "EXPIRED", message: "request refused before execution" } },
  { arr: [1, 2, 3, [4, true, null]], nested: { a: { b: { c: "deep" } } } },
  { weird: 'quote" back\\slash tab\tnew\nline unicode é 日本' },
  { empty: {}, emptyArr: [] },
  { n: -12.5e3, zero: 0, big: 9007199254740991 },
];

test("differential: stringify and parse agree with native JSON over the envelope corpus", () => {
  const codec = loadCodec();
  for (const value of CORPUS) {
    const native = JSON.stringify(value);
    const own = codec.stringify(value);
    assert.equal(own, native, `stringify mismatch for ${native}`);
    const reparsed = codec.parse(native);
    assert.deepEqual(JSON.stringify(reparsed), native, `parse mismatch for ${native}`);
  }
});

test("the ES3 code path is the one taken when JSON is absent", () => {
  const codec = loadCodec();
  assert.equal(typeof codec.stringify, "function");
  assert.equal(typeof codec.parse, "function");
  const out = codec.stringify({ a: 1 });
  assert.equal(out, '{"a":1}');
});

test("malformed input throws instead of guessing (host refuses, never invents)", () => {
  const codec = loadCodec();
  const bad = ["{", '{"a":}', "nope", "[1,]", '"unterminated', "{}extra", "1 2"];
  for (const text of bad) {
    assert.throws(() => codec.parse(text), /probe-json parse error/);
  }
});

test("codec handles the characters ExtendScript's Object.prototype pollutes keys with", () => {
  const codec = loadCodec();
  // "+", "-", "*", "/" — observed as non-enumerable function members on AE
  // 26.5x89's Object.prototype. has() must gate them. (Comparison is by
  // re-stringify: the vm realm's objects do not compare reference-equal.)
  const value = { "+": 1, "-": 2, "*": 3, "/": 4 };
  assert.equal(codec.stringify(value), JSON.stringify(value));
  assert.equal(
    codec.stringify(codec.parse(JSON.stringify(value))),
    JSON.stringify(value),
  );
});