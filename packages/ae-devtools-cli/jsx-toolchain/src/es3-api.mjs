/**
 * es3-api.mjs — ExtendScript runtime API compatibility table (Issue #52).
 *
 * SEPARATE CONCERN from syntax. `es3-syntax.mjs` proves the emitted JSX
 * parses as ECMAScript 3 grammar; this module answers a different
 * question: "does the ExtendScript *host* provide this builtin?" A
 * program can be perfectly ES3-legal and still call `JSON.parse`,
 * which does not exist in the ExtendScript ES3 host.
 *
 * Provenance and honesty:
 *
 *   - `ABSENT_GLOBALS` / `BUILTIN_ES5_MEMBERS` list ECMAScript features
 *     introduced AFTER ES3 (ES5/ES6+). ExtendScript's scripting engine
 *     is ES3-based; ES5+ builtins are absent unless Adobe added them
 *     (none of the listed ones are documented for ExtendScript).
 *   - ES3-standard members are deliberately NOT listed: `Date.UTC`,
 *     `Date.parse`, `String.fromCharCode`, `String.prototype.indexOf`,
 *     `Array.prototype.slice`, `Function.prototype.call/apply`,
 *     `Object.prototype.hasOwnProperty`, `Array.prototype` itself, etc.
 *     are all ES3 and MUST NOT be flagged. (An earlier revision of this
 *     table wrongly listed `Date.UTC` and `String.fromCharCode` — both
 *     are ES3; that was a false positive, fixed here.)
 *   - `ES5_METHOD_NAMES` are prototype method names that are ES5+ on
 *     EVERY receiver ExtendScript ships (Array/String/Function). They
 *     are flagged on any `.name(` call because receiver types cannot be
 *     resolved without type info. `.indexOf` is deliberately EXCLUDED:
 *     `String.prototype.indexOf` is ES3 while `Array.prototype.indexOf`
 *     is ES5, and the name alone cannot distinguish them — flagging it
 *     would false-positive on legal ES3 code. Known miss, documented.
 *   - This is a CURATED TABLE, not an exhaustive model of the
 *     ExtendScript API. Host objects (`$`, `app`, `Project`, ...) are
 *     out of scope — they are covered by the generated `ae-api.d.ts`
 *     typings in `check`, not by this lint. Absence from this table is
 *     NOT proof that a member exists in the real host.
 */

/** Globals that do not exist in the ES3 host at all (ES5+/ES6+). */
export const ABSENT_GLOBALS = new Set([
  "JSON", // ES5
  "Symbol", "Reflect", "Promise", "Map", "Set", "WeakMap", "WeakSet",
  "Proxy", "Intl", // ES6
  "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array",
  "Float64Array", "BigInt64Array", "BigUint64Array",
  "BigInt", "globalThis", "WeakRef", "FinalizationRegistry",
  "AggregateError",
]);

/**
 * ES5+ static/object members absent from the ES3 host, keyed by the
 * builtin object name. Only members introduced after ES3 are listed;
 * ES3 members of the same objects are intentionally absent from these
 * sets so they are never flagged. Prototype objects themselves
 * (`Array.prototype`, `Function.prototype`) are ES3 and are NOT listed.
 */
export const BUILTIN_ES5_MEMBERS = new Map([
  ["Object", new Set([
    "keys", "values", "entries", "getOwnPropertyNames",
    "getOwnPropertyDescriptor", "getPrototypeOf", "setPrototypeOf",
    "defineProperty", "defineProperties", "create", "freeze", "seal",
    "isFrozen", "isSealed", "isExtensible", "preventExtensions",
    "assign", "getOwnPropertySymbols",
  ])],
  ["Array", new Set(["isArray", "from", "of"])],
  ["Date", new Set(["now"])], // UTC/parse are ES3 — NOT listed
  ["Math", new Set([
    "trunc", "sign", "cbrt", "clz32", "imul", "fround",
    "log2", "log10", "expm1", "hypot", "log1p",
  ])],
  ["Number", new Set([
    "isFinite", "isInteger", "isNaN", "isSafeInteger",
    "parseFloat", "parseInt",
    "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON",
    "POSITIVE_INFINITY", "NEGATIVE_INFINITY",
  ])],
  ["String", new Set(["fromCodePoint", "raw"])], // fromCharCode is ES3
  ["Function", new Set(["bind"])],
]);

/**
 * Unambiguous ES5+ prototype method names. Flagged on ANY `.name(`
 * call regardless of receiver — ExtendScript ships no receiver with
 * these methods in ES3. `call`/`apply` are ES3 and excluded.
 * `indexOf` excluded: String ES3 vs Array ES5 ambiguity (see header).
 */
export const ES5_METHOD_NAMES = new Set([
  "forEach", "map", "filter", "reduce", "reduceRight", "some", "every",
  "find", "findIndex", "findLast", "findLastIndex",
  "trim", "trimLeft", "trimRight", "trimStart", "trimEnd",
  "bind",
]);

/**
 * ES3 ReservedWord set (ECMA-262 3rd ed. §7.5.3): Keyword +
 * FutureReservedWord + NullLiteral/BooleanLiteral names. Future
 * reserved words (`class`, `enum`, `export`, `extends`, `implements`,
 * `package`, `private`, `protected`, `public`, `static`, `super`,
 * `interface`, `native`, ... ) CANNOT be identifiers in ES3 even though
 * acorn accepts them — that is why this check exists.
 *
 * Deliberately NOT included: `let`, `yield`, `await`, `async` — these
 * became reserved only in ES2015+; `var let = 1` is legal ES3.
 */
export const ES3_RESERVED_WORDS = new Set([
  // Keyword
  "break", "case", "catch", "continue", "default", "delete", "do",
  "else", "finally", "for", "function", "if", "in", "instanceof",
  "new", "return", "switch", "this", "throw", "try", "typeof", "var",
  "void", "while", "with",
  // FutureReservedWord
  "abstract", "boolean", "byte", "char", "class", "const", "debugger",
  "double", "enum", "export", "extends", "final", "float", "goto",
  "implements", "import", "int", "interface", "long", "native",
  "package", "private", "protected", "public", "short", "static",
  "super", "synchronized", "throws", "transient", "volatile",
  // NullLiteral / BooleanLiteral names (cannot be identifiers either)
  "null", "true", "false",
]);

/**
 * Classify `ObjectName.member` access. Returns a reason string when the
 * access is absent from the ES3 host, or null when it is ES3-legal or
 * simply unknown (unknown = not flagged; this table only claims absences
 * it is confident about).
 */
export function classifyMemberAccess(objectName, memberName) {
  if (ABSENT_GLOBALS.has(objectName)) {
    return `'${objectName}' does not exist in the ExtendScript ES3 host (ES5+/ES6+ global)`;
  }
  const members = BUILTIN_ES5_MEMBERS.get(objectName);
  if (members?.has(memberName)) {
    return `'${objectName}.${memberName}' is an ES5+ builtin absent from ExtendScript ES3`;
  }
  return null;
}

/** True when `.name(` is an unambiguous ES5+ prototype method call. */
export function isEs5MethodCall(memberName) {
  return ES5_METHOD_NAMES.has(memberName);
}
