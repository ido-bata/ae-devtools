/**
 * schema.mjs — contract for Adobe `extendscript-debug` V2 launch
 * configurations (Issue #53).
 *
 * Source of truth: Adobe's official "ExtendScript Debugger" VS Code
 * extension docs (marketplace item Adobe.extendscript-debug, V2
 * rewrite). V1 property names were renamed; accepting them silently
 * would produce a config the extension ignores, so they are errors.
 *
 * This module validates the *configuration document*, not whether a
 * debugger can actually attach — that is real-host UNVERIFIED.
 */

export const DEBUG_TYPE = "extendscript-debug";
export const SCHEMA = "ae-devtools.vscode-debugger.config/v1";

/** Properties accepted on BOTH attach and launch requests (V2). */
export const COMMON_PROPERTIES = new Set([
  "type", "request", "name",
  "hostAppSpecifier", "engineName", "hiddenTypes",
  "aliasPath", "registeredSpecifier",
]);

/** Properties accepted ONLY on request:"launch". */
export const LAUNCH_ONLY_PROPERTIES = new Set([
  "script", "bringToFront", "debugLevel",
]);

/** Every property the V2 extension understands. */
export const KNOWN_PROPERTIES = new Set([...COMMON_PROPERTIES, ...LAUNCH_ONLY_PROPERTIES]);

/** V1 names renamed in V2 — must never appear. */
export const V1_PROPERTIES = new Set([
  "targetSpecifier", "program", "excludes",
]);

export const VALID_REQUESTS = new Set(["attach", "launch"]);

/** hiddenTypes accepts the documented primitives plus any ExtendScript
 * class name — an open set we cannot enumerate, so entries only need
 * identifier shape. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Loose shape check for host app specifiers, e.g. "aftereffects-25.0",
 *  "illustrator-29.064", "premierepro-22.0". Not a guarantee the
 *  specifier matches an installed build — that is host-side. */
export const HOST_APP_SPECIFIER_RE = /^[a-z][a-z0-9]*-\d+(\.\d+)*$/;

function diag(severity, code, message, configName = null) {
  return { schema: SCHEMA, severity, code, config: configName, message };
}

/**
 * Validate one configuration object. Returns diagnostics; empty = ok.
 * `severity: "error"` means the extension will ignore/misread the
 * config; `"warning"` means legal but crosses our ownership boundary.
 */
export function validateConfig(config, { index = 0 } = {}) {
  const diags = [];
  const name = typeof config?.name === "string" ? config.name : `#${index}`;
  const at = (code, message, severity = "error") => diags.push(diag(severity, code, message, name));

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    at("not-an-object", "configuration is not an object");
    return diags;
  }

  if (config.type !== DEBUG_TYPE) {
    at("wrong-type", `type must be "${DEBUG_TYPE}", got ${JSON.stringify(config.type)}`);
  }
  if (!VALID_REQUESTS.has(config.request)) {
    at("bad-request", `request must be one of ${[...VALID_REQUESTS].join("/")}, got ${JSON.stringify(config.request)}`);
  }
  if (typeof config.name !== "string" || config.name.length === 0) {
    at("bad-name", "name must be a non-empty string");
  }

  for (const key of Object.keys(config)) {
    if (V1_PROPERTIES.has(key)) {
      at("v1-property", `V1 property '${key}' was renamed in debugger V2 and will be ignored`);
    } else if (!KNOWN_PROPERTIES.has(key)) {
      at("unknown-property", `unknown property '${key}' — not part of the V2 contract`);
    } else if (config.request === "attach" && LAUNCH_ONLY_PROPERTIES.has(key)) {
      at("launch-only-on-attach", `'${key}' is only valid on request:"launch"`);
    }
  }

  if ("hostAppSpecifier" in config) {
    const s = config.hostAppSpecifier;
    if (typeof s !== "string" || !HOST_APP_SPECIFIER_RE.test(s)) {
      at("bad-host-app-specifier", `hostAppSpecifier must look like 'appname-x.y', got ${JSON.stringify(s)}`);
    }
  }
  if ("engineName" in config && (typeof config.engineName !== "string" || config.engineName.length === 0)) {
    at("bad-engine-name", "engineName must be a non-empty string when present");
  }
  if ("hiddenTypes" in config) {
    const ht = config.hiddenTypes;
    if (!Array.isArray(ht)) {
      at("bad-hidden-types", "hiddenTypes must be an array of strings");
    } else {
      for (const t of ht) {
        if (typeof t !== "string" || !IDENT_RE.test(t)) {
          at("bad-hidden-type", `hiddenTypes entry ${JSON.stringify(t)} is not a valid type/class name`);
        }
      }
    }
  }
  if ("debugLevel" in config && ![0, 1, 2].includes(config.debugLevel)) {
    at("bad-debug-level", "debugLevel must be 0, 1, or 2");
  }
  if ("script" in config && typeof config.script !== "string") {
    at("bad-script", "script must be an absolute path string when present");
  }
  if ("aliasPath" in config && typeof config.aliasPath !== "string") {
    at("bad-alias-path", "aliasPath must be a string when present");
  }
  if ("bringToFront" in config && typeof config.bringToFront !== "boolean") {
    at("bad-bring-to-front", "bringToFront must be a boolean when present");
  }

  // Ownership-boundary warnings (not errors — the extension accepts
  // these, but they bypass the ae-a8n owned-session dispatch path).
  if (config.request === "launch") {
    at("launch-bypasses-owned-session",
      "request:\"launch\" evaluates `script` directly in the host, bypassing the ae-a8n owned-session dispatch/consent path — prefer attach",
      "warning");
  }
  if (config.request === "attach" && !config.hostAppSpecifier) {
    at("attach-unpinned",
      "attach without hostAppSpecifier shows an app picker — the session cannot be pinned to a declared AE build",
      "warning");
  }
  return diags;
}

/**
 * Validate a whole launch.json document ({version, configurations:[...]}).
 */
export function validateLaunchJson(doc) {
  const diags = [];
  if (typeof doc !== "object" || doc === null) {
    return [diag("error", "not-an-object", "launch.json is not an object")];
  }
  if (doc.version !== "0.2.0") {
    diags.push(diag("error", "bad-version", `launch.json version must be "0.2.0", got ${JSON.stringify(doc.version)}`));
  }
  if (!Array.isArray(doc.configurations)) {
    diags.push(diag("error", "bad-configurations", "configurations must be an array"));
    return diags;
  }
  doc.configurations.forEach((c, i) => diags.push(...validateConfig(c, { index: i })));
  return diags;
}

export function hasErrors(diags) {
  return diags.some((d) => d.severity === "error");
}
