/**
 * CAP001 tool registry: the exact tools inventoried, their pinned commit,
 * license observation and evidence status.
 *
 * `commit` values are pinned; the extractor refuses to run against a clone
 * whose HEAD differs, so citations cannot silently drift (see refresh.ts for
 * the update procedure).
 */

import { resolve } from "node:path";
import type { ToolRecord } from "./types.ts";

/** Inventory observation date (ISO). refresh --update rewrites this. */
export const OBSERVED_AT = "2026-11-12";

/** inventories/tools package root. */
export const PKG_ROOT = resolve(import.meta.dir, "..");
/** Repository root (two levels above this package). */
export const REPO_ROOT = resolve(PKG_ROOT, "../..");
/** Third-party clones live here (git-ignored). */
export const REFERENCE_ROOT = resolve(REPO_ROOT, ".reference");

export const AE_A8N_ID = "ido-bata/ae-a8n";
export const AE_DEVTOOLS_ID = "ido-bata/ae-devtools";

export interface ToolDef {
  id: string;
  repoUrl: string;
  kind: ToolRecord["kind"];
  /** Pinned commit SHA the inventory was taken at. */
  commit: string;
  license: string;
  licenseEvidence: string;
  /** Directory under .reference/; omitted for self/local roots. */
  cloneDir?: string;
  extraction: string;
  notes?: string;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    id: AE_A8N_ID,
    repoUrl: "https://github.com/ido-bata/ae-a8n",
    kind: "automation-runtime",
    commit: "61d490c15363a287b3a918155022be1a6dd5fe0b",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License'; package.json \"license\": \"MIT\"",
    extraction: "ae-a8n",
    notes: "Local read-only checkout; primary existing-implementation reference.",
  },
  {
    id: AE_DEVTOOLS_ID,
    repoUrl: "https://github.com/ido-bata/ae-devtools",
    kind: "experiment",
    commit: "103012be99562c98b9e9cbc9a276219d159c227a",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License'",
    extraction: "ae-devtools",
    notes:
      "Only experiments/runtime-bridge is inventoried; pinned to the release-0-1-0 base commit the experiments were read at.",
  },
  {
    id: "BenZed/after-effects",
    repoUrl: "https://github.com/BenZed/after-effects",
    kind: "library",
    commit: "316c063987f9994668d55f77f250204a5936f3f8",
    license: "MIT (LICENSE text) / ISC (package.json) — mismatch kept as ambiguity",
    licenseEvidence:
      "LICENSE 'Permission is hereby granted...'; package.json \"license\": \"ISC\" — recorded without resolving",
    cloneDir: "BenZed_after-effects",
    extraction: "benzed",
    notes: "Cited by ae-a8n ADR-0001 as prior external AE invocation precedent.",
  },
  {
    id: "ido-bata/Ae_LayerNote",
    repoUrl: "https://github.com/ido-bata/Ae_LayerNote",
    kind: "cep-extension",
    commit: "60193a0e49da61cfa3713258452cccbd41c37874",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License', copyright 'Hyper Brew LLC'; package.json has no license field",
    cloneDir: "ido-bata_Ae_LayerNote",
    extraction: "layernote",
  },
  {
    id: "ishu86/after-effects-mcp",
    repoUrl: "https://github.com/ishu86/after-effects-mcp",
    kind: "mcp-server",
    commit: "5223c17a8e8c1273b25c6a9d306839259ad35143",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License'; package.json \"license\": \"MIT\"",
    cloneDir: "ishu86_after-effects-mcp",
    extraction: "ishu86",
  },
  {
    id: "HeroicSwan/after-effects-mcp",
    repoUrl: "https://github.com/HeroicSwan/after-effects-mcp",
    kind: "mcp-server",
    commit: "e38b2609cde262822b888e815684117b35447b11",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License'; package.json \"license\": \"MIT\"",
    cloneDir: "HeroicSwan_after-effects-mcp",
    extraction: "heroicswan",
  },
  {
    id: "Dakkshin/after-effects-mcp",
    repoUrl: "https://github.com/Dakkshin/after-effects-mcp",
    kind: "mcp-server",
    commit: "88d5fbf08b7ae9f015ee98e5f8c4904095cf8202",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License'; root package.json declares no license field",
    cloneDir: "Dakkshin_after-effects-mcp",
    extraction: "dakkshin-family",
  },
  {
    id: "TheLlamainator/after-effects-mcp",
    repoUrl: "https://github.com/TheLlamainator/after-effects-mcp",
    kind: "mcp-server",
    commit: "e4a462098d28acc22a128ec20a9091ae47422915",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License'; copyright line copies Dakkshin's original; no package license field",
    cloneDir: "TheLlamainator_after-effects-mcp",
    extraction: "dakkshin-family",
    notes: "Fork lineage of Dakkshin/after-effects-mcp (same package name and script set).",
  },
  {
    id: "a-y-ibrahim/after-effects-mcp",
    repoUrl: "https://github.com/a-y-ibrahim/after-effects-mcp",
    kind: "mcp-server",
    commit: "e9ffbed9f675a3ac31a4295c83abfd1fb4a7b3f5",
    license: "MIT",
    licenseEvidence: "LICENSE 'Copyright (c) 2025 Dakkshin (original work)'; package.json \"license\": \"MIT\"",
    cloneDir: "a-y-ibrahim_after-effects-mcp",
    extraction: "dakkshin-family",
    notes: "Derivative of the Dakkshin bridge design with additional lib/ helpers.",
  },
  {
    id: "JUNKDOGE-JOE/after-effects-mcp",
    repoUrl: "https://github.com/JUNKDOGE-JOE/after-effects-mcp",
    kind: "mcp-server",
    commit: "10b0154ca64f5ed15096b367f160129ee9ffe503",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License', copyright 'ae-mcp contributors'; root has no package.json license field",
    cloneDir: "JUNKDOGE-JOE_after-effects-mcp",
    extraction: "junkdoge",
  },
  {
    id: "VolksRat71/after-effects-mcp-vision",
    repoUrl: "https://github.com/VolksRat71/after-effects-mcp-vision",
    kind: "mcp-server",
    commit: "d2c95489ff0481169bb6c693fc60527b315f88ce",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License', copyright 'Dakkshin'; cep/package.json \"license\": \"MIT\"",
    cloneDir: "VolksRat71_after-effects-mcp-vision",
    extraction: "volksrat",
  },
  {
    id: "Engine-Room-Games/after-effects-mcp",
    repoUrl: "https://github.com/Engine-Room-Games/after-effects-mcp",
    kind: "mcp-server",
    commit: "9cbf7cc8fe12317541e01dfce83b42538c94160b",
    license: "MIT",
    licenseEvidence: "LICENSE first line 'MIT License', copyright 'Engine Room'; workspace package.json declares no license field",
    cloneDir: "Engine-Room-Games_after-effects-mcp",
    extraction: "engineroom",
  },
  {
    id: "23d1/after-effects-mcp",
    repoUrl: "https://github.com/23d1/after-effects-mcp",
    kind: "mcp-server",
    commit: "be7717314439dda29b64cbba85664f04f737543b",
    license: "MIT",
    licenseEvidence: "LICENSE 'MIT License Copyright (c) 2026 23d1'; package.json \"license\": \"MIT\"",
    cloneDir: "23d1_after-effects-mcp",
    extraction: "23d1",
  },
];

export interface ResolvedRoot {
  toolId: string;
  /** Absolute directory that definitionFile/implementationFile resolve against. */
  root: string;
  /** Whether git HEAD == pinned commit (self roots are checked via git diff). */
  kind: "clone" | "self" | "local";
}

/** Resolve the source root for a tool. */
export function resolveSourceRoot(def: ToolDef): ResolvedRoot {
  if (def.id === AE_DEVTOOLS_ID) {
    return { toolId: def.id, root: REPO_ROOT, kind: "self" };
  }
  if (def.id === AE_A8N_ID) {
    const envPath = process.env.AE_A8N_PATH;
    if (envPath) return { toolId: def.id, root: resolve(envPath), kind: "local" };
    const clone = resolve(REFERENCE_ROOT, "ae-a8n");
    return { toolId: def.id, root: clone, kind: "clone" };
  }
  return {
    toolId: def.id,
    root: resolve(REFERENCE_ROOT, def.cloneDir ?? def.id.replace("/", "_")),
    kind: "clone",
  };
}
