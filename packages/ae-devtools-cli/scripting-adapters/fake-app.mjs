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
      this.__keys.push({ time: t, value: Array.isArray(v) ? v.slice() : v });
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
    inPoint: 0,
    outPoint: comp ? comp.duration : 0,
    __pos: makeProperty([0, 0], { matchName: "ADBE Position" }),
    __fx: null,
    // TextDocument model: only text layers carry one. The real API
    // reaches it via the matchName path Text Properties > Text Document.
    __textDoc: kind === "text" ? { text: "", pointText: true, boxText: false } : null,
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
    moveToBeginning() { comp.__moveLayer(layer, "top"); },
    moveToEnd() { comp.__moveLayer(layer, "bottom"); },
    duplicate() {
      const l = makeLayer(this.name + " copy", comp, this.kind);
      if (l.__textDoc !== null && this.__textDoc !== null) l.__textDoc.text = this.__textDoc.text;
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

function makeComp(name, w, h, par, dur, owner) {
  const comp = new CompItem();
  Object.assign(comp, {
    name,
    typeName: "Composition",
    id: Math.floor(Math.random() * 1e9),
    width: w,
    height: h,
    pixelAspect: par,
    duration: dur,
    __layers: [],
    remove() {
      const i = owner.indexOf(comp);
      if (i >= 0) owner.splice(i, 1);
    },
    __reindex() { comp.__layers.forEach((l, i) => { l.index = i + 1; }); },
    resolutionFactor: 1,
    label: 0,
    comment: "",
    duplicate() {
      const d = makeComp(this.name + " copy", this.width, this.height,
        this.pixelAspect, this.duration, owner);
      d.frameRate = this.frameRate;
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
      owner.push(d);
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
    addCamera(cname) {
      const l = makeLayer(cname, comp, "camera");
      l.threeDLayer = true;
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    // Real signature: addLight(name, lightType, lightIntensity);
    // lightType is the LightType enum, stored verbatim by the fake.
    addLight(lname, ltype, intensity) {
      const l = makeLayer(lname, comp, "light");
      l.threeDLayer = true;
      l.__light = { lightType: ltype === undefined ? null : ltype, intensity: intensity === undefined ? null : intensity };
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

function makeFootage(path, owner) {
  const f = new FootageItem();
  const base = String(path).split("/").pop().split("\\").pop();
  Object.assign(f, {
    name: base,
    typeName: "Footage",
    id: owner.length + 1,
    label: 0,
    comment: "",
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
    remove() {
      const i = owner.indexOf(f);
      if (i >= 0) owner.splice(i, 1);
    },
  });
  return f;
}

export function createAdapterFakeApp() {
  const items = [];
  const renderItems = [];
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
      const f = makeFootage(io.file.fsName, items);
      items.push(f);
      return f;
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
      const c = makeComp(name, w, h, par, dur, items);
      c.frameRate = frameRate;
      items.push(c);
      return c;
    },
    addFolder(name) {
      const f = new FolderItem();
      Object.assign(f, {
        name,
        typeName: "Folder",
        id: items.length + 1,
        label: 0,
        comment: "",
        remove() {
          const i = items.indexOf(f);
          if (i >= 0) items.splice(i, 1);
        },
      });
      items.push(f);
      return f;
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
    newProject() { items.length = 0; project.activeItem = null; },
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
    reset: () => { items.length = 0; project.activeItem = null; },
  };
  return app;
}
