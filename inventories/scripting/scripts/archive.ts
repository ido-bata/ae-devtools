/**
 * Minimal in-memory reader for the pinned gzipped tarball of the community guide.
 *
 * Only regular files under `docs/` are considered. The tar reader handles the
 * ustar/GNU formats produced by GitHub's codeload service (long names via the
 * `././@LongLink` entry or the ustar `prefix` field).
 */

import { gunzipSync } from "node:zlib";
import type { DocFile } from "./extract-symbols.ts";

const BLOCK = 512;

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end += 1;
  return Buffer.from(buf.subarray(offset, end)).toString("utf8");
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  if (text === "") return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type TarEntry = { path: string; bytes: Uint8Array };

export function readTarGz(payload: Uint8Array): TarEntry[] {
  const tar = gunzipSync(payload);
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    const name = readString(header, 0, 100);
    if (name === "") break;

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "L") {
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0+$/, "");
      offset = dataStart + padded;
      continue;
    }

    const fullName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = null;

    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ path: fullName, bytes: data });
    }
    offset = dataStart + padded;
  }
  return entries;
}

/**
 * Turn the archive into documentation files with a site-relative path.
 * The leading `<repo>-<sha>/docs/` directory is stripped.
 */
export function docsFromArchive(payload: Uint8Array): DocFile[] {
  const entries = readTarGz(payload);
  const out: DocFile[] = [];
  for (const entry of entries) {
    const match = /^[^/]+\/docs\/(.+)\.md$/.exec(entry.path);
    if (!match?.[1]) continue;
    const sitePath = match[1];
    if (sitePath.startsWith("_global/")) continue;
    out.push({
      path: entry.path,
      sitePath,
      text: Buffer.from(entry.bytes).toString("utf8"),
    });
  }
  return out.sort((a, b) => a.sitePath.localeCompare(b.sitePath));
}
