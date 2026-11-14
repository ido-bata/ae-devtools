/**
 * extension.mjs — HostExtension consumed by `ae-a8n extension build`.
 *
 * Declares exactly one method, `aeDevtools.trustedEval`, whose body evaluates
 * caller-supplied ExtendScript source inside the AE host and returns a
 * structured result. This is the experiment seam that lets the
 * trusted-execution runner (experiments/trusted-execution) reach a REAL AE
 * session through ae-a8n's owned-session `ae.call` path.
 *
 * Boundary (Issue #49, explicit non-claims):
 *   - the method source is fixed ES3, declared at host-script build time;
 *     what varies per call is `params.source`, gated client-side by the
 *     trusted-execution consent/permission pipeline — NOT by ae-a8n's
 *     production authorization (ae-a8n #97–#99 owns that);
 *   - this file must only ever be built into a host script for a session
 *     ae-a8n reports as `owned`. `ae.call` enforces ownership itself
 *     (`requireOwned`), so an attached/unknown host refuses before send;
 *   - eval-result serialization uses the SAME a8n-json codec the host
 *     protocol uses, loaded from beside the generated host script. Raw AE
 *     objects are returned as text, never traversed blindly: callers that
 *     need structure return a JSON string or primitives from their source.
 *
 * ES3 only — `ae-a8n extension build` parses with acorn ecmaVersion 3.
 */

const EVAL_METHOD_SOURCE = `function (params) {
  var requestId = "";
  var source = "";
  if (params !== null && params !== undefined) {
    if (params.requestId !== undefined && params.requestId !== null) {
      requestId = String(params.requestId);
    }
    if (params.source !== undefined && params.source !== null) {
      source = String(params.source);
    }
  }

  // Same codec the host protocol uses, loaded the same way a8n-host.js
  // loads it: $.evalFile returns the file's completion value, and the file
  // sits beside the generated host script ($.fileName's directory).
  var codec = null;
  try {
    codec = $.evalFile(new File($.fileName).parent.fsName + "/a8n-json.js");
  } catch (codecError) {
    codec = null;
  }
  if (codec === null || typeof codec.stringify !== "function") {
    codec = null;
  }

  var value;
  try {
    value = eval(source);
  } catch (evalError) {
    var name = "EvalError";
    var message = "unknown eval failure";
    var line = null;
    var file = null;
    try { if (evalError.name !== undefined) name = String(evalError.name); } catch (e1) {}
    try { if (evalError.message !== undefined) message = String(evalError.message); } catch (e2) {}
    try { if (evalError.line !== undefined) line = evalError.line; } catch (e3) {}
    try { if (evalError.file !== undefined) file = String(evalError.file); } catch (e4) {}
    return {
      requestId: requestId,
      ok: false,
      evalError: { name: name, message: message, line: line, file: file }
    };
  }

  // Result marshalling. Primitives pass through; objects/arrays are only
  // JSON-serialized when the codec accepts them — an AE object graph is
  // never handed to the serializer speculatively (hang/overflow risk), it
  // degrades to text instead. undefined becomes null so the reply shape is
  // stable.
  var valueType = typeof value;
  var resultJson = null;
  var valueText = null;
  var serialized = false;
  if (value === undefined || value === null) {
    serialized = true;
  } else if (valueType === "string" || valueType === "number" ||
             valueType === "boolean") {
    if (codec !== null) {
      try { resultJson = codec.stringify(value); serialized = true; } catch (e5) {}
    }
    if (!serialized) {
      try { valueText = String(value); } catch (e6) { valueText = null; }
      serialized = valueText !== null;
    }
  } else if (codec !== null) {
    // Objects and arrays: attempt codec serialization inside try/catch.
    // ExtendScript objects expose few own enumerable properties, so this
    // resolves quickly in practice; a stack overflow throws and is caught.
    try {
      resultJson = codec.stringify(value);
      serialized = true;
    } catch (e7) {
      serialized = false;
    }
  }
  if (!serialized) {
    try { valueText = String(value); } catch (e8) { valueText = null; }
  }
  return {
    requestId: requestId,
    ok: true,
    resultJson: serialized && resultJson !== null ? resultJson : null,
    valueText: valueText,
    valueType: valueType
  };
}`;

export default {
  name: "aedevtools",
  version: "0.1.0",
  methods: [
    { name: "aeDevtools.trustedEval", source: EVAL_METHOD_SOURCE },
  ],
};
