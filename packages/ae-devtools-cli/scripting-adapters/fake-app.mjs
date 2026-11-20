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
class FootageItem extends AVItem {
  // Proxy surface (Issue #298). proxySource is read-only per the docs;
  // all changes go through the setProxy* methods, which also set
  // useProxy. Only FootageItem is modeled — proxies are a footage
  // feature and the adapters resolve items as FootageItem.
  get proxySource() {
    return this.__proxySource === undefined ? null : this.__proxySource;
  }
  __makeFileProxySource(file, isSequence) {
    const s = new FileSource();
    Object.assign(s, {
      file: { fsName: String(file.fsName) },
      missingFootagePath: "",
      isStill: false,
      hasAlpha: false,
      alphaMode: "IGNORE",
      loop: false,
      conformFrameRate: true,
      nativeFrameRate: 30,
      reload() {},
      __sequence: isSequence === true,
    });
    return s;
  }
  setProxy(file) {
    if (file === null || file === undefined || file.fsName === undefined) {
      throw new Error("fake-app: setProxy requires a File");
    }
    if (file.exists === false) {
      throw new Error("fake-app: proxy file not found: " + file.fsName);
    }
    this.__proxySource = this.__makeFileProxySource(file, false);
    this.useProxy = true;
  }
  setProxyWithSequence(file, forceAlphabetical) {
    this.setProxy(file);
    this.__proxySource.__sequence = true;
    this.__proxySource.__forceAlphabetical = forceAlphabetical === true;
  }
  setProxyWithSolid(color, sname, w, h, par) {
    const s = new SolidSource();
    Object.assign(s, {
      color: Array.isArray(color) ? color.slice() : color,
      name: sname, width: w, height: h, pixelAspect: par,
      // Solids are always still footage (FootageSource.isStill).
      isStill: true,
    });
    this.__proxySource = s;
    this.useProxy = true;
  }
  setProxyWithPlaceholder(pname, w, h, frameRate, duration) {
    const s = new PlaceholderSource();
    Object.assign(s, {
      name: pname, width: w, height: h,
      frameRate: frameRate, duration: duration,
      // Documented rule: placeholders with a duration of 0 are still.
      isStill: duration === 0,
    });
    this.__proxySource = s;
    this.useProxy = true;
  }
  setProxyToNone() {
    this.__proxySource = null;
    this.useProxy = false;
  }
}
// FootageSource hierarchy: proxies and mainSource are FootageSource
// subclass instances so generated `instanceof` checks discriminate
// file/solid/placeholder exactly like the real host.
class FootageSource {}
class FileSource extends FootageSource {}
class SolidSource extends FootageSource {}
class PlaceholderSource extends FootageSource {}

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
// PostRenderAction (Issue #299): numeric values are declaration-order
// stand-ins — the inventory records no numericValue and adapters pass
// enum NAMES, so the fake mapping is not load-bearing for claims.
export const PostRenderAction = {
  NONE: 0, IMPORT: 1, IMPORT_AND_REPLACE_USAGE: 2, SET_PROXY: 3,
};

// KeyframeEase constructor object. influence is documented as
// [0.1..100.0]; speed is a finite float whose units depend on the
// property. Public fields stay enumerable so __adp_json serializes
// {speed,influence} like the host read-back.
export class KeyframeEase {
  constructor(speed, influence) {
    if (typeof speed !== "number" || !isFinite(speed)) {
      throw new Error("fake-app: KeyframeEase.speed must be a finite number");
    }
    if (typeof influence !== "number" || !isFinite(influence) || influence < 0.1 || influence > 100) {
      throw new Error("fake-app: KeyframeEase.influence must be in 0.1..100");
    }
    this.speed = speed;
    this.influence = influence;
  }
}

function defaultEaseList(dims) {
  const out = [];
  for (let i = 0; i < dims; i++) out.push(new KeyframeEase(0, 33.33));
  return out;
}

/*
 * MarkerValue (Issue #295). Real constructor:
 *   new MarkerValue(comment, chapter, url, frameTarget, cuePointName, params)
 * — comment is required, the rest optional; scalar args are strings and
 * `params` is a key-value-pair carrier accessed via get/setParameters.
 * The fake keeps the documented scalar fields plus a params map.
 * label/protectedRegion are AE 16.0+ and deliberately NOT modeled —
 * version-gated fields stay unclaimed until a version-aware gate exists.
 */
export class MarkerValue {
  constructor(comment, chapter, url, frameTarget, cuePointName, params) {
    if (typeof comment !== "string") {
      throw new Error("fake-app: MarkerValue comment must be a string");
    }
    this.comment = comment;
    this.chapter = chapter === undefined ? "" : String(chapter);
    this.url = url === undefined ? "" : String(url);
    this.frameTarget = frameTarget === undefined ? "" : String(frameTarget);
    this.cuePointName = cuePointName === undefined ? "" : String(cuePointName);
    this.duration = 0;
    this.eventCuePoint = false;
    this.__params = {};
    if (params !== undefined && params !== null) this.setParameters(params);
  }
  getParameters() {
    const out = {};
    for (const k in this.__params) out[k] = this.__params[k];
    return out;
  }
  setParameters(pairs) {
    if (pairs === null || typeof pairs !== "object" || Array.isArray(pairs)) {
      throw new Error("fake-app: MarkerValue.setParameters requires a key-value object");
    }
    const next = {};
    for (const k in pairs) {
      if (!pairs.hasOwnProperty(k)) continue;
      if (typeof pairs[k] !== "string") {
        throw new Error("fake-app: MarkerValue parameter values must be strings");
      }
      next[String(k)] = pairs[k];
    }
    this.__params = next;
  }
}

/*
 * Marker property group: Layer.marker / CompItem.markerProperty both
 * behave as a keyframed Property whose values are MarkerValue objects.
 * Reuses makeProperty so numKeys/keyTime/keyValue/setValueAtTime/
 * valueAtTime semantics (incl. same-time update) match the other
 * property surfaces.
 */
function makeMarkerProperty(matchName) {
  return makeProperty(null, { matchName: matchName ?? "ADBE Marker" });
}

// Duplicated layers/comps get INDEPENDENT MarkerValue copies — sharing
// the object would make later edits leak across duplicates.
function cloneMarkerValue(mv) {
  const c = new MarkerValue(mv.comment, mv.chapter, mv.url, mv.frameTarget, mv.cuePointName);
  c.duration = mv.duration;
  c.eventCuePoint = mv.eventCuePoint;
  c.setParameters(mv.getParameters());
  return c;
}

function copyMarkers(srcProp, dstProp) {
  if (srcProp === null || srcProp === undefined) return;
  for (var i = 1; i <= srcProp.numKeys; i++) {
    dstProp.setValueAtTime(srcProp.keyTime(i), cloneMarkerValue(srcProp.keyValue(i)));
  }
}

/*
 * ShapeLayer contents model (Issue #296). Verified against the official
 * Shape Layer matchnames: Contents = "ADBE Root Vectors Group"; a Path
 * is "ADBE Vector Shape - Group" containing "ADBE Vector Shape
 * Direction" + "ADBE Vector Shape" (whose value is a Shape object).
 * The fake models ONLY the Path slice — groups/filters/materials are
 * recorded non-claims, not silently approximated.
 */
export class Shape {
  constructor() {
    this.vertices = null;
    this.inTangents = null;
    this.outTangents = null;
    this.closed = false;
  }
}

function makePropGroup(matchName, name) {
  const g = {
    matchName,
    name,
    __kids: [],
    numProperties: 0,
    property(ref) {
      if (typeof ref === "number") {
        if (!Number.isInteger(ref) || ref < 1 || ref > g.__kids.length) {
          throw new Error("fake-app: property index out of range " + ref);
        }
        return g.__kids[ref - 1];
      }
      const hits = [];
      for (var i = 0; i < g.__kids.length; i++) {
        if (g.__kids[i].matchName === ref || g.__kids[i].name === ref) hits.push(g.__kids[i]);
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new Error("fake-app: ambiguous property " + ref);
      throw new Error("fake-app: no such property " + ref);
    },
    canAddProperty(mn) {
      return g.__addable !== undefined && g.__addable.indexOf(mn) !== -1;
    },
    addProperty(mn) {
      if (!g.canAddProperty(mn)) {
        throw new Error("fake-app: cannot add property " + mn + " to " + g.matchName);
      }
      const node = g.__makeNode(mn);
      g.__kids.push(node);
      g.numProperties = g.__kids.length;
      return node;
    },
  };
  return g;
}

function makePathGroup() {
  const dir = makeProperty(1, { matchName: "ADBE Vector Shape Direction" });
  const shapeProp = makeProperty(null, { matchName: "ADBE Vector Shape" });
  const g = makePropGroup("ADBE Vector Shape - Group", "Path");
  g.__kids.push(dir, shapeProp);
  g.numProperties = 2;
  return g;
}

function makeShapeContents() {
  const g = makePropGroup("ADBE Root Vectors Group", "Contents");
  g.__addable = ["ADBE Vector Shape - Group"];
  g.__makeNode = function () { return makePathGroup(); };
  return g;
}

function cloneVectorValue(v) {
  if (v instanceof Shape) {
    const s = new Shape();
    s.vertices = v.vertices === null || v.vertices === undefined ? null : v.vertices.map((r) => r.slice());
    s.inTangents = v.inTangents === null || v.inTangents === undefined ? null : v.inTangents.map((r) => r.slice());
    s.outTangents = v.outTangents === null || v.outTangents === undefined ? null : v.outTangents.map((r) => r.slice());
    s.closed = v.closed === true;
    return s;
  }
  return Array.isArray(v) ? v.slice() : v;
}

// Deep-copies a vectors-group subtree so duplicated shape layers get
// independent Shape values (same rule as MarkerValue copies).
function clonePropNode(node) {
  if (node.__kids !== undefined) {
    const g = makePropGroup(node.matchName, node.name);
    for (var i = 0; i < node.__kids.length; i++) g.__kids.push(clonePropNode(node.__kids[i]));
    g.numProperties = g.__kids.length;
    return g;
  }
  return makeProperty(cloneVectorValue(node.value), { matchName: node.matchName });
}

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
      const dims = Array.isArray(v) ? v.length : 1;
      this.__keys.push({
        time: t, value: Array.isArray(v) ? v.slice() : v,
        inType: KeyframeInterpolationType.BEZIER, outType: KeyframeInterpolationType.BEZIER,
        easeIn: defaultEaseList(dims), easeOut: defaultEaseList(dims),
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
      return this.__keys[i - 1].easeIn.map((e) => new KeyframeEase(e.speed, e.influence));
    },
    keyOutTemporalEase(i) {
      if (!Number.isInteger(i) || i < 1 || i > this.numKeys) throw new Error("fake-app: invalid keyframe index " + i);
      return this.__keys[i - 1].easeOut.map((e) => new KeyframeEase(e.speed, e.influence));
    },
    setTemporalEaseAtKey(keyIndex, inEase, outEase) {
      if (!Number.isInteger(keyIndex) || keyIndex < 1 || keyIndex > this.numKeys) {
        throw new Error("fake-app: invalid keyframe index " + keyIndex);
      }
      const k = this.__keys[keyIndex - 1];
      const dims = Array.isArray(k.value) ? k.value.length : 1;
      const valid = (arr) => Array.isArray(arr) && arr.length === dims &&
        arr.every((e) => e instanceof KeyframeEase);
      if (!valid(inEase) || !valid(outEase)) {
        throw new Error("fake-app: temporal ease requires arrays of KeyframeEase matching property dimensions");
      }
      k.easeIn = inEase.map((e) => new KeyframeEase(e.speed, e.influence));
      k.easeOut = outEase.map((e) => new KeyframeEase(e.speed, e.influence));
    },
    // Approximation: returns the value of the last key at-or-before t
    // (AE interpolates; the fake only needs a deterministic, honest
    // read-back for contract tests — not motion-accurate sampling).
    // Documented signature is valueAtTime(time, preExpression); the fake
    // never applies expressions here, matching preExpression=false.
    valueAtTime(t, preExpression) {
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

// TextDocument model (Issues #285/#297). Fields documented as
// conditional in the AE scripting reference throw on access in the
// fake too: fillColor requires applyFill, strokeColor requires
// applyStroke, and boxTextSize/boxTextPos require boxText. Setting a
// gated color also enables its apply flag, matching the docs.
// Defaults are the fake's approximation — real-host defaults may
// differ. Attributes gated to AE 24.x (lineOrientation, the 24.x
// paragraph/box options, CharacterRange/ParagraphRange accessors) are
// intentionally NOT modeled; there is no version gate in the fake.
function makeTextDoc(box) {
  const d = {
    text: "",
    pointText: box !== true,
    boxText: box === true,
    // Style fields (Issue #285).
    font: "ArialMT",
    fontSize: 100,
    // fontStyle is read-only in the scripting reference (it reflects
    // the first character's style). The fake has no per-character
    // style state, so it exposes a constant via a getter backed by
    // __fontStyle — writes throw in strict mode like a real read-only
    // attribute assignment would.
    __fontStyle: "Regular",
    justification: 0,
    tracking: 0,
    leading: 0,
    // Residual attributes (Issue #297).
    fontFamily: "Arial",
    autoLeading: true,
    applyFill: true,
    applyStroke: false,
    strokeOverFill: false,
    __strokeWidth: 0,
    baselineShift: 0,
    horizontalScale: 100,
    verticalScale: 100,
    fauxBold: false,
    fauxItalic: false,
    smallCaps: false,
    subscript: false,
    superscript: false,
    allCaps: false,
    // composedLineCount is read-only and, per the docs, does not
    // recompute after the TextDocument is initialized — the fake
    // freezes it at 1 rather than pretending to run a line breaker.
    composedLineCount: 1,
    // Backing store for the conditionally-readable fields.
    __state: {
      fillColor: [0, 0, 0],
      strokeColor: [0, 0, 0],
      boxTextSize: box === true ? [100, 100] : [0, 0],
      boxTextPos: [0, 0],
    },
  };
  Object.defineProperty(d, "fillColor", {
    get() {
      if (this.applyFill !== true) throw new Error("fake-app: fillColor requires applyFill");
      return this.__state.fillColor;
    },
    set(v) { this.applyFill = true; this.__state.fillColor = Array.isArray(v) ? v.slice() : v; },
    enumerable: true,
  });
  Object.defineProperty(d, "strokeColor", {
    get() {
      if (this.applyStroke !== true) throw new Error("fake-app: strokeColor requires applyStroke");
      return this.__state.strokeColor;
    },
    set(v) { this.applyStroke = true; this.__state.strokeColor = Array.isArray(v) ? v.slice() : v; },
    enumerable: true,
  });
  for (const k of ["boxTextSize", "boxTextPos"]) {
    Object.defineProperty(d, k, {
      get() {
        if (this.boxText !== true) throw new Error("fake-app: " + k + " requires boxText");
        return this.__state[k];
      },
      set(v) {
        if (this.boxText !== true) throw new Error("fake-app: " + k + " requires boxText");
        this.__state[k] = Array.isArray(v) ? v.slice() : v;
      },
      enumerable: true,
    });
  }
  // strokeWidth: documented range 0-1000; a set value of 0 is silently
  // clipped to 0.01 by the real host — the fake models that clip.
  Object.defineProperty(d, "strokeWidth", {
    get() { return this.__strokeWidth; },
    set(v) {
      const n = typeof v === "number" && isFinite(v) ? v : 0;
      this.__strokeWidth = n < 0.01 ? 0.01 : n > 1000 ? 1000 : n;
    },
    enumerable: true,
  });
  Object.defineProperty(d, "paragraphCount", {
    // Paragraphs are newline-separated; always >= 1.
    get() {
      const parts = String(this.text).split(/\r\n|\r|\n/);
      return parts.length < 1 ? 1 : parts.length;
    },
    enumerable: true,
  });
  Object.defineProperty(d, "fontStyle", {
    get() { return this.__fontStyle; },
    enumerable: true,
  });
  // Clone support for layer/comp duplication: copies every own field
  // except the conditional getters (read via __state instead).
  const CONDITIONAL = ["fillColor", "strokeColor", "boxTextSize", "boxTextPos", "paragraphCount", "composedLineCount", "fontStyle"];
  d.__snapshot = function () {
    const s = {};
    for (const k in this) {
      if (k === "__state" || CONDITIONAL.indexOf(k) >= 0) continue;
      s[k] = this[k];
    }
    s.__state = JSON.parse(JSON.stringify(this.__state));
    s.composedLineCount = this.composedLineCount;
    return s;
  };
  d.__restore = function (s) {
    for (const k in s) {
      if (k === "__state") { this.__state = JSON.parse(JSON.stringify(s.__state)); continue; }
      this[k] = s[k];
    }
  };
  return d;
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
    // AVLayer.frameBlending is read-only in the scripting reference;
    // expose it via a getter backed by __frameBlending so generated
    // code cannot write it (strict-mode assignment throws).
    __frameBlending: false,
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
    __textDoc: kind === "text" ? makeTextDoc(false) : null,
    // Layer.marker (Issue #295): a lazily-created keyframed property
    // whose values are MarkerValue objects. All layer kinds carry one,
    // matching the Layer base class.
    __marker: null,
    get marker() {
      if (layer.__marker === null) layer.__marker = makeMarkerProperty();
      return layer.__marker;
    },
    // Shape contents (Issue #296): only kind==="shape" layers expose
    // "ADBE Root Vectors Group". Lazily created so untouched layers
    // stay cheap; non-shape layers throw like the real host.
    __shapeContents: null,
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
      if (group === "ADBE Root Vectors Group") {
        if (layer.kind !== "shape") {
          throw new Error("fake-app: layer has no shape contents (not a shape layer)");
        }
        if (layer.__shapeContents === null) layer.__shapeContents = makeShapeContents();
        return layer.__shapeContents;
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
    // AVLayer.source / replaceSource (Issue #289/#300). replaceSource
    // takes an AVItem (CompItem or FootageItem) plus fixExpressions;
    // deeper usage/cycle checks remain real-host verification items.
    get source() { return layer.__source; },
    replaceSource(item, fixExpressions) {
      if (!(item instanceof FootageItem) && !(item instanceof CompItem)) {
        throw new Error("fake-app: replaceSource requires a CompItem or FootageItem");
      }
      layer.__source = item;
      layer.__fixExpressions = fixExpressions === true;
      return item;
    },
    // Fake approximation: modeled AV/solid/null layers can time-remap;
    // text/camera/light cannot. Real AE has its own availability rules.
    get canSetTimeRemapEnabled() {
      return layer.kind === "av" || layer.kind === "solid" || layer.kind === "null";
    },
    get hasTrackMatte() { return layer.__trackMatte !== null; },
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
      // Scalar layer state survives duplication in real AE; copy the
      // flag/binding fields the fake models (track matte is skipped —
      // remapping __trackMatte across the copy is not modeled).
      for (const k of ["enabled", "locked", "solo", "shy", "label", "comment",
        "audioEnabled", "threeDLayer", "motionBlur", "guideLayer",
        "adjustmentLayer", "preserveTransparency", "__frameBlending",
        "collapseTransformation", "timeRemapEnabled",
        "inPoint", "outPoint", "startTime", "stretch"]) {
        l[k] = this[k];
      }
      if (l.__textDoc !== null && this.__textDoc !== null) {
        l.__textDoc.__restore(this.__textDoc.__snapshot());
      }
      copyMarkers(this.__marker, l.marker);
      if (this.__shapeContents !== null) l.__shapeContents = clonePropNode(this.__shapeContents);
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
  Object.defineProperty(layer, "frameBlending", {
    get() { return layer.__frameBlending; },
    enumerable: true,
  });
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
        if (nl.__textDoc !== null && l.__textDoc !== null) {
          nl.__textDoc.__restore(l.__textDoc.__snapshot());
        }
        nl.startTime = l.startTime;
        nl.stretch = l.stretch;
        nl.solo = l.solo;
        nl.shy = l.shy;
        nl.label = l.label;
        nl.locked = l.locked;
        nl.enabled = l.enabled;
        nl.comment = l.comment;
        nl.audioEnabled = l.audioEnabled;
        nl.threeDLayer = l.threeDLayer;
        nl.motionBlur = l.motionBlur;
        nl.guideLayer = l.guideLayer;
        nl.adjustmentLayer = l.adjustmentLayer;
        nl.preserveTransparency = l.preserveTransparency;
        nl.__frameBlending = l.__frameBlending;
        nl.collapseTransformation = l.collapseTransformation;
        nl.timeRemapEnabled = l.timeRemapEnabled;
        nl.inPoint = l.inPoint;
        nl.outPoint = l.outPoint;
        copyMarkers(l.__marker, nl.marker);
        if (l.__shapeContents !== null) nl.__shapeContents = clonePropNode(l.__shapeContents);
        d.__layers.push(nl);
      }
      copyMarkers(this.__marker, d.markerProperty);
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
  // CompItem.markerProperty (Issue #295, AE 14.0+): same keyframed
  // MarkerValue property as Layer.marker but owned by the comp.
  comp.__marker = null;
  Object.defineProperty(comp, "markerProperty", {
    get() {
      if (comp.__marker === null) comp.__marker = makeMarkerProperty();
      return comp.__marker;
    },
    configurable: true,
  });
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
    // Real signature: addBoxText([width, height]) — no name argument;
    // adapters rename via layer.name afterwards. Creates a paragraph
    // (box) text layer; pointText is false.
    addBoxText(wh) {
      if (!Array.isArray(wh) || wh.length !== 2 ||
          wh.some((v) => typeof v !== "number" || !isFinite(v) || v <= 0)) {
        throw new Error("fake-app: addBoxText requires [width, height] positive numbers");
      }
      const l = makeLayer("Text Layer " + (comp.__layers.length + 1), comp, "text");
      l.__textDoc = makeTextDoc(true);
      l.__textDoc.__state.boxTextSize = [wh[0], wh[1]];
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    // Real signature: addShape() takes NO arguments — the layer gets
    // AE's default name; adapters rename via layer.name afterwards.
    addShape() {
      const l = makeLayer("Shape Layer " + (comp.__layers.length + 1), comp, "shape");
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
    // real values depend on the imported media. mainSource is a
    // FileSource instance, distinct from proxySource (Issue #298).
    mainSource: Object.assign(new FileSource(), {
      file: { fsName: String(path) },
      alphaMode: "IGNORE",
      hasAlpha: false,
      isStill: false,
      loop: false,
      conformFrameRate: true,
      nativeFrameRate: 30,
      missingFootagePath: "",
      reload() {},
    }),
    __proxySource: null,
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
  // Render/output-module template stores (Issue #299). Real templates
  // are .aer/.aom files in AE's template folders; the fake keeps a
  // deterministic in-memory registry seeded with AE's shipped template
  // names. Render-template payloads carry only the RQ-item settings the
  // fake models; OM-template payloads are OutputModule settings maps.
  const renderTemplateStore = {
    "Best Settings": { skipFrames: 0, logType: 0, startTime: 0, timeSpanStart: 0 },
    "Lossless": { skipFrames: 0, logType: 0, startTime: 0, timeSpanStart: 0 },
    "Draft": { skipFrames: 0, logType: 1, startTime: 0, timeSpanStart: 0 },
  };
  const omTemplateStore = {
    "Lossless": { "Output File Info": "[compName].mov" },
    "Draft": { "Output File Info": "[compName].avi" },
  };
  const makeOM = (name) => ({
    name,
    __owner: null,
    file: null,
    includeSourceXMP: false,
    postRenderAction: 0,
    __settings: { "Output File Info": "[compName].mov" },
    get templates() { return Object.keys(omTemplateStore); },
    getSettings() {
      const out = {};
      for (const k in this.__settings) out[k] = this.__settings[k];
      return out;
    },
    setSetting(k, v) { this.__settings[k] = v; },
    applyTemplate(tname) {
      if (!Object.prototype.hasOwnProperty.call(omTemplateStore, tname)) {
        throw new Error("fake-app: unknown output module template: " + tname);
      }
      const t = omTemplateStore[tname];
      for (const k in t) this.__settings[k] = t[k];
    },
    saveAsTemplate(tname) {
      if (typeof tname !== "string" || tname.length === 0) {
        throw new Error("fake-app: saveAsTemplate requires a non-empty name");
      }
      omTemplateStore[tname] = Object.assign({}, this.__settings);
    },
    remove() {
      const arr = this.__owner === null ? null : this.__owner.__oms;
      if (arr !== null) {
        const i = arr.indexOf(this);
        if (i >= 0) arr.splice(i, 1);
      }
    },
  });
  const makeRQItem = (comp) => {
    const it = {
      comp, index: 0, status: 1,
      timeSpanStart: 0,
      timeSpanDuration: comp.duration,
      // Issue #289: queue item control fields (fake defaults).
      startTime: 0,
      skipFrames: 0,
      logType: 0,
      elapsedSeconds: 0,
      __oms: [makeOM("Lossless")],
      // RenderQueueItem.templates: names of available render settings
      // templates (Issue #299); saveAsTemplate adds to the store.
      get templates() { return Object.keys(renderTemplateStore); },
      applyTemplate(tname) {
        if (!Object.prototype.hasOwnProperty.call(renderTemplateStore, tname)) {
          throw new Error("fake-app: unknown render settings template: " + tname);
        }
        const t = renderTemplateStore[tname];
        for (const k in t) this[k] = t[k];
      },
      saveAsTemplate(tname) {
        if (typeof tname !== "string" || tname.length === 0) {
          throw new Error("fake-app: saveAsTemplate requires a non-empty name");
        }
        renderTemplateStore[tname] = {
          skipFrames: this.skipFrames, logType: this.logType,
          startTime: this.startTime, timeSpanStart: this.timeSpanStart,
        };
      },
      get numOutputModules() { return this.__oms.length; },
      get outputModules() {
        const item = this;
        return collection(item.__oms, {
          add() {
            const om = makeOM("Output Module " + (item.__oms.length + 1));
            om.__owner = item;
            item.__oms.push(om);
            return om;
          },
        });
      },
      outputModule(idx) {
        const om = this.__oms[idx - 1];
        if (om === undefined) {
          throw new Error("fake-app: output module index out of range: " + idx);
        }
        return om;
      },
      duplicate() {
        // Copies the RECEIVER's settings (this === source item),
        // including every output module's settings.
        const d = makeRQItem(this.comp);
        d.status = 1;
        d.timeSpanStart = this.timeSpanStart;
        d.timeSpanDuration = this.timeSpanDuration;
        d.startTime = this.startTime;
        d.skipFrames = this.skipFrames;
        d.logType = this.logType;
        d.elapsedSeconds = 0;
        d.__oms = this.__oms.map((om) => {
          const c = makeOM(om.name);
          c.__settings = Object.assign({}, om.__settings);
          c.file = om.file;
          c.includeSourceXMP = om.includeSourceXMP;
          c.postRenderAction = om.postRenderAction;
          c.__owner = d;
          return c;
        });
        renderItems.push(d);
        renderItems.forEach((r, j) => { r.index = j + 1; });
        return d;
      },
      remove() {
        const i = renderItems.indexOf(this);
        if (i >= 0) renderItems.splice(i, 1);
        renderItems.forEach((r, j) => { r.index = j + 1; });
      },
    };
    it.__oms.forEach((om) => { om.__owner = it; });
    return it;
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
          const it = makeRQItem(comp);
          it.index = renderItems.length + 1;
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
    // Documented signature is getPrefAsX(sectionName, keyName[, prefType])
    // — prefType selects the preferences file and is not modelled here.
    // Callers apply their own default when havePref is false (Issue #336).
    getPrefAsString(section, key) {
      if (!this.havePref(section, key)) return "";
      const v = prefStore[section][key];
      return typeof v === "string" ? v : String(v);
    },
    getPrefAsBool(section, key) {
      if (!this.havePref(section, key)) return false;
      const v = prefStore[section][key];
      return typeof v === "boolean" ? v : v === "true" || v === 1;
    },
    getPrefAsLong(section, key) {
      if (!this.havePref(section, key)) return 0;
      const v = prefStore[section][key];
      return typeof v === "number" ? Math.round(v) : Math.round(Number(v));
    },
    getPrefAsFloat(section, key) {
      if (!this.havePref(section, key)) return 0;
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
    // Font collection: real AE exposes app.fonts as a FontsObject whose
    // allFonts attribute is the indexable FontObject list;
    // FontObject.postScriptName is the stable font identifier.
    fonts: { allFonts: collection([{ postScriptName: "ArialMT" }, { postScriptName: "HelveticaLTStd-Bold" }]) },
    project,
    newProject() { clearProjectItems(); },
    open(f) { project.file = f; },
  };
  app.CompItem = CompItem;
  app.FolderItem = FolderItem;
  app.FootageItem = FootageItem;
  app.AVItem = AVItem;
  app.ImportOptions = ImportOptions;
  app.FootageSource = FootageSource;
  app.FileSource = FileSource;
  app.SolidSource = SolidSource;
  app.PlaceholderSource = PlaceholderSource;
  app.__state = {
    items,
    fingerprint: () => JSON.stringify(items.map((i) => ({ n: i.name, t: i.typeName }))),
    reset: () => { clearProjectItems(); },
  };
  return app;
}
