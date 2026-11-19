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
    expressionEnabled: false,
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
        property(n) { return makeProperty(0, { expressionAllowed: false }); },
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

function makeLayer(name, comp) {
  const layer = {
    name,
    comp,
    index: 0,
    __parent: null,
    enabled: true,
    locked: false,
    solo: false,
    shy: false,
    label: 0,
    comment: "",
    startTime: 0,
    stretch: 100,
    inPoint: 0,
    outPoint: comp ? comp.duration : 0,
    __pos: makeProperty([0, 0]),
    __fx: null,
    property(group) {
      // Real AE resolves both display name and matchName; we only
      // implement the stable matchName path adapters must use.
      if (group === "ADBE Transform Group" || group === "Transform") {
        return {
          property(sub) {
            if (sub === "ADBE Position" || sub === "Position") return layer.__pos;
            if (sub === "ADBE Anchor Point" || sub === "Anchor Point") return makeProperty([0, 0]);
            throw new Error("fake-app: no such transform property " + sub);
          },
          addProperty(mn) { throw new Error("fake-app: cannot add property to transform group"); },
        };
      }
      if (group === "ADBE Effect Parade" || group === "Effects") {
        if (layer.__fx === null) layer.__fx = makeFxGroup(layer);
        return layer.__fx;
      }
      throw new Error("fake-app: no such property group " + group);
    },
    moveToBeginning() { comp.__moveLayer(layer, "top"); },
    moveToEnd() { comp.__moveLayer(layer, "bottom"); },
    duplicate() {
      const l = makeLayer(this.name + " copy", comp);
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
        const nl = makeLayer(l.name, d);
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
      const l = makeLayer("Null " + (comp.__layers.length + 1), comp);
      comp.__layers.push(l);
      comp.__reindex();
      return l;
    },
    addSolid(color, lname, w2, h2, par2, d2) {
      const l = makeLayer(lname, comp);
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
    mainSource: { file: { fsName: String(path) } },
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
  const app = {
    version: "99.0-fake",
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
