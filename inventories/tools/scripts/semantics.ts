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
  // --- layer/property/keyframe ids used by several operator-style tools ----
  "tool.set-layer": {
    label: "Update layer metadata (name/enabled/locked/shy/solo/3D/blend/label/in-out)",
    adobeOperation: "Layer DOM (layer creation and layer properties)",
  },
  "tool.delete-layer": {
    label: "Delete a layer",
    adobeOperation: "Layer DOM (layer removal)",
  },
  "tool.duplicate-layer": {
    label: "Duplicate a layer",
    adobeOperation: "Layer.duplicate",
  },
  "tool.parent-layer": {
    label: "Set or clear a layer's parent",
    adobeOperation: "Layer.parent",
  },
  "tool.reorder-layer": {
    label: "Move a layer in the render stack",
    adobeOperation: "Layer move before/after (index invalidation)",
  },
  "tool.create-text-layer": {
    label: "Create a text layer",
    adobeOperation: "CompItem.layers.addText + TextDocument property writes",
  },
  "tool.create-solid-layer": {
    label: "Create a solid layer",
    adobeOperation: "CompItem.layers.addSolid",
  },
  "tool.create-shape-layer": {
    label: "Create a shape layer",
    adobeOperation: "CompItem.layers.addShape",
  },
  "tool.create-null-layer": {
    label: "Create a null layer",
    adobeOperation: "CompItem.layers.addNull",
  },
  "tool.create-adjustment-layer": {
    label: "Create an adjustment layer",
    adobeOperation: "CompItem.layers.addSolid with adjustment flag",
  },
  "tool.create-precomp-layer": {
    label: "Insert an existing comp into another as a layered comp",
    adobeOperation: "CompItem.layers.add(comp)",
  },
  "tool.create-camera-layer": {
    label: "Create a camera layer",
    adobeOperation: "CompItem.layers.addCamera",
  },
  "tool.create-light-layer": {
    label: "Create a light layer",
    adobeOperation: "CompItem.layers.addLight",
  },
  "tool.set-transform": {
    label: "Set transform properties (position/scale/rotation/anchor/opacity)",
    adobeOperation: "ADBE Transform Group property writes",
  },
  "tool.set-property": {
    label: "Set a named property by path",
    adobeOperation: "Property.setValue by matchName path",
  },
  "tool.get-property": {
    label: "Read a named property by path",
    adobeOperation: "Property value read by matchName path",
  },
  "tool.get-layer-full": {
    label: "Read one layer's full state",
    adobeOperation: "Layer property/effect/marker/text projection",
  },
  "tool.list-layers": {
    label: "List a comp's layers (compact)",
    adobeOperation: "CompItem.numLayers / layer projection",
  },
  "tool.get-comp-tree": {
    label: "Read a comp with its nested layer tree",
    adobeOperation: "CompItem/layer recursion (pre-comp walk)",
  },
  "tool.set-interpolation": {
    label: "Set one keyframe's interpolation/flags",
    adobeOperation: "Property keyframe DOM (setInterpolationTypeAtKey)",
  },
  "tool.set-temporal-ease": {
    label: "Set a keyframe's in/out temporal ease",
    adobeOperation: "Property keyframe DOM (setTemporalEaseAtKey)",
  },
  "tool.set-spatial-tangents": {
    label: "Set a keyframe's spatial tangents",
    adobeOperation: "Property keyframe DOM (setSpatialTangentsAtKey)",
  },
  "tool.set-shape-path": {
    label: "Write shape path vertices/tangents",
    adobeOperation: "ADBE Vector Shape (shape.setValue)",
  },
  "tool.set-shape-property": {
    label: "Set a shape property (fill/stroke/group/gradient)",
    adobeOperation: "Shape layer property setValue",
  },
  "tool.set-effect-enabled": {
    label: "Enable/disable an effect",
    adobeOperation: "Effect.enabled",
  },
  "tool.set-work-area": {
    label: "Set a comp's work area",
    adobeOperation: "CompItem.workAreaStart/workAreaDuration",
  },
  "tool.remove-keyframes": {
    label: "Remove keyframes from a property",
    adobeOperation: "Property keyframe removal",
  },
  "tool.retime-keyframes": {
    label: "Move/stretch/reverse/stagger existing keyframes",
    adobeOperation: "Property keyframe DOM (key time rewrites)",
  },
  "tool.copy-animation": {
    label: "Copy a layer's animation onto other layers",
    adobeOperation: "Property keyframe DOM (key copy incl. eases/expressions)",
  },
  "tool.copy-keyframes": {
    label: "Copy keyframes between properties",
    adobeOperation: "Property keyframe DOM (key copy)",
  },
  "tool.offset-keyframes": {
    label: "Shift keyframes in time",
    adobeOperation: "Property keyframe DOM (key time shift)",
  },
  "tool.reverse-keyframes": {
    label: "Reverse keyframe order in time",
    adobeOperation: "Property keyframe DOM (key time reversal)",
  },
  "tool.apply-easy-ease": {
    label: "Apply easy-ease to keyframes",
    adobeOperation: "Property keyframe DOM (setTemporalEaseAtKey/interpolation)",
  },
  "tool.batch-set-expressions": {
    label: "Set expressions on many properties at once",
    adobeOperation: "Property expression DOM (bulk writes)",
  },
  "tool.link-properties": {
    label: "Link one property to another with an expression",
    adobeOperation: "Property expression DOM (pick-whip style link)",
  },
  "tool.select": {
    label: "Change UI selection of layers",
    adobeOperation: "Layer.selected",
  },
  "tool.save-frame": {
    label: "Save a frame to an image file",
    adobeOperation: "CompItem.saveFrameToPng",
  },
  "tool.see-frame": {
    label: "Preview a frame as an image",
    adobeOperation: "CompItem.saveFrameToPng (preview-oriented)",
  },
  "tool.undo": {
    label: "Trigger an app-level undo",
    adobeOperation: "app.undo / undo group close",
  },
  "tool.execute-script": {
    label: "Execute arbitrary ExtendScript",
    adobeOperation: "arbitrary ExtendScript eval",
  },
  "tool.import": {
    label: "Import a file into the project",
    adobeOperation: "app.project.importFile",
  },
  "tool.import-folder": {
    label: "Import every file in a folder",
    adobeOperation: "app.project.importFile (folder walk)",
  },
  "tool.list-fonts": {
    label: "List available fonts",
    adobeOperation: "app.fonts enumeration",
  },
  "tool.list-presets": {
    label: "List available animation presets",
    adobeOperation: "Effects & Presets surface (preset scan)",
  },
  "tool.purge-unused-footage": {
    label: "Remove unused footage items from the project",
    adobeOperation: "app.project.reduceProject / unused item removal",
  },
  "tool.collect-files": {
    label: "Collect the project's source files into one folder",
    adobeOperation: "app.project item file copy + relink on disk",
  },
  "tool.queue-in-ame": {
    label: "Hand a comp to Adobe Media Encoder",
    adobeOperation: "AME queue handoff (external app)",
  },
  "tool.place-audio-cues": {
    label: "Import audio and place cue layers",
    adobeOperation: "footage import + AVLayer timing writes",
  },  // --- ae-a8n host dispatch -------------------------------------------------
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
  // --- shared ids introduced by later adapters ------------------------------
  "layer.get-selection": {
    label: "Read the current UI layer selection",
    adobeOperation: "Comp/layer selectedLayers projection",
  },
  "keyframe.get": {
    label: "List keyframes on a property",
    adobeOperation: "Property keyframe DOM (keys and interpolation)",
  },
  "expression.enable": {
    label: "Enable/disable an expression without clearing it",
    adobeOperation: "Property.expressionEnabled",
  },
  "expression.list-all": {
    label: "Collect all expressions in the project",
    adobeOperation: "Property expression DOM (expression text/enabled/error)",
  },
  "expression.search": {
    label: "Search project expressions",
    adobeOperation: "Property expression DOM (expression text/enabled/error)",
  },
  "expression.validate": {
    label: "Syntax/semantic expression validation without applying",
    adobeOperation: "none — linting of the passed string, no project operation",
  },
  "expression.test": {
    label: "Temporarily apply an expression to probe runtime errors",
    adobeOperation: "Property.expression temp assignment restored in-call",
  },
  "expression.stats": {
    label: "Aggregate statistics over project expressions",
    adobeOperation: "Property expression DOM (aggregation read)",
  },
  "layer.get-comment": {
    label: "Read a layer's comment",
    adobeOperation: "Layer.comment",
  },
  "layer.set-comment": {
    label: "Write a layer's comment",
    adobeOperation: "Layer.comment",
  },
  "layer.list-properties": {
    label: "List a layer's properties",
    adobeOperation: "Layer property group iteration",
  },
  "mogrt.add-essential-property": {
    label: "Add an Essential Graphics controller property",
    adobeOperation: "MotionGraphicsTemplate controller surface (comp MotionGraphics)",
  },
  "mogrt.export": {
    label: "Export a Motion Graphics template",
    adobeOperation: "comp.exportAsMotionGraphicsTemplate",
  },
  "app.instance-lifecycle": {
    label: "Discover/start/stop local AE instances",
    adobeOperation: "process lifecycle outside AE (launcher control)",
  },
  "comp.compose-op": {
    label: "Precompose / track matte / blend mode / parent / 3D structure ops",
    adobeOperation: "CompItem.layers precompose, trackMatteType, blendingMode, parent, threeDLayer",
  },
  "render.queue-op": {
    label: "Render queue add/render/batch/AME queue",
    adobeOperation: "Render output (render queue / saveFrameToPng / frame export)",
  },
  "time.timing-op": {
    label: "Layer in/out, comp duration/fps, markers, time remap",
    adobeOperation: "Comp/layer timing (current time, retiming)",
  },
  "tool.layout-op": {
    label: "Measure/align/distribute/stack/pin/fit/stagger layout helpers",
    adobeOperation: "Layer Transform property writes derived from sourceRectAtTime reads",
  },
  "tool.query-project": {
    label: "Multi-command project query dispatcher",
    adobeOperation: "Project/comp/layer/property read projections",
  },
  "tool.read-tree": {
    label: "Structured paginated project tree read",
    adobeOperation: "Project/comp/layer/property reflection",
  },
  "tool.diagnostics": {
    label: "Project diagnostics (missing footage, fonts, broken expressions)",
    adobeOperation: "Project state scans assembled manually",
  },
  "tool.project-checkpoint": {
    label: "Create/list project checkpoints",
    adobeOperation: "project save snapshot to disk (file-system level)",
  },
  "tool.project-revert": {
    label: "Revert the project to a saved checkpoint",
    adobeOperation: "project open/close lifecycle around a saved file",
  },
  "tool.validate-expressions": {
    label: "Force-evaluate expressions and report errors",
    adobeOperation: "Property expression DOM (expressionError reads)",
  },
  "tool.tool-library-save": {
    label: "Persist a reusable script artifact in the local tool library",
    adobeOperation: "none — local file store, no AE contact",
  },
  "tool.tool-library-search": {
    label: "Search the local tool library",
    adobeOperation: "none — local file store read",
  },
  "tool.workspace-bind": {
    label: "Bind a task to an AE project and manage write access",
    adobeOperation: "host capability state (no direct project mutation)",
  },
  "system.run-jsx": {
    label: "Run arbitrary caller-supplied ExtendScript",
    adobeOperation: "arbitrary ExtendScript eval — access depends on the script",
  },
  "system.write-script-file": {
    label: "Write a compiled script to the Scripts Panel folder",
    adobeOperation: "none — local file write, AE not launched",
  },
  "system.get-results": {
    label: "Read the temp result file of a dispatched script",
    adobeOperation: "none — local file read",
  },
  "system.prepare-command": {
    label: "Wrap a function/command for dispatch",
    adobeOperation: "none — request-local object construction",
  },
  "system.result-error": {
    label: "Error type for script results returned from AE",
    adobeOperation: "none — result plumbing",
  },
  // --- one-word curations for remaining derived ids (gap-matrix clarity) ---
  "tool.ae-guide": {
    label: "Serve a bundled usage guide topic",
    adobeOperation: "none — server-local documentation read",
  },
  "tool.analyze-cuts": {
    label: "Analyze footage for cuts (silence/scene detection)",
    adobeOperation: "none — external media analysis outside AE",
  },
  "tool.analyze-motion": {
    label: "Summarize an animation from key reads",
    adobeOperation: "Property keyframe DOM (key/ease reads, server-side summary)",
  },
  "tool.animate-from-data": {
    label: "Generate animation from external data",
    adobeOperation: "Property keyframe DOM (bulk generated keys)",
  },
  "tool.archive-issue": {
    label: "Archive an issue-journal entry",
    adobeOperation: "none — local file store rewrite",
  },
  "tool.audit-editorial-plan": {
    label: "Audit an editorial plan for problems",
    adobeOperation: "none — request-local plan analysis",
  },
  "tool.await-job": {
    label: "Block on a running render/batch job",
    adobeOperation: "none — server job registry wait",
  },
  "tool.cancel-job": {
    label: "Cancel a running render/batch job",
    adobeOperation: "aerender/batch process termination (host-side)",
  },
  "tool.check-setup": {
    label: "Report panel/bridge installation status",
    adobeOperation: "none — install-state inspection",
  },
  "tool.comp-diff": {
    label: "Diff a comp against a stored fingerprint",
    adobeOperation: "structural layer fingerprint comparison (read)",
  },
  "tool.contact-sheet": {
    label: "Compose captured frames into one contact sheet",
    adobeOperation: "none — local image compositing",
  },
  "tool.create-editorial-plan": {
    label: "Generate an editorial plan document",
    adobeOperation: "none — local file write",
  },
  "tool.create-logo-reveal": {
    label: "Build a logo reveal animation",
    adobeOperation: "layer/keyframe creation driven by a shipped template",
  },
  "tool.create-lower-third": {
    label: "Build a lower-third graphic",
    adobeOperation: "layer/keyframe/shape creation driven by a shipped template",
  },
  "tool.create-review": {
    label: "Record a review item in the local review store",
    adobeOperation: "none — local file write",
  },
  "tool.create-title-card": {
    label: "Build a title card animation",
    adobeOperation: "layer/keyframe creation driven by a shipped template",
  },
  "tool.create-transition": {
    label: "Build a transition between layers",
    adobeOperation: "layer/keyframe creation driven by a shipped template",
  },
  "tool.debugalert": {
    label: "Raise a debug alert dialog",
    adobeOperation: "ExtendScript alert() (debug)",
  },
  "tool.decide-review": {
    label: "Record a decision on a review item",
    adobeOperation: "none — local file write",
  },
  "tool.delete-checkpoints": {
    label: "Delete stored comp checkpoints",
    adobeOperation: "project item removal (checkpoint comps)",
  },
  "tool.get-job": {
    label: "Inspect a render/batch job record",
    adobeOperation: "none — server job registry read",
  },
  "tool.get-results": {
    label: "Fetch a bridge job result",
    adobeOperation: "none — job result retrieval",
  },
  "tool.import-3d-from-blender": {
    label: "Import a Blender scene as AE layers",
    adobeOperation: "footage import + layer creation driven by external data",
  },
  "tool.init-project": {
    label: "Initialize a project folder on disk",
    adobeOperation: "none — local folder write",
  },
  "tool.list-blender-jobs": {
    label: "List queued Blender render jobs",
    adobeOperation: "none — local job registry read",
  },
  "tool.list-checkpoints": {
    label: "List stored comp checkpoints",
    adobeOperation: "project item iteration (read)",
  },
  "tool.list-instances": {
    label: "List AE instances registered with a broker",
    adobeOperation: "none — broker-local registry read",
  },
  "tool.list-known-issues": {
    label: "List issue-journal entries",
    adobeOperation: "none — local file store read",
  },
  "tool.list-reviews": {
    label: "List review items from the local review store",
    adobeOperation: "none — local file store read",
  },
  "tool.log-issue": {
    label: "Record an issue-journal entry",
    adobeOperation: "none — local file write",
  },
  "tool.mark-issue-reported": {
    label: "Mark an issue-journal entry reported",
    adobeOperation: "none — local file rewrite",
  },
  "tool.match-reference": {
    label: "Match a reference look/motion",
    adobeOperation: "effect/property writes derived from analysis",
  },
  "tool.populate-template": {
    label: "Populate a comp template with data",
    adobeOperation: "layer property writes driven by data",
  },
  "tool.prepare-blender-3d-job": {
    label: "Queue a Blender render for later AE import",
    adobeOperation: "none — external Blender job submission",
  },
  "tool.reconnect": {
    label: "Re-inject a bridge bootstrap into AE",
    adobeOperation: "host lifecycle (AfterFX -r bootstrap run)",
  },
  "tool.scanfolder": {
    label: "Scan a folder and return file names",
    adobeOperation: "none — local filesystem read",
  },
  "tool.setup-panel": {
    label: "Install the CEP panel on disk",
    adobeOperation: "none — local install (panel files / debug preference)",
  },
  "tool.status": {
    label: "Report host/bridge connection status",
    adobeOperation: "none — host status read",
  },
  "tool.test-animation": {
    label: "Run a canned bridge animation test",
    adobeOperation: "arbitrary ExtendScript eval (test payload)",
  },
  "tool.transcribe-video": {
    label: "Transcribe video audio to text (local)",
    adobeOperation: "none — external transcription, no AE contact",
  },
  "tool.transcript-to-cuts": {
    label: "Derive cut segments from a transcript",
    adobeOperation: "none — local file processing",
  },
  "tool.verify-blender-job": {
    label: "Check a Blender render job's state",
    adobeOperation: "none — local job registry read",
  },
  "tool.writetextfile": {
    label: "Write a text file at an absolute path",
    adobeOperation: "none — local filesystem write",
  },
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
