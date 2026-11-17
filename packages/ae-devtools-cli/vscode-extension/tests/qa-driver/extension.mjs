import * as vscode from "vscode";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

// QA workspace dir: mode.txt selects the command lane, qa-results.json is
// the evidence output. Override with AE_QA_DIR for isolated VSCode runs.
const QA_DIR = process.env.AE_QA_DIR ?? "/tmp/vscode-iso";
const OUT = `${QA_DIR}/qa-results.json`;
const results = { startedAt: new Date().toISOString(), steps: [], notes: [] };
const flush = () => { try { writeFileSync(OUT, JSON.stringify(results, null, 2)); } catch {} };
const rec = (step, data = {}) => { results.steps.push({ step, at: new Date().toISOString(), ...data }); flush(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function activate() {
  rec("driver-activated");
  let mode = "auto";
  try { if (existsSync(`${QA_DIR}/mode.txt`)) mode = readFileSync(`${QA_DIR}/mode.txt`, "utf8").trim(); } catch {}
  rec("mode", { mode });

  // Continuously dismiss info notifications so command handlers that
  // end in showResult can settle. Modal confirms and input boxes are
  // NOT affected — those are driven externally (AppleScript) or time out.
  const clearer = setInterval(async () => {
    try { await vscode.commands.executeCommand("notifications.clearAll"); } catch {}
  }, 1200);

  const trigger = async (name, id) => {
    const p = vscode.commands.executeCommand(id)
      .then(() => rec(name, { settled: true }))
      .catch((e) => rec(name, { settled: false, error: String(e?.message ?? e) }));
    rec(`${name}-triggered`);
    // Watch for settlement up to 90s.
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const done = results.steps.some((s) => s.step === name);
      if (done) break;
      await sleep(400);
    }
    if (!results.steps.some((s) => s.step === name)) rec(name, { settled: false, timeout: true });
    return p;
  };

  if (mode === "inspect") {
    await trigger("inspect", "ae-devtools.inspect");
  } else if (mode === "execute") {
    await trigger("execute", "ae-devtools.execute");
  } else if (mode === "verify") {
    await trigger("verify", "ae-devtools.verify");
  } else {
    // default: full auto pass — discover, debug.setup, debug.attach only
    // (commands needing input/modal are handled by dedicated modes).
    await trigger("discover", "ae-devtools.discover");
    await trigger("debug-setup", "ae-devtools.debug.setup");
    await trigger("debug-attach", "ae-devtools.debug.attach");
    try {
      const all = vscode.languages.getDiagnostics();
      results.problems = all.map(([uri, diags]) => ({ uri: uri.toString(), count: diags.length }));
    } catch (e) { results.problemsError = String(e); }
  }
  try {
    const all = vscode.languages.getDiagnostics();
    results.problems = all.map(([uri, diags]) => ({
      uri: uri.toString(), count: diags.length,
      first: diags[0] ? { message: String(diags[0].message).slice(0, 300), source: diags[0].source, severity: diags[0].severity } : null,
    }));
  } catch (e) { results.problemsError = String(e); }
  clearInterval(clearer);
  rec("done");
  flush();
}
export async function deactivate() {}
