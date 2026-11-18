# REMOTE-DEBUGGING — CEP remote debugging feasibility note (Issue #193, CAP058-adjacent)

Scope: whether the scaffold/lifecycle should gain an opt-in mechanism for
live panel inspection via CEP/Chromium remote debugging. **Nothing here is
a verified capability** — this note separates documented behavior,
host-observed environment facts, and open questions.

## What is documented (source-reviewed)

Per Adobe's official CEP documentation (Adobe-CEP/CEP-Resources on
GitHub):

- **Remote debugging exists since CEP 5.0.** The mechanism is a `.debug`
  file placed at the **root of the extension folder** (next to
  `CSXS/manifest.xml`). It is an XML file with the same `ExtensionList` /
  `Extension Id` / `HostList` shape as a manifest fragment:

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <ExtensionList>
      <Extension Id="com.example.my-panel">
          <HostList>
              <Host Name="AEFT" Port="8088"/>
          </HostList>
      </Extension>
  </ExtensionList>
  ```

  Sources:
  - `CEP_11.x/Documentation/Debugging Handbook.md` §3 "Debugging Tools"
  - `CEP_12.x/Documentation/Debugging Handbook.md` §3 "Debugging Tools"
  - `CEP_11.x/Documentation/CEP 11.1 HTML Extension Cookbook.md`
    §"Remote Debugging"
    <https://github.com/Adobe-CEP/CEP-Resources>

- **Port rules (cookbook):** the `Port` value must be between 1024 and
  65535 (65535 excluded); each host application gets its own port; one
  extension bundle may list multiple `<Host>` entries. The `.debug` file
  name is special on both platforms and must be created via command line
  (`copy con .debug` on Windows, `touch .debug` on macOS).
- **Debugging surface:** once the `.debug` file is present, the panel's
  CEPHtmlEngine instance exposes Chromium DevTools protocol — attach via
  `http://localhost:<port>` in a Chrome/Edge `devtools://` or equivalent
  frontend. Adobe's own blog post "Debugging Your Adobe Panel"
  (developer.adobe.com, 2019) walks through exactly this flow.

## What was observed on the real dev host (environment only)

From `EVIDENCE.md` §Real-host environment observations (2026-11-14,
non-invasive read-only inspection of the operator's running AE 2026 /
CEPHtmlEngine 12.0.1):

- The operator's own panels (e.g. `app.ty-plus`) run renderer processes
  with `--remote-debugging-port` arguments driven by `.debug` files —
  **ports 8970/9170 were observed** on `CEPHtmlEngine12-AEFT-26.5.3-*`
  processes.
- This proves the mechanism is live on this host for *other* extensions;
  it is **not** evidence that our scaffolded extension would get the same
  treatment.

## What is UNVERIFIED

- Whether AE 2026 (26.5.3) / AE 2027 honors a `.debug` `<Host Name="AEFT"
  Port="…">` entry for an arbitrary extension id, or whether the observed
  `--remote-debugging-port` flags come from a different configuration
  path (e.g. product-bundled panels, manifest flags, or CEP internals).
- Whether remote debugging requires `PlayerDebugMode=1`, a signed
  extension, or works for unsigned debug-load panels.
- Port allocation conflicts: nothing reserves or validates that a chosen
  port is free; a collision would presumably fail closed but is
  unverified.
- Windows behavior entirely (no Windows host; Issue #21 policy).
- Whether UXP (when GA) has an equivalent surface — out of scope here.

## Recommendation

**Yes — add an opt-in `.debug` emission flag to the scaffold, off by
default.** Rationale:

- The `.debug` file is per-extension, inert when absent, and is the only
  documented mechanism for live panel inspection — a real gap for
  CAP059-adjacent debugging once the load proof lands.
- Cost is small: scaffold already writes dotfile-adjacent artifacts and
  the file is plain XML reusing manifest vocabulary; `validate.mjs` can
  check well-formedness and id/host consistency cheaply.
- Risks are contained by keeping it **opt-in** (`scaffold.mjs --debug-port
  <n>` or similar): default scaffolds must not silently open debug ports.
- Before claiming anything: the flag's output must be labeled
  **UNVERIFIED** until a real-host load proof confirms the panel is
  reachable at the configured port. Do not document it as a working
  feature.

Suggested shape (not implemented here): `--debug-port <1024–65534>`
emits `.debug` with `<Host Name="AEFT" Port="<n>"/>`; `validate` warns if
`.debug` is present but `PlayerDebugMode` status is unknown/unset.
Port selection guidance: pick a high port unlikely to collide (the
observed operator panels use 8970/9170); document that the operator must
ensure the port is free.
