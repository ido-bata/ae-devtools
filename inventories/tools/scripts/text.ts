/**
 * File/line helpers shared by the extractors and the verifier.
 *
 * Citation integrity rule (review D3): `definitionFile` and `definitionLine`
 * must resolve inside the SAME file, and `implementationFile` must exist with
 * `implementationLine` within its length. verify.ts enforces this on every row.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FileLines {
  path: string;
  lines: string[];
}

export function readLines(absPath: string): FileLines {
  const raw = readFileSync(absPath, "utf8");
  // Trailing newline does not create an extra logical line.
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { path: absPath, lines };
}

export function fileLineCount(absPath: string): number {
  return readLines(absPath).lines.length;
}

/** 1-based line lookup; returns null when out of range. */
export function lineAt(file: FileLines, line: number): string | null {
  if (!Number.isInteger(line) || line < 1 || line > file.lines.length) return null;
  return file.lines[line - 1] ?? null;
}

export interface CitationCheck {
  ok: boolean;
  reason?: string;
  actual?: string;
}

/** Verify a file+line pair resolves within that same file. */
export function checkCitation(root: string, relFile: string, line: number): CitationCheck {
  const abs = join(root, relFile);
  if (!existsSync(abs)) return { ok: false, reason: `file missing: ${relFile}` };
  const file = readLines(abs);
  const actual = lineAt(file, line);
  if (actual === null) {
    return {
      ok: false,
      reason: `line ${line} out of range for ${relFile} (${file.lines.length} lines)`,
    };
  }
  return { ok: true, actual };
}

/** Git HEAD of a checkout, or null when not a git checkout. */
export function gitHead(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Whether a directory has uncommitted changes to the given pathspec. */
export function gitDirty(dir: string, pathspec: string): boolean {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", pathspec], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Deterministic JSON with stable key order (objects keep insertion order). */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
