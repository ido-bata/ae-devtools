# node-server — runtime-bridge daemon stub

> Status: **Unverified end-to-end, but runnable on Linux without
> After Effects.** This is the smallest daemon half (M3) that
> satisfies the security mitigations from
> `docs/architecture/research/05-security.md` (bind `127.0.0.1` only;
   per-launch shared secret; constant-time comparison; 1 MiB body
   cap; graceful shutdown). It does **not** forward to a CEP panel
   in this stub; that wiring belongs to the real implementation,
   not the verification probes. See `../EXPERIMENT-LOG.md` Probe 10.

---

## What it does

- Listens on `127.0.0.1:$PORT` only. The default port is `7000`.
- Requires the env var `AE_BRIDGE_TOKEN` to start (a 256-bit
  shared-secret token). Refuses to start without it.
- Accepts `POST /eval` with a JSON body of shape
  `{ "id": "<request-id>", "source": "<extendscript-source>" }`.
- Returns
  `{ "status": "no_panel_attached", "id": "<request-id>",
     "note": "..." }` for valid token + valid JSON, with HTTP 200.
- Returns HTTP 401 `{ "error": "unauthorized" }` on missing or
  wrong token.
- Returns HTTP 400 `{ "error": "bad_request", "detail": "..." }`
  on invalid JSON.
- Returns HTTP 405 on non-POST.
- Returns HTTP 404 on non-`/eval` / non-`/healthz` paths.
- Exposes `GET /healthz` (token-exempt) for liveness checks.

---

## Run on Linux (no After Effects)

This server runs on Linux without AE. The probes that require AE
cannot run here; this stub does.

```
cd node-server
# Generate a 256-bit token, export it, start the server.
AE_BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') \
  PORT=7000 node server.js
```

In another shell:

```
# Health (no token required).
curl -sS -i http://127.0.0.1:7000/healthz
# Expect: HTTP/1.1 200 OK, {"status":"ok"}

# Missing token: expect 401.
curl -sS -i -X POST http://127.0.0.1:7000/eval -d '{}'

# Wrong token: expect 401.
curl -sS -i -X POST http://127.0.0.1:7000/eval \
  -H "X-AE-Bridge-Token: not-the-real-token" \
  -d '{}'

# Right token: expect 200 with stub payload.
curl -sS -i -X POST http://127.0.0.1:7000/eval \
  -H "X-AE-Bridge-Token: $AE_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"probe-10","source":"return JSON.stringify({version: app.version});"}'
# Expect: HTTP/1.1 200 OK,
#         {"status":"no_panel_attached","id":"probe-10","note":"..."}
```

The stub deliberately returns `"no_panel_attached"`; the **real**
daemon will, in addition to accepting this request, maintain a
separate channel to the CEP panel and forward the request's
`source` to it, returning the panel's response.

---

## Syntax check (no run)

```
node --check server.js
```

Should exit 0 with no output.

---

## Limitations

- No panel forwarding. This is a stub for the **external process
  half** of the bridge, not the bridge itself. The CEP-panel
  forwarding is part of the real implementation.
- No Origin allowlist (research/05 §Mitigations required, item 4).
  Real daemon will reject requests whose `Origin` header is not
  `null` or in an allowlist.
- No audit log (research/05 §Mitigations required, item 6). The
  stub writes to stderr only.
- No request timeout. Real daemon must enforce a deadline on each
  `evalScript` call because AE has no native timeout/cancel
  (research/01 §AE busy states).
- No body size limit beyond 1 MiB. Real daemon's limit will be
  smaller (ExtendScript source is typically < 64 KiB).
- Token comparison uses `crypto.timingSafeEqual`. Length match is
  short-circuited, which leaks the expected token length. Real
  daemon will hash both sides with a fixed-length function before
  comparison to remove that side channel.
