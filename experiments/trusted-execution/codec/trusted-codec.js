/*
 * trusted-codec.js — ES3 strict codec for trusted execution (Issue #14,
 * CAP026; design note specs/ae-capability-coverage/design/trusted-execution.md §2).
 *
 * Two layers:
 *
 *   TrustedJson    — JSON parse/stringify for the ES3 host. ExtendScript
 *                    ships no JSON object; this is the dispatcher's own
 *                    codec (same pattern as the read-only probe's
 *                    probe-json.js — each host script carries its own
 *                    copy). Feature-detects a native JSON first.
 *
 *   TrustedCodec   — the trusted-execution value domain on top of JSON:
 *                    serializable set is exactly null / boolean / finite
 *                    number / string / array / plain object. Host objects
 *                    (Project, Comp, Layer, Property, Item) are NEVER
 *                    exported — callers must wrap them in the ae* markers
 *                    below first. Anything else throws; the host refuses
 *                    the request instead of guessing.
 *
 * Wire wrappers (plain objects, versioned by marker key):
 *
 *   {"aeRef":  {"type": "<typeTag>", "name": "<str>",
 *               "path": [<int>, ...], "contentHash": "<str>"?}}
 *       stable identity descriptor for a host object — never a live handle.
 *       `path` is the index path from the project root; resolution failure
 *       at dispatch time is STALE_REFERENCE, not re-resolution.
 *   {"aeEnum": {"name": "<str>", "value": <number>}}
 *       enum-like value: string name plus observed numeric value so version
 *       skew is detectable rather than silently coerced.
 *   {"aePath": {"path": "<posix-style>", "pathKind":
 *               "project-item" | "filesystem" | "absolute"}}
 *       `absolute` filesystem paths require the write class and are
 *       recorded in trace.
 *   {"aeError":{"name": "<str>", "message": "<str>",
 *               "line": <int>?, "file": "<str>"?}}
 *       host exception with source-map position when available; missing
 *       position fields stay absent — they are not fabricated.
 *
 * ES3 only: var, no JSON assumption, no Array.isArray / Object.keys.
 * The completion value is the codec so $.evalFile returns it (same trick
 * as probe-json.js / ae-a8n a8n-json.js).
 */
var TrustedCodec = (function () {
  var api = {};

  // ExtendScript's Object.prototype carries non-enumerable members — among
  // them functions named "+", "-", "*" and "/" (observed on AE 26.5x89) —
  // so a plain `table[key]` finds one for those characters. Key lookups
  // on data go through has(), exactly like the probe codec.
  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function typeOf(value) {
    return Object.prototype.toString.call(value);
  }

  function esc(string) {
    var out = "";
    var i;
    for (i = 0; i < string.length; i++) {
      var c = string.charAt(i);
      var code = string.charCodeAt(i);
      if (c === '"') { out += '\\"'; }
      else if (c === "\\") { out += "\\\\"; }
      else if (c === "\n") { out += "\\n"; }
      else if (c === "\r") { out += "\\r"; }
      else if (c === "\t") { out += "\\t"; }
      else if (code < 32) {
        var hex = code.toString(16);
        while (hex.length < 4) { hex = "0" + hex; }
        out += "\\u" + hex;
      } else if (code > 126 && code < 160) {
        out += " ";
      } else if (code > 55295 && (code < 57344 || code > 65533)) {
        out += "?"; // lone surrogate / noncharacter: never emit raw
      } else {
        out += c;
      }
    }
    return out;
  }

  function stringOf(value) {
    return '"' + esc(String(value)) + '"';
  }

  var MAX_DEPTH = 12;

  // ------------------------------------------------------------------
  // Strict value domain (trusted-execution serializable set)
  // ------------------------------------------------------------------

  function fail(message) {
    throw new Error("trusted-codec: " + message);
  }

  function isPlainObject(value) {
    return typeOf(value) === "[object Object]";
  }

  // Marker keys that carry domain wrappers. A plain object may contain at
  // most one of these keys at its top level.
  var MARKERS = ["aeRef", "aeEnum", "aePath", "aeError"];

  function markerOf(value) {
    var found = null;
    var i;
    for (i = 0; i < MARKERS.length; i++) {
      if (has(value, MARKERS[i])) {
        if (found !== null) { fail("object carries two ae* markers"); }
        found = MARKERS[i];
      }
    }
    return found;
  }

  function assertMarker(marker, value, required, optional) {
    var inner = value[marker];
    if (!isPlainObject(inner)) { fail(marker + " wrapper must be a plain object"); }
    var key;
    for (key in inner) {
      if (!has(inner, key)) { continue; }
      var ok = false;
      for (var r = 0; r < required.length; r++) {
        if (required[r] === key) { ok = true; }
      }
      if (!ok) {
        for (var o = 0; o < optional.length; o++) {
          if (optional[o] === key) { ok = true; }
        }
      }
      if (!ok) { fail(marker + " wrapper has unexpected field " + key); }
    }
    for (var q = 0; q < required.length; q++) {
      if (!has(inner, required[q])) {
        fail(marker + " wrapper missing field " + required[q]);
      }
    }
    return inner;
  }

  function assertString(v, what) {
    if (typeof v !== "string") { fail(what + " must be a string"); }
  }

  function assertFiniteNumber(v, what) {
    if (typeof v !== "number" || !isFinite(v)) {
      fail(what + " must be a finite number");
    }
  }

  // Validate one wrapper object (already known to carry `marker`).
  function assertWrapper(value, depth) {
    var marker = markerOf(value);
    if (marker === null) { return; }
    if (depth > MAX_DEPTH) { fail("nesting too deep"); }
    // A wrapper object has exactly one own enumerable key: the marker.
    var ownCount = 0;
    for (var k in value) {
      if (has(value, k)) { ownCount++; }
    }
    if (ownCount !== 1) {
      fail("ae* wrapper must be the object's only field");
    }
    if (marker === "aeRef") {
      var ref = assertMarker(marker, value,
        ["type", "name", "path"], ["contentHash"]);
      assertString(ref.type, "aeRef.type");
      assertString(ref.name, "aeRef.name");
      if (typeOf(ref.path) !== "[object Array]") {
        fail("aeRef.path must be an array of indices");
      }
      for (var i = 0; i < ref.path.length; i++) {
        if (typeof ref.path[i] !== "number" || !isFinite(ref.path[i]) ||
            Math.floor(ref.path[i]) !== ref.path[i] || ref.path[i] < 0) {
          fail("aeRef.path entries must be non-negative integers");
        }
      }
      if (has(ref, "contentHash")) { assertString(ref.contentHash, "aeRef.contentHash"); }
    } else if (marker === "aeEnum") {
      var en = assertMarker(marker, value, ["name", "value"], []);
      assertString(en.name, "aeEnum.name");
      assertFiniteNumber(en.value, "aeEnum.value");
    } else if (marker === "aePath") {
      var p = assertMarker(marker, value, ["path", "pathKind"], []);
      assertString(p.path, "aePath.path");
      if (p.pathKind !== "project-item" && p.pathKind !== "filesystem" &&
          p.pathKind !== "absolute") {
        fail("aePath.pathKind must be project-item | filesystem | absolute");
      }
    } else if (marker === "aeError") {
      var e = assertMarker(marker, value, ["name", "message"], ["line", "file"]);
      assertString(e.name, "aeError.name");
      assertString(e.message, "aeError.message");
      if (has(e, "line")) { assertFiniteNumber(e.line, "aeError.line"); }
      if (has(e, "file")) { assertString(e.file, "aeError.file"); }
    }
    // Wrapper payloads are already fully validated above; no recursion into
    // arbitrary nested host objects is needed.
  }

  // Recursive serializable-set check used before stringify.
  function assertSerializable(value, depth) {
    if (depth > MAX_DEPTH) { fail("nesting too deep"); }
    if (value === null) { return; }
    switch (typeOf(value)) {
      case "[object Undefined]":
        fail("undefined is not serializable");
        break;
      case "[object String]":
      case "[object Boolean]":
        return;
      case "[object Number]":
        if (!isFinite(value)) { fail("non-finite number is not serializable"); }
        return;
      case "[object Array]": {
        var i;
        for (i = 0; i < value.length; i++) {
          assertSerializable(value[i], depth + 1);
        }
        return;
      }
      case "[object Object]": {
        if (markerOf(value) !== null) { assertWrapper(value, depth); return; }
        var k;
        for (k in value) {
          if (!has(value, k)) { continue; }
          var v = value[k];
          if (typeof v === "function") {
            fail("function value for key " + k + " is not serializable");
          }
          assertSerializable(v, depth + 1);
        }
        return;
      }
      default:
        // Date, host objects (Project/Comp/Layer/Property/Item/File/Folder),
        // ExtendScript host types: none may cross the wire. Wrap host
        // objects in aeRef first.
        fail("value of type " + typeOf(value) +
             " is not serializable; wrap host objects in aeRef");
    }
  }

  // ------------------------------------------------------------------
  // JSON engine (adapted from experiments/read-only-probe/host/probe-json.js)
  // ------------------------------------------------------------------

  function stringifyJson(value, depth) {
    if (depth > MAX_DEPTH) { return "null"; }
    if (value === null || value === undefined) { return "null"; }
    switch (typeOf(value)) {
      case "[object String]": return stringOf(value);
      case "[object Number]":
        return isFinite(value) ? String(value) : "null";
      case "[object Boolean]": return value ? "true" : "false";
      case "[object Array]": {
        var arrOut = [];
        var i;
        for (i = 0; i < value.length; i++) {
          arrOut.push(stringifyJson(value[i], depth + 1));
        }
        return "[" + arrOut.join(",") + "]";
      }
      case "[object Date]":
        return stringOf(value.toString());
      default: {
        var keys = [];
        var k;
        for (k in value) {
          if (has(value, k) &&
              typeof value[k] !== "function" && value[k] !== undefined) {
            keys.push(k);
          }
        }
        if (keys.length === 0 && typeOf(value) !== "[object Object]") {
          return stringOf(String(value));
        }
        var objOut = [];
        for (k = 0; k < keys.length; k++) {
          objOut.push(stringOf(keys[k]) + ":" + stringifyJson(value[keys[k]], depth + 1));
        }
        return "{" + objOut.join(",") + "}";
      }
    }
  }

  function parseJson(text) {
    var pos = 0;
    text = String(text);
    function perr(msg) {
      throw new Error("trusted-codec parse error at " + pos + ": " + msg);
    }
    function skip() {
      while (pos < text.length) {
        var c = text.charAt(pos);
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { pos++; }
        else { break; }
      }
    }
    function readString() {
      if (text.charAt(pos) !== '"') { perr("expected string"); }
      pos++;
      var out = "";
      while (pos < text.length) {
        var c = text.charAt(pos);
        if (c === '"') { pos++; return out; }
        if (c === "\\") {
          pos++;
          var e = text.charAt(pos);
          if (e === "u") {
            out += String.fromCharCode(parseInt(text.substr(pos + 1, 4), 16));
            pos += 5;
          } else if (e === "n") { out += "\n"; pos++; }
          else if (e === "r") { out += "\r"; pos++; }
          else if (e === "t") { out += "\t"; pos++; }
          else if (e === "b") { out += "\b"; pos++; }
          else if (e === "f") { out += "\f"; pos++; }
          else if (e === '"') { out += '"'; pos++; }
          else if (e === "\\") { out += "\\"; pos++; }
          else if (e === "/") { out += "/"; pos++; }
          else { perr("bad escape"); }
        } else {
          out += c;
          pos++;
        }
      }
      perr("unterminated string");
      return null;
    }
    function readValue(depth) {
      if (depth > MAX_DEPTH) { perr("too deep"); }
      skip();
      var c = text.charAt(pos);
      if (c === "{") {
        pos++;
        var obj = {};
        skip();
        if (text.charAt(pos) === "}") { pos++; return obj; }
        while (true) {
          skip();
          var key = readString();
          skip();
          if (text.charAt(pos) !== ":") { perr("expected colon"); }
          pos++;
          obj[key] = readValue(depth + 1);
          skip();
          if (text.charAt(pos) === ",") { pos++; continue; }
          if (text.charAt(pos) === "}") { pos++; return obj; }
          perr("bad object");
        }
      }
      if (c === "[") {
        pos++;
        var arr = [];
        skip();
        if (text.charAt(pos) === "]") { pos++; return arr; }
        while (true) {
          arr.push(readValue(depth + 1));
          skip();
          if (text.charAt(pos) === ",") { pos++; continue; }
          if (text.charAt(pos) === "]") { pos++; return arr; }
          perr("bad array");
        }
      }
      if (c === '"') { return readString(); }
      if (text.substr(pos, 4) === "true") { pos += 4; return true; }
      if (text.substr(pos, 5) === "false") { pos += 5; return false; }
      if (text.substr(pos, 4) === "null") { pos += 4; return null; }
      var numMatch = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(
        text.substring(pos));
      if (numMatch && numMatch[0].length > 0) {
        pos += numMatch[0].length;
        return Number(numMatch[0]);
      }
      perr("unexpected token");
      return null;
    }
    var value = readValue(0);
    skip();
    if (pos !== text.length) { perr("trailing characters"); }
    return value;
  }

  var json = {};
  if (typeof JSON !== "undefined" && JSON !== null &&
      typeof JSON.stringify === "function" &&
      typeof JSON.parse === "function") {
    json.stringify = function (v) { return JSON.stringify(v); };
    json.parse = function (s) { return JSON.parse(s); };
  } else {
    json.stringify = function (v) { return stringifyJson(v, 0); };
    json.parse = parseJson;
  }
  api.json = json;

  // Strict stringify: validate the serializable set first, then encode.
  // Non-conforming values throw — the host refuses rather than coercing.
  api.stringify = function (value) {
    assertSerializable(value, 0);
    return json.stringify(value);
  };
  api.parse = function (text) {
    var value = json.parse(text);
    // Parsed wire data may contain ae* wrappers; validate their shape so a
    // malformed wrapper is refused here, not misinterpreted downstream.
    assertWireShape(value, 0);
    return value;
  };

  // Walk parsed data and validate every ae* wrapper shape. Plain data is
  // unchecked (JSON parse already guarantees the JSON domain).
  function assertWireShape(value, depth) {
    if (depth > MAX_DEPTH) { fail("nesting too deep"); }
    if (value === null) { return; }
    if (typeOf(value) === "[object Array]") {
      var i;
      for (i = 0; i < value.length; i++) {
        assertWireShape(value[i], depth + 1);
      }
      return;
    }
    if (typeOf(value) !== "[object Object]") { return; }
    if (markerOf(value) !== null) { assertWrapper(value, depth); return; }
    for (var k in value) {
      if (has(value, k)) { assertWireShape(value[k], depth + 1); }
    }
  }

  // ------------------------------------------------------------------
  // Domain constructors — the only sanctioned way to build wrappers.
  // ------------------------------------------------------------------

  api.ref = function (type, name, path, contentHash) {
    var r = { type: String(type), name: String(name), path: path };
    if (contentHash !== undefined && contentHash !== null) {
      r.contentHash = String(contentHash);
    }
    return { aeRef: r };
  };

  // `enum` is a reserved word in ES3 — the constructor is `enumValue`.
  api.enumValue = function (name, value) {
    return { aeEnum: { name: String(name), value: value } };
  };

  api.path = function (path, pathKind) {
    return { aePath: { path: String(path), pathKind: String(pathKind) } };
  };

  api.error = function (name, message, line, file) {
    var e = { name: String(name), message: String(message) };
    if (line !== undefined && line !== null) { e.line = line; }
    if (file !== undefined && file !== null) { e.file = String(file); }
    return { aeError: e };
  };

  api.MARKERS = MARKERS;
  return api;
})();
// Completion value so $.evalFile returns the codec (probe-json.js trick).
TrustedCodec;
