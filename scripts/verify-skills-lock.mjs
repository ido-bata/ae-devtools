#!/usr/bin/env node
// Verifies skills-lock.json against the vendored skills/ tree.
//
// computedHash uses the same algorithm as the skills CLI
// (`bunx skills`, computeSkillFolderHash, lock format version 2):
// per file, sha256 over path bytes + NUL + decimal content length + NUL +
// content (CRLF normalized to LF, NUL-containing files hashed raw),
// entries sorted by raw path bytes.
//
// Also checks that every vendored skill has a lock entry, every lock
// entry has a vendored directory, and metadata.requires-skills
// dependencies resolve to vendored skills.
//
// Exit 0 = PASS, 1 = verification failure, 2 = tool/IO error.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(root, 'skills');
const lockPath = join(root, 'skills-lock.json');

const EXCLUDE_FILES = new Set(['metadata.json']);
const EXCLUDE_DIRS = new Set(['.git', '__pycache__', '__pypackages__']);

const isExcluded = (name, isDirectory = false) =>
  EXCLUDE_FILES.has(name) || (isDirectory && EXCLUDE_DIRS.has(name));

function normalizeLineEndings(content) {
  if (content.includes(0) || !content.includes('\r\n')) return content;
  return Buffer.from(content.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
}

function collectFiles(dir, prefix, rootReal, ancestors, results) {
  const realDir = realpathSync(dir);
  if (ancestors.has(realDir)) return;
  const branch = new Set(ancestors).add(realDir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isExcluded(entry.name, entry.isDirectory())) continue;
    const fullPath = join(dir, entry.name);
    const path = prefix + entry.name;
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(fullPath);
      } catch {
        continue;
      }
      const rootWithSep = rootReal.endsWith('/') ? rootReal : rootReal + '/';
      if (target !== rootReal && !target.startsWith(rootWithSep)) continue;
      isDirectory = statSync(target).isDirectory();
      if (isDirectory && isExcluded(entry.name, true)) continue;
    } else if (!isDirectory && !entry.isFile()) {
      continue;
    }
    if (isDirectory) collectFiles(fullPath, `${path}/`, rootReal, branch, results);
    else results.push({ path, content: readFileSync(fullPath) });
  }
}

export function folderHash(directory) {
  const rootReal = realpathSync(directory);
  const files = [];
  collectFiles(directory, '', rootReal, new Set(), files);
  const entries = files.map((file) => ({
    path: Buffer.from(file.path.split('\\').join('/'), 'utf8'),
    content: normalizeLineEndings(file.content),
  }));
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  const hash = createHash('sha256');
  for (const { path, content } of entries) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

function parseRequiresSkills(skillMdPath) {
  const text = readFileSync(skillMdPath, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^metadata:\s*$/);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\S/.test(line) && !/^\s/.test(line)) break;
      const req = line.match(/^\s+requires-skills:\s*(.+?)\s*$/);
      if (req) {
        return req[1].split(/\s+/).filter(Boolean);
      }
    }
  }
  return [];
}

function main() {
  const failures = [];

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    console.error(`verify-skills-lock: FAIL: cannot read skills-lock.json: ${error.message}`);
    process.exit(2);
  }
  if (lock.version !== 2 || typeof lock.skills !== 'object' || lock.skills === null) {
    console.error('verify-skills-lock: FAIL: skills-lock.json must be version 2 with a skills object');
    process.exit(1);
  }

  const lockNames = new Set(Object.keys(lock.skills));
  const vendoredNames = new Set(
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name),
  );

  for (const name of vendoredNames) {
    if (!lockNames.has(name)) {
      failures.push(`${name}: vendored under skills/ but missing from skills-lock.json`);
    }
  }

  for (const [name, entry] of Object.entries(lock.skills)) {
    if (typeof entry?.computedHash !== 'string') {
      failures.push(`${name}: invalid skills-lock.json entry (missing computedHash)`);
      continue;
    }
    const dir = join(skillsDir, name);
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd) || !statSync(skillMd).isFile()) {
      failures.push(`${name}: in skills-lock.json but skills/${name}/SKILL.md is not committed`);
      continue;
    }
    let actual;
    try {
      actual = folderHash(dir);
    } catch (error) {
      failures.push(`${name}: cannot hash skills/${name}: ${error.message}`);
      continue;
    }
    if (actual !== entry.computedHash) {
      failures.push(
        `${name}: vendored copy differs from skills-lock.json ` +
          `(expected ${entry.computedHash}, got ${actual}); update via 'bunx skills update' instead of editing the copy`,
      );
      continue;
    }
    for (const dep of parseRequiresSkills(skillMd)) {
      if (!vendoredNames.has(dep)) {
        failures.push(`${name}: requires-skills dependency '${dep}' is not vendored under skills/`);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`verify-skills-lock: FAIL: ${failure}`);
    process.exit(1);
  }
  console.log(`verify-skills-lock: PASS (${lockNames.size} skills)`);
}

main();
