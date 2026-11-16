/**
 * Build the After Effects Scripting API inventory (CAP005-CAP008).
 *
 * Usage:
 *   bun run scripts/build.ts            # reproduce from the cache, verify hashes
 *   bun run scripts/build.ts --refresh  # re-download, re-pin sources.lock.json
 *
 * The build is deterministic: identical input bytes produce byte-identical output.
 * Timestamps are taken from the source lock, never from the wall clock, so a
 * no-op run leaves the working tree clean.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { docsFromArchive } from "./archive.ts";
import { parseAdobePage } from "./adobe-page.ts";
import type { AdobePageText } from "./adobe-page.ts";
import { resolveClaims } from "./claims.ts";
import { extractChangelog } from "./extract-changelog.ts";
import { extractEnums } from "./extract-enums.ts";
import { extractFromDoc } from "./extract-symbols.ts";
import { extractHierarchyCaveats } from "./extract-symbols.ts";
import type { ClassRecord, SymbolRecord } from "./extract-symbols.ts";
import type { EnumRecord } from "./extract-enums.ts";
import { REAL_HOST_REQUIREMENTS } from "./constraints.ts";
import { DIVERGENCES } from "./divergence.ts";
import { resolveConstraints } from "./resolve-constraints.ts";
import { obtainSource, readLock, writeLock } from "./fetch.ts";
import type { LockEntry } from "./fetch.ts";
import { ALL_SOURCES, COMMUNITY_ARCHIVE, REFERENCE_HOSTS } from "./sources.ts";
import type { SourceSpec } from "./sources.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "generated");
const CACHE = join(ROOT, ".cache");

const DFAD_BASE = "https://ae-scripting.docsforadobe.dev";

function dfadUrl(sitePath: string): string {
  return `${DFAD_BASE}/${sitePath}/`;
}

function adobeUrl(spec: SourceSpec): string {
  return spec.publicUrl;
}

type Domain =
  | "application"
  | "project"
  | "item"
  | "comp"
  | "layer"
  | "property"
  | "keyframe"
  | "expression"
  | "effect"
  | "mask"
  | "shape"
  | "text"
  | "render-queue"
  | "output"
  | "source"
  | "preferences"
  | "ui"
  | "undo"
  | "file"
  | "system"
  | "collection"
  | "unknown";

/**
 * Map a class to a functional domain so the README can report per-domain counts.
 * The mapping is by class, because the source documents by class. Members whose
 * owner is not listed fall into `unknown` rather than being guessed.
 */
const CLASS_DOMAIN: Record<string, Domain> = {
  app: "application",
  Application: "application",
  Project: "project",
  System: "system",
  Item: "item",
  AVItem: "item",
  CompItem: "comp",
  FolderItem: "item",
  FootageItem: "item",
  ItemCollection: "collection",
  Layer: "layer",
  AVLayer: "layer",
  CameraLayer: "layer",
  LightLayer: "layer",
  ShapeLayer: "shape",
  TextLayer: "text",
  ThreeDModelLayer: "layer",
  ParametricMeshLayer: "shape",
  LayerCollection: "collection",
  Property: "property",
  PropertyBase: "property",
  PropertyGroup: "property",
  MaskPropertyGroup: "mask",
  RenderQueue: "render-queue",
  RenderQueueItem: "render-queue",
  RQItemCollection: "collection",
  OMCollection: "collection",
  OutputModule: "output",
  FootageSource: "source",
  FileSource: "source",
  SolidSource: "source",
  PlaceholderSource: "source",
  TextDocument: "text",
  CharacterRange: "text",
  ParagraphRange: "text",
  ComposedLineRange: "text",
  FontObject: "text",
  FontsObject: "text",
  MarkerValue: "keyframe",
  KeyframeEase: "keyframe",
  Shape: "shape",
  ImportOptions: "item",
  GuideOptions: "ui",
  Preferences: "preferences",
  Settings: "preferences",
  Viewer: "ui",
  View: "ui",
  ViewOptions: "ui",
  Collection: "collection",
  global: "system",
};

function domainFor(owner: string): Domain {
  return CLASS_DOMAIN[owner] ?? "unknown";
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");

  const payloads = new Map<string, Uint8Array>();
  const entries: LockEntry[] = [];
  for (const spec of ALL_SOURCES) {
    const got = await obtainSource(spec, { root: ROOT, cacheDir: CACHE, refresh });
    payloads.set(spec.key, got.payload);
    entries.push(got.entry);
    process.stderr.write(
      `${got.fromCache ? "cache" : "fetch"}  ${spec.key}  ${got.entry.sha256.slice(0, 12)}  ${got.entry.bytes}B\n`,
    );
  }
  if (refresh || !existsSync(join(ROOT, "sources.lock.json"))) {
    await writeLock(ROOT, entries);
  }
  const lock = await readLock(ROOT);
  if (!lock) throw new Error("sources.lock.json missing after build");

  // ---- CAP005: community-tier symbol extraction -------------------------
  const archive = payloads.get(COMMUNITY_ARCHIVE.key);
  if (!archive) throw new Error("community archive was not fetched");
  const docs = docsFromArchive(archive);

  const symbols: SymbolRecord[] = [];
  const classes: ClassRecord[] = [];
  const enums: EnumRecord[] = [];

  // First pass: members and classes. Enum extraction needs the full class set so it
  // can tell an enum namespace (`LayerInputStageType.SOURCE`) from a class reference
  // that happens to be written `Class.CONSTANT`-shaped.
  for (const doc of docs) {
    // Match-name tables enumerate AE internal match names, not scripting
    // members. They belong to a different inventory axis and are counted
    // separately as a documented gap rather than mixed into the symbol total.
    if (doc.sitePath.startsWith("matchnames/")) continue;
    if (doc.sitePath === "index") continue;

    const extracted = extractFromDoc(doc, {
      sourceKey: COMMUNITY_ARCHIVE.key,
      publisher: COMMUNITY_ARCHIVE.publisher,
      urlFor: dfadUrl,
    });
    symbols.push(...extracted.symbols);
    classes.push(...extracted.classes);
  }

  const knownClassNames = [...new Set(classes.map((c) => c.name))];

  // Apply the documented `instanceof` caveats from the class-hierarchy page.
  const hierarchyDoc = docs.find((d) => d.sitePath === "introduction/classhierarchy");
  if (hierarchyDoc) {
    const caveats = extractHierarchyCaveats(hierarchyDoc.text);
    for (const c of classes) {
      const caveat = caveats.get(c.name);
      if (caveat) c.instanceofCaveat = caveat;
    }
  }

  // Second pass: enums, now class-aware.
  for (const doc of docs) {
    if (doc.sitePath.startsWith("matchnames/")) continue;
    if (doc.sitePath === "index") continue;

    const enumResult = extractEnums(doc, {
      sourceKey: COMMUNITY_ARCHIVE.key,
      urlFor: dfadUrl,
      knownClassNames,
    });
    for (const e of enumResult.enums) {
      const existing = enums.find((x) => x.name === e.name);
      if (existing) {
        for (const v of e.values) {
          if (!existing.values.some((y) => y.value === v.value)) existing.values.push(v);
        }
      } else {
        enums.push(e);
      }
    }
  }

  for (const s of symbols) {
    s.notes.includes("domain unresolved") || s.notes.push(`domain=${domainFor(s.owner)}`);
  }
  symbols.sort((a, b) => a.id.localeCompare(b.id));
  classes.sort((a, b) => a.name.localeCompare(b.name));
  enums.sort((a, b) => a.name.localeCompare(b.name));

  // ---- CAP006/CAP007: Adobe-official claims ------------------------------
  const adobePages = new Map<string, AdobePageText>();
  for (const spec of ALL_SOURCES) {
    if (spec.tier !== "adobe-official") continue;
    const payload = payloads.get(spec.key);
    if (!payload) continue;
    adobePages.set(spec.key, parseAdobePage(Buffer.from(payload).toString("utf8")));
  }
  const claims = resolveClaims(adobePages, (key) => {
    const spec = ALL_SOURCES.find((s) => s.key === key);
    if (!spec) throw new Error(`unknown source key ${key}`);
    return adobeUrl(spec);
  });

  // ---- CAP006: version deltas from the guide changelog -------------------
  const changelogDoc = docs.find((d) => d.sitePath === "introduction/changelog");
  if (!changelogDoc) throw new Error("changelog page not found in pinned archive");
  const changelog = extractChangelog(changelogDoc, symbols, { classes, enums });

  // ---- CAP007: classified constraints ------------------------------------
  const constraintResult = resolveConstraints(docs, adobePages, {
    dfad: (sitePath, anchor) =>
      `${dfadUrl(sitePath)}${anchor ? `#${anchor}` : ""}`,
    adobe: (key) => {
      const spec = ALL_SOURCES.find((s) => s.key === key);
      if (!spec) throw new Error(`unknown source key ${key}`);
      return adobeUrl(spec);
    },
  });
  if (constraintResult.failures.length > 0) {
    throw new Error(
      `constraint citation drift:\n - ${constraintResult.failures.join("\n - ")}`,
    );
  }
  const constraints = constraintResult.evidence;

  // ---- CAP008: tier divergences and real-host-only behaviours ------------
  const realHostByCategory = new Map<string, number>();
  for (const r of REAL_HOST_REQUIREMENTS) {
    realHostByCategory.set(r.category, (realHostByCategory.get(r.category) ?? 0) + 1);
  }

  // ---- Derived counts ----------------------------------------------------
  const enumValues = enums.reduce((n, e) => n + e.values.length, 0);
  const versioned = symbols.filter((s) => s.versionRangeStated).length;
  const undocumentedByCommunity = symbols.filter((s) => s.markedUndocumented).length;

  const byDomain = new Map<string, number>();
  for (const s of symbols) {
    const d = domainFor(s.owner);
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }
  const byKind = new Map<string, number>();
  for (const s of symbols) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);

  const summary = {
    note:
      "Provisional inventory metadata. The capability-ID grammar and catalog schema " +
      "are owned by ido-bata/ae-devtools#11 and are NOT frozen here.",
    provisionalIds: true,
    generatedFrom: "inventories/scripting/scripts/build.ts",
    sourceLock: "sources.lock.json",
    denominators: {
      scriptingMembers: symbols.length,
      scriptingClasses: classes.length,
      enums: enums.length,
      enumValues,
      // Distinct denominators are reported separately, never summed.
      byKind: Object.fromEntries([...byKind.entries()].sort()),
      byDomain: Object.fromEntries([...byDomain.entries()].sort()),
      membersWithStatedVersion: versioned,
      membersVersionUnstated: symbols.length - versioned,
      membersMarkedUndocumentedByCommunity: undocumentedByCommunity,
      adobeOfficialClaims: claims.length,
      adobeOfficialSymbolLevelClaims: 0,
      constraints: constraints.length,
      versionDeltas: changelog.deltas.length,
      versionDeltasUnresolved: changelog.deltas.filter((d) => d.resolvedId === null).length,
      tierDivergences: DIVERGENCES.length,
      realHostRequirements: REAL_HOST_REQUIREMENTS.length,
    },
    sourceTiers: {
      "adobe-official": {
        publisher: "Adobe",
        authority: "primary",
        symbolLevelReference: false,
        note:
          "Adobe publishes operational constraints for scripting but no symbol-level " +
          "scripting reference. Recorded as a CAP008 finding, not as a coverage claim.",
      },
      "community-reference": {
        publisher: COMMUNITY_ARCHIVE.publisher,
        authority: "community-maintained",
        revision: COMMUNITY_ARCHIVE.revision,
        note:
          "Not an Adobe-official mirror. Agreement between tiers is not verification.",
      },
    },
    referenceHosts: REFERENCE_HOSTS,
    evidenceLevel: {
      inventory: "source-reviewed",
      verification: "not-run",
      realHost: "not-run",
      statement:
        "Symbols were extracted from a pinned source revision. No After Effects " +
        "process was started and no symbol was executed. Anything a real host would " +
        "have to confirm is listed as such in cap008-requirements.md.",
    },
  };

  await mkdir(OUT, { recursive: true });
  const write = async (name: string, value: unknown) => {
    await writeFile(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  await write("symbols.json", {
    schemaNote: "Provisional shape; final schema owned by issue #11.",
    counts: { members: symbols.length, classes: classes.length, enums: enums.length, enumValues },
    classes,
    symbols,
    enums,
  });
  await write("official-claims.json", {
    schemaNote: "Provisional shape; final schema owned by issue #11.",
    tier: "adobe-official",
    claims,
  });
  await write("version-deltas.json", {
    schemaNote: "Provisional shape; final schema owned by issue #11.",
    tier: "community-reference",
    publisher: COMMUNITY_ARCHIVE.publisher,
    note:
      "Per-release scripting changes as stated by the community guide changelog. " +
      "Not an Adobe-published version matrix. resolvedId is null when the entry " +
      "naming could not be matched to an extracted symbol.",
    counts: {
      deltas: changelog.deltas.length,
      unresolved: changelog.deltas.filter((d) => d.resolvedId === null).length,
    },
    /**
     * Every delta whose symbol could not be tied to an inventory row, so
     * `counts.unresolved` is always fully enumerated. `changelog.resolverMisses`
     * alone is not sufficient: it tracks member-level misses only, while a
     * changelog entry may name a class whose identifier differs (the guide calls
     * the page "Font object" but the class is `FontObject`), which leaves
     * `resolvedId` null without being a member miss.
     */
    unresolvedEntries: changelog.deltas
      .filter((d) => d.resolvedId === null)
      .map((d) => ({
        aeVersion: d.aeVersion,
        kind: d.kind,
        symbol: d.symbol,
        anchor: d.anchor,
      })),
    /** Member-level naming misses, kept for the narrower audit trail. */
    resolverMisses: changelog.resolverMisses,
    releaseNotes: changelog.notes,
    deltas: changelog.deltas,
  });
  await write("constraints.json", {
    schemaNote: "Provisional shape; final schema owned by issue #11.",
    tiers: {
      "adobe-official":
        "Statements published by Adobe. authority=primary.",
      "community-reference":
        "Statements from the community guide at the pinned revision. " +
        "authority=community-maintained.",
    },
    counts: {
      total: constraints.length,
      byTier: Object.fromEntries(
        ["adobe-official", "community-reference"].map((t) => [
          t,
          constraints.filter((c) => c.tier === t).length,
        ]),
      ),
      byCategory: Object.fromEntries(
        [...new Set(constraints.map((c) => c.category))]
          .sort()
          .map((cat) => [cat, constraints.filter((c) => c.category === cat).length]),
      ),
    },
    constraints,
  });
  await write("cap008-requirements.json", {
    schemaNote: "Provisional shape; final schema owned by issue #11.",
    evidenceLevel: "not-run",
    statement:
      "Nothing in this list was executed. Each row states a behaviour only a real " +
      "After Effects host can settle, and is labelled `requires real host`.",
    realHostRequirements: REAL_HOST_REQUIREMENTS,
    realHostSummary: {
      total: REAL_HOST_REQUIREMENTS.length,
      byCategory: Object.fromEntries([...realHostByCategory.entries()].sort()),
    },
    tierDivergences: DIVERGENCES,
    divergenceSummary: {
      total: DIVERGENCES.length,
      byClass: Object.fromEntries(
        [...new Set(DIVERGENCES.map((d) => d.divergenceClass))].sort().map((k) => [
          k,
          DIVERGENCES.filter((d) => d.divergenceClass === k).length,
        ]),
      ),
    },
  });
  await write("summary.json", summary);

  process.stderr.write(
    `\nmembers=${symbols.length} classes=${classes.length} enums=${enums.length} ` +
      `enumValues=${enumValues} claims=${claims.length}\n`,
  );

  // Non-fatal integrity checks that must not silently regress.
  const problems: string[] = [];
  const dup = new Map<string, number>();
  for (const s of symbols) dup.set(s.id, (dup.get(s.id) ?? 0) + 1);
  for (const [id, n] of dup) if (n > 1) problems.push(`duplicate member id: ${id} (${n})`);
  for (const s of symbols) {
    if (!s.url) problems.push(`member without url: ${s.id}`);
    if (s.status === "documented" && s.notes.some((x) => x.startsWith("kind inferred"))) {
      problems.push(`documented member with inferred kind: ${s.id}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`inventory integrity failures:\n - ${problems.join("\n - ")}`);
  }
}

await main();
