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
class CompItem {}
class FolderItem {}
class FootageItem {}

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

function makeProperty(value) {
  return {
    value,
    __keys: [],
    expression: "",
    expressionEnabled: false,
    numKeys: 0,
    canSetExpression() { return true; },
    setValue(v) { this.value = Array.isArray(v) ? v.slice() : v; },
    setValueAtKey(t, v) {
      this.__keys.push({ time: t, value: Array.isArray(v) ? v.slice() : v });
      this.numKeys = this.__keys.length;
      this.value = Array.isArray(v) ? v.slice() : v;
    },
    property(name) {
      if (name === "Position" || name === "ADBE Position") return makeProperty([0, 0]);
      throw new Error("fake-app: no such property " + name);
    },
  };
}

// Minimal Effect Parade group: addProperty(matchName) like real AE.
function makeFxGroup(layer) {
  const fx = [];
  return {
    __list: fx,
    numProperties: 0,
    addProperty(matchName) {
      const e = {
        name: matchName, matchName, enabled: true,
        property(n) { throw new Error("fake-app: effect param " + n + " not implemented"); },
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
    parent: null,
    enabled: true,
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
    __moveLayer(layer, to) {
      const i = comp.__layers.indexOf(layer);
      if (i < 0) return;
      comp.__layers.splice(i, 1);
      if (to === "top") comp.__layers.unshift(layer); else comp.__layers.push(layer);
      comp.__reindex();
    },
  });
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

export function createAdapterFakeApp() {
  const items = [];
  const renderItems = [];
  const project = {
    activeItem: null,
    save() {},
    close() {},
    file: { fsName: "/tmp/fake.aep" },
    renderQueue: {
      rendering: false,
      __rendered: 0,
      items: collection(renderItems, {
        add(comp) {
          const it = { comp, index: renderItems.length + 1 };
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
  app.__state = {
    items,
    fingerprint: () => JSON.stringify(items.map((i) => ({ n: i.name, t: i.typeName }))),
    reset: () => { items.length = 0; project.activeItem = null; },
  };
  return app;
}
