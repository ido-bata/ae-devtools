/**
 * Classify upstream drift for every registered source WITHOUT mutating
 * `.cache/` or `sources.lock.json`.
 *
 *   bun run drift            # report only; exit 0 (classification, not a gate)
 *   bun run drift --strict   # exit 1 when any source drifted or a detector failed
 *
 * For each source the current upstream bytes are downloaded and hashed
 * against `sources.lock.json`:
 *
 *   - `unchanged`  — bytes identical to the lock. Nothing to review.
 *   - `DRIFTED`    — bytes differ. For `adobe-official` helpx pages the
 *                    extracted-claim detectors (claims.ts /
 *                    constraints.ts citation checks) are re-run against
 *                    the NEW bytes, so a drift is classified:
 *                      * `content-neutral` — every detector still
 *                        resolves; the upstream edit did not touch the
 *                        statements this inventory relies on. Accepting
 *                        it is `bun run refresh` + commit the lock diff.
 *                      * `SEMANTIC-DRIFT` — at least one detector no
 *                        longer resolves; the upstream page changed in a
 *                        way that affects recorded claims. Review the
 *                        upstream change BEFORE refreshing; do not
 *                        blanket-accept.
 *     For the commit-pinned community archive a hash mismatch means the
 *     pinned commit itself changed (force-push / tag move) — always
 *     `unexpected`, never auto-accepted.
 *
 * This script never writes the cache or the lock: `bun run build`
 * (verify path) and `bun run refresh` (accept path) remain the only
 * mutating commands.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { docsFromArchive } from "./archive.ts";
import { parseAdobePage } from "./adobe-page.ts";
import { resolveClaims } from "./claims.ts";
import { resolveConstraints } from "./resolve-constraints.ts";
import { readLock, sha256 } from "./fetch.ts";
import { ALL_SOURCES, COMMUNITY_ARCHIVE } from "./sources.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DFAD_BASE = "https://ae-scripting.docsforadobe.dev";

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "ae-devtools-scripting-inventory/1 (+research; contact via repo)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const lock = await readLock(ROOT);
  if (!lock) throw new Error("sources.lock.json missing");
  const lockByKey = new Map(lock.sources.map((s) => [s.key, s]));

  const payloads = new Map<string, Uint8Array>();
  const drifted: { key: string; digest: string }[] = [];

  for (const spec of ALL_SOURCES) {
    const entry = lockByKey.get(spec.key);
    if (!entry) {
      console.log(`MISSING-LOCK  ${spec.key}  (no lock entry — run build/refresh)`);
      if (strict) process.exitCode = 1;
      continue;
    }
    let payload: Uint8Array;
    try {
      payload = await download(spec.fetchUrl);
    } catch (e) {
      console.log(`FETCH-ERROR   ${spec.key}  ${(e as Error).message}`);
      if (strict) process.exitCode = 1;
      continue;
    }
    payloads.set(spec.key, payload);
    const digest = sha256(payload);
    if (digest === entry.sha256 && payload.byteLength === entry.bytes) {
      console.log(`unchanged     ${spec.key}  ${digest.slice(0, 12)}  ${payload.byteLength}B`);
    } else {
      drifted.push({ key: spec.key, digest });
      console.log(
        `DRIFTED       ${spec.key}  locked ${entry.sha256.slice(0, 12)} -> now ${digest.slice(0, 12)}  (${entry.bytes}B -> ${payload.byteLength}B)`,
      );
    }
  }

  // ---- classify drifted sources -------------------------------------
  // Detector re-runs need the FULL adobe page set and the dfad docs;
  // every payload was fetched above, so build them once here.
  let adobePages: Map<string, ReturnType<typeof parseAdobePage>> | null = null;
  let docs: ReturnType<typeof docsFromArchive> | null = null;
  const detectorContext = () => {
    if (adobePages === null) {
      adobePages = new Map();
      for (const s of ALL_SOURCES) {
        if (s.tier !== "adobe-official") continue;
        const p = payloads.get(s.key);
        if (!p) continue;
        adobePages.set(s.key, parseAdobePage(Buffer.from(p).toString("utf8")));
      }
    }
    if (docs === null) {
      const p = payloads.get(COMMUNITY_ARCHIVE.key);
      docs = p ? docsFromArchive(p) : [];
    }
    return { adobePages, docs };
  };

  const runDetectors = (): string[] => {
    const { adobePages: pages, docs: ds } = detectorContext();
    const failures: string[] = [];
    try {
      resolveClaims(pages, (key) => {
        const sp = ALL_SOURCES.find((x) => x.key === key);
        return sp ? sp.publicUrl : key;
      });
    } catch (e) {
      failures.push(`claims: ${(e as Error).message.split("\n").slice(0, 4).join(" | ")}`);
    }
    if (ds.length > 0) {
      const res = resolveConstraints(ds, pages, {
        dfad: (sitePath, anchor) =>
          `${DFAD_BASE}/${sitePath}/${anchor ? `#${anchor}` : ""}`,
        adobe: (key) => {
          const sp = ALL_SOURCES.find((x) => x.key === key);
          if (!sp) throw new Error(`unknown source key ${key}`);
          return sp.publicUrl;
        },
      });
      for (const f of res.failures) failures.push(`constraints: ${f}`);
    } else {
      failures.push("constraints: dfad payload unavailable; detector not run");
    }
    return failures;
  };

  let semanticFailures = 0;
  for (const { key, digest } of drifted) {
    const spec = ALL_SOURCES.find((s) => s.key === key);
    const prior = lockByKey.get(key);
    if (!spec || !prior) continue;

    if (spec.parser === "docsforadobe-markdown") {
      console.log(
        `  -> unexpected: commit-pinned archive bytes changed ` +
          `(locked ${prior.sha256.slice(0, 12)}, now ${digest.slice(0, 12)}). ` +
          `The pinned commit ${spec.revision} should be immutable — investigate ` +
          `before any refresh.`,
      );
      semanticFailures++;
      continue;
    }

    const failures = runDetectors();
    if (failures.length === 0) {
      console.log(
        `  -> content-neutral: all claim/constraint detectors still resolve ` +
          `on the new bytes. Accept via \`bun run refresh\` and commit the ` +
          `sources.lock.json diff (the lock diff IS the review record).`,
      );
    } else {
      semanticFailures += failures.length;
      console.log(`  -> SEMANTIC-DRIFT: ${failures.length} detector failure(s):`);
      for (const f of failures.slice(0, 10)) console.log(`       ${f}`);
      console.log(`     Review the upstream change BEFORE \`bun run refresh\`.`);
    }
  }

  if (drifted.length === 0) {
    console.log("\nNo drift: every source matches sources.lock.json.");
  } else {
    console.log(
      `\n${drifted.length} source(s) drifted; ` +
        `${semanticFailures} semantic detector failure(s). ` +
        (semanticFailures > 0
          ? "Resolve semantic drift before refreshing."
          : "All drift is content-neutral; `bun run refresh` accepts it."),
    );
  }
  if (strict && (drifted.length > 0 || semanticFailures > 0)) process.exitCode = 1;
}

await main();
