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

const COMMANDS = [
  "ae-devtools.discover",
  "ae-devtools.inspect",
  "ae-devtools.execute",
  "ae-devtools.verify",
];

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
  const outcome = payload?.outcome ?? payload?.status ?? payload?.error ?? "ok";
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

  const reg = (id, fn) => context.subscriptions.push(
    vscode.commands.registerCommand(id, async () => {
      try {
        await showResult(await fn());
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
}

export async function deactivate() {
  await controller?.close();
  controller = null;
}
