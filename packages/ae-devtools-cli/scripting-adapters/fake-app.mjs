/*
 * fake-app.mjs — minimal ExtendScript `app` surface for adapter tests.
 *
 * Fake/mock only: implements just enough of the AE Scripting object
 * model for the #15 operations (project items, comps, layers,
 * Transform>Position) so generated adapter sources can actually run in
 * the agent-loop fake host. NOT After Effects; unimplemented members
 * throw, matching how a real host fails on absent API.
 *
 * Collections are 1-based like ExtendScript: items[1] is the first
 * element (implemented via Proxy over a 0-based JS array).
 */

// Host-object classes so generated `instanceof` checks work exactly
// like ExtendScript. Display names (typeName) stay for reporting only.
class AVItem {}
class CompItem extends AVItem {}
class FolderItem {}
class FootageItem extends AVItem {}

function collection(list, extra = {}) {
  return new Proxy(extra, {
    get(target, prop) {
      if (prop === "length") return list.length;
      if (typeof prop === "string" && /^[1-9]\d*$/.test(prop)) {
        return list[Number(prop) - 1];
      }
      if (prop in target) return target[prop];
      return list[prop];
    },
  });
}

/*
 * Project-panel hierarchy model (Issue #291).
 *
 * `owner` is the flat project item list backing app.project.items /
 * Project.item(i) / Project.numItems / Project.itemByID(). Folder
 * membership lives in each FolderItem.__children; the root folder's
 * __children are the top-level Project panel rows. parentFolder is the
 * documented move API; cycles and removed items are refused like the
 * real host is expected to refuse them (exact host error text remains
 * a real-host verification item).
 */
function nextOwnerId(owner) {
  owner.__nextItemId = (owner.__nextItemId || 0) + 1;
  return owner.__nextItemId;
}

function initItemShell(item, name, typeName, owner, parent) {
  item.name = name;
  item.typeName = typeName;
  item.id = nextOwnerId(owner);
  item.label = 0;
  item.comment = "";
  item.__owner = owner;
  item.__parent = parent;
  item.__selected = false;
  item.__removed = false;
  item.__isRoot = false;
  item.__children = item instanceof FolderItem ? [] : null;
  Object.defineProperty(item, "parentFolder", {
    get() {
      if (item.__removed) throw new Error("fake-app: item has been removed");
      return item.__parent;
    },
    set(folder) { setItemParent(item, folder); },
    configurable: true,
  });
  Object.defineProperty(item, "selected", {
    get() { return item.__selected === true; },
    set(v) {
      if (item.__removed) throw new Error("fake-app: item has been removed");
      item.__selected = v === true;
    },
    configurable: true,
  });
  item.remove = function removeItem() { removeItemTree(item); };
  if (item instanceof FolderItem) {
    Object.defineProperty(item, "numItems", {
      get() { return item.__children.length; },
      configurable: true,
    });
    item.item = function folderItem(index) {
      if (!Number.isInteger(index) || index < 1 || index > item.__children.length) return null;
      return item.__children[index - 1];
    };
    item.items = collection(item.__children, {
      addComp(cname, w, h, par, dur, frameRate) {
        const c = makeComp(cname, w, h, par, dur, owner, item);
        c.frameRate = frameRate;
        return c;
      },
      addFolder(fname) { return makeFolder(fname, owner, item); },
    });
  }
  return item;
}

function adoptItem(item, name, typeName, owner, parent) {
  initItemShell(item, name, typeName, owner, parent);
  owner.push(item);
  if (parent !== null && parent !== undefined && parent.__children) parent.__children.push(item);
  return item;
}

function makeFolder(name, owner, parent) {
  return adoptItem(new FolderItem(), name, "Folder", owner, parent);
}

function setItemParent(item, folder) {
  if (item.__removed) throw new Error("fake-app: item has been removed");
  if (item.__isRoot) throw new Error("fake-app: project root folder cannot be reparented");
  if (!(folder instanceof FolderItem)) throw new Error("fake-app: parentFolder must be a FolderItem");
  if (folder.__removed) throw new Error("fake-app: parent folder has been removed");
  if (folder === item) throw new Error("fake-app: item cannot be its own parentFolder");
  for (var cur = folder; cur; cur = cur.__parent) {
    if (cur === item) throw new Error("fake-app: parentFolder would create a cycle");
  }
  var old = item.__parent;
  if (old !== null && old !== undefined && old.__children) {
    var oi = old.__children.indexOf(item);
    if (oi >= 0) old.__children.splice(oi, 1);
  }
  item.__parent = folder;
  folder.__children.push(item);
}

function collectItemTree(item, out) {
  out.push(item);
  if (item instanceof FolderItem && item.__children) {
    for (var i = 0; i < item.__children.length; i++) collectItemTree(item.__children[i], out);
  }
  return out;
}

function removeItemTree(item) {
  if (item.__removed) throw new Error("fake-app: item has been removed");
  if (item.__isRoot) throw new Error("fake-app: project root folder cannot be removed");
  var doomed = collectItemTree(item, []);
  for (var i = 0; i < doomed.length; i++) {
    var d = doomed[i];
    d.__removed = true;
    var p = d.__parent;
    if (p !== null && p !== undefined && p.__children) {
      var pi = p.__children.indexOf(d);
      if (pi >= 0) p.__children.splice(pi, 1);
    }
    var o = d.__owner;
    if (o) {
      var oi = o.indexOf(d);
      if (oi >= 0) o.splice(oi, 1);
    }
  }
  for (var j = 0; j < doomed.length; j++) {
    if (doomed[j].__children) doomed[j].__children.length = 0;
  }
}

function panelOrderItems(folder, out) {
  for (var i = 0; i < folder.__children.length; i++) {
    var child = folder.__children[i];
    out.push(child);
    if (child instanceof FolderItem) panelOrderItems(child, out);
  }
  return out;
}

// ExtendScript enum stand-ins (Issue #287). Numeric values follow the
// community reference ordering; they are placeholders for round-trip
// testing only — real-host numeric values must be confirmed during
// real-host verification (#21/#172). Generated sources reference the
// enum NAMES via globals, never these literals.
export const KeyframeInterpolationType = { BEZIER: 1, LINEAR: 2, HOLD: 3 };
export const TrackMatteType = {
  NO_TRACK_MATTE: 0, ALPHA: 1, ALPHA_INVERTED: 2, LUMA: 3, LUMA_INVERTED: 4,
};

function makeProperty(value, opts = {}) {
  const expressionAllowed = opts.expressionAllowed !== false;
  const prop = {
    value,
    __keys: [],
    matchName: opts.matchName ?? null,
    minValue: opts.minValue ?? null,
    maxValue: opts.maxValue ?? null,
    // PropertyValueType enum stand-in: null = fake has no type model.
    propertyValueType: opts.propertyValueType ?? null,
    __exprEnabled: false,
    numKeys: 0,
    isTimeVarying: false,
    // Real API: keyIndex is the 1-based keyframe INDEX, not a time.
    keyTime(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + i);
      }
      return this.__keys[i - 1].time;
    },
    keyValue(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + i);
      }
      const v = this.__keys[i - 1].value;
      return Array.isArray(v) ? v.slice() : v;
    },
    canSetExpression: expressionAllowed,
    expressionError: "",
    // expressionEnabled honors canSetExpression like the real host:
    // enabling on a non-expressionable property throws.
    get expressionEnabled() { return this.__exprEnabled; },
    set expressionEnabled(v) {
      if (v === true && !expressionAllowed) {
        throw new Error("fake-app: expression not allowed on this property");
      }
      this.__exprEnabled = v === true;
    },
    setValue(v) { this.value = Array.isArray(v) ? v.slice() : v; },
    // Real API: keyIndex is the 1-based keyframe INDEX, not a time.
    // Out-of-range indexes throw; they do not append.
    setValueAtKey(keyIndex, v) {
      if (!Number.isInteger(keyIndex) || keyIndex < 1 || keyIndex > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + keyIndex);
      }
      const k = this.__keys[keyIndex - 1];
      k.value = Array.isArray(v) ? v.slice() : v;
      this.value = k.value;
    },
    // Real API: time-based keyframing adds or updates the key at t.
    setValueAtTime(t, v) {
      for (var i = 0; i < this.__keys.length; i++) {
        if (this.__keys[i].time === t) {
          this.__keys[i].value = Array.isArray(v) ? v.slice() : v;
          this.value = this.__keys[i].value;
          return;
        }
      }
      this.__keys.push({
        time: t, value: Array.isArray(v) ? v.slice() : v,
        inType: KeyframeInterpolationType.BEZIER, outType: KeyframeInterpolationType.BEZIER,
        easeIn: { speed: 0, influence: 33.33 }, easeOut: { speed: 0, influence: 33.33 },
      });
      this.numKeys = this.__keys.length;
      this.isTimeVarying = this.numKeys > 0;
      this.value = this.__keys[this.__keys.length - 1].value;
    },
    // Real API: removes the keyframe at a 1-based key INDEX; out of
    // range throws (same contract as setValueAtKey).
    removeKey(keyIndex) {
      if (!Number.isInteger(keyIndex) || keyIndex < 1 || keyIndex > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + keyIndex);
      }
      this.__keys.splice(keyIndex - 1, 1);
      this.numKeys = this.__keys.length;
      this.isTimeVarying = this.numKeys > 0;
    },
    // Keyframe interpolation (Issue #287). Types are the numeric enum
    // stand-ins above; invalid types throw like the real host.
    isInterpolationTypeValid(t) {
      return t === KeyframeInterpolationType.BEZIER ||
             t === KeyframeInterpolationType.LINEAR ||
             t === KeyframeInterpolationType.HOLD;
    },
    keyInInterpolationType(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) throw new Error("fake-app: invalid keyframe index " + i);
      return this.__keys[i - 1].inType;
    },
    keyOutInterpolationType(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) throw new Error("fake-app: invalid keyframe index " + i);
      return this.__keys[i - 1].outType;
    },
    setInterpolationTypeAtKey(keyIndex, inType, outType) {
      if (!Number.isInteger(keyIndex) || keyIndex < 1 || keyIndex > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + keyIndex);
      }
      if (!this.isInterpolationTypeValid(inType) || !this.isInterpolationTypeValid(outType)) {
        throw new Error("fake-app: invalid interpolation type");
      }
      const k = this.__keys[keyIndex - 1];
      k.inType = inType; k.outType = outType;
    },
    keyInTemporalEase(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) throw new Error("fake-app: invalid keyframe index " + i);
      const e = this.__keys[i - 1].easeIn;
      return { speed: e.speed, influence: e.influence };
    },
    keyOutTemporalEase(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) throw new Error("fake-app: invalid keyframe index " + i);
      const e = this.__keys[i - 1].easeOut;
      return { speed: e.speed, influence: e.influence };
    },
    setTemporalEaseAtKey(keyIndex, inEase, outEase) {
      if (!Number.isInteger(keyIndex) || keyIndex < 1 || keyIndex > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + keyIndex);
      }
      for (const e of [inEase, outEase]) {
        if (e === null || typeof e !== "object" ||
            typeof e.speed !== "number" || !isFinite(e.speed) ||
            typeof e.influence !== "number" || !isFinite(e.influence)) {
          throw new Error("fake-app: temporal ease requires {speed,influence} numbers");
        }
      }
      const k = this.__keys[keyIndex - 1];
      k.easeIn = { speed: inEase.speed, influence: inEase.influence };
      k.easeOut = { speed: outEase.speed, influence: outEase.influence };
    },
    // Approximation: returns the value of the last key at-or-before t
    // (AE interpolates; the fake only needs a deterministic, honest
    // read-back for contract tests — not motion-accurate sampling).
    valueAtTime(t) {
      if (this.numKeys === 0) return Array.isArray(this.value) ? this.value.slice() : this.value;
      var v = this.__keys[0].value;
      for (var i = 0; i < this.__keys.length; i++) {
        if (this.__keys[i].time <= t) v = this.__keys[i].value;
        else break;
      }
      return Array.isArray(v) ? v.slice() : v;
    },
    get expression() { return this.__expr || ""; },
    set expression(v) {
      if (!expressionAllowed) throw new Error("fake-app: expression not allowed on this property");
      this.__expr = String(v);
    },
    property(name) {
      if (name === "Position" || name === "ADBE Position") return makeProperty([0, 0]);
      throw new Error("fake-app: no such property " + name);
    },
  };
  return prop;
}

// Minimal Effect Parade group: addProperty(matchName) like real AE.
const KNOWN_EFFECTS = ["ADBE Gaussian Blur 2", "ADBE Tint", "ADBE Drop Shadow", "ADBE Linear Wipe"];

function makeFxGroup(layer) {
  const fx = [];
  return {
    __list: fx,
    numProperties: 0,
    canAddProperty(matchName) { return KNOWN_EFFECTS.indexOf(matchName) !== -1; },
    addProperty(matchName) {
      // Real AE rejects matchNames that are not installed effects.
      if (KNOWN_EFFECTS.indexOf(matchName) === -1) {
        throw new Error("fake-app: unknown effect matchName " + matchName);
      }
      const e = {
        name: matchName, matchName, enabled: true,
        // Fake fixture: effect params are modeled as non-expressionable
        // to exercise the canSetExpression guard; real params vary.
        property(n) { return makeProperty(0, { expressionAllowed: false, matchName: n }); },
      };
      fx.push(e);
      this.numProperties = fx.length;
      return e;
    },
    property(n) {
      const hit = fx.filter((e) => e.matchName === n || e.name === n);
      if (hit.length === 1) return hit[0];
      throw new Error("fake-app: effect not found: " + n);
    },
  };
}

function makeLayer(name, comp, kind) {
  kind = kind || "av";
  const layer = {
    name,
    comp,
    index: 0,
    kind, // fake-only discriminator: "av"|"text"|"camera"|"light"|"null"|"solid"
    __parent: null,
    enabled: true,
    locked: false,
    solo: false,
    shy: false,
    label: 0,
    comment: "",
    startTime: 0,
    stretch: 100,
    audioEnabled: true,
    threeDLayer: false,
    motionBlur: false,
    guideLayer: false,
    // Render/stacking flags (Issue #285). preserveTransparency defaults
    // true to match the common footage-layer case.
    adjustmentLayer: false,
    preserveTransparency: true,
    frameBlending: false,
    collapseTransformation: false,
    timeRemapEnabled: false,
    // Track matte state (Issue #287): {layer, type} or null. The matte
    // layer's __isTrackMatte flag mirrors the real host behavior.
    __trackMatte: null,
    __isTrackMatte: false,
    // AVLayer.source model (Issue #289): replaced via replaceSource.
    // Solid/text/null/camera/light layers have no footage source in
    // the fake (null); only replaceSource-populated values are read.
    __source: null,
    inPoint: 0,
    outPoint: comp ? comp.duration : 0,
    __pos: makeProperty([0, 0], { matchName: "ADBE Position" }),
    __fx: null,
    // TextDocument model: only text layers carry one. The real API
    // reaches it via the matchName path Text Properties > Text Document.
    __textDoc: kind === "text" ? {
      text: "",
      pointText: true,
      boxText: false,
      // TextDocument style fields (Issue #285). Defaults are the fake's
      // approximation of AE's defaults — real-host defaults may differ.
      font: "ArialMT",
      fontSize: 100,
      fontStyle: "Regular",
      justification: 0,
      fillColor: [0, 0, 0],
      tracking: 0,
      leading: 0,
    } : null,
    property(group) {
      // Real AE resolves both display name and matchName; we only
      // implement the stable matchName path adapters must use.
      if (group === "ADBE Transform Group" || group === "Transform") {
        return {
          property(sub) {
            if (sub === "ADBE Position" || sub === "Position") return layer.__pos;
            if (sub === "ADBE Anchor Point" || sub === "Anchor Point") return makeProperty([0, 0], { matchName: sub });
            throw new Error("fake-app: no such transform property " + sub);
          },
          addProperty(mn) { throw new Error("fake-app: cannot add property to transform group"); },
        };
      }
      if (group === "ADBE Effect Parade" || group === "Effects") {
        if (layer.__fx === null) layer.__fx = makeFxGroup(layer);
        return layer.__fx;
      }
      if (group === "ADBE Text Properties" || group === "Text") {
        if (layer.__textDoc === null) {
          throw new Error("fake-app: layer has no text document (not a text layer)");
        }
        return {
          property(sub) {
            if (sub === "ADBE Text Document" || sub === "Source Text") return layer.__textDoc;
            throw new Error("fake-app: no such text property " + sub);
          },
        };
      }
      throw new Error("fake-app: no such property group " + group);
    },
    // AVLayer.source / replaceSource (Issue #289). The fake accepts
    // FootageItem only — real AE accepts any AVItem and checks usage;
    // that restriction is a real-host verification item.
    get source() { return layer.__source; },
    replaceSource(item) {
      if (!(item instanceof FootageItem)) {
        throw new Error("fake-app: replaceSource requires a FootageItem");
      }
      layer.__source = item;
      return item;
    },
    // Fake approximation: every modeled AV layer can time-remap.
    // Real AE restricts this (e.g. no time remap on some layer types);
    // that gate is a real-host verification item.
    canSetTimeRemapEnabled() { return true; },
    hasTrackMatte() { return layer.__trackMatte !== null; },
    get isTrackMatte() { return layer.__isTrackMatte === true; },
    get trackMatteLayer() { return layer.__trackMatte === null ? null : layer.__trackMatte.layer; },
    get trackMatteType() { return layer.__trackMatte === null ? 0 : layer.__trackMatte.type; },
    setTrackMatte(matteLayer, type) {
      // Clearing via NO_TRACK_MATTE (0) detaches without a layer arg.
      if (type === TrackMatteType.NO_TRACK_MATTE || type === 0) {
        if (layer.__trackMatte !== null) layer.__trackMatte.layer.__isTrackMatte = false;
        layer.__trackMatte = null;
        return;
      }
      if (matteLayer === null || matteLayer === undefined || matteLayer === layer) {
        throw new Error("fake-app: setTrackMatte requires a different matte layer");
      }
      if (![1, 2, 3, 4].includes(type)) throw new Error("fake-app: invalid track matte type");
      if (layer.__trackMatte !== null) layer.__trackMatte.layer.__isTrackMatte = false;
      layer.__trackMatte = { layer: matteLayer, type };
      matteLayer.__isTrackMatte = true;
    },
    removeTrackMatte() {
      if (layer.__trackMatte !== null) layer.__trackMatte.layer.__isTrackMatte = false;
      layer.__trackMatte = null;
    },
    moveToBeginning() { comp.__moveLayer(layer, "top"); },
    moveToEnd() { comp.__moveLayer(layer, "bottom"); },
    duplicate() {
      const l = makeLayer(this.name + " copy", comp, this.kind);
      l.__source = this.__source;
      if (l.__textDoc !== null && this.__textDoc !== null) {
        for (var k in this.__textDoc) l.__textDoc[k] = this.__textDoc[k];
      }
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    remove() {
      const i = comp.__layers.indexOf(layer);
      if (i >= 0) comp.__layers.splice(i, 1);
      comp.__reindex();
    },
  };
  // Real AE rejects self-parenting and parent cycles; model both.
  Object.defineProperty(layer, "parent", {
    get() { return layer.__parent; },
    set(p) {
      if (p === layer) throw new Error("fake-app: layer cannot parent itself");
      for (var cur = p; cur; cur = cur.__parent) {
        if (cur === layer) throw new Error("fake-app: parenting would create a cycle");
      }
      layer.__parent = p;
    },
  });
  return layer;
}

function makeComp(name, w, h, par, dur, owner, parent) {
  const comp = new CompItem();
  adoptItem(comp, name, "Composition", owner, parent);
  Object.assign(comp, {
    width: w,
    height: h,
    pixelAspect: par,
    duration: dur,
    __layers: [],
    __reindex() { comp.__layers.forEach((l, i) => { l.index = i + 1; }); },
    resolutionFactor: 1,
    label: 0,
    comment: "",
    // Comp settings (Issue #289). Defaults are the fake's approximation
    // of AE defaults — real-host defaults may differ.
    bgColor: [0, 0, 0],
    displayStartTime: 0,
    displayStartFrame: 0,
    shutterAngle: 180,
    shutterPhase: 0,
    motionBlur: false,
    frameBlending: false,
    draft3d: false,
    hideShyLayers: false,
    preserveNestedFrameRate: true,
    dropFrame: false,
    duplicate() {
      const d = makeComp(this.name + " copy", this.width, this.height,
        this.pixelAspect, this.duration, owner, this.__parent);
      d.frameRate = this.frameRate;
      for (const k of ["bgColor","displayStartTime","displayStartFrame","shutterAngle","shutterPhase",
        "motionBlur","frameBlending","draft3d","hideShyLayers","preserveNestedFrameRate","dropFrame"]) {
        d[k] = Array.isArray(this[k]) ? this[k].slice() : this[k];
      }
      for (const l of this.__layers) {
        const nl = makeLayer(l.name, d, l.kind);
        if (nl.__textDoc !== null && l.__textDoc !== null) nl.__textDoc.text = l.__textDoc.text;
        nl.startTime = l.startTime;
        nl.stretch = l.stretch;
        nl.solo = l.solo;
        nl.shy = l.shy;
        nl.label = l.label;
        nl.locked = l.locked;
        d.__layers.push(nl);
      }
      d.__reindex();
      return d;
    },
    __moveLayer(layer, to) {
      const i = comp.__layers.indexOf(layer);
      if (i < 0) return;
      comp.__layers.splice(i, 1);
      if (to === "top") comp.__layers.unshift(layer); else comp.__layers.push(layer);
      comp.__reindex();
    },
  });
  Object.defineProperty(comp, "numLayers", { get() { return comp.__layers.length; } });
  comp.layers = collection(comp.__layers, {
    addNull(d) {
      const l = makeLayer("Null " + (comp.__layers.length + 1), comp, "null");
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    // Real signature: addSolid(color, name, width, height, pixelAspect, duration).
    // The fake keeps the solid spec so read-back can verify it persisted.
    addSolid(color, lname, w2, h2, par2, d2) {
      const l = makeLayer(lname, comp, "solid");
      l.__solid = {
        color: Array.isArray(color) ? color.slice() : color,
        width: w2, height: h2, pixelAspect: par2, duration: d2,
      };
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    addText(tname) {
      const l = makeLayer(tname, comp, "text");
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    addCamera(cname, centerPoint) {
      if (!Array.isArray(centerPoint) || centerPoint.length !== 2 ||
          centerPoint.some((v) => typeof v !== "number" || !isFinite(v))) {
        throw new Error("fake-app: addCamera requires centerPoint [x, y]");
      }
      const l = makeLayer(cname, comp, "camera");
      l.threeDLayer = true;
      l.__centerPoint = centerPoint.slice();
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    // Real signature: addLight(name, centerPoint). Light type and
    // intensity are LightLayer properties, not creation arguments.
    addLight(lname, centerPoint) {
      if (!Array.isArray(centerPoint) || centerPoint.length !== 2 ||
          centerPoint.some((v) => typeof v !== "number" || !isFinite(v))) {
        throw new Error("fake-app: addLight requires centerPoint [x, y]");
      }
      const l = makeLayer(lname, comp, "light");
      l.threeDLayer = true;
      l.__centerPoint = centerPoint.slice();
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
  });
  return comp;
}

// ImportOptions is a global ExtendScript constructor (not app.*).
// The fake models only the file attribute; importAs variants are a
// recorded non-claim until a batch needs them.
export class ImportOptions {
  constructor() {
    this.file = null;
    this.importAs = null;
  }
}

function makeFootage(path, owner, parent) {
  const f = new FootageItem();
  const base = String(path).split("/").pop().split("\\").pop();
  adoptItem(f, base, "Footage", owner, parent);
  Object.assign(f, {
    duration: 10,
    width: 1920,
    height: 1080,
    pixelAspect: 1,
    frameRate: 30,
    footageMissing: false,
    hasVideo: true,
    hasAudio: false,
    frameDuration: 1 / 30,
    useProxy: false,
    // FootageSource model: fields the read ops consume. Fake defaults —
    // real values depend on the imported media.
    mainSource: {
      file: { fsName: String(path) },
      alphaMode: "IGNORE",
      hasAlpha: false,
      isStill: false,
      loop: false,
      conformFrameRate: true,
      nativeFrameRate: 30,
      missingFootagePath: "",
      reload() {},
    },
  });
  return f;
}

export function createAdapterFakeApp() {
  const items = [];
  const renderItems = [];
  // Virtual project root: not part of the flat item list, but its
  // children are the top-level Project panel rows.
  const rootFolder = initItemShell(new FolderItem(), "Root", "Folder", items, null);
  rootFolder.__isRoot = true;
  rootFolder.id = 0;
  const clearProjectItems = () => {
    for (const it of items) it.__removed = true;
    items.length = 0;
    rootFolder.__children.length = 0;
    items.__nextItemId = 0;
    project.activeItem = null;
  };
  const project = {
    activeItem: null,
    save() {},
    close() {},
    file: { fsName: "/tmp/fake.aep" },
    // Project settings read surface (Issue #281 batch 3). Fake defaults
    // only — real values depend on host/project state.
    bitsPerChannel: 16,
    expressionEngine: 2,
    displayStartFrame: 0,
    framesUseFeetFrames: false,
    footageTimecodeDisplayStartType: 0,
    importFile(io) {
      if (io === null || io.file === null || io.file === undefined) {
        throw new Error("fake-app: ImportOptions.file is required");
      }
      if (io.file.exists === false) {
        throw new Error("fake-app: import file not found: " + io.file.fsName);
      }
      return makeFootage(io.file.fsName, items, rootFolder);
    },
    renderQueue: {
      rendering: false,
      __rendered: 0,
      items: collection(renderItems, {
        add(comp) {
          const it = {
            comp, index: renderItems.length + 1,
            // RQItemStatus enum value; fake uses the queued constant.
            status: 1,
            timeSpanStart: 0,
            timeSpanDuration: comp.duration,
            // Issue #289: queue item control fields (fake defaults).
            startTime: 0,
            skipFrames: 0,
            logType: 0,
            elapsedSeconds: 0,
            duplicate() {
              // Copies the RECEIVER's settings (this === source item).
              const src = this;
              const d = {
                comp: src.comp, index: 0, status: 1,
                timeSpanStart: src.timeSpanStart, timeSpanDuration: src.timeSpanDuration,
                startTime: src.startTime, skipFrames: src.skipFrames,
                logType: src.logType, elapsedSeconds: 0,
                __om: src.__om === undefined ? undefined : {
                  name: src.__om.name, templates: [],
                  __settings: Object.assign({}, src.__om.__settings),
                  getSettings() {
                    const out = {};
                    for (const k in this.__settings) out[k] = this.__settings[k];
                    return out;
                  },
                  setSetting(k, v) { this.__settings[k] = v; },
                },
                remove() {
                  const i = renderItems.indexOf(d);
                  if (i >= 0) renderItems.splice(i, 1);
                  renderItems.forEach((r, j) => { r.index = j + 1; });
                },
                outputModule(idx) {
                  if (idx !== 1) throw new Error("fake-app: only output module 1 is modeled");
                  if (this.__om === undefined) {
                    this.__om = {
                      name: "Lossless", templates: [],
                      __settings: { "Output File Info": "[compName].mov" },
                      getSettings() {
                        const out = {};
                        for (const k in this.__settings) out[k] = this.__settings[k];
                        return out;
                      },
                      setSetting(k, v) { this.__settings[k] = v; },
                    };
                  }
                  return this.__om;
                },
                duplicate: src.duplicate,
              };
              renderItems.push(d);
              renderItems.forEach((r, j) => { r.index = j + 1; });
              return d;
            },
            remove() {
              const i = renderItems.indexOf(it);
              if (i >= 0) renderItems.splice(i, 1);
              renderItems.forEach((r, j) => { r.index = j + 1; });
            },
            outputModule(idx) {
              if (idx !== 1) throw new Error("fake-app: only output module 1 is modeled");
              // One OutputModule instance per queue item — settings must
              // persist across calls like the real host object.
              if (this.__om === undefined) {
                this.__om = {
                  name: "Lossless",
                  templates: [],
                  __settings: { "Output File Info": "[compName].mov" },
                  getSettings() {
                    const out = {};
                    for (const k in this.__settings) out[k] = this.__settings[k];
                    return out;
                  },
                  setSetting(k, v) { this.__settings[k] = v; },
                };
              }
              return this.__om;
            },
          };
          renderItems.push(it);
          return it;
        },
      }),
      render() {
        this.rendering = true;
        this.__rendered += 1;
        this.rendering = false;
        return true;
      },
    },
  };
  project.items = collection(items, {
    addComp(name, w, h, par, dur, frameRate) {
      const c = makeComp(name, w, h, par, dur, items, rootFolder);
      c.frameRate = frameRate;
      return c;
    },
    addFolder(name) { return makeFolder(name, items, rootFolder); },
  });
  Object.defineProperty(project, "numItems", { get() { return items.length; } });
  project.item = function projectItem(index) {
    if (!Number.isInteger(index) || index < 1 || index > items.length) return null;
    return items[index - 1];
  };
  project.itemByID = function projectItemByID(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  };
  project.rootFolder = rootFolder;
  Object.defineProperty(project, "selection", {
    get() {
      const panel = panelOrderItems(rootFolder, []);
      return panel.filter((it) => it.__selected === true);
    },
  });
  // Preferences model (Issue #283): section -> key -> typed value.
  // Getters return the stored value or the caller's default; the fake
  // does not coerce across types — a mismatched read returns the
  // default, which is the conservative fake behavior.
  const prefStore = {};
  const preferences = {
    havePref(section, key) {
      return prefStore[section] !== undefined && prefStore[section][key] !== undefined;
    },
    getPrefAsString(section, key, def) {
      if (!this.havePref(section, key)) return def === undefined ? "" : String(def);
      const v = prefStore[section][key];
      return typeof v === "string" ? v : String(v);
    },
    getPrefAsBool(section, key, def) {
      if (!this.havePref(section, key)) return def === undefined ? false : def === true;
      const v = prefStore[section][key];
      return typeof v === "boolean" ? v : v === "true" || v === 1;
    },
    getPrefAsLong(section, key, def) {
      if (!this.havePref(section, key)) return def === undefined ? 0 : Math.round(Number(def));
      const v = prefStore[section][key];
      return typeof v === "number" ? Math.round(v) : Math.round(Number(v));
    },
    getPrefAsFloat(section, key, def) {
      if (!this.havePref(section, key)) return def === undefined ? 0 : Number(def);
      const v = prefStore[section][key];
      return typeof v === "number" ? v : Number(v);
    },
    savePrefAsString(section, key, value) { this.__set(section, key, String(value)); },
    savePrefAsBool(section, key, value) { this.__set(section, key, value === true); },
    savePrefAsLong(section, key, value) { this.__set(section, key, Math.round(Number(value))); },
    savePrefAsFloat(section, key, value) { this.__set(section, key, Number(value)); },
    __set(section, key, value) {
      if (prefStore[section] === undefined) prefStore[section] = {};
      prefStore[section][key] = value;
    },
    deletePref(section, key) {
      if (prefStore[section] !== undefined) delete prefStore[section][key];
    },
    saveToDisk() {},
    reload() {},
  };
  const app = {
    version: "99.0-fake",
    buildName: "fake-build",
    buildNumber: 1,
    isoLanguage: "en_US",
    preferences,
    // Effect collection: matchName is the stable identifier adapters use.
    effects: collection(KNOWN_EFFECTS.map((mn) => ({ matchName: mn, name: mn }))),
    // Font collection: Font.name is the PostScript name in real AE.
    fonts: collection([{ name: "ArialMT" }, { name: "HelveticaLTStd-Bold" }]),
    project,
    newProject() { clearProjectItems(); },
    open(f) { project.file = f; },
  };
  app.CompItem = CompItem;
  app.FolderItem = FolderItem;
  app.FootageItem = FootageItem;
  app.AVItem = AVItem;
  app.ImportOptions = ImportOptions;
  app.__state = {
    items,
    fingerprint: () => JSON.stringify(items.map((i) => ({ n: i.name, t: i.typeName }))),
    reset: () => { clearProjectItems(); },
  };
  return app;
}
