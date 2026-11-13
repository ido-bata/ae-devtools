/*
 * probe-json.js — minimal ES3 JSON codec for the read-only probe.
 *
 * Same problem as ae-a8n's host/a8n-json.js: ExtendScript is ES3 and ships
 * no JSON object, and the probe must not depend on caller-supplied code.
 * This is the read-only-probe's own copy (issue #13 scope: only
 * experiments/read-only-probe/** is edited), kept dependency-free and
 * small: parse is not needed for full ECMAScript fidelity, only for the
 * envelopes this probe itself writes (flat objects, string/number/bool,
 * one nesting level of params/result).
 *
 * It feature-detects a native JSON first (in case a future AE ships one),
 * exactly like the ae-a8n host script does.
 */
var ProbeJson = (function () {
  var api = {};

  // ExtendScript's Object.prototype carries non-enumerable members — among
  // them functions named "+", "-", "*" and "/" (observed on AE 26.5x89) —
  // so a plain `table[key]` finds one for any of those characters. Key
  // lookups on data go through has(), exactly like ae-a8n's a8n-json.js.
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

  function stringify(value, depth) {
    if (depth > 12) { return "null"; }
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
          arrOut.push(stringify(value[i], depth + 1));
        }
        return "[" + arrOut.join(",") + "]";
      }
      case "[object Date]":
        return stringOf(value.toString());
      default: {
        // Objects with a meaningful toString (ExtendScript does this for
        // File/Folder and others) must not explode the encoder. Only plain
        // object shapes are serialized structurally; anything else is the
        // string form, audited to contain no control characters.
        var keys = [];
        var k;
        for (k in value) {
          if (value.hasOwnProperty(k) &&
              typeof value[k] !== "function" && value[k] !== undefined) {
            keys.push(k);
          }
        }
        if (keys.length === 0 && Object.prototype.toString.call(value) !== "[object Object]") {
          return stringOf(String(value));
        }
        var objOut = [];
        for (k = 0; k < keys.length; k++) {
          objOut.push(stringOf(keys[k]) + ":" + stringify(value[keys[k]], depth + 1));
        }
        return "{" + objOut.join(",") + "}";
      }
    }
  }

  // Parser: strict subset (no comments, no NaN/Infinity, no implicit
  // octal). Depth-bounded to avoid pathological inputs; failures throw so
  // the dispatcher refuses the request instead of guessing.
  function parse(text) {
    var pos = 0;
    text = String(text);
    function fail(msg) {
      throw new Error("probe-json parse error at " + pos + ": " + msg);
    }
    function skip() {
      while (pos < text.length) {
        var c = text.charAt(pos);
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { pos++; }
        else { break; }
      }
    }
    function readString() {
      if (text.charAt(pos) !== '"') { fail("expected string"); }
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
          else { fail("bad escape"); }
        } else {
          out += c;
          pos++;
        }
      }
      fail("unterminated string");
      return null;
    }
    function readValue(depth) {
      if (depth > 12) { fail("too deep"); }
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
          if (text.charAt(pos) !== ":") { fail("expected colon"); }
          pos++;
          obj[key] = readValue(depth + 1);
          skip();
          if (text.charAt(pos) === ",") { pos++; continue; }
          if (text.charAt(pos) === "}") { pos++; return obj; }
          fail("bad object");
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
          fail("bad array");
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
      fail("unexpected token");
      return null;
    }
    var value = readValue(0);
    skip();
    if (pos !== text.length) { fail("trailing characters"); }
    return value;
  }

  if (typeof JSON !== "undefined" && JSON !== null &&
      typeof JSON.stringify === "function" &&
      typeof JSON.parse === "function") {
    api.stringify = function (v) { return JSON.stringify(v); };
    api.parse = function (s) { return JSON.parse(s); };
  } else {
    api.stringify = function (v) { return stringify(v, 0); };
    api.parse = parse;
  }
  return api;
})();
// The completion value, so `$.evalFile` returns the codec (same trick as
// ae-a8n's a8n-json.js). In Node/vm the top-level var is visible, and a
// real AE scopes included-file vars to the calling function.
ProbeJson;

