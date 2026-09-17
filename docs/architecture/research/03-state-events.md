# Runtime State and Events

> Research document for the ae-devtools project. Authoritative sources:
> Adobe-official docs (`developer.adobe.com`, `github.com/Adobe-CEP`)
> and the community-maintained `ae-scripting.docsforadobe.dev`
> (derived from the Adobe After Effects CS6 Scripting Guide). Items
> that cannot be verified are listed under **Unverified items**.
>
> Access date for every cited URL: **2026-09-18**.

This document covers how an external tool can inspect After Effects
runtime state and receive change notifications, as exposed by the
ExtendScript / scripting API and the CEP bridge.

---

## Snapshot introspection

The scripting API is **attribute-driven** rather than event-driven.
Every "live" piece of state in AE is reachable as an attribute on a
chain of parent objects starting at `app`:

```
app  ->  app.project  ->  Item / FolderItem / CompItem / FootageItem
       ->  Layer / AVLayer / TextLayer / ShapeLayer / ...
       ->  PropertyGroup (Layer's top group: "ADBE Root Properties")
       ->  PropertyGroup (e.g. "ADBE Transform Group", "ADBE Effect Parade")
       ->  Property (leaf)
```

`evalScript` from a CEP panel (or an external daemon driving
ExtendScript through `BridgeTalk` or a wrapper) returns the
**value** at the end of the script as a JSON-serializable string.
The script cannot return the AE object itself across the boundary;
it must serialize.

### `app` (Application object)

Source: `https://ae-scripting.docsforadobe.dev/general/application/`

| Attribute | Type | Notes |
| --- | --- | --- |
| `app.version` | String (RO) | Major version, e.g. `"25.0"` |
| `app.buildName`, `app.buildNumber` | String / Integer (RO) | Internal build id |
| `app.isoLanguage` | String (RO) | e.g. `"en_US"` |
| `app.project` | Project (RO) | Singleton for the open project |
| `app.activeViewer` | Viewer (RO) | Currently focused viewer panel |
| `app.fonts` | Fonts (RO) | System + installed fonts |
| `app.settings`, `app.preferences` | Settings / Preferences (RO) | |
| `app.memoryInUse` | Number (RO) | Live memory metric |
| `app.effects` | EffectCollection (RO) | **Installed** effects |
| `app.exitCode`, `app.onError`, `app.disableRendering` | mixed (RW) | Render-engine / error hooks |
| `app.isRenderEngine`, `app.isWatchFolder` | Boolean (RO) | Headless contexts |

Notable methods: `app.scheduleTask(string, delay, repeat)`,
`app.cancelTask(taskID)`, `app.beginUndoGroup(undoString)` /
`app.endUndoGroup()`, `app.findMenuCommandId(command)` /
`app.executeCommand(id)`, `app.purge(target)`,
`app.beginSuppressDialogs()` / `app.endSuppressDialogs(alert)`.

There is **no documented `app.activeItem`** attribute on the
Application object. `activeItem` is on the **Project** object. Some
third-party guides list `app.activeItem` informally; the canonical
access is `app.project.activeItem`.

### `app.project` (Project object)

Source: `https://ae-scripting.docsforadobe.dev/general/project/`

| Attribute | Type | Notes |
| --- | --- | --- |
| `project.activeItem` | Item or `null` | Front-most focused item |
| `project.numItems` | Integer | Total items including folders |
| `project.items` | ItemCollection | All items at root |
| `project.rootFolder` | FolderItem | Root folder |
| `project.selection` | Array of Item | Items selected in the Project panel |
| `project.file` | File or null | Project file (null if never saved) |
| `project.usedFonts` | Array | Font usage stats |
| `project.renderQueue` | RenderQueue | RQ entries |
| `project.expressionEngine` | String | `"extendscript"` or `"javascript-1.0"` |
| `project.dirty`, `project.revision` | Boolean / Integer | Save state |
| `project.xmpPacket` | String | Raw RDF/XML metadata |

`activeItem` is **not** the same as the open comp. In AE the "active
item" is what is currently focused in the Project panel; if a comp
viewer is focused, `activeItem` may return that `CompItem` or `null`
depending on focus state.

### `CompItem` (composition)

Source: `https://ae-scripting.docsforadobe.dev/compitem/compitem/`

Key attributes: `layers`, `numLayers`, `selectedLayers`,
`selectedProperties`, `duration`, `frameRate`, `width`, `height`,
`bgColor` (`[r, g, b]` 0.0–1.0), `workAreaStart`,
`workAreaDuration`, `shutterAngle`, `shutterPhase`, `motionBlur`,
`preserveNestedFrameRate`, `preserveNestedResolution`.

There is **no `selectedProperties` on the Project object**. The only
`selectedProperties` accessor the scripting guide documents is on
`CompItem` and on `Layer` (which inherits from `PropertyGroup`).
Project-level selection is exposed only as `project.selection`
(items, not properties).

### `Layer`, `AVLayer`, and friends

Source: `https://ae-scripting.docsforadobe.dev/layer/layer/` and
`https://ae-scripting.docsforadobe.dev/layer/avlayer/`

Common attributes across all layer types:

| Attribute | Type | Notes |
| --- | --- | --- |
| `layer.index` | Integer | Position in the parent comp's layer stack (1-based) |
| `layer.name` | String | Display name |
| `layer.parent` | Layer or null | Parent in a parenting chain |
| `layer.selected` | Boolean | Transient UI selection (not `selectedLayers`) |
| `layer.locked`, `layer.shy`, `layer.solo` | Boolean | Persistent flags |
| `layer.inPoint`, `layer.outPoint`, `layer.startTime`, `layer.stretch` | Float | Time controls |
| `layer.time` | Float | Current comp time at the layer's position |
| `layer.containingComp` | CompItem | The comp that owns this layer |
| `layer.selectedProperties` | Array of PropertyBase | Properties selected within this layer |
| `layer.marker` | PropertyGroup | Markers as a property group |
| `layer.comment`, `layer.label` | String / Integer | |
| `layer.autoOrient` | AutoOrientType enum | |

`AVLayer` adds: `source` (AVItem), `width`/`height`,
`adjustmentLayer`, `guideLayer`, `threeDLayer`, `effectsActive`,
`motionBlur`, `collapseTransformation`, `audioEnabled`/`hasAudio`/
`audioActive`, `blendingMode`, `quality`, `samplingQuality`,
`frameBlendingType`, `trackMatteType`, `trackMatteLayer`,
`timeRemapEnabled`, `canSetTimeRemapEnabled`, `environmentLayer`,
`isTrackMatte`.

Text, shape, camera, light, and 3D layers add layer-type-specific
attributes (text uses `layer.text.sourceText` as a Property; shape
layers expose contents under `"ADBE Vector Shape - Group"`).

### Property hierarchy (`Property` / `PropertyGroup` / `PropertyBase`)

Source: `https://ae-scripting.docsforadobe.dev/property/property/`
and `https://ae-scripting.docsforadobe.dev/property/propertygroup/`

- `PropertyGroup` extends `PropertyBase`. A `Layer` is itself a
  `PropertyGroup` whose root contains the indexed top groups
  `"ADBE Mask Parade"`, `"ADBE Effect Parade"`, and the
  `"ADBE Transform Group"` (the latter is **not** indexed —
  `numProperties` on a layer returns `3`).
- `PropertyGroup.property(index)` / `PropertyGroup.property(name)` /
  `PropertyGroup.properties` — read a child by 1-based index or by
  name (matches display name, match name, or expression selector).
  `propertyGroup(countUp)` walks up the tree. `addProperty(name)`
  creates a new `PropertyBase`.

`Property` (the leaf): `propertyValueType` (enum: `NO_VALUE`,
`ThreeD_SPATIAL`, `ThreeD`, `TwoD_SPATIAL`, `TwoD`, `OneD`,
`COLOR`, `CUSTOM_VALUE`, `MARKER`, `LAYER_INDEX`, `MASK_INDEX`,
`SHAPE`, `TEXT_DOCUMENT`); `expression` (string, read/write if
`canSetExpression`); `expressionEnabled`; `expressionError`;
`value` (current evaluated value); `numKeys`.

`PropertyBase` (parent of PropertyGroup and Property): `name`,
`matchName` (stable programmatic id, e.g. `"ADBE Position"`),
`propertyType` (`PROPERTY` / `INDEXED_GROUP` / `NAMED_GROUP`),
`numProperties`, `properties`, `enabled`, `canSetEnabled`,
`isModified`, `selected` (transient UI selection),
`parentProperty`.

Keyframe API (on `Property` only): `keyTime(keyIndex)`,
`keyValue(keyIndex)`, `addKey(time)`, `removeKey(keyIndex)`,
`setValueAtTime(time, newValue)`, `nearestKeyIndex(time)`,
`keySelected(keyIndex)`, `setInterpolationTypeAtKey(...)`,
`setTemporalEaseAtKey(...)`, `setSpatialTangentsAtKey(...)`. Marker
properties use the `markerComment` string form (only valid when
`propertyValueType === MARKER`).

### Effects on a layer

Effects are accessed as a property group named
**`"ADBE Effect Parade"`** on the layer. Each entry is a
`PropertyGroup` whose match name is the effect's stable id (e.g.
`"ADBE Gaussian Blur 2"`) and whose `displayName` is the user-facing
label.

- `layer.effects` — convenience array on `AVLayer` (alias to
  `"ADBE Effect Parade"`).
- `effect("ADBE Gaussian Blur 2")` — returns the effect by match name
  or display name.
- To enumerate: walk `layer.effects` (or
  `layer.property("ADBE Effect Parade").properties`).
- To add: `layer.property("ADBE Effect Parade").addProperty(matchName)`.

**Installed** effects (independent of any layer) are exposed via
`app.effects`, an `EffectCollection`. Each entry has `matchName`,
`displayName`, `category`, and the effect's internal property
descriptor tree. This is the canonical catalog for "what can I add
to this layer?".

### Expressions

Expression state lives on the `Property` itself: `expression` (string
source), `expressionEnabled` (toggle), `expressionError` (last error
string, empty when OK). The engine is governed by
`project.expressionEngine` (legacy ExtendScript or newer
JavaScript). There is **no built-in expression-edit event**; the
consumer must re-poll the property and compare against a cached
version.

### Footage and sources

`FootageItem.mainSource` is a `FootageSource`: `FileSource`
(`file`, `missingFootagePath`), `PlaceholderSource` (name only), or
`SolidSource` (`color`, `pixelAspect`, etc.). `CompItem` has no
`mainSource`; comps reference other items only through their layers.

### Project tree

`project.rootFolder.items` enumerates top-level items; each
`FolderItem` exposes its own `.items` collection. The project tree
is flat at the model level; folders are presentation only.

### AE version

`app.version` returns the major version string (e.g. `"25.0"` for AE
2025). For more granularity use `app.buildName` and
`app.buildNumber`.

---

## Object identity — handle vs snapshot

### ExtendScript handle behavior

ExtendScript returns **live object handles** within a single script
invocation. If two attribute reads return the same AE-side object,
the two JS handles compare equal. Across invocations:

- `evalScript` runs as a fresh execution. Any JS handle from a
  prior call is **not** carried into the next call. The caller
  can only re-fetch by path.
- Within a single execution, handles are stable. The AE-side
  object they point to is only stable until something in the
  project invalidates it.

### What invalidates a handle

The following invalidate **prior references**:

- **Reordering layers**: `layer.index` changes; `comp.layers[i]`
  now points at a different layer. Community guidance: "the index
  is positional in the current layer collection, not a persistent
  identity."
- **Removing a layer / item**: the handle becomes a dangling
  reference. Accessing attributes may throw or silently return
  stale data.
- **Renaming a layer**: any name-based re-resolution will miss it.
- **Project reload / undo across the handle's lifetime**: handle
  is invalidated.
- **Undo / redo**: an undo that recreates a layer typically
  returns a **different** handle.

The only stable identity is **`layer.id`** and **`item.id`**.
These IDs are exposed by the AE scripting API but are **not
officially documented as stable across project reload**.
Community convention treats the **path** (`comp.path /
layer.name / property.matchName`) as the stable identifier, and
re-resolves the handle on every snapshot.

### Recommended pattern for external tools

For ae-devtools the practical recommendation is:

1. **Treat every external snapshot as immutable data**, not as a
   live handle. The bridge returns a JSON tree; the bridge should
   re-derive the tree on each request.
2. **Identify objects by stable IDs**, not by JS handles:
   - `item.id` (project item) — stable for the project's lifetime.
   - `layer.index` (positional, 1-based) — stable **only as long
     as the layer order is unchanged**. Treat as a session-local
     cache key.
   - `layer.name` (display name) — unique within a comp by
     convention, but renames are not prohibited.
   - `property.matchName` — stable across renames and reorder.
   - `property.propertyIndex` (1-based position in parent) —
     positional.
3. **For long-running watches**, define an ID format the daemon
   emits: `{projectPath}::{compName}::{layerIndexOrId}::{propertyPath}`.
   The consumer keeps this string; on each tick, the daemon
   re-resolves against the live project and emits the freshest
   snapshot. The consumer never holds an AE handle.
4. **Subscribe to the change stream**, not the object. The
   daemon's output is a stream of "this ID changed; here is its
   new snapshot" events (see "Change events" below).

### Standard pattern in existing tools

The community uses the `comp("name")` / `layer("name")` lookup forms
for script-side re-resolution. `aenhancers.com` is explicit: "Use
`comp('name')` for explicit references, or `activeItem` for
context-sensitive references." External tools that wrap AE scripting
(aequery, AE Console, AEXMLSocket-based tooling) all serialize
snapshots to JSON and never hand an AE handle back to the host.

---

## Change events

After Effects does **not** expose a general event stream for
"selection changed", "active comp changed", "property changed",
"expression changed", "layer added", "item added", or "project
modified". The scripting API has no `app.addEventListener(...)`,
no `project.addEventListener(...)`, no `comp.addEventListener(...)`,
and no `property.addEventListener(...)`. Confirmed by:

- The official scripting guide lists no events on `app`, `project`,
  `CompItem`, `Layer`, `Property`, or `PropertyGroup`.
- Adobe Community thread "CEP extension development — How to
  detect user selection changes in active project" (2024-05):
  explicitly states no built-in way exists.
- Creative COW "CEP Panel: Event Listener Layer Selection"
  (2024-2025): confirms CSInterface has no AE selection event; the
  working pattern is to poll with `setInterval`.

What **does** exist:

### CSInterface events (panel-side, OS-level)

`CSInterface` exposes a small set of host-level events that have
nothing to do with project state: `WindowStateChanged` (panel
show/hide), `ApplicationActivated` (host focus),
`ThemeColorChanged`, `LocaleChanged`, `ProfileChanged`. These are
useful for panel UX but **do not fire on AE project state
changes**.

### Custom CEP events (`CSEvent`)

`CSInterface` (panel JS) and `CSInterface` (ExtendScript, in newer
hosts) support dispatching custom events on the
`com.adobe.csxs.events.*` namespace — the **only** event channel
that lets ExtendScript push notifications to the panel side:

```javascript
// From ExtendScript:
var cs = new CSInterface();              // available in CEP 11+
var ev = new CSEvent("com.adobe.csxs.events.MySignal", "APPLICATION");
ev.data = JSON.stringify({ kind: "selectionChanged" });
cs.dispatchEvent(ev);
```

```javascript
// From panel JS:
csInterface.addEventListener("com.adobe.csxs.events.MySignal", function (evt) {
    var data = JSON.parse(evt.data);
    // ...
});
```

This does not solve the "AE project changed in the UI" problem on
its own — something on the ExtendScript side has to detect the
change and dispatch the event.

### `app.scheduleTask` (ExtendScript-side polling)

`app.scheduleTask(stringToExecute, delay, repeat)` is the documented
mechanism for a periodic ExtendScript callback:

- `stringToExecute` — a **string** evaluated in global scope (not a
  closure); local variables are not visible.
- `delay` — milliseconds before the first run (Float).
- `repeat` — milliseconds between subsequent runs; **omit for
  one-shot**.
- Returns a `taskID` that `app.cancelTask(taskID)` can cancel.

Caveats: scheduled strings evaluate in global scope (workaround:
state on `$.global`, a `ScriptUI` panel object, or a file);
modal dialogs pause scheduled tasks; in dockable panels the
panel's `this` is not in the eval scope; polling every 500 ms
against a large project can be slow; no clean shutdown short of a
re-schedule guard.

Realistic polling intervals in community tooling: 100–250 ms for
"feels real-time" UI sync, 500–1000 ms for selection / active
comp polling (typical), 2–5 s for project-level metadata.

### `$.sleep(ms)` (blocking)

ExtendScript provides `$.sleep(milliseconds)`, which yields the
engine but blocks the current script. Useful inside a
manually-driven loop but **not a substitute for `scheduleTask`** —
`$.sleep` does not fire callbacks; it merely pauses the current
thread.

### Realistic feasibility of event-driven UI sync

Given that AE exposes no project-state events, the practical model
for ae-devtools is:

1. **ExtendScript-side poller.** A long-running ExtendScript
   registers a `scheduleTask` loop. Each tick computes a small
   "diff" (active comp id, selected layer indices, hash of
   selected properties, expression source on a watched property)
   and dispatches a `CSEvent` only when something changed.
2. **Panel-side consumer.** The panel listens via
   `CSInterface.addEventListener`. On receipt, it re-fetches a
   snapshot via `evalScript`. Because the event only fires on
   actual change, this is much cheaper than polling from the
   panel side.
3. **External daemon fallback.** If the panel is not running, the
   same poller can `$.writeln` JSON, write to a file, or push to
   a TCP socket (using ExtendScript's `Socket` object or
   `system.callSystem`).

This three-tier model (ExtendScript timer → event → snapshot) is
the established pattern. Rate limit is the ExtendScript engine's
throughput: each `evalScript` call crosses a process boundary.

### Per-event-type summary

| Change type | Event API | Polling needed | Notes |
| --- | --- | --- | --- |
| Active comp changed (`project.activeItem`) | none | yes (≈500 ms) | Standard pattern |
| Layer selection changed (`comp.selectedLayers`) | none | yes (≈500 ms) | Confirmed in Creative COW thread |
| Property selection changed | none | yes (≈500 ms) | Same channel |
| Layer added / removed / reordered | none | yes (≈500 ms) | Detect via `comp.numLayers` and `layer.index` |
| Property value changed | none | yes | No value-change event |
| Expression source changed | none | yes | Compare `property.expression` to cached |
| Project item added / removed / renamed | none | yes | Detect via `project.numItems`, `project.rootFolder.items` |
| Window state (panel show / hide) | `WindowStateChanged` | no | CEP `CSInterface` |
| Application focus | `ApplicationActivated` | no | CEP `CSInterface` |
| UI theme | `ThemeColorChanged` | no | CEP `CSInterface` |

---

## Evidence

All URLs accessed **2026-09-18**.

- `https://ae-scripting.docsforadobe.dev/` and its subpages
  (`general/application/`, `general/project/`, `compitem/compitem/`,
  `layer/layer/`, `layer/avlayer/`, `property/property/`,
  `property/propertygroup/`, `other/glob.html`) — authoritative
  scripting guide; confirms attribute-driven model, no app-level
  events.
- `https://extendscript.docsforadobe.dev/user-interface-tools/defining-behavior-with-event-callbacks-and-listeners/`
  — confirms `addEventListener` is for **UI control** events,
  not AE state.
- `https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html`
  — official Adobe scripting introduction.
- `https://community.adobe.com/t5/after-effects-discussions/cep-extension-development-how-to-detect-user-selection-changes-in-active-project/m-p/1424843`
  — confirms no built-in selection-change event; only pattern is
  to poll `app.project.activeItem.selectedLayers`.
- `https://creativecow.net/forums/thread/cep-panel-event-listener-layer-selection/`
  — working example of polling `selectedLayers` every 1 s via
  `CSInterface.evalScript`.
- `https://creativecow.net/forums/thread/appscheduletask/`,
  `https://github.com/TLKorjak/copy-ease-values-script/blob/main/Knowledge%20Base/reference_ae_egp_scripting.md`
  — `app.scheduleTask` polling pattern, eval-string scope
  limitation, modal-dialog pause caveat.
- `https://github.com/pushREC/after-effects-sdk-kb/blob/main/scripting/01-extendscript-complete-reference.md`
  — Property / PropertyGroup / Effect reference; keyframe API.
- `https://aenhancers.com/jsobjectref` — community convention
  "Use `comp('name')` for explicit references, or `activeItem`
  for context-sensitive references."
- `https://helpx.adobe.com/after-effects/using/selected-layers-active-item-and-the-active-composition.html`
  — user-facing docs for active item and active comp.
- `https://ivg-design.github.io/cep/`, `https://forums.adobe.com/thread/1331599`
  — community CEP docs; code for enumerating installed effects
  via `app.effects`.

---

## Unverified items

- **`layer.id` / `item.id` stability across project reload.** The
  scripting guide exposes these as attributes on `Layer` and
  `Item`, but Adobe does not document their persistence across
  "Save → Quit → Reload". Community tooling treats them as
  session-local and uses path-based IDs for persistence.
- **Exact `app.scheduleTask` repeat granularity.** Community
  references suggest the engine rounds `repeat` to ~10–30 ms
  granularity on Windows; Adobe does not publish the behavior.
- **`app.activeItem` on the Application object.** Some older
  guides mention it directly; the current official guide places
  `activeItem` on `Project` only. May have been a CS6-era alias.
- **`expression.canSetExpression` availability.** Whether it is
  a public, documented attribute varies by AE version.
- **CSInterface availability from ExtendScript inside AE.** The
  ExtendScript Toolkit historically did not expose
  `CSInterface`; newer AE versions (CEP 11/12 era) appear to,
  but Adobe does not formally commit to this.
- **Behavior of `selectedLayers` when the active comp is a viewer
  panel vs. the Project panel.** Community says it can return
  `[]` when no composition viewer is focused.

---

## Working assumptions for ae-devtools

1. **Snapshotting is the primary mode.** Every external tool
   re-fetches on demand via `evalScript` and treats the response
   as immutable data.
2. **Stable IDs are path-based.** Use
   `{projectPath}::{compName}::{layerIndexOrName}::{propertyPath}`
   where `propertyPath` is match-names from the layer root down.
   `layer.index` is acceptable as a session-local key only.
3. **Change detection is poll-based, with smart throttling.** An
   ExtendScript-side `app.scheduleTask` loop computes a small diff
   (active comp id + selected layer indices + hash of selected
   property match-names) every ~500 ms and dispatches a `CSEvent`
   only on change.
4. **Panel-side receives the change event, then fetches the full
   snapshot.** The custom `CSEvent` carries the bare minimum
   (changed IDs); the panel re-queries `evalScript` for full state.
5. **External daemon support.** The same ExtendScript poller can
   write the diff to a file or socket for consumers without a CEP
   panel.
6. **No reliance on undocumented attribute stability.** Treat
   every AE handle as if it might be invalidated by the next undo.

These assumptions should be revisited when Adobe publishes updated
scripting docs (which historically lag AE releases by 1–2 years).
