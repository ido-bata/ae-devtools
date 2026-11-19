#!/usr/bin/env node
/*
 * audit-member-kinds.mjs — FakeHost/generated-JSX audit (priority 2,
 * Issue #319 structural rework).
 *
 * Cross-checks every member an op CLAIMS against two independent
 * sources of truth:
 *
 *   1. inventories/scripting/generated/symbols.json — the documented
 *      kind ("method" vs "attribute"), access mode, owner, and
 *      signature (parameter list; optional params appear as `[, x]`).
 *   2. The actual generated ExtendScript source — member call sites
 *      `.name(...)`, attribute writes `.name =`, and attribute reads,
 *      each resolved to a host-owner kind via receiver-type inference.
 *
 * What changed vs the #309 name-based audit:
 *
 *   - OWNER-AWARE: member names collide across owners (`name`,
 *     `property`, `file`, ...). Every site is resolved to the receiver's
 *     host-owner kind (helper return types, `var` initializer
 *     expressions, documented attribute/method returns, collection
 *     element types, and a conservative inheritance chain), and a claim
 *     is only satisfied by a site on a receiver that IS-A the claimed
 *     owner. A `Layer.name` read can no longer mask a missing
 *     `Item.name` exercise.
 *   - SIGNATURE-AWARE: method calls are arity-checked against the
 *     inventory signature wherever one is recorded (required..required
 *     +optional), and coverage of signature-less claims is measured.
 *   - ARG-VARIANT ENUMERATION IS MECHANICAL: discriminating values are
 *     extracted from the op's own `source`/`validate` function literals
 *     (the comparisons that switch emitted members are literally in
 *     that text) and each arg is probed independently. No hand-kept
 *     VARIANTS table — a new arg-conditional member call is covered the
 *     moment it is written. Args whose probes produce different sources
 *     are reported as discriminating in the coverage stats.
 *   - COVERAGE IS MEASURED: the report counts typed vs untyped receiver
 *     sites, per-arg probe coverage, discriminating args, signature
 *     coverage, and known-inventory-gap suppressions — unchecked
 *     surface is visible, not hidden.
 *   - STRING-SAFE: string literals are masked before member scanning,
 *     so probe-generated arg values that embed text like
 *     "layer.reorder: ..." cannot parse as phantom member accesses.
 *   - KNOWN_GAPS: members documented in the AE scripting DOM but absent
 *     from the scraped symbols.json (e.g. Layer.property, source
 *     geometry) are suppressed explicitly and counted in
 *     stats.gapSuppressed — never silently.
 *
 * Scope of the per-op site set: the op tail plus the transitive
 * `__adp_*` helpers it actually calls (call-graph closure over every
 * `function name(...)` in the generated source), so shared-helper
 * member uses count only for ops that reach them.
 *
 * Limitations (documented, not hidden):
 *   - Receiver typing is best-effort static inference over generated
 *     ES3. Receivers that cannot be typed land in the `untyped` bucket
 *     and are counted, not silently passed.
 *   - Arg probing is single-arg perturbation plus a bounded joint
 *     retry for coupled validation (e.g. pref.get's type/default
 *     pairing); deep arg interactions beyond that bound could still
 *     hide a variant. Discriminating-arg stats make this visible.
 *   - Signature checking covers arity where the inventory records a
 *     signature; argument TYPE checking is not performed.
 *   - Findings are REVIEW SIGNALS — verify each against Adobe docs
 *     before treating as a bug.
 *
 * Usage: node scripts/audit-member-kinds.mjs
 * Exit 0 = no findings; exit 1 = findings printed for review.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS, buildSource } from "../registry.mjs";
import { sampleArgs } from "../tests/sample-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SYMBOLS_JSON = join(here, "..", "..", "..", "..", "inventories", "scripting", "generated", "symbols.json");

// ---------------------------------------------------------------------------
// Inventory model
// ---------------------------------------------------------------------------

// kind -> ancestor kinds, nearest first. Only documented inheritance is
// listed; anything not here is treated as unrelated (fail-closed for
// claim satisfaction, which is the safe direction for a review audit).
// Documented AE object-model inheritance (docsforadobe):
//   Item -> AVItem -> {CompItem, FootageItem}; Item -> FolderItem
//   PropertyBase -> {Property, PropertyGroup, Layer}
//   Layer -> AVLayer -> {TextLayer, ShapeLayer, CameraLayer, LightLayer,
//                        NullLayer, SolidLayer, ParametricMeshLayer}
// Only documented links are listed; anything absent is treated as
// unrelated (fail-closed for claim satisfaction).
const INHERITS = {
  CompItem: ["AVItem"],
  FootageItem: ["AVItem"],
  AVItem: ["Item"],
  FolderItem: ["Item"],
  AVLayer: ["Layer"],
  TextLayer: ["AVLayer"],
  ShapeLayer: ["AVLayer"],
  CameraLayer: ["AVLayer"],
  LightLayer: ["AVLayer"],
  NullLayer: ["AVLayer"],
  SolidLayer: ["AVLayer"],
  ParametricMeshLayer: ["AVLayer"],
  Layer: ["PropertyBase"],
  Property: ["PropertyBase"],
  PropertyGroup: ["PropertyBase"],
  FileSource: ["FootageSource"],
  SolidSource: ["FootageSource"],
  PlaceholderSource: ["FootageSource"],
};

// True when a receiver of kind `kind` may legitimately expose members
// documented on `owner` (same kind or documented descendant).
function kindIsA(kind, owner) {
  return kindChain(kind).includes(owner);
}

// Ancestor chain including self, nearest first (recursive, cycle-safe).
function kindChain(kind) {
  const chain = [];
  const seen = new Set();
  const walk = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    chain.push(k);
    for (const p of INHERITS[k] || []) walk(p);
  };
  walk(kind);
  return chain;
}

// Member lookup across the inheritance chain. Returns the symbol or
// null. `viaParent` flags lookups satisfied by an ancestor.
function lookupMember(byOwnerMember, kind, member) {
  for (const k of kindChain(kind)) {
    const s = byOwnerMember.get(`${k}.${member}`);
    if (s) return { sym: s, via: k };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receiver typing
// ---------------------------------------------------------------------------

// Globals and JS builtins — never host objects.
const JS_KINDS = new Set([
  "Object", "Math", "JSON", "String", "Number", "Array", "Boolean",
  "Date", "RegExp", "Error", "TypeError", "isFinite", "isNaN",
  "parseFloat", "parseInt", "undefined", "NaN", "Infinity",
]);
const GLOBAL_KINDS = { app: "app" };

// PRELUDE helper signatures: param name -> receiver kind, `returns` ->
// kind string, "same" (receiver kind), "js", or a function of the call
// site text for arg-dependent returns (ctor literal, collection kind).
// Params typed "js"/"any" produce no host sites.
const HELPERS = {
  __adp_fail: { params: { msg: "js" }, returns: "js" },
  __adp_items: { params: {}, returns: "ItemCollection" },
  __adp_typeMatch: { params: { it: "Item", ctor: "js" }, returns: "js" },
  __adp_findInColl: {
    params: { coll: "ItemCollection", name: "js", ctor: "js", scope: "js" },
    returns: (site) => ctorKind(site),
  },
  __adp_isArray: { params: { v: "js" }, returns: "js" },
  __adp_resolveFolderPath: { params: { path: "js" }, returns: "FolderItem" },
  __adp_findItemRef: {
    params: { ref: "js", ctor: "js" },
    returns: (site) => ctorKind(site),
  },
  __adp_findItem: {
    params: { name: "js", ctor: "js" },
    returns: (site) => ctorKind(site),
  },
  __adp_findLayer: { params: { comp: "CompItem", name: "js" }, returns: "AVLayer" },
  __adp_findRQItem: { params: { compName: "js" }, returns: "RenderQueueItem" },
  __adp_markerSnapshot: { params: { prop: "Property" }, returns: "js" },
  __adp_vectorTree: { params: { group: "PropertyGroup" }, returns: "js" },
  __adp_proxySnapshot: { params: { it: "js" }, returns: "js" }, // `it` typed by call-site inference (AVItem/FootageItem)
  __adp_json: { params: { v: "js" }, returns: "js" },
  // Per-op helpers emitted into individual op tails (registry.mjs).
  __adp_brief: { params: { it: "Item" }, returns: "js" },
  __adp_tree: { params: { folder: "FolderItem" }, returns: "js" },
};

// `ctor` argument of the find* helpers is a bare global constructor
// name (CompItem, FootageItem, FolderItem, null). Map to the inventory
// owner; null ctor means "any item" -> Item.
function ctorKind(callSiteText) {
  const m = /,\s*([A-Za-z_$][\w$]*)\s*\)?\s*;?\s*$/.exec(callSiteText) ||
            /\(\s*[^,]+,\s*([A-Za-z_$][\w$]*)/.exec(callSiteText);
  const ctor = m && m[1];
  if (!ctor || ctor === "null") return "Item";
  return ctor; // CompItem / FootageItem / FolderItem — all inventory owners
}

// Documented member returns: "Owner.member" -> kind | "same" | fn(site).
// "same" means the return has the receiver's kind (duplicate()).
// Only entries needed by generated sources are listed; unknown members
// yield an untyped receiver (counted, not guessed).
const MEMBER_RETURN = {
  "Project.items": "ItemCollection",
  "Project.rootFolder": "FolderItem",
  "Project.file": "File",
  "Project.activeItem": "AVItem",
  "Project.itemByID": "Item",
  "Project.renderQueue": "RenderQueue",
  "ItemCollection.addComp": "CompItem",
  "ItemCollection.addFolder": "FolderItem",
  "FolderItem.items": "ItemCollection",
  "FolderItem.item": "Item",
  "FolderItem.numItems": "js",
  "CompItem.layers": "LayerCollection",
  "CompItem.duplicate": "same",
  "AVItem.duplicate": "same",
  "Item.duplicate": "same",
  "Item.parentFolder": "FolderItem",
  "LayerCollection.addNull": "NullLayer",
  "LayerCollection.addText": "TextLayer",
  "LayerCollection.addBoxText": "TextLayer",
  "LayerCollection.addVerticalText": "TextLayer",
  "LayerCollection.addVerticalBoxText": "TextLayer",
  "LayerCollection.addShape": "ShapeLayer",
  "LayerCollection.addSolid": "SolidLayer",
  "LayerCollection.addCamera": "CameraLayer",
  "LayerCollection.addLight": "LightLayer",
  "LayerCollection.addParametricMesh": "ParametricMeshLayer",
  "LayerCollection.add": "AVLayer",
  "LayerCollection.byName": "AVLayer",
  "LayerCollection.precompose": "CompItem",
  "Layer.duplicate": "same",
  "AVLayer.duplicate": "same",
  "Layer.parent": "AVLayer",
  "PropertyBase.duplicate": "same",
  "Property.duplicate": "same",
  "PropertyGroup.duplicate": "same",
  "PropertyBase.propertyGroup": "PropertyGroup",
  "Property.parentProperty": "PropertyOrGroup",
  "PropertyGroup.parentProperty": "PropertyOrGroup",
  "Layer.property": (site) => textDocKind(site) || "PropertyOrGroup",
  "AVLayer.property": (site) => textDocKind(site) || "PropertyOrGroup",
  "PropertyGroup.property": (site) => textDocKind(site) || "PropertyOrGroup",
  "PropertyGroup.addProperty": "PropertyOrGroup",
  "Property.property": (site) => textDocKind(site) || "PropertyOrGroup",
  "PropertyGroup.addVariableFontAxis": "Property",
  "RenderQueue.items": "RQItemCollection",
  "RenderQueue.item": "RenderQueueItem",
  "Project.item": "Item",
  "Project.selection": "AVItemArray",
  "RQItemCollection.add": "RenderQueueItem",
  "RenderQueueItem.comp": "CompItem",
  "RenderQueueItem.outputModules": "OMCollection",
  "RenderQueueItem.outputModule": "OutputModule",
  "RenderQueueItem.duplicate": "same",
  "CompItem.markerProperty": "Property",
  "Layer.marker": "Property",
  "AVLayer.marker": "Property",
  "Property.keyInTemporalEase": "KeyframeEase",
  "Property.keyOutTemporalEase": "KeyframeEase",
  // Property.value is polymorphic; generated code only member-accesses
  // it for vector-shape contents (duck-typed `v.vertices`). Typed as
  // possibly-Shape so those reads are checkable; documented limitation.
  "Property.value": "Shape|js",
  "FontsObject.allFonts": "FontObjectArray",
  "RenderQueueItem.applyTemplate": "js",
  "OMCollection.add": "OutputModule",
  "FootageItem.mainSource": "FootageSource|FileSource|SolidSource|PlaceholderSource",
  "FootageItem.proxySource": "FootageSource|FileSource|SolidSource|PlaceholderSource",
  "AVItem.proxySource": "FootageSource|FileSource|SolidSource|PlaceholderSource",
  "AVItem.useProxy": "js",
  "AVLayer.source": "AVItem",
  "FootageItem.file": "File",
  "FootageSource.file": "File",
  "FileSource.file": "File",
  "FileSource.missingFootagePath": "js",
  "MarkerValue.getParameters": "js",
  "Property.keyValue": "MarkerValue",
  "Property.keyTime": "js",
  "Property.numKeys": "js",
  "Preferences.havePref": "js",
  "app.preferences": "Preferences",
  "app.project": "Project",
  "app.fonts": "FontsObject",
  "app.effects": "js", // Effects object is not an inventory owner
  "app.newProject": "Project",
  "app.open": "Project",
  "app.project.file": "File",
};

// The fake host returns the TextDocument object itself for these
// matchNames (fake-app.mjs `property(sub)` special-case); the real API
// exposes TextDocument through the same property indirection.
function textDocKind(callSiteText) {
  if (/"ADBE Text Document"|"Source Text"/.test(callSiteText)) return "TextDocument";
  return null;
}

// Pseudo-kind covering the Property|PropertyGroup union: generated code
// walks `prop.property(name)` chains whose intermediate results may be
// either. Member lookup tries each member of the union.
const UNION_KINDS = { PropertyOrGroup: ["Property", "PropertyGroup"] };

// Collection element kinds for `coll[i]` indexing. `*Array` pseudo-kinds
// cover ExtendScript indexable returns that are not *Collection owners
// (e.g. Project.selection).
const COLLECTION_ELEMENT = {
  ItemCollection: "Item",
  // Comp layers are always AVLayer (TextLayer/ShapeLayer/etc. derive).
  LayerCollection: "AVLayer",
  RQItemCollection: "RenderQueueItem",
  OMCollection: "OutputModule",
  AVItemArray: "AVItem",
  FontObjectArray: "FontObject",
};

// Members that are part of the ExtendScript collection protocol rather
// than documented dfad members — `.length` on collections, indexing.
// Reads of these on typed collection receivers are protocol use, not
// undocumented-member findings.
const COLLECTION_PROTOCOL = new Set(["length"]);

// KNOWN INVENTORY GAPS: members that exist in the real AE scripting
// DOM (and the fake host) but are absent from the scraped
// symbols.json inventory. Each entry is "Owner.member" and is checked
// against the receiver's whole inheritance chain. Suppressed sites are
// counted in stats.gapSuppressed — never silently.
//   - Layer.property()/numProperties: documented in the AE scripting
//     guide under the property-access API; the dfad scrape only captured
//     them on PropertyGroup.
//   - Still/placeholder source geometry (name/width/height/...): read by
//     generated code but not claimed; absent from the scrape.
const KNOWN_GAPS = new Set([
  "Layer.property", "AVLayer.property", "PropertyBase.property",
  "Layer.numProperties", "AVLayer.numProperties", "PropertyBase.numProperties",
  "FileSource.name", "FileSource.width", "FileSource.height",
  "FileSource.pixelAspect", "FileSource.frameRate", "FileSource.duration",
  "SolidSource.name", "SolidSource.width", "SolidSource.height",
  "SolidSource.pixelAspect", "SolidSource.frameRate", "SolidSource.duration",
  "PlaceholderSource.name", "PlaceholderSource.width", "PlaceholderSource.height",
  "PlaceholderSource.pixelAspect", "PlaceholderSource.frameRate", "PlaceholderSource.duration",
]);

// ---------------------------------------------------------------------------
// Source model: functions + member sites
// ---------------------------------------------------------------------------

// Quote-aware comment stripper: generated sources carry explanatory
// comments that mention member syntax (`// layer.reorder(...)`) — without
// stripping, comments become phantom audit sites.
function stripComments(src) {
  let out = "", quote = null, esc = false, i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote !== null) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Replace string-literal contents with spaces (length-preserving) so
// member/call scans never match inside string text — generated arg
// values can embed arbitrary strings like "layer.reorder: ..." which
// would otherwise parse as phantom member accesses.
function maskStrings(src) {
  let out = "", quote = null, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote !== null) {
      if (esc) { esc = false; out += c === "\n" ? "\n" : " "; }
      else if (c === "\\") { esc = true; out += " "; }
      else if (c === quote) { quote = null; out += c; }
      else out += c === "\n" ? "\n" : " ";
      continue;
    }
    out += c;
    if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return out;
}

// Split generated source into top-level functions and the main tail.
// Returns [{name, params[], body, isMain}]. Brace-matched; generated
// sources never contain unbalanced braces inside strings.
function splitFunctions(src) {
  const fns = [];
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let m;
  const spans = [];
  while ((m = re.exec(src)) !== null) {
    let depth = 1, j = re.lastIndex;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    spans.push({ name: m[1], params: m[2].split(",").map((s) => s.trim()).filter(Boolean),
                 start: m.index, end: j, bodyStart: re.lastIndex });
  }
  // main tail = source minus function spans (PRELUDE funcs + helpers)
  let tail = "";
  let pos = 0;
  for (const s of spans) { tail += src.slice(pos, s.start); pos = s.end; }
  tail += src.slice(pos);
  for (const s of spans) fns.push({ name: s.name, params: s.params, body: stripComments(src.slice(s.bodyStart, s.end - 1)), isMain: false });
  fns.push({ name: "(main)", params: [], body: stripComments(tail), isMain: true });
  return fns;
}

// Split a call's argument text into top-level comma-separated args.
function splitArgs(argText) {
  const args = [];
  let depth = 0, start = 0, quote = null, esc = false;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (quote !== null) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { args.push(argText.slice(start, i)); start = i + 1; }
  }
  const last = argText.slice(start);
  if (last.trim() !== "") args.push(last);
  return args;
}

// Extract the argument-list text of every `.name(...)` call.
// Returns [{name, argsText, index}].
function callSites(src) {
  const out = [];
  const masked = maskStrings(src);
  const re = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let depth = 1, j = re.lastIndex;
    let quote = null, esc = false;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (quote !== null) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    out.push({ name: m[1], argsText: src.slice(re.lastIndex, j - 1), index: m.index });
    re.lastIndex = j;
  }
  return out;
}

// Member access sites: `.name` followed by `(`, `=`, or other.
// Write = single `=` not `==`/`=>`. Returns
// [{name, kind: "call"|"write"|"read", receiver, argsText}]
// where `receiver` is the dotted expression text before `.name`.
function memberSites(src) {
  const out = [];
  const masked = maskStrings(src);
  // receiver may contain dotted idents, [expr] index segments, and
  // simple (args) call groups — enough for `a.b("x").c.d` chains.
  const SEG = String.raw`(?:[A-Za-z_$][\w$]*(?:\([^()\n]*\))?(?:\[[^\]\n]*\])?|\([^()\n]*\)|\[[^\]\n]*\])`;
  const re = new RegExp(`(${SEG}(?:\\.${SEG})*)\\.([A-Za-z_$][\\w$]*)\\s*(.)`, "g");
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Receiver/name/next come from the masked text — string literals
    // inside index brackets appear as spaces, which receiverKinds
    // tolerates (it only needs the leading identifier chain).
    const receiver = m[1], name = m[2], next = m[3];
    // skip `..` (none in ES3) and numeric-ish; `next` is first char after name+ws
    let kind;
    let argsText = "";
    if (next === "(") {
      kind = "call";
      // Capture arg text by lookahead WITHOUT advancing lastIndex —
      // member sites inside the arguments must still be scanned.
      let depth = 1, j = m.index + m[0].length;
      let quote = null, esc = false;
      const start = j;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (quote !== null) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      argsText = src.slice(start, j - 1);
    } else if (next === "=") {
      // distinguish `=` write from `==`/`===`/`=>`
      const after = src[re.lastIndex] || "";
      if (after === "=" || after === ">") { kind = "read"; }
      else kind = "write";
    } else {
      kind = "read";
    }
    out.push({ receiver, name, kind, argsText });
    // Member chains: every intermediate `.segment` in the receiver is
    // itself an attribute read (e.g. `app.project.renderQueue.items`
    // reads Project.renderQueue AND RenderQueue.items). Emit prefix
    // sites so claims on intermediate members are exercised too.
    for (const pre of chainPrefixes(receiver)) {
      out.push({ receiver: pre.recv, name: pre.name, kind: "read", argsText: "" });
    }
    // Call groups inside the receiver are method-call sites too
    // (`a.b("x").c.d` — `.b(` is a call on `a`, `.c` read on the result).
    for (const nc of nestedCallSites(receiver)) {
      out.push(nc);
    }
  }
  return out;
}

// Find `.name(...)` call sites inside a receiver expression.
// `layer.property("A").property("B")` -> calls on `layer` and on
// `layer.property("A")`.
function nestedCallSites(receiver) {
  const out = [];
  let depth = 0, quote = null, esc = false;
  for (let i = 0; i < receiver.length; i++) {
    const c = receiver[i];
    if (quote !== null) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) { depth++; continue; }
    if (")]}".includes(c)) { depth--; continue; }
    if (c !== "." || depth !== 0) continue;
    const nm = /^\.([A-Za-z_$][\w$]*)\s*\(/.exec(receiver.slice(i));
    if (!nm) continue;
    const name = nm[1];
    const argsStart = i + nm[0].length;
    let d = 1, j = argsStart, q2 = null, e2 = false;
    while (j < receiver.length && d > 0) {
      const cj = receiver[j];
      if (q2 !== null) {
        if (e2) e2 = false;
        else if (cj === "\\") e2 = true;
        else if (cj === q2) q2 = null;
      } else if (cj === '"' || cj === "'" || cj === "`") q2 = cj;
      else if (cj === "(") d++;
      else if (cj === ")") d--;
      j++;
    }
    out.push({ receiver: receiver.slice(0, i), name, kind: "call", argsText: receiver.slice(argsStart, j - 1) });
    i = j - 1; // continue after this call's close paren
  }
  return out;
}

// Split a receiver expression into intermediate member-access sites.
// `app.project.renderQueue` -> [{recv:"app",name:"project"},
// {recv:"app.project",name:"renderQueue"}]. Respects [..] depth.
function chainPrefixes(receiver) {
  const out = [];
  let depth = 0, quote = null;
  const dots = [];
  for (let i = 0; i < receiver.length; i++) {
    const c = receiver[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "." && depth === 0) dots.push(i);
  }
  for (let d = 0; d < dots.length; d++) {
    const dot = dots[d];
    const nextDot = d + 1 < dots.length ? dots[d + 1] : receiver.length;
    const name = receiver.slice(dot + 1, nextDot);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    out.push({ recv: receiver.slice(0, dot), name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receiver-kind inference
// ---------------------------------------------------------------------------

// env maps identifier -> Set of kinds ("js" for plain JS values).
// Kinds may be union pseudo-kinds ("PropertyOrGroup").

function exprKind(expr, env) {
  expr = expr.trim();
  if (expr === "") return null;
  // parenthesized
  if (expr.startsWith("(") && expr.endsWith(")")) return exprKind(expr.slice(1, -1), env);
  // string / number / boolean / null / array / object literal -> js
  if (/^[\s]*[\[{]/.test(expr) || expr === "null" || expr === "true" || expr === "false" ||
      /^[-+]?\d/.test(expr) || expr.startsWith('"') || expr.startsWith("'")) {
    // template literal -> js (generated code interpolates values)
    return "js";
  }
  if (expr.startsWith("`")) return "js";
  // `new X(...)` — X becomes the receiver kind (filtered to inventory
  // owners later); JS builtins stay "js".
  let m = /^new\s+([A-Za-z_$][\w$]*)/.exec(expr);
  if (m) {
    const k = m[1];
    return JS_KINDS.has(k) ? "js" : k;
  }
  // index suffix `X[...]` -> collection/array element kind
  const idxM = /^(.+?)\[[^\]\n]*\]$/.exec(expr);
  if (idxM) {
    const base = exprKind(idxM[1], env);
    if (!base) return null;
    return elementKind(base);
  }
  // bare identifier
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    if (expr in GLOBAL_KINDS) return GLOBAL_KINDS[expr];
    if (JS_KINDS.has(expr)) return "js";
    return env[expr] || null;
  }
  // dotted/call chain `a.b("x").c[i].d` -> segment-wise evaluation
  const segs = splitChain(expr);
  if (segs && segs.length > 1) return chainKind(segs, env);
  // bare call `name(args)` / `__adp_x(...)`
  const callM = /^([A-Za-z_$][\w$]*)\s*\((.*)\)\s*;?\s*$/.exec(expr);
  if (callM) {
    const recvExpr = callM[1];
    const argText = callM[2];
    if (recvExpr.startsWith("__adp_")) {
      const h = HELPERS[recvExpr];
      if (!h) return null;
      if (typeof h.returns === "function") return h.returns(argText);
      return h.returns === "same" ? null : h.returns;
    }
    return JS_KINDS.has(recvExpr) ? "js" : null;
  }
  // ternary `cond ? a : b` — union of branch kinds (lightweight split)
  const q = topLevelChar(expr, "?");
  if (q !== -1) {
    const colon = topLevelChar(expr, ":", q + 1);
    if (colon !== -1) {
      const a = exprKind(expr.slice(q + 1, colon), env);
      const b = exprKind(expr.slice(colon + 1), env);
      return unionKind(a, b);
    }
  }
  return null;
}

// Split an expression on top-level '.' (depth 0 across ()[]{} and
// quotes). Returns null when there is no top-level dot.
function splitChain(expr) {
  const dots = [];
  let depth = 0, quote = null, esc = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote !== null) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "." && depth === 0) dots.push(i);
  }
  if (dots.length === 0) return null;
  const segs = [];
  let start = 0;
  for (const d of dots) { segs.push(expr.slice(start, d)); start = d + 1; }
  segs.push(expr.slice(start));
  return segs;
}

// Parse one chain segment: `name`, `name(args)`, `name[i]`,
// `name(args)[i]`, or a bare `(...)`/`[...]` group.
function parseSeg(seg) {
  const m = /^([A-Za-z_$][\w$]*)((?:\((?:[^()]|\([^()]*\))*\))?)(\[[^\]]*\])?$/.exec(seg);
  if (!m) return { bare: true };
  return {
    name: m[1],
    args: m[2] ? m[2].slice(1, -1) : "",
    hasCall: m[2] !== undefined && m[2] !== "",
    indexed: m[3] !== undefined,
  };
}

// Evaluate a dotted/call chain segment list left to right.
function chainKind(segs, env) {
  const first = parseSeg(segs[0]);
  let kinds;
  if (first.bare) {
    kinds = segs[0].startsWith("(") ? "js" : null;
  } else if (first.hasCall) {
    // `name(args)` as chain head: helper or JS builtin
    if (segs[0].startsWith("__adp_")) {
      const h = HELPERS[first.name];
      kinds = h ? (typeof h.returns === "function" ? h.returns(first.args) : h.returns === "same" ? null : h.returns) : null;
    } else {
      kinds = JS_KINDS.has(first.name) ? "js" : null;
    }
  } else {
    kinds = exprKind(first.name, env);
    if (kinds && first.indexed) kinds = elementKind(kinds);
  }
  if (!kinds) return null;
  for (let i = 1; i < segs.length; i++) {
    const s = parseSeg(segs[i]);
    if (s.bare) return null;
    kinds = memberReturnKind(kinds, s.name, s.args || "", segs.slice(0, i + 1).join("."));
    if (!kinds) return null;
    if (s.indexed) kinds = elementKind(kinds);
    if (!kinds) return null;
  }
  return kinds;
}

// Element kind for `X[i]` where X's kind is a collection/array pseudo.
function elementKind(kindsStr) {
  const out = [];
  for (const k of kindList(kindsStr)) {
    if (COLLECTION_ELEMENT[k]) out.push(COLLECTION_ELEMENT[k]);
  }
  return out.length ? [...new Set(out)].join("|") : "js";
}

function topLevelChar(s, ch, from = 0) {
  let depth = 0, quote = null, esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote !== null) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function unionKind(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  return "|" + [a, b].sort().join("|");
}

// kinds may be "A|B" unions or pseudo-union names; normalize to array.
function kindList(kinds) {
  if (!kinds) return [];
  const flat = [];
  for (const k of kinds.split("|")) {
    if (UNION_KINDS[k]) flat.push(...UNION_KINDS[k]);
    else flat.push(k);
  }
  return [...new Set(flat)];
}

// MEMBER_RETURN lookup walks the inheritance chain (nearest ancestor
// wins) so `TextLayer.property` resolves via `AVLayer.property`.
function MEMBER_RETURN_KEY(k, member) {
  for (const kk of kindChain(k)) {
    const key = `${kk}.${member}`;
    if (MEMBER_RETURN[key] !== undefined) return key;
  }
  return null;
}

// memberReturnKind(kinds, member, argText, objExpr) -> union kind
// string|null. Collects the documented return for EVERY kind in the
// union (a `FileSource|SolidSource` receiver may return File from one
// and nothing documented from the other — the union keeps what is
// known rather than first-hit guessing).
function memberReturnKind(kindsStr, member, argText, objExpr) {
  const kinds = kindList(kindsStr);
  const results = [];
  for (const k of kinds) {
    // app.* pseudo-members
    if (k === "app") {
      if (member === "project") results.push("Project");
      if (member === "preferences") results.push("Preferences");
      if (member === "fonts") results.push("FontsObject");
      continue;
    }
    const key = MEMBER_RETURN_KEY(k, member);
    if (key !== null) {
      const r = MEMBER_RETURN[key];
      if (typeof r === "function") {
        const v = r(argText || objExpr || "");
        if (v) results.push(v);
      } else if (r === "same") {
        results.push(k);
      } else {
        results.push(r);
      }
      continue;
    }
    // collection element via .item(i)/.byName(...) method calls
    if (COLLECTION_ELEMENT[k] && (member === "item" || member === "byName") && argText !== "") {
      results.push(COLLECTION_ELEMENT[k]);
    }
  }
  const flat = [...new Set(results.flatMap((r) => kindList(r)))];
  return flat.length ? flat.join("|") : null;
}

// Extract argument-list texts of every `name(...)` call in src.
function callArgsOf(src, name) {
  const out = [];
  const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1, j = re.lastIndex, quote = null, esc = false;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (quote !== null) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    out.push(src.slice(re.lastIndex, j - 1));
    re.lastIndex = j;
  }
  return out;
}

// Infer env for one function body. `paramKinds` maps param name -> kind.
function inferEnv(body, paramKinds = {}) {
  const env = { ...GLOBAL_KINDS };
  for (const [p, k] of Object.entries(paramKinds)) if (k) env[p] = k;
  // iterate var/assignment decls to a fixpoint (max 4 passes — chains
  // like comp -> layer -> prop -> prop resolve in order anyway)
  const assignRe = /(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/g;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    assignRe.lastIndex = 0;
    let m;
    while ((m = assignRe.exec(body)) !== null) {
      const name = m[1], rhs = m[2];
      // skip comparisons / compound assigns / for-loop headers
      if (/^[=!<>]/.test(rhs) || /^(==|===|!=|!==|<=|>=|&&|\|\|)/.test(rhs)) continue;
      if (/\b(for|if|while|return|switch)\b/.test(m[0].slice(0, m[0].indexOf("=")))) continue;
      const k = exprKind(rhs, env);
      if (!k || k === "js") continue;
      if (env[name] !== k) {
        // widen: keep union of observed kinds
        env[name] = env[name] ? unionKind(env[name], k) : k;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // instanceof narrowing (over-approximation): `x instanceof FolderItem`
  // anywhere in the body widens x's kind set. Covers guarded reads like
  // `if (it instanceof FolderItem) it.numItems` without block tracking.
  const instRe = /\b([A-Za-z_$][\w$]*)\s+instanceof\s+([A-Z][\w$]*)/g;
  let im;
  while ((im = instRe.exec(body)) !== null) {
    const v = im[1], ctor = im[2];
    env[v] = env[v] ? unionKind(env[v], ctor) : ctor;
  }
  return env;
}

// Resolve a member site's receiver expression to kind set.
// receiver text may be `it`, `comp.layers`, `app.project`, etc.
function receiverKinds(receiver, env, fnName) {
  const kinds = exprKind(receiver, env);
  return kinds ? kindList(kinds) : [];
}

// ---------------------------------------------------------------------------
// Arg-variant enumeration (mechanical)
// ---------------------------------------------------------------------------

// Literals appearing in a function's source text — the discriminating
// values an op's source/validate compare args against are literally
// present there.
function fnLiterals(fn) {
  const src = typeof fn === "function" ? fn.toString() : String(fn);
  const strings = new Set(), numbers = new Set();
  let m;
  const sre = /"([^"\\\n]{1,64})"|'([^'\\\n]{1,64})'/g;
  while ((m = sre.exec(src)) !== null) strings.add(m[1] ?? m[2]);
  const nre = /(?<![\w$.])(-?\d+(?:\.\d+)?)(?![\w$])/g;
  while ((m = nre.exec(src)) !== null) numbers.add(Number(m[1]));
  return { strings: [...strings], numbers: [...numbers] };
}

const MAX_PROBES_PER_ARG = 20;

// Candidate probe values for one arg: sample value first, then literals
// from the op's own source+validate matching the sample's JS type, then
// one generic alternate. validate()/buildSource() filters invalids.
function argProbes(op, argName, sampleVal) {
  const cands = [];
  const seen = new Set();
  const push = (v) => {
    const key = JSON.stringify(v);
    if (!seen.has(key) && cands.length < MAX_PROBES_PER_ARG + 2) {
      seen.add(key); cands.push(v);
    }
  };
  push(sampleVal);
  const lits = fnLiterals(op.source);
  const valLits = op.validate ? fnLiterals(op.validate) : { strings: [], numbers: [] };
  const strings = [...new Set([...lits.strings, ...valLits.strings])];
  const numbers = [...new Set([...lits.numbers, ...valLits.numbers])];
  if (typeof sampleVal === "string") {
    for (const s of strings) if (typeof s === "string") push(s);
  } else if (typeof sampleVal === "number") {
    for (const n of numbers) if (typeof n === "number") push(n);
  } else if (typeof sampleVal === "boolean") {
    push(true); push(false);
  } else if (Array.isArray(sampleVal)) {
    push([]);
  } else if (sampleVal && typeof sampleVal === "object") {
    push({});
  }
  // Generic alternates: coupled validation (e.g. `type` selects which
  // `default` shape is legal) needs cross-type probes the literal pass
  // cannot produce. validate()/buildSource() filters invalid combos.
  push(false); push(true); push(0); push(1); push("");
  return cands;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

// Arity range from an inventory signature array: required params are
// top-level comma-separated items; `[ ... ]` groups are optional.
export function signatureArity(signature) {
  const sigStr = signature.join(",");
  let depth = 0, required = sigStr.trim() === "" ? 0 : 1;
  for (const ch of sigStr) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) required++;
  }
  let optional = 0;
  for (const m of sigStr.matchAll(/\[([^\]]*)\]/g)) {
    optional += m[1].split(",").filter((s) => s.trim() !== "").length;
  }
  return { min: required, max: required + optional, sig: sigStr };
}

/**
 * Run the audit.
 * @param {string|{symbolsPath?, operations?, sampleArgsFn?, buildSourceFn?}} opts
 *   Injectable for counterexample tests; defaults are the real registry.
 */
export function auditMemberKinds(opts = {}) {
  const symbolsPath = typeof opts === "string" ? opts : (opts.symbolsPath || SYMBOLS_JSON);
  const operations = opts.operations || OPERATIONS;
  const sampleFn = opts.sampleArgsFn || sampleArgs;
  const buildFn = opts.buildSourceFn || ((id, args) => buildSource(id, args));
  const findings = [];
  const stats = {
    ops: 0, claims: 0, methods: 0, attributes: 0,
    sources: 0, functions: 0,
    callSites: 0, writeSites: 0, readSites: 0,
    typedSites: 0, untypedSites: 0,
    arityChecked: 0, sigClaims: 0,
    argsProbed: 0, discriminatingArgs: 0,
    helpersReached: 0, gapSuppressed: 0,
  };
  if (!existsSync(symbolsPath)) return { stats, findings, skipped: true };
  const symbols = JSON.parse(readFileSync(symbolsPath, "utf8")).symbols;
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const owners = new Set(symbols.map((s) => s.owner));
  const byOwnerMember = new Map();
  for (const s of symbols) {
    const k = `${s.owner}.${s.member}`;
    if (!byOwnerMember.has(k)) byOwnerMember.set(k, s);
  }

  for (const op of operations) {
    // ---- generate variant sources ----
    const { argSets, argStats } = variantArgSetsFor(op, sampleFn, buildFn);
    stats.sources += argSets.length;
    for (const [an, st] of Object.entries(argStats)) {
      stats.argsProbed += st.probes;
      if (st.distinctSources > 1) stats.discriminatingArgs++;
    }

    // ---- per-function envs + reachable helper closure ----
    // Collect sources once; split each into functions.
    const srcFns = []; // {fn, env} — main bodies, one per variant
    const helperFns = new Map(); // name -> [{params, body}] (all variants)
    for (const args of argSets) {
      let src;
      try { src = buildFn(op.id, args); }
      catch (e) {
        findings.push({ op: op.id, member: "(buildSource)", issue: `source generation failed: ${e.message}` });
        continue;
      }
      for (const f of splitFunctions(src)) {
        if (f.isMain) {
          srcFns.push({ fn: f, env: inferEnv(f.body) });
        } else {
          if (!helperFns.has(f.name)) helperFns.set(f.name, []);
          helperFns.get(f.name).push(f);
        }
      }
    }
    stats.functions += srcFns.length;

    // Reachability: functions actually CALLED by the main tail, then
    // transitively by reached helpers. Works for PRELUDE helpers and
    // per-op helpers alike (any `function name(...)` in the source).
    const fnBodies = helperFns;
    const reachable = new Set();
    const queue = [];
    const callReFor = (n) => new RegExp(`\\b${n.replace(/[$]/g, "\\$")}\\s*\\(`);
    for (const { fn } of srcFns) {
      for (const name of fnBodies.keys()) {
        if (callReFor(name).test(fn.body)) queue.push(name);
      }
    }
    while (queue.length) {
      const n = queue.pop();
      if (reachable.has(n)) continue;
      reachable.add(n);
      stats.helpersReached++;
      for (const f of fnBodies.get(n) || []) {
        for (const name of fnBodies.keys()) {
          if (name !== n && callReFor(name).test(f.body)) queue.push(name);
        }
      }
    }

    // Analysis units: every main variant body + each DISTINCT reachable
    // helper body (deduped — identical helper text analyzed once).
    const units = [];
    for (const { fn, env } of srcFns) units.push({ name: fn.name, body: fn.body, env, isMain: true });
    const seenHelperBody = new Set();
    for (const n of reachable) {
      const hs = HELPERS[n] || { params: {} };
      for (const hf of fnBodies.get(n) || []) {
        const key = n + "\n" + hf.body;
        if (seenHelperBody.has(key)) continue;
        seenHelperBody.add(key);
        const paramKinds = {};
        hf.params.forEach((p) => { paramKinds[p] = (hs.params && hs.params[p]) || "js"; });
        // Call-site inference: for params still "js", union the kinds of
        // the corresponding arguments at every call in the main tails.
        const argKinds = hf.params.map(() => []);
        for (const { fn, env } of srcFns) {
          for (const argText of callArgsOf(fn.body, n)) {
            splitArgs(argText).forEach((a, i) => {
              if (i >= hf.params.length) return;
              const k = exprKind(a.trim(), env);
              if (k && k !== "js") argKinds[i].push(k);
            });
          }
        }
        hf.params.forEach((p, i) => {
          if (paramKinds[p] === "js" && argKinds[i].length) {
            paramKinds[p] = [...new Set(argKinds[i].flatMap((k) => kindList(k)))].join("|");
          }
        });
        units.push({ name: n, body: hf.body, env: inferEnv(hf.body, paramKinds), isMain: false });
      }
    }

    // ---- collect typed member sites across all units ----
    const sites = [];
    for (const u of units) {
      for (const s of memberSites(u.body)) {
        const kinds = receiverKinds(s.receiver, u.env);
        const hostKinds = kinds.filter((k) => owners.has(k) || k === "app" ||
          UNION_KINDS[k] || kindChain(k).some((c) => owners.has(c)));
        const typed = hostKinds.length > 0;
        if (s.kind === "call") stats.callSites++;
        else if (s.kind === "write") stats.writeSites++;
        else stats.readSites++;
        if (typed) stats.typedSites++; else stats.untypedSites++;
        sites.push({ ...s, unit: u.name, kinds: kindList(hostKinds.join("|")), typed });
      }
    }

    // A site "concerns" owner O when any receiver kind IS-A O.
    const concerns = (s, owner) => s.kinds.some((k) => kindIsA(k, owner));
    const exercised = (owner, member, want) =>
      sites.some((s) => {
        if (s.name !== member || !s.typed || !concerns(s, owner)) return false;
        if (want === "call") return s.kind === "call";
        if (want === "write") return s.kind === "write";
        return s.kind === "read" || s.kind === "write";
      });

    for (const memberId of op.members) {
      const sym = byId.get(memberId);
      if (!sym) continue;
      stats.claims++;
      if (sym.kind === "method") stats.methods++; else stats.attributes++;
      const name = sym.member;
      const owner = sym.owner;

      if (sym.kind === "method" && !exercised(owner, name, "call")) {
        findings.push({
          op: op.id, member: memberId, kind: sym.kind,
          issue: `method '${owner}.${name}' claimed but never invoked as .${name}() on a ${owner}-compatible receiver in any generated variant`,
        });
      }
      if (sym.kind === "attribute") {
        if (!exercised(owner, name, "access")) {
          findings.push({
            op: op.id, member: memberId, kind: sym.kind,
            issue: `attribute '${owner}.${name}' claimed but never accessed on a ${owner}-compatible receiver in any generated variant`,
          });
        }
        if (sym.access === "read") {
          const w = sites.find((s) => s.name === name && s.kind === "write" && s.typed &&
            s.kinds.some((k) => kindIsA(k, owner)));
          if (w) {
            findings.push({
              op: op.id, member: memberId, kind: sym.kind,
              issue: `read-only attribute '${owner}.${name}' is assigned (${w.unit}.${w.receiver}.${w.name} =)`,
            });
          }
        }
        const c = sites.find((s) => s.name === name && s.kind === "call" && s.typed &&
          s.kinds.some((k) => kindIsA(k, owner)));
        if (c) {
          findings.push({
            op: op.id, member: memberId, kind: sym.kind,
            issue: `attribute '${owner}.${name}' claimed but invoked as .${name}() on ${c.kinds.join("|")} — possible property/method confusion`,
          });
        }
      }

      // ---- site-level checks for this member across all sources ----
      if (sym.kind === "method" && Array.isArray(sym.signature) && sym.signature.length > 0) {
        stats.arityChecked++;
        stats.sigClaims++;
        const { min, max, sig } = signatureArity(sym.signature);
        for (const s of sites) {
          if (s.name !== name || s.kind !== "call" || !s.typed) continue;
          if (!s.kinds.some((k) => kindIsA(k, owner))) continue;
          const n = callArgCount(s.argsText);
          if (n < min || n > max) {
            findings.push({
              op: op.id, member: memberId, kind: sym.kind,
              issue: `method '${owner}.${name}' called with ${n} arg(s); documented signature allows ${min}..${max} (${sig})`,
            });
          }
        }
      }
    }

    // ---- site-level checks NOT tied to claims: documented-member
    // validation on typed receivers (catches wrong-owner calls and
    // typos the claim list never mentions). Union receivers pass when
    // ANY member kind documents the member compatibly.
    for (const s of sites) {
      if (!s.typed) continue;
      // collection-protocol members are not dfad-documented
      if (s.kinds.every((k) => k.endsWith("Collection") || k.endsWith("Array")) &&
          COLLECTION_PROTOCOL.has(s.name)) continue;
      // Only kinds whose inheritance chain reaches an inventory owner
      // are checkable (File, AVItemArray, ... are outside inventory).
      const checkable = s.kinds.filter((k) => kindChain(k).some((c) => owners.has(c)));
      if (checkable.length === 0) continue;
      const hits = [];
      for (const k of checkable) {
        const h = lookupMember(byOwnerMember, k, s.name);
        if (h) hits.push({ k, ...h });
      }
      const siteLabel = `(${s.unit}:${s.receiver}.${s.name})`;
      if (hits.length === 0) {
        // Inventory-gap suppression: every checkable kind's chain must
        // hit a KNOWN_GAPS entry, and the gap must be recorded.
        const gapHit = checkable.some((k) =>
          kindChain(k).some((c) => KNOWN_GAPS.has(`${c}.${s.name}`)));
        if (gapHit) { stats.gapSuppressed++; continue; }
        findings.push({
          op: op.id, member: siteLabel, kind: s.kind,
          issue: `site uses '${checkable.join("|")}.${s.name}' (${s.kind}) but no such member is documented for those owners or their ancestors`,
        });
        continue;
      }
      if (s.kind === "call" && !hits.some((h) => h.sym.kind === "method")) {
        const h = hits[0];
        findings.push({
          op: op.id, member: siteLabel, kind: "method",
          issue: `attribute '${h.k}.${s.name}' (via ${h.via}, documented ${h.sym.kind}) invoked as .${s.name}() — property/method confusion`,
        });
      }
      if (s.kind === "write") {
        if (hits.some((h) => h.sym.kind === "method")) {
          const h = hits.find((x) => x.sym.kind === "method");
          findings.push({
            op: op.id, member: siteLabel, kind: "attribute",
            issue: `method '${h.k}.${s.name}' (via ${h.via}) assigned as .${s.name} =`,
          });
        } else if (hits.every((h) => h.sym.kind === "attribute" && h.sym.access === "read")) {
          const h = hits[0];
          findings.push({
            op: op.id, member: siteLabel, kind: "attribute",
            issue: `read-only attribute '${h.k}.${s.name}' (via ${h.via}) assigned`,
          });
        }
      }
    }
    stats.ops++;
  }
  // Same site text recurs across generated variants — dedup findings.
  const seenFinding = new Set();
  const deduped = findings.filter((f) => {
    const key = `${f.op}|${f.member}|${f.issue}`;
    if (seenFinding.has(key)) return false;
    seenFinding.add(key);
    return true;
  });
  return { stats, findings: deduped };
}

// variantArgSets needs sampleArgsFn injected; wrapper keeps signature tidy.
function variantArgSetsFor(op, sampleFn, buildFn = (id, args) => buildSource(id, args)) {
  const base = sampleFn(op);
  const argSets = [base];
  const argStats = {};
  const seenSrc = new Set([safeBuild(op.id, base, buildFn)]);
  const failures = []; // {arg, value} — probes validate() rejected alone
  const addSource = (args) => {
    const src = safeBuild(op.id, args, buildFn);
    if (src === null || seenSrc.has(src)) return false;
    seenSrc.add(src); argSets.push(args); return true;
  };
  for (const name of op.args || []) {
    const probes = argProbes(op, name, base[name]);
    let distinct = 0;
    const localSeen = new Set();
    for (const v of probes) {
      const args = { ...base, [name]: v };
      const src = safeBuild(op.id, args, buildFn);
      if (src === null) { if (JSON.stringify(v) !== JSON.stringify(base[name])) failures.push({ arg: name, value: v }); continue; }
      if (!localSeen.has(src)) { localSeen.add(src); distinct++; }
      addSource(args);
    }
    argStats[name] = { probes: probes.length, distinctSources: distinct };
  }
  // Coupled-arg retry: some ops validate arg COMBINATIONS (e.g.
  // pref.get requires `default` to match `type`). Single-arg probes
  // that failed are retried jointly with each other arg's probes —
  // first successful combination is kept. Bounded and mechanical.
  for (const f of failures.slice(0, 40)) {
    let done = false, attempts = 0;
    for (const other of op.args || []) {
      if (other === f.arg || done || attempts > 120) continue;
      for (const v2 of argProbes(op, other, base[other])) {
        if (++attempts > 120) break;
        const args = { ...base, [f.arg]: f.value, [other]: v2 };
        if (addSource(args)) { done = true; break; }
      }
      if (done) break;
    }
  }
  return { argSets, argStats };
}

function safeBuild(id, args, buildFn) {
  try { return buildFn(id, args); } catch { return null; }
}

// Exported for counterexample tests (tests/audit-member-kinds.test.mjs).
export { splitFunctions, memberSites, inferEnv, exprKind, receiverKinds, kindChain, kindIsA, lookupMember, callArgsOf, argProbes, HELPERS, INHERITS, variantArgSetsFor };
export const __testables = { MEMBER_RETURN, COLLECTION_ELEMENT, UNION_KINDS, JS_KINDS, GLOBAL_KINDS };

// Count top-level comma-separated args in an arg list (0 for empty).
function callArgCount(argText) {
  if (!argText || argText.trim() === "") return 0;
  return splitArgs(argText).length;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { stats, findings, skipped } = auditMemberKinds();
  if (skipped) {
    console.log("audit-member-kinds: symbols.json not present (published tarball) — skipping");
    process.exit(0);
  }
  console.log(`audit-member-kinds: ${stats.ops} ops, ${stats.sources} sources, ${stats.claims} claims (${stats.methods} methods, ${stats.attributes} attributes)`);
  console.log(`  sites: ${stats.callSites} calls, ${stats.writeSites} writes, ${stats.readSites} reads — typed ${stats.typedSites}, untyped ${stats.untypedSites}`);
  console.log(`  args: ${stats.argsProbed} probes, ${stats.discriminatingArgs} discriminating args; arity-checked ${stats.arityChecked} signatured method claims; ${stats.gapSuppressed} known-inventory-gap site(s) suppressed`);
  if (findings.length === 0) {
    console.log("audit-member-kinds: no findings");
    process.exit(0);
  }
  for (const f of findings) {
    console.log(`FINDING ${f.op} :: ${f.member}\n  ${f.issue}`);
  }
  console.log(`audit-member-kinds: ${findings.length} finding(s) — verify each against Adobe docs before treating as a bug`);
  process.exit(1);
}
