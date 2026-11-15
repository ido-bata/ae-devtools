/**
 * gen.mjs — generate `.vscode/launch.json` for the Adobe
 * `extendscript-debug` extension (Issue #53).
 *
 * Defaults are deliberately conservative:
 *   - request is ALWAYS "attach" — a "launch" request would evaluate a
 *     script file directly in the host, bypassing the ae-a8n
 *     owned-session dispatch/consent path.
 *   - the configuration is named "Attach to After Effects (ae-devtools)"
 *     so it is distinguishable in the debug dropdown.
 *   - `hiddenTypes: ["builtin"]` keeps the Variables view usable.
 *
 * Session pinning honesty: `hostAppSpecifier` selects app family +
 * version, NOT a process. Instance-level pinning to the ae-a8n owned
 * session cannot be expressed in launch.json — see README/EVIDENCE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateLaunchJson, hasErrors, HOST_APP_SPECIFIER_RE, DEBUG_TYPE, SCHEMA } from "./schema.mjs";

export const DEFAULT_NAME = "Attach to After Effects (ae-devtools)";
export const DEFAULT_HIDDEN_TYPES = ["builtin"];

/**
 * Build the attach configuration object. Throws on invalid input —
 * generation must fail closed, never emit a malformed config.
 */
export function buildAttachConfig({
  hostAppSpecifier,
  engineName = "main",
  name = DEFAULT_NAME,
  hiddenTypes = DEFAULT_HIDDEN_TYPES,
} = {}) {
  if (typeof hostAppSpecifier !== "string" || !HOST_APP_SPECIFIER_RE.test(hostAppSpecifier)) {
    throw new Error(`hostAppSpecifier must look like 'aftereffects-25.0', got ${JSON.stringify(hostAppSpecifier)}`);
  }
  const config = {
    type: DEBUG_TYPE,
    request: "attach",
    name,
    hostAppSpecifier,
    engineName,
    hiddenTypes: [...hiddenTypes],
  };
  // Self-check: the generator must never emit a config its own
  // validator rejects.
  const diags = validateLaunchJson({ version: "0.2.0", configurations: [config] });
  if (hasErrors(diags)) {
    throw new Error(`generated config failed self-validation: ${JSON.stringify(diags)}`);
  }
  return config;
}

/**
 * Write `.vscode/launch.json` under `projectDir`, merging with any
 * existing file: our named configuration is replaced, others kept.
 * Returns { path, config, merged, diagnostics }.
 */
export function writeLaunchJson(projectDir, config) {
  const vscodeDir = join(resolve(projectDir), ".vscode");
  const path = join(vscodeDir, "launch.json");
  let doc = { version: "0.2.0", configurations: [] };
  let merged = false;
  if (existsSync(path)) {
    try {
      // launch.json is JSONC in VS Code; we only read/write strict JSON
      // and refuse to clobber a file we cannot parse.
      doc = JSON.parse(readFileSync(path, "utf8"));
      merged = true;
    } catch (e) {
      throw new Error(`existing ${path} is not strict JSON — refusing to overwrite: ${e.message}`);
    }
  }
  if (!Array.isArray(doc.configurations)) doc.configurations = [];
  const idx = doc.configurations.findIndex((c) => c && c.name === config.name);
  if (idx >= 0) doc.configurations[idx] = config;
  else doc.configurations.push(config);

  const diags = validateLaunchJson(doc);
  // Fail closed on doc-level breakage or on OUR config being rejected.
  // Foreign pre-existing configs are reported but do not block — VS
  // Code ignores entries it cannot parse, and refusing to write would
  // hold our lane hostage to unrelated user config.
  const fatal = diags.filter((d) =>
    d.code === "bad-version" || d.code === "bad-configurations" ||
    d.code === "not-an-object" || d.config === config.name);
  if (fatal.some((d) => d.severity === "error")) {
    throw new Error(`launch.json would fail validation: ${JSON.stringify(fatal)}`);
  }
  mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 4) + "\n");
  return { path, config, merged, diagnostics: diags };
}
