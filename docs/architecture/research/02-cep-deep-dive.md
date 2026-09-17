# CEP Capabilities and Constraints

> Research document for the ae-devtools project. Source-quality rules below:
> Adobe-official sources (developer.adobe.com, github.com/Adobe-CEP, blog.developer.adobe.com)
> are treated as authoritative; pre-2022 third-party articles are flagged where used.
> Items that cannot be verified from current Adobe documentation are listed under
> **Unverified items** at the end.

---

## Current AE / CEP version mapping

After Effects hosts CEP (Common Extensibility Platform, formerly "Creative Cloud
Extensibility Platform") as a Chromium Embedded Framework (CEF) panel runtime.
Adobe maps a specific CEP version to each host application version.

AE / CEP integration matrix (as understood on 2026-09-18; each row graded for
source quality per `research/corrections-02`):

| After Effects | Version number | CEP version integrated | Verdict |
| ------------- | -------------- | ---------------------- | ------- |
| 2022          | 22.x           | CEP 11                 | **Not Cookbook-listed, inferred from FY2021 baseline (AE 18.4 → CEP 11).** The CEP 12 Cookbook jumps from AE 18.4 (FY2021, CEP 11) directly to AE 25.0 (FY2024, CEP 12) with no AE 22.x or 23.x row. The mapping is the most plausible reading of the table's silence. |
| 2023          | 23.x           | CEP 11                 | **Not Cookbook-listed, inferred from FY2021 baseline.** Same gap as 22.x. |
| 2024          | 24.x           | CEP 11 (community-attributed) | **NOT Cookbook-confirmed.** The CEP 12 Cookbook contains no AE 24.x row. The strongest evidence is third-party (`elevenpercent.net` AutoEdit help docs): "enable debugging for CEP 11 (2024) or CEP 12 (2025)" — i.e. AE 2024 (= 24.x) ships with CEP 11 and AE 2025 (= 25.x) ships with CEP 12. The working hypothesis is **AE 24.x → CEP 11**, not CEP 12. Until Adobe publishes a CEP 11.x / 12.x cookbook that includes an AE 24.x row, this remains community-attributed. |
| 2025          | 25.x           | CEP 12                 | **Cookbook-confirmed.** Per CEP 12 Cookbook "Applications Integrated with CEP" table, FY2024 column: `AEFT 25.0 (CEP 12)`. AE 25.0 was released October 2024. |
| 2026          | 26.x           | CEP 12 (undocumented)  | **Undocumented in materials examined.** AE 26.x is a real product line; whether it ships CEP 12 or a future CEP 13 is not stated in the CEP 12 Cookbook or any other Adobe primary source consulted here. Prior research's "no CEP 13 confirmed" should be read as "no CEP 13 evidence found in the sources consulted". |

Adobe's `CEP 12 HTML Extension Cookbook` lists `AEFT 25.0` as the After Effects
host that integrates CEP 12; no AE 22.x / 23.x / 24.x / 26.x rows appear in the
table. There is **no evidence of a CEP 13 release** for any After Effects
version in the materials examined as of 2026-09-18; issues filed against
`Adobe-CEP/CEP-Resources` requesting CEP 13 remain open.

**CEP 12 vs CEP 11 — what changed (Adobe official):**

- CEF upgraded to **Chromium 99** (CEF 3 branch 99, V8 9.9.115).
- Node.js embedded is **Node.js 17.7.1** with **node-webkit 0.62.1**, gated by the
  CEF `--enable-nodejs` command-line parameter.
- CORS is **strictly enforced** by default (same enforcement as a stock
  Chromium browser). The previous "lenient cross-origin" behavior of earlier
  CEP versions is gone.
- Cookie attributes (`SameSite=None`, `Secure`) are now required for
  third-party cookies; a workaround CEF flag
  (`--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,NetworkService`)
  is documented for development only.
- `CSInterface.evalScript` callback behavior changed in CEP 11: callbacks from
  nested iframes are no longer reliably delivered (Adobe-CEP issue #364),
  likely tied to CSP tightening.

For projects that must support After Effects 2022 and 2023, CEP 11 is the
minimum target. CEP 12-only features (CORS-strict-by-default, Node 17.7.1
APIs) must be feature-detected if the extension is to load in both host
versions.

---

## Execution primitives

### CSInterface

`CSInterface` is the JavaScript bridge shipped by Adobe that runs **inside
the CEP HTML panel**. The `CSInterface.js` file must be included in the
extension's HTML panel; `CEPEngine_extensions.js` is provided by the host.

Key entry points (Adobe official `CSInterface` reference):

- `evalScript(script, callback)` — run an ExtendScript snippet in the host
  application's ExtendScript engine and deliver the return value to a
  callback on the panel side.
- `requestOpenExtension(extensionId)` — programmatically request the host to
  open another panel.
- `addEventListener(type, listener, dispatchImmediately)` — listen for host
  events such as `com.adobe.csxs.events.WindowStateChanged`,
  `com.adobe.csxs.events.ApplicationActivated`, theme/color-theme changes.
- `getSystemPath(pathKey)` — resolve CEP system paths (extension folder,
  user data, temp).
- `getHostEnvironment()` — returns JSON describing the host application
  name, version, and locale.
- `getCurrentApiVersion()` — retrieves the **CEP engine version** integrated
  by the host, **not the host application version** and **not a single
  numeric version**. Source: `Adobe-CEP/CEP-Resources/CEP_12.x/CSInterface.js`
  (header version `CSInterface - v12.0.0`); the wrapper calls
  `JSON.parse(window.__adobe_cep__.getCurrentApiVersion())` and returns an
  `ApiVersion` object with three numeric fields: `{major, minor, micro}`.
  For a CEP 12 host the return is e.g. `{major: 12, minor: 0, micro: 0}`;
  for CEP 11 it would be `{major: 11, minor: 1, micro: 0}` (or whatever
  build the host ships). The encoding is an object with three numeric
  fields, **not** a string like `"12.0"` and **not** a single number.
  Correct usage: compare `apiVersion.major` directly; do not rely on
  `CSInterface.VERSION_11` / `CSInterface.VERSION_12` constants, which are
  **not** defined on the current shipped `CSInterface` prototype or class
  (multiple passes of `CSInterface.js` v12.0.0 and the community TypeScript
  port `csinterface-ts@1.0.3` confirm this). This API has existed since
  CSInterface 4.2.0; on CEP 4.0 / 4.1 hosts the call does not exist and
  extensions targeting those hosts must use `manifest.xml` `RequiredRuntime`
  instead.

### evalScript signature (Adobe official)

```
CSInterface.prototype.evalScript = function(script, callback)
```

- `script` is a **string** containing ExtendScript source.
- `callback` is **optional**. If provided, it receives the result of the
  ExtendScript evaluation as a **single argument** (a string when the
  ExtendScript code returned a string, or `undefined` for void results).
- On evaluation failure the callback receives the string returned by
  ExtendScript's `EvalScript_ErrMessage()`.
- The script runs **on the main thread of the host application's
  ExtendScript engine**, not in the panel's V8 context.
- The call is **asynchronous from the panel's perspective**: the callback is
  fired via a CEP event pump.

Practical consequences:

- `evalScript` is **string-only**. To pass complex objects, the panel side
  must `JSON.stringify` and the ExtendScript side must `JSON.parse` (or use
  ExtendScript's built-in serializer). Adobe's `CEP Panels and JSON Objects`
  article covers the pattern.
- There is no synchronous variant. Code that depends on ExtendScript return
  values must continue through the callback chain (or use a Promise wrapper
  around `evalScript`).
- Nested-iframe callbacks broke in CEP 11; on AE 24+ extensions should call
  `evalScript` only from the panel's **top-level frame**.

### CEPEngine_extensions.js

This file is provided by the host at runtime; the panel can call its
functions (e.g. `CEPEngine_extensions.getApp()`) but the API surface is
small and version-dependent. Most extensions only need `CSInterface`.

### Vulcan.js

Vulcan is Adobe's bridge used when the panel needs to communicate with
other Adobe extension panels in the same host. It is not used for talking
to After Effects ExtendScript — that path goes through `CSInterface.evalScript`.

---

## Node.js availability

Node.js in CEP 12 is **embedded inside the panel's Chromium process**, not
a separate Node process. It is enabled at host startup by passing
`--enable-nodejs` to the CEF command line (Adobe distributes the binary as
`CEPHtmlEngine.exe` on Windows, `CEPHtmlEngine` on macOS).

Access pattern (Adobe official Cookbook):

- The global object exposed to panel JavaScript is **`cep_node`**.
- `cep_node` exposes `Buffer`, `global`, `process`, and `require`.
- Node globals are **only available in the main frame** by default. To make
  them available in every iframe, the CEF flag `--mixed-context` must also
  be passed.
- **Node version is fixed at 17.7.1** (Node-WebKit 0.62.1). This is several
  years behind current Node LTS; modern Node 18+/20+/22+ APIs are not
  available.

### Limitations observed

- Many third-party npm modules fail to install or load inside CEP because
  they target current Node ABI versions, use native bindings, or rely on
  features removed in Node 17. The Adobe community regularly reports
  modules like `exiftool-vendored` failing to load.
- Native modules (anything requiring `node-gyp`) are not supported.
- The Node context shares Chromium's process; a crashing module can take
  the panel down.
- There is no `fs` access outside the extension's sandboxed folder (the
  CEF sandbox applies), and no `child_process` spawning of arbitrary
  binaries.

For the ae-devtools project this means: if a CEP panel needs to talk to a
sidecar process, the sidecar must be **launched externally** (e.g. by an
OS-level launcher or by ExtendScript using `system.callSystem()`), and the
panel must connect over a documented IPC channel (TCP socket, WebSocket,
named pipe).

---

## Network and IPC capabilities

### Browser-side (panel V8) network access

The panel runs in CEF/Chromium 99 and is subject to the same web platform
constraints as a stock browser:

- **Same-origin policy** is enforced. Cross-origin XHR / `fetch` requires
  the remote server to return proper CORS headers
  (`Access-Control-Allow-Origin`, etc.).
- **Mixed content** is blocked by default (HTTPS panel cannot fetch HTTP).
- **Cookies** are subject to Chromium's `SameSite` rules. Cross-site
  cookies require `SameSite=None; Secure`.

The CEF `--disable-web-security` flag exists but is **not** an officially
supported configuration and may break with CEF updates.

### Connect-out (panel → external)

The panel can open outbound TCP / WebSocket connections to a local
daemon using:

- Standard browser `fetch` / `XMLHttpRequest` (subject to CORS).
- `cep_node.require('net')` for raw TCP clients/servers.
- `cep_node.require('ws')` or similar for WebSocket (must be bundled with
  the extension — see limitations above).

Outbound to **`localhost`** is the most common pattern: the panel connects
to a Node.js / Python / Rust daemon the user started on a known port. No
official Adobe documentation forbids this; it is the standard pattern for
extensions that need capabilities the CEP sandbox cannot provide.

### Server-in-panel (panel opens a port, external connects in)

This is **feasible** because the panel has access to `cep_node.require('net')`
and can `net.createServer(...)` on a chosen port. Practical caveats:

- The port must not collide with ports the host or other extensions
  reserve (debugging ports, system services).
- On macOS the system firewall may prompt the user the first time the
  port opens.
- The Adobe documentation does not explicitly bless or forbid this; it is
  considered an internal implementation detail. Extensions that rely on
  it should choose ports above 49152 and document the choice clearly.

### Connect-in via ExtendScript Socket

ExtendScript has a built-in **`Socket`** object (TCP only, no SSL/TLS, no
UDP). It supports `open(host, port)`, `close()`, `read()`, `write()`,
`listen(port)`, `poll()`. This is older, synchronous, and limited — it is
**not recommended** for new work, but it does exist for code that runs
without CEP.

### Network summary

| Direction | Path                                  | Constraints                           |
| --------- | ------------------------------------- | ------------------------------------- |
| Panel → external HTTP/HTTPS | `fetch` / XHR          | CORS required from remote             |
| Panel → external TCP/WS     | `cep_node.require('net'/'ws')` | Module must work under Node 17.7.1 |
| External → panel TCP/WS     | `cep_node.require('net')` + `createServer` | Port choice is yours; document it   |
| ExtendScript → external TCP | `$.socket`              | Plain TCP only, blocking              |

---

## Extension lifecycle

### Load timing

CEP panels are **user-launched**. The lifecycle is:

1. User installs the extension (`.zxp` via Adobe Extension Manager / CLI,
   or a developer-mode install to a CEP extension folder).
2. The extension appears in the host's `Window > Extensions` menu after
   the host is restarted.
3. The user clicks the menu entry. **Only then** does the host launch
   `CEPHtmlEngine` and load the panel's `index.html`.
4. When the panel window is closed by the user, the panel process is
   torn down. CEP **does not have a persistent background mode** —
   there is no equivalent of a `service`-style extension that runs without
   a UI surface.

### Cold start vs warm start

- **Cold start** (AE launched with no project): the panel is not loaded
  until the user opens it. No auto-load happens.
- **Warm start** (AE launched with a project already open): same behavior.
  The panel is dormant until clicked.
- **AE exit / restart**: the CEP process is killed when AE exits. Any
  in-memory state is lost. Anything that needs to survive an AE restart
  must be persisted to disk by the panel or by a sidecar process.

### Auto-load patterns

There is **no official "auto-run at AE start" hook for CEP**. Workarounds
documented in the community:

- The AE startup scripts folder (`~/Documents/Adobe/After Effects <ver>/Scripts/Startup`)
  runs ExtendScript at AE launch. Combined with a CEP that watches for a
  file or port, this can simulate auto-load.
- A user-side launcher (macOS launchd, Windows Task Scheduler, or a
  background daemon started by the user) can pre-launch a sidecar
  process that the panel later connects to.

For ae-devtools, the realistic model is: **sidecar process lives
independently of the panel**. The panel is a developer convenience, not a
required component of the runtime path.

---

## Multiple AE instances

Each After Effects process loads its own `CEPHtmlEngine` (one per process)
and its own copy of every extension the user has opened. Implications:

- **Port allocation**: if multiple AE instances run and the panel opens a
  listening socket (debug port or otherwise), each instance needs a
  distinct port. The standard `.debug` file mechanism requires the
  developer to write the port into the file before launching; the host
  reads it and forwards it to `CEPHtmlEngine` as
  `--remote-debugging-port=<port>`. Two AE instances cannot share one
  `.debug` file safely.
- **CEF debug port collision**: a known limitation; Adobe-CEP issue #200
  documents workarounds (pick different ports per AE instance).
- **State**: each instance has independent in-memory state. There is no
  built-in shared state across AE processes from the CEP layer.
- **Sidecar addressing**: a single external daemon can serve multiple AE
  instances by accepting connections on a single port; each AE instance
  opens its own socket. The daemon is responsible for multiplexing.

In practice, multi-instance development requires per-instance port files
and a sidecar that is either a daemon or a per-instance helper that
discovers a free port.

---

## Signing model

Adobe requires signed `.zxp` packages for distribution. The signing tool
is **`ZXPSignCmd`**, distributed via `Adobe-CEP/CEP-Resources`. The
public, Adobe-documented flow:

### Development (unsigned, local only)

To load an unsigned extension during development, the user sets the
**PlayerDebugMode** flag in the host's CSXS registry entry:

- **Windows**: `HKEY_CURRENT_USER\Software\Adobe\CSXS.<ver>` (where `<ver>`
  is `8` for CEP 8/9/10/11/12 era, sometimes `9` for newer hosts), add a
  string value `PlayerDebugMode` set to `"1"`.
- **macOS**: `~/Library/Preferences/com.adobe.CSXS.<ver>.plist`,
  add `<key>PlayerDebugMode</key><string>1</string>`.
- Linux: similar plist path under `~/.config/`.

This is the documented escape hatch used by every CEP developer; without
it the host refuses to load an unsigned extension.

### Distribution

- `.zxp` files must be signed with a certificate that chains to a
  publicly trusted root.
- ZXPSignCmd accepts a `.pfx` / `.p12` and produces a signed `.zxp`.
- Certificates issued by public CAs (DigiCert, etc.) are required for
  end-user installation; self-signed certificates trigger warnings.
- As of 2024-2025 ZXPSignCmd has known stability issues
  (segmentation faults on macOS / Windows) — Adobe-CEP documents these
  in `ZXPSignCMD/KnownIssue2024.md`.

For ae-devtools this means development is friction-free (`PlayerDebugMode=1`)
but any shipped panel that the user installs through standard means must
be signed.

---

## Background / invisible mode

**CEP has no documented invisible / background mode.** The host only
launches `CEPHtmlEngine` when the user opens a panel. There is no
documented API to launch the engine headlessly or to detach it from the
panel UI.

Consequences:

- A pure-CEP design **cannot** provide a persistent agent that runs
  without UI.
- The realistic architectures are:
  1. **ExtendScript-only** — start a script from the AE startup folder,
     keep it alive via `app.scheduleTask` or a polling loop. UI optional.
  2. **External sidecar** — a normal OS process started by the user or
     by a one-time launcher; the panel is purely a control surface and
     inspection window.
  3. **UXP** — Adobe's newer platform. UXP also has no documented
     background mode as of 2026-09-18, but its plugin model may evolve
     differently.

For the ae-devtools architecture, option (2) is the most consistent with
the vision document's "shared core" intent: the core is a normal process,
the CEP/UXP panels are developer-facing UI.

---

## Debugger / inspector integration

The official Adobe debugging path uses **Chromium DevTools over CDP**
(Chrome DevTools Protocol):

- A `.debug` file in the extension's folder (alongside `manifest.xml`)
  contains the debug port, e.g. `8088`.
- `PlayerDebugMode=1` must be set (see Signing model).
- The host launches `CEPHtmlEngine` with
  `--remote-debugging-port=<port>` (in some AE versions this is passed
  base64-encoded as a JSON array — Adobe community confirmed this in
  May 2025 for AE 25.2.2).
- Older approach: open `http://localhost:<port>/` in Chrome and use the
  DevTools UI directly.
- Newer approach: Chrome's `chrome://inspect` page discovers the
  remote-debugging endpoint and attaches DevTools there. Recommended
  for recent CEF versions (CEF 128+).

Caveats reported by the community (2024-2025):

- After Effects 25.2.2 on Windows was reported to fail to open the
  remote-debugging port unless the `.debug` file is in the exact
  expected directory.
- CEF updates occasionally break the `http://localhost:<port>/` flow;
  `chrome://inspect` is the more robust fallback.

ExtendScript itself (the side that `evalScript` invokes) has no
remote-debugging protocol from CEP. The standard ExtendScript Toolkit
debugger still works via TCP port 2018 if launched separately, but the
CEP panel cannot drive that debugger programmatically.

---

## Evidence

- `https://github.com/Adobe-CEP/CEP-Resources` — 2026-09-18 — Authoritative
  source for CEP versions, sample extensions, and the `CEP 12 HTML
  Extension Cookbook`. Confirms CEP 12 as the latest version; confirms
  `CSInterface.js` and `Vulcan.js` as the panel-side runtime files; links
  to integration matrix in the cookbook.
- `https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md`
  — 2026-09-18 — Official Adobe integration matrix (PHSP/PHXS 25.12,
  ILST 29.5.1, PPRO 25.0, AEFT 25.0, AUDT 25.0, IDSN 20.4). Confirms
  Node.js 17.7.1 with Node-WebKit 0.62.1, `cep_node` global, mixed-context
  flag, CORS enforcement from CEP 11 onwards, and the CEF flags for
  `SameSite` cookie workarounds.
- `https://github.com/Adobe-CEP/CEP-Resources/issues/364` — 2026-09-18 —
  Documents the CEP 11 / AE 18.4 regression where `evalScript` callbacks
  are not delivered from nested iframes. Confirms that on modern hosts
  `evalScript` must be called from the top-level frame.
- `https://github.com/Adobe-CEP/CEP-Resources/blob/master/ZXPSignCMD/KnownIssue2024.md`
  — 2026-09-18 — Documents the `PlayerDebugMode` registry entry path
  (`HKEY_CURRENT_USER\Software\Adobe\CSXS.<ver>`) and the 2024-2025
  ZXPSignCmd stability issues.
- `https://theiviaxx.github.io/photoshop-docs/CEP/csinterface.html` —
  2026-09-18 — Third-party but heavily cross-referenced CSInterface API
  reference; confirms `evalScript(script, callback)` signature and the
  callback contract (result on success, `EvalScript_ErrMessage()` on
  failure).
- `https://extendscript.docsforadobe.dev/external-communication/socket-object/`
  — 2026-09-18 — Documents ExtendScript's built-in Socket object (TCP
  only, no SSL/TLS, no UDP) and its `open`/`close`/`listen`/`poll`/`read`/
  `write` methods.
- `https://blog.developer.adobe.com/en/publish/2019/06/debugging-your-adobe-panel`
  — 2026-09-18 — Official Adobe debugging guide; documents `.debug`
  file, port 8088 default, and Chrome DevTools integration via
  `chrome://inspect`.
- `https://community.adobe.com/questions-529/after-effects-25-2-2-win-cep-remote-debugging-port-not-opening-netstat-confirms-no-listening-pr-59962`
  — 2026-09-18 — May 2025 confirmation that AE 25.2.2 on Windows
  occasionally fails to open the CEP remote debugging port; documents
  the base64-encoded JSON-array form of the `--remote-debugging-port`
  argument and the correct `.debug` file directory.
- `https://community.adobe.com/questions-729/how-to-start-node-js-server-in-cep-1414669`
  — 2026-09-18 — Recent Adobe community thread confirming that the
  `cep_node` context does not provide full Node.js module access and
  that bundled third-party modules often fail to load.
- `https://community.adobe.com/questions-628/rest-api-calls-from-inside-cep-are-canceled-685370`
  — 2026-09-18 — Adobe community confirmation that CEP enforces
  CORS by default and that cross-origin requests need proper
  `Access-Control-Allow-Origin` headers; community workarounds
  (Node.js webhook) confirm the network restriction.

---

## Unverified items

The following could not be confirmed from current Adobe documentation
and should be re-verified before relying on them in ae-devtools:

- **After Effects 2026 (v26.x) — CEP version.** As of 2026-09-18 Adobe
  has not published an updated integration matrix entry for AE 26.
  Whether it ships CEP 12 or a future CEP 13 is undocumented in the
  materials examined. Do not assert "AE 26.x → CEP 12" as confirmed.
- **CEP 13 release status.** No public Adobe announcement; issues
  requesting it remain open. Whether AE 2026 will ship CEP 13 is
  unknown. Phrased as "no CEP 13 evidence found in the sources
  consulted", not as a definitive negative.
- **After Effects 2024 (v24.x) — CEP version.** The CEP 12 Cookbook
  contains no AE 24.x row. The strongest evidence is third-party
  (`elevenpercent.net` AutoEdit docs: CEP 11 (2024) / CEP 12 (2025)).
  The working hypothesis is **AE 24.x → CEP 11**, not CEP 12, until an
  Adobe primary source confirms otherwise.
- **Exact multi-AE-instance debug port allocation behavior.** The
  community recommends different ports per instance, but the
  officially blessed allocation strategy (if any) is not in
  Adobe's docs.
- **Programmatic auto-launch of a CEP panel without user click.**
  No documented API exists; the AE startup-scripts folder trick is
  a community pattern, not an Adobe contract.
- **Behavior of `CSInterface.evalScript` under heavy load / large
  payloads.** The string-only contract is documented; size limits
  and back-pressure behavior are not.
- **`--disable-web-security` CEF flag durability.** Known to be
  fragile across CEF versions; Adobe does not document it as a
  supported configuration.
- **UXP scripting in After Effects.** Out of scope for this document
  but flagged as needing its own research note — Adobe has shipped
  UXP panels for Photoshop and Premiere; AE support is less clear.

---

## Working assumptions for ae-devtools

Based on the verified material above, the following assumptions are
reasonable for downstream design work and should be revisited when new
Adobe documentation appears:

1. Target CEP 12 as the primary supported version (Cookbook-confirmed
   for AE 25.x / FY2024). CEP 11 fallback is only needed if AE 2022 / 2023
   / 2024 (24.x, community-attributed CEP 11) must be supported; AE 24.x
   is **not** Cookbook-confirmed as CEP 11 in the materials examined,
   and the AutoEdit vendor documentation is the only third-party
   attribution linking AE 24.x to a specific CEP version.
2. The "shared core" should be an **external daemon** (Node.js or
   equivalent), not a Node.js module running inside the CEP panel.
   Reasons: full Node version, no module-loading fragility, and the
   ability to run without a panel at all.
3. The CEP panel communicates with the daemon over **localhost TCP
   or WebSocket**. Document the chosen port; allow override.
4. Treat `evalScript` as the **only** way to drive ExtendScript from
   the panel. Keep callbacks top-level; JSON-serialize any complex
   payloads.
5. Distribute as a signed `.zxp` for end users; document the
   `PlayerDebugMode` setup for development.
6. Debug the panel via Chrome DevTools `chrome://inspect` (modern
   path) or `http://localhost:<port>/` (legacy path).
7. If AE 2026 / CEP 13 ships during the project's lifetime, re-run
   this research — the Node.js version, CORS enforcement, and
   `evalScript` contract may all change.
