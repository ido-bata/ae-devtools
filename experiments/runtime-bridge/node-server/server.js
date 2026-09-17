/*
 * server.js — minimal HTTP loopback server with auth-token check.
 *
 * Status: UNVERIFIED end-to-end, but SYNTAX-CHECKABLE on Linux
 * without After Effects. This file is the "external daemon half"
 * (M3) of the runtime bridge. It binds 127.0.0.1 only and requires
 * a per-launch shared-secret token in the `X-AE-Bridge-Token`
 * header.
 *
 * What this server does NOT do (and that is intentional for the v1
 * stub):
 *   - It does not maintain a WebSocket or persistent connection to a
 *     CEP panel. The real daemon will speak both HTTP (for the
 *     daemon contract) and a separate channel to the panel. That
 *     wiring is part of the actual implementation, not the
 *     verification probes.
 *   - It does not enforce Origin / Host allowlists. Those are part
 *     of research/05-security.md mitigations and belong to the
 *     real daemon.
 *   - It does not log to disk. Audit log is a research/05
 *     mitigation; the stub prints to stderr only.
 *
 * Run:
 *   cd node-server
 *   AE_BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') \
 *     PORT=7000 node server.js
 *
 * Probe (in another shell):
 *   curl -sS -i -X POST http://127.0.0.1:7000/eval \
 *     -H "Content-Type: application/json" \
 *     -H "X-AE-Bridge-Token: $AE_BRIDGE_TOKEN" \
 *     -d '{"id":"probe-10","source":"return JSON.stringify({version: app.version});"}'
 *
 * Expected response: HTTP 200 with a JSON body like
 *   { "status": "no_panel_attached", "id": "probe-10" }
 *
 * Misuse:
 *   curl -sS -i -X POST http://127.0.0.1:7000/eval -d '{}'
 * Expected: HTTP 401 with { "error": "unauthorized" }.
 */
"use strict";

var http = require("http");
var crypto = require("crypto");

var PORT = parseInt(process.env.PORT, 10) || 7000;
var HOST = "127.0.0.1"; // loopback only; never 0.0.0.0
var EXPECTED_TOKEN = process.env.AE_BRIDGE_TOKEN || "";

if (!EXPECTED_TOKEN) {
  // Refuse to start without a token rather than silently fall back.
  // This matches research/05-security.md §Mitigations required,
  // item 1 (per-launch shared secret).
  process.stderr.write(
    "[server] AE_BRIDGE_TOKEN env var is required. Refusing to start.\n"
  );
  process.exit(2);
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    var LIMIT = 1024 * 1024; // 1 MiB hard cap; ExtendScript probes
                              // are small JSON strings.
    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > LIMIT) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      var raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("invalid json: " + e.message));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  var json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json)
  });
  res.end(json);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  var ab = Buffer.from(a, "utf8");
  var bb = Buffer.from(b, "utf8");
  return crypto.timingSafeEqual(ab, bb);
}

var server = http.createServer(function (req, res) {
  if (req.method !== "POST") {
    send(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (req.url !== "/eval" && req.url !== "/healthz") {
    send(res, 404, { error: "not_found" });
    return;
  }

  // /healthz is intentionally exempt from token check so a bare curl
  // can probe the listener. It does not return any privileged data.
  if (req.url === "/healthz") {
    send(res, 200, { status: "ok" });
    return;
  }

  var presented = req.headers["x-ae-bridge-token"];
  if (typeof presented !== "string" || !timingSafeEqualStr(presented, EXPECTED_TOKEN)) {
    send(res, 401, { error: "unauthorized" });
    return;
  }

  readJsonBody(req)
    .then(function (body) {
      // Stub behavior: do NOT forward to a panel; return a structured
      // "no_panel_attached" payload so the contract shape is
      // observable without AE.
      send(res, 200, {
        status: "no_panel_attached",
        id: body && typeof body.id === "string" ? body.id : null,
        note:
          "Stub server. Real daemon forwards `body.source` to a CEP panel " +
          "via a separate channel and returns the evalScript callback result."
      });
    })
    .catch(function (err) {
      send(res, 400, { error: "bad_request", detail: String(err && err.message) });
    });
});

server.listen(PORT, HOST, function () {
  process.stderr.write(
    "[server] listening on http://" + HOST + ":" + PORT +
    " (token-checked; /healthz exempt)\n"
  );
});

// Graceful shutdown.
function shutdown(signal) {
  process.stderr.write("[server] received " + signal + ", closing.\n");
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 5000).unref();
}
process.on("SIGINT", function () { shutdown("SIGINT"); });
process.on("SIGTERM", function () { shutdown("SIGTERM"); });
