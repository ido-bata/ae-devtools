/**
 * trusted-codec tests — the ES3 codec must (a) agree with native JSON over
 * the plain-data corpus, (b) refuse everything outside the trusted
 * serializable set, (c) round-trip the ae* wrappers and reject malformed
 * ones. Runs the codec in node:vm with native JSON removed — the same code
 * path the ES3 host takes (mirrors probe-json.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const codecSource = readFileSync(
  join(here, "..", "codec", "trusted-codec.js"),
  "utf8",
);

function loadCodec() {
  const ctx = vm.createContext({
    Object, Array, String, Number, Boolean, Date, RegExp,
    isFinite, parseInt, parseFloat, Error, Math,
  });
  vm.runInContext("var JSON = undefined;", ctx);
  return vm.runInContext(`${codecSource}\nTrustedCodec`, ctx, { filename: "trusted-codec.js" });
}

const CORPUS = [
  { v: 1, id: "a".repeat(32), method: "op.test", params: { message: "ping-01ab" } },
  { ok: true, result: { aeVersion: "27.0.0", flags: [true, false, null], n: -12.5e3 } },
  { ok: false, error: { aeError: { name: "Refusal", message: "no", line: 42, file: "host/x.jsx" } } },
  { arr: [1, 2, 3, [4, true, null]], nested: { a: { b: { c: "deep" } } } },
  { weird: 'quote" back\\slash tab\tnew\nline unicode é 日本' },
  { empty: {}, emptyArr: [] },
  { n: -12.5e3, zero: 0, big: 9007199254740991 },
];

test("differential: stringify/parse agree with native JSON over the plain corpus", () => {
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
  assert.equal(codec.stringify({ a: 1 }), '{"a":1}');
  // Cross-realm objects: compare by re-stringify, not deepEqual.
  assert.equal(JSON.stringify(codec.parse('{"a":1}')), '{"a":1}');
});

test("non-serializable values are refused, never coerced", () => {
  const codec = loadCodec();
  const bad = [
    () => {},
    { fn: () => {} },
    { u: undefined },
    [undefined],
    NaN,
    Infinity,
    { d: new Date(0) }, // host-ish object: Date is not in the serializable set
    { nested: { deep: { fn: function () {} } } },
  ];
  for (const value of bad) {
    assert.throws(() => codec.stringify(value), /trusted-codec/, `accepted ${JSON.stringify(value)}`);
  }
});

test("host objects that tag as non-plain types are refused (Date etc.)", () => {
  const codec = loadCodec();
  // ES3 host objects (Project/Comp/Layer/…) must be wrapped in aeRef by the
  // dispatcher before stringify; the codec refuses any value whose type tag
  // is outside the serializable set. A host object that tags as plain
  // [object Object] cannot be distinguished from a data object by type tag
  // alone — that boundary is the dispatcher's wrapping discipline, not the
  // codec's. This test pins the tag-level refusal.
  assert.throws(() => codec.stringify(new Date(0)), /trusted-codec/);
  assert.throws(() => codec.stringify({ when: new Date(0) }), /trusted-codec/);
});

test("wrappers round-trip through stringify/parse", () => {
  const codec = loadCodec();
  const value = {
    ref: codec.ref("layer", "Shape Layer 1", [0, 2, 1], "sha256:abc"),
    en: codec.enumValue("BlendingMode", 2),
    p: codec.path("comp/main/item[3]", "project-item"),
    pabs: codec.path("/tmp/x.aep", "absolute"),
    err: codec.error("ReferenceError", "bad ref", 17, "host/dispatcher.jsx"),
    errNoPos: codec.error("TypeError", "no position"),
  };
  const text = codec.stringify(value);
  const back = codec.parse(text);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(value)));
  assert.equal(back.ref.aeRef.type, "layer");
  assert.equal(back.en.aeEnum.name, "BlendingMode");
  assert.equal(back.p.aePath.pathKind, "project-item");
  assert.equal(back.err.aeError.line, 17);
  assert.equal(back.errNoPos.aeError.line, undefined);
});

test("malformed wrappers are refused on both stringify and parse", () => {
  const codec = loadCodec();
  const badWraps = [
    { aeRef: { type: "layer" } },                                  // missing name/path
    { aeRef: { type: "layer", name: "x", path: [0, "a"] } },        // non-int path
    { aeRef: { type: "layer", name: "x", path: [-1] } },            // negative index
    { aeEnum: { name: "X" } },                                      // missing value
    { aeEnum: { name: "X", value: "2" } },                          // non-number value
    { aeEnum: { name: "X", value: NaN } },                          // non-finite
    { aePath: { path: "x", pathKind: "uri" } },                     // bad pathKind
    { aePath: { path: "x" } },                                      // missing pathKind
    { aeError: { name: "E" } },                                     // missing message
    { aeError: { name: "E", message: "m", line: "17" } },           // line not number
    { aeRef: { type: "l", name: "n", path: [], extra: 1 } },        // unexpected field
    { aeRef: { type: "l", name: "n", path: [] }, other: 1 },        // wrapper + sibling
    { aeRef: {}, aeEnum: {} },                                      // two markers
  ];
  for (const value of badWraps) {
    assert.throws(() => codec.stringify(value), /trusted-codec/, `stringify accepted ${JSON.stringify(value)}`);
  }
  // Same shapes arriving over the wire are refused at parse time.
  for (const value of badWraps) {
    const text = JSON.stringify(value);
    assert.throws(() => codec.parse(text), /trusted-codec/, `parse accepted ${text}`);
  }
});

test("depth limit refuses pathological nesting on both directions", () => {
  const codec = loadCodec();
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 20; i++) { cur.a = {}; cur = cur.a; }
  assert.throws(() => codec.stringify(deep), /trusted-codec/);
  const deepText = "[".repeat(20) + "]".repeat(20);
  assert.throws(() => codec.parse(deepText), /trusted-codec/);
});

test("malformed JSON throws instead of guessing", () => {
  const codec = loadCodec();
  const bad = ["{", '{"a":}', "nope", "[1,]", '"unterminated', "{}extra", "1 2"];
  for (const text of bad) {
    assert.throws(() => codec.parse(text), /trusted-codec/);
  }
});

test("ExtendScript Object.prototype pollution keys survive", () => {
  const codec = loadCodec();
  const value = { "+": 1, "-": 2, "*": 3, "/": 4 };
  assert.equal(codec.stringify(value), JSON.stringify(value));
  assert.equal(
    codec.stringify(codec.parse(JSON.stringify(value))),
    JSON.stringify(value),
  );
});
