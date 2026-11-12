/**
 * CAP003: normalized (provisional) semantic operation ids + gap matrix.
 *
 * One Adobe operation reached through several wrappers is counted once: rows
 * from every tool are grouped by `semanticId`, and the semantic op records the
 * set of tools that reach it. The id grammar and final catalog schema are
 * owned by ae-devtools#11 — every id emitted here is `provisional: true`.
 *
 * The gap matrix compares competitor coverage against the two consumers this
 * repository owns: ae-a8n (public API / host dispatch) and ae-devtools
 * (experiments/runtime-bridge).
 */

import { AE_A8N_ID, AE_DEVTOOLS_ID } from "./registry.ts";
import { humanize } from "./normalize.ts";
import type { GapRow, OperationRow, SemanticBundle, SemanticOp, SemanticOpMeta, ToolRecord } from "./types.ts";

/** Domain -> the Adobe surface a derived id in that domain denotes. */
const DOMAIN_ADOBE: Record<string, string> = {
  project: "After Effects Project/Item DOM (project file, items, metadata)",
  comp: "CompItem DOM (composition settings, items, timing)",
  layer: "Layer DOM (layer creation and layer properties)",
  effect: "Effect/Property DOM (effects and their parameters)",
  property: "Property DOM (property values)",
  keyframe: "Property keyframe DOM (keys and interpolation)",
  expression: "Property expression DOM (expression text/enabled/error)",
  text: "Text layer / TextDocument DOM",
  shape: "Shape layer group/path DOM",
  mask: "Mask property DOM",
  path: "Mask/shape path DOM (vertices and tangents)",
  marker: "Marker property DOM",
  render: "Render output (render queue / saveFrameToPng / frame export)",
  footage: "Footage import and footage item DOM",
  camera: "Camera layer DOM",
  light: "Light layer DOM",
  material: "Layer material options DOM",
  geometry: "Layer geometry options DOM",
  time: "Comp/layer timing (current time, retiming)",
  menu: "app menu commands (findMenuCommandId / executeCommand)",
  app: "app object (version, lifecycle, environment)",
  ui: "Host UI dialogs (alert/prompt/confirm)",
  system: "Bridge/host system surface (ping, health, script execution)",
  view: "Viewer / frame capture surface",
  audio: "Audio property DOM",
  edit: "Footage edit assembly (cut/keep segments)",
  subtitle: "Subtitle text creation",
  motion: "Motion graphics / animation preset surface",
  mogrt: "Motion graphics template (MOGRT) DOM",
  style: "Style/color settings surface",
  search: "Project search (item name matching)",
  preference: "Preferences surface",
  proxy: "Footage proxy DOM",
  probe: "ae-devtools probe (no product operation)",
  devtools: "ae-devtools runtime-bridge surface",
  tool: "derived from the tool name; Adobe surface not yet pinned (provisional)",
};

function derivedMeta(id: string): SemanticOpMeta {
  const domain = id.slice(0, id.indexOf(".") > 0 ? id.indexOf(".") : id.length);
  return {
    label: humanize(id),
    adobeOperation: DOMAIN_ADOBE[domain] ?? DOMAIN_ADOBE.tool ?? "unknown",
  };
}

export interface SemanticMeta {
  label: string;
  /** The single underlying Adobe operation/API surface. */
  adobeOperation: string;
}

/**
 * Normalization table: semantic id -> human label + the one Adobe operation it
 * denotes. Adapters must only emit ids present here; adding an adapter means
 * adding its ids to this table (that is the normalization act itself).
 */
export const SEMANTIC_META: Record<string, SemanticMeta> = {
  // --- ae-a8n host dispatch -------------------------------------------------
  "app.version-info": {
    label: "Read app version/build info",
    adobeOperation: "ExtendScript app.version / app.buildNumber",
  },
  "ui.alert": {
    label: "Raise a modal alert dialog",
    adobeOperation: "ExtendScript alert()",
  },
  "app.quit": {
    label: "Quit After Effects",
    adobeOperation: "app.quit() with unsaved-changes guard",
  },
  "project.open": {
    label: "Open a project file",
    adobeOperation: "app.open(File)",
  },
  "project.close": {
    label: "Close the open project",
    adobeOperation: "Project.close(CloseOptions)",
  },
  "project.info": {
    label: "Read project metadata",
    adobeOperation: "Project.file / Project.numItems",
  },
  "project.list-comps": {
    label: "List compositions in the project",
    adobeOperation: "Project item iteration (CompItem properties)",
  },
  "comp.info": {
    label: "Read composition settings",
    adobeOperation: "CompItem name/width/height/duration/frameRate",
  },
  "comp.list-layers": {
    label: "List a comp's layers",
    adobeOperation: "CompItem.numLayers / CompItem.layer(i) projection",
  },
  "comp.get-layer": {
    label: "Read one layer's info",
    adobeOperation: "Layer id/name/index/enabled/selected projection",
  },
  "layer.list-effects": {
    label: "List effects on a layer",
    adobeOperation: "ADBE Effect Parade property iteration",
  },
  "effect.apply": {
    label: "Apply an effect to a layer",
    adobeOperation: "Effect Parade addProperty",
  },
  "effect.list-parameters": {
    label: "List an effect's parameters",
    adobeOperation: "Effect property iteration (describeProperty)",
  },
  "effect.get-parameter": {
    label: "Read one effect parameter",
    adobeOperation: "Property value read",
  },
  "effect.set-parameter": {
    label: "Set an effect parameter",
    adobeOperation: "Property.setValue",
  },
  "render.frame": {
    label: "Render one frame to a PNG file",
    adobeOperation: "CompItem.saveFrameToPng",
  },
  "comp.create": {
    label: "Create a composition",
    adobeOperation: "Project.items.addComp",
  },
  "comp.open-in-viewer": {
    label: "Open a comp in the viewer",
    adobeOperation: "CompItem.openInViewer",
  },
  "layer.add-text": {
    label: "Add a text layer",
    adobeOperation: "CompItem.layers.addText + TextDocument property setValue",
  },
  "layer.select": {
    label: "Change UI layer selection",
    adobeOperation: "Layer.selected",
  },
  "layer.set-enabled": {
    label: "Enable/disable a layer",
    adobeOperation: "Layer.enabled",
  },
  "layer.get-transform": {
    label: "Read layer transform values",
    adobeOperation: "ADBE Transform Group property values",
  },
  "layer.get-shape-paths": {
    label: "Read shape layer paths",
    adobeOperation: "ADBE Vector Shape vertices/inTangents/outTangents",
  },
  "app.set-environment": {
    label: "Set process environment variables",
    adobeOperation: "$.setenv (ExtendScript process-scoped env)",
  },
  "menu.find-command": {
    label: "Find a menu command id by name",
    adobeOperation: "app.findMenuCommandId",
  },
  "menu.execute-command": {
    label: "Execute a menu command",
    adobeOperation: "app.executeCommand",
  },
  // --- ae-devtools runtime-bridge -----------------------------------------
  "project.active-item": {
    label: "Read the active project item projection",
    adobeOperation: "Project.activeItem projection",
  },
  "project.walk-tree": {
    label: "Walk the project item tree (counts)",
    adobeOperation: "Project.item(i) iteration (read-only)",
  },
  "project.snapshot": {
    label: "Structured project state snapshot",
    adobeOperation: "Project/comp/selection state read",
  },
  "layer.add-solid": {
    label: "Add a solid layer",
    adobeOperation: "CompItem.layers.addSolid",
  },
  "devtools.probe.error-propagation": {
    label: "Force an evalScript error-path failure (probe)",
    adobeOperation: "none — $.error probe, no project operation",
  },
  "devtools.bridge.eval": {
    label: "Submit arbitrary ExtendScript over the loopback bridge",
    adobeOperation: "none yet — v1 stub does not dispatch to AE",
  },
  "devtools.bridge.healthz": {
    label: "Loopback bridge listener health probe",
    adobeOperation: "none — static HTTP response",
  },
  // --- competitor rows append their ids below as adapters land -------------
};

export function buildSemantics(operations: OperationRow[], _tools: ToolRecord[]): SemanticBundle {
  const grouped = new Map<string, Set<string>>();
  for (const row of operations) {
    const set = grouped.get(row.semanticId) ?? new Set<string>();
    set.add(row.toolId);
    grouped.set(row.semanticId, set);
  }

  const semanticOps: SemanticOp[] = [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, toolSet]) => {
      const meta = SEMANTIC_META[id] ?? derivedMeta(id);
      return {
        id,
        provisional: true,
        label: meta.label,
        adobeOperation: meta.adobeOperation,
        tools: [...toolSet].sort(),
      };
    });

  const gapMatrix: GapRow[] = semanticOps.map((op) => {
    const inAeA8n = op.tools.includes(AE_A8N_ID);
    const inAeDevtools = op.tools.includes(AE_DEVTOOLS_ID);
    const competitors = op.tools.filter((t) => t !== AE_A8N_ID && t !== AE_DEVTOOLS_ID).sort();
    return {
      semanticId: op.id,
      provisional: true,
      label: op.label,
      inAeA8n,
      inAeDevtools,
      competitors,
      gap: competitors.length > 0 && !inAeA8n && !inAeDevtools,
    };
  });

  return {
    provisional: true,
    note:
      "Provisional normalization owned by ae-devtools#11. One Adobe operation reached through several wrappers is counted once (grouped by semanticId); gap = a competitor reaches an operation that neither ae-a8n nor ae-devtools implements.",
    semanticOps,
    gapMatrix,
  };
}
