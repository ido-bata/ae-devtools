/**
 * ae-devtools adapter: the implemented surface of experiments/runtime-bridge —
 * eight ExtendScript probes plus the loopback node-server endpoints.
 *
 * These are probes, not a product API (README status: Unverified), but they are
 * the operations this repository actually implements today and therefore the
 * ae-devtools side of the CAP003 gap matrix.
 */

import { classifyBody, classifyOverride, type ClassifyExtras } from "../classify.ts";
import { AE_DEVTOOLS_ID, resolveSourceRoot } from "../registry.ts";
import { checkCitation, readLines, type FileLines } from "../text.ts";
import type { OperationRow } from "../types.ts";

const PROBE_ROUTE = "CEP panel (CSInterface.evalScriptFile) → ExtendScript probe in After Effects";
const SERVER_ROUTE = "HTTP loopback (X-AE-Bridge-Token) → CEP panel dispatch (v1 stub: not dispatched)";

const EXTRAS: ClassifyExtras = {
  read: [/jsonOk\s*\(/, /numItemsBefore\b/, /compIndex\b/],
};

interface ProbeSpec {
  file: string;
  name: string;
  semanticId: string;
  /** First line matching this pattern is the definition/implementation site. */
  site: RegExp;
  /** Explicit classification when the generic rules misread the probe. */
  override?: { access: OperationRow["access"]; basis: string };
  note: string;
}

const PROBES: ProbeSpec[] = [
  {
    file: "extendscript/01-version.jsx",
    name: "probe.version",
    semanticId: "app.version-info",
    site: /var v = app\.version/,
    note: "returns app.version as JSON; read-only probe",
  },
  {
    file: "extendscript/02-active-item.jsx",
    name: "probe.active-item",
    semanticId: "project.active-item",
    site: /var ai = app\.project \?/,
    note: "JSON projection of app.project.activeItem; read-only probe",
  },
  {
    file: "extendscript/03-mutate-then-inspect.jsx",
    name: "probe.mutate-then-inspect",
    semanticId: "comp.create",
    site: /items\.addComp\("probe-03-temp"/,
    override: {
      access: "write",
      basis:
        "creates temporary comp probe-03-temp via items.addComp, snapshots numItems, then removes it again in cleanup — net project content unchanged on the success path",
    },
    note: "two-stage probe: mutate, inspect, cleanup; see file for cleanup at the tail of the try block",
  },
  {
    file: "extendscript/04-exception.jsx",
    name: "probe.exception",
    semanticId: "devtools.probe.error-propagation",
    site: /\$\.error\("probe-04/,
    override: {
      access: "build-test",
      basis:
        "calls $.error(...) to force an evalScript error-path failure; a test-only probe that neither reads nor writes project state",
    },
    note: "error-propagation probe; no Adobe operation is exercised",
  },
  {
    file: "extendscript/05-concurrent-A.jsx",
    name: "probe.concurrent-read-a",
    semanticId: "project.walk-tree",
    site: /for \(var i = 1; i <= app\.project\.numItems/,
    note: "long-ish safe read (project tree walk) used for concurrency probing",
  },
  {
    file: "extendscript/06-concurrent-B.jsx",
    name: "probe.concurrent-read-b",
    semanticId: "app.version-info",
    site: /var numItems = app\.project \?/,
    note: "short read (app.version) paired with probe 05; same Adobe operation as probe.version",
  },
  {
    file: "extendscript/07-snapshot.jsx",
    name: "probe.snapshot",
    semanticId: "project.snapshot",
    site: /var snap = \{/,
    note: "structured snapshot of project state; read-only probe",
  },
  {
    file: "extendscript/08-identity.jsx",
    name: "probe.identity",
    semanticId: "layer.add-solid",
    site: /items\.addComp\("probe-08-temp"/,
    override: {
      access: "write",
      basis:
        "creates temp comp probe-08-temp plus a solid layer via addSolid to capture index/id/name, then removes the comp in cleanup (comp.remove()) — net project content unchanged on the success path",
    },
    note: "stops at create+read; does not exercise rename/reorder/save (see file header)",
  },
];

function findLine(file: FileLines, pattern: RegExp, label: string): number {
  for (let i = 0; i < file.lines.length; i++) {
    if (pattern.test(file.lines[i] ?? "")) return i + 1;
  }
  throw new Error(`${AE_DEVTOOLS_ID}: pattern not found in ${file.path} for ${label}: ${pattern}`);
}

export function extract(): OperationRow[] {
  const def = resolveSourceRoot({
    id: AE_DEVTOOLS_ID,
    repoUrl: "https://github.com/ido-bata/ae-devtools",
    kind: "experiment",
    commit: "",
    license: "",
    licenseEvidence: "",
    extraction: "ae-devtools",
  });
  const rows: OperationRow[] = [];

  for (const probe of PROBES) {
    const file = readLines(`${def.root}/experiments/runtime-bridge/${probe.file}`);
    const site = findLine(file, probe.site, probe.name);
    const cls = probe.override
      ? classifyOverride(probe.override.access, probe.override.basis)
      : classifyBody(file.lines.join("\n"), EXTRAS);
    const row: OperationRow = {
      toolId: AE_DEVTOOLS_ID,
      name: probe.name,
      args: [],
      access: cls.access,
      accessBasis: cls.basis,
      route: PROBE_ROUTE,
      semanticId: probe.semanticId,
      status: "source-verified",
      definitionFile: `experiments/runtime-bridge/${probe.file}`,
      definitionLine: site,
      implementationFile: `experiments/runtime-bridge/${probe.file}`,
      implementationLine: site,
      note: probe.note,
    };
    rows.push(row);
  }

  // Loopback node-server endpoints.
  const server = readLines(`${def.root}/experiments/runtime-bridge/node-server/server.js`);
  const evalDefLine = findLine(server, /req\.url !== "\/eval"/, "server./eval");
  const evalImplLine = findLine(server, /Stub behavior: do NOT forward/, "server./eval stub");
  rows.push({
    toolId: AE_DEVTOOLS_ID,
    name: "bridge.eval",
    args: ["id", "source"],
    access: "execute",
    accessBasis:
      "accepts arbitrary ExtendScript source over the authenticated loopback endpoint; the v1 stub answers no_panel_attached without dispatching to AE (server.js stub branch), so execution is intended but not yet performed",
    route: SERVER_ROUTE,
    semanticId: "devtools.bridge.eval",
    status: "source-verified",
    definitionFile: "experiments/runtime-bridge/node-server/server.js",
    definitionLine: evalDefLine,
    implementationFile: "experiments/runtime-bridge/node-server/server.js",
    implementationLine: evalImplLine,
    note: "privileged arbitrary-script surface; FR-07 keeps this a separate development action",
  });

  const healthLine = findLine(server, /req\.url !== "\/healthz"/, "server./healthz");
  rows.push({
    toolId: AE_DEVTOOLS_ID,
    name: "bridge.healthz",
    args: [],
    access: "read",
    accessBasis: "returns a static { status: \"ok\" } payload; no privileged data, no AE contact",
    route: SERVER_ROUTE,
    semanticId: "devtools.bridge.healthz",
    status: "source-verified",
    definitionFile: "experiments/runtime-bridge/node-server/server.js",
    definitionLine: healthLine,
    implementationFile: "experiments/runtime-bridge/node-server/server.js",
    implementationLine: healthLine,
    note: "token-exempt listener probe",
  });

  for (const row of rows) {
    const a = checkCitation(def.root, row.definitionFile, row.definitionLine);
    if (!a.ok) throw new Error(`${row.name}: ${a.reason}`);
    const b = checkCitation(def.root, row.implementationFile, row.implementationLine);
    if (!b.ok) throw new Error(`${row.name}: ${b.reason}`);
  }
  return rows;
}
