/**
 * extension.mjs — VSCode activation entry for AE DevTools (Issue #152).
 *
 * Registers the dev-loop commands and delegates ALL behavior to
 * controller.mjs. This file only adapts vscode UI (input boxes,
 * modal confirms, information messages) to the controller's injected
 * `ui` surface — no dispatch or permission logic lives here.
 */
import * as vscode from "vscode";
import { createController } from "./controller.mjs";
import { normalizedOutcome } from "../dev-loop/outcomes.mjs";

const COMMANDS = [
  "ae-devtools.discover",
  "ae-devtools.inspect",
  "ae-devtools.execute",
  "ae-devtools.verify",
];

const SEVERITY_MAP = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

let diagnosticCollection = null;
const publishedUris = new Set();

function uriForItem(item) {
  const file = item.range?.file ?? item.file;
  if (typeof file === "string" && file.length > 0) {
    if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) {
      return vscode.Uri.file(file);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return vscode.Uri.joinPath(folder.uri, file);
  }
  // No usable file — publish on a dedicated scheme rather than
  // inventing a workspace path. Problems panel still lists it.
  return vscode.Uri.parse(`ae-devtools:diagnostics/${item.kind ?? "record"}`);
}

function rangeForItem(item) {
  const r = item.range;
  if (!r) return new vscode.Range(0, 0, 0, 0);
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

/**
 * Publish a controller `diagnostics` publish plan (built by
 * diagnostics.mjs) into the Problems panel. Positions come only from
 * resolved maps or the record's own fields — unmapped/no-position
 * records are shown with their mapping status, never a fabricated
 * location.
 */
function publishDiagnostics(plan) {
  if (!diagnosticCollection || !plan?.items?.length) return;
  const byUri = new Map();
  for (const item of plan.items) {
    const uri = uriForItem(item);
    if (!byUri.has(uri.toString())) byUri.set(uri.toString(), { uri, items: [] });
    byUri.get(uri.toString()).items.push(item);
  }
  const nextUris = new Set(byUri.keys());
  for (const key of publishedUris) {
    if (!nextUris.has(key)) {
      diagnosticCollection.delete(vscode.Uri.parse(key));
      publishedUris.delete(key);
    }
  }
  for (const { uri, items } of byUri.values()) {
    const diags = items.map((item) => {
      const d = new vscode.Diagnostic(
        rangeForItem(item),
        item.message,
        SEVERITY_MAP[item.severity] ?? vscode.DiagnosticSeverity.Error,
      );
      d.source = `ae-devtools · ${item.kind}`;
      d.code = item.collector;
      // Surface mapping honesty in the Problems panel: an unmapped or
      // absent position is stated, not hidden.
      if (item.mappingStatus && item.mappingStatus !== "mapped" && item.mappingStatus !== "record-position") {
        d.message = `${item.message} [source position: ${item.mappingStatus}]`;
      }
      return d;
    });
    diagnosticCollection.set(uri, diags);
    publishedUris.add(uri.toString());
  }
}

function realUi() {
  return {
    async confirm({ title, detail, modal }) {
      const pick = await vscode.window.showWarningMessage(
        title,
        { modal: modal === true, detail },
        "Allow",
      );
      return pick === "Allow";
    },
    async info(message) {
      await vscode.window.showInformationMessage(message);
    },
    async error(message) {
      await vscode.window.showErrorMessage(message);
    },
  };
}

function summarize(payload) {
  // Honest one-line summary; the full payload stays available via
  // "Show Details". Evidence level is always surfaced — fake/mock
  // results are never presented as real-host verification.
  const evidence = payload?.session?.evidenceLevel ?? payload?.evidenceLevel ?? "n/a";
  const outcome = normalizedOutcome(payload) ?? payload?.error ?? "ok";
  return `AE DevTools: ${outcome} (evidence: ${evidence})`;
}

async function showResult(payload) {
  const detail = JSON.stringify(payload, null, 2);
  const pick = await vscode.window.showInformationMessage(
    summarize(payload),
    "Show Details",
  );
  if (pick === "Show Details") {
    const doc = await vscode.workspace.openTextDocument({
      content: detail,
      language: "json",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

async function promptOpId() {
  return vscode.window.showInputBox({
    title: "AE operation id",
    prompt: "Registry operation id, e.g. item.addComp (see ae-devtools.discover)",
    ignoreFocusOut: true,
  });
}

async function promptArgsJson() {
  const raw = await vscode.window.showInputBox({
    title: "Operation arguments (JSON, optional)",
    prompt: 'e.g. {"name":"Comp 1"} — leave empty for {}',
    ignoreFocusOut: true,
  });
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    await vscode.window.showErrorMessage("Arguments must be a JSON object; dispatch cancelled.");
    return null;
  }
}

let controller = null;

export async function activate(context) {
  const config = vscode.workspace.getConfiguration("ae-devtools");
  controller = createController({
    session: config.get("session", "fake"),
    aeA8nRoot: config.get("aeA8nRoot"),
    installDir: config.get("installDir"),
    ui: realUi(),
  });

  diagnosticCollection = vscode.languages.createDiagnosticCollection("ae-devtools");
  context.subscriptions.push(diagnosticCollection);

  const reg = (id, fn) => context.subscriptions.push(
    vscode.commands.registerCommand(id, async () => {
      try {
        const result = await fn();
        publishDiagnostics(result?.diagnostics);
        await showResult(result);
      } catch (e) {
        await vscode.window.showErrorMessage(`AE DevTools ${id} failed: ${e?.message ?? e}`);
      }
    }),
  );

  reg("ae-devtools.discover", () => controller.discover());
  reg("ae-devtools.inspect", async () => {
    const opId = await promptOpId();
    if (!opId) return { schema: "ae-devtools.vscode-extension/v1", status: "cancelled", detail: "no operation id entered" };
    return controller.inspect(opId);
  });
  reg("ae-devtools.execute", async () => {
    const opId = await promptOpId();
    if (!opId) return { schema: "ae-devtools.vscode-extension/v1", status: "cancelled", detail: "no operation id entered" };
    const args = await promptArgsJson();
    if (args === null) return { schema: "ae-devtools.vscode-extension/v1", status: "cancelled", detail: "invalid arguments JSON" };
    return controller.execute({ opId, args });
  });
  reg("ae-devtools.verify", () => controller.verify());
  reg("ae-devtools.debug.setup", () => controller.debugSetup({
    projectDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    hostAppSpecifier: config.get("debug.hostAppSpecifier", ""),
  }));
  reg("ae-devtools.debug.attach", () => controller.debugAttach({
    hostAppSpecifier: config.get("debug.hostAppSpecifier", ""),
    ownedPid: config.get("debug.ownedPid", ""),
  }));
}

export async function deactivate() {
  await controller?.close();
  controller = null;
  diagnosticCollection?.dispose();
  diagnosticCollection = null;
  publishedUris.clear();
}
