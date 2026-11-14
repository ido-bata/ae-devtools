/**
 * Content-addressed fetch cache.
 *
 * Raw source bytes are never committed: the task forbids mirroring documentation
 * prose into the repository. Instead the cache lives under `.cache/` (git-ignored)
 * and a committed `sources.lock.json` records the URL, the pinned revision, the
 * byte size and the SHA-256 of the exact payload that produced the inventory.
 *
 * A normal build reads the cache and fails if the bytes do not match the lock.
 * `--refresh` re-downloads, rewrites the cache, and rewrites the lock. That is the
 * only path that may change the recorded hash, so an inventory diff is always
 * explained by an explicit, reviewable lock change.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceSpec } from "./sources.ts";

export type LockEntry = {
  readonly key: string;
  readonly tier: string;
  readonly revision: string;
  readonly fetchUrl: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly fetchedAt: string;
};

export type SourceLock = {
  readonly lockVersion: 1;
  readonly note: string;
  readonly sources: readonly LockEntry[];
};

const LOCK_NOTE =
  "Content hashes of the exact upstream bytes used to build this inventory. " +
  "Raw payloads are intentionally not committed. Regenerate with `bun run refresh`.";

export function sha256(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function cachePath(cacheDir: string, spec: SourceSpec): string {
  return join(cacheDir, `${spec.key}.payload`);
}

export function lockPath(root: string): string {
  return join(root, "sources.lock.json");
}

export async function readLock(root: string): Promise<SourceLock | null> {
  const p = lockPath(root);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf8")) as SourceLock;
}

export async function writeLock(
  root: string,
  entries: readonly LockEntry[],
): Promise<void> {
  const lock: SourceLock = {
    lockVersion: 1,
    note: LOCK_NOTE,
    sources: [...entries].sort((a, b) => a.key.localeCompare(b.key)),
  };
  await writeFile(lockPath(root), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      // Identify the inventory tool honestly. Adobe's CDN rejects requests that
      // omit Accept/Accept-Language entirely (403), so those are always sent.
      "user-agent": "ae-devtools-scripting-inventory/1 (+research; contact via repo)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`fetch failed: ${url} -> HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export type ObtainResult = {
  readonly spec: SourceSpec;
  readonly payload: Uint8Array;
  readonly entry: LockEntry;
  readonly fromCache: boolean;
};

/**
 * Obtain one source payload, verifying it against the lock unless refreshing.
 * Refuses to silently accept different bytes: an upstream change must be an
 * explicit `--refresh`.
 */
export async function obtainSource(
  spec: SourceSpec,
  opts: { root: string; cacheDir: string; refresh: boolean },
): Promise<ObtainResult> {
  const prior = await readLock(opts.root);
  const priorEntry = prior?.sources.find((s) => s.key === spec.key);
  const cached = cachePath(opts.cacheDir, spec);

  if (!opts.refresh && existsSync(cached)) {
    const payload = new Uint8Array(await readFile(cached));
    const digest = sha256(payload);
    if (!priorEntry) {
      throw new Error(
        `cache hit for "${spec.key}" but sources.lock.json has no entry; run \`bun run refresh\``,
      );
    }
    if (priorEntry.sha256 !== digest) {
      throw new Error(
        `cache for "${spec.key}" does not match sources.lock.json ` +
          `(cached ${digest}, locked ${priorEntry.sha256}); run \`bun run refresh\` to re-pin deliberately`,
      );
    }
    if (priorEntry.revision !== spec.revision) {
      throw new Error(
        `revision drift for "${spec.key}": sources.ts pins ${spec.revision} but ` +
          `sources.lock.json records ${priorEntry.revision}; run \`bun run refresh\``,
      );
    }
    return { spec, payload, entry: priorEntry, fromCache: true };
  }

  const payload = await download(spec.fetchUrl);
  const entry: LockEntry = {
    key: spec.key,
    tier: spec.tier,
    revision: spec.revision,
    fetchUrl: spec.fetchUrl,
    sha256: sha256(payload),
    bytes: payload.byteLength,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };

  if (!opts.refresh && priorEntry && priorEntry.sha256 !== entry.sha256) {
    throw new Error(
      `upstream content for "${spec.key}" changed ` +
        `(locked ${priorEntry.sha256}, now ${entry.sha256}). ` +
        "Review the change, then re-run with `--refresh` to accept it.",
    );
  }

  await mkdir(dirname(cached), { recursive: true });
  await writeFile(cached, payload);
  return { spec, payload, entry, fromCache: false };
}
