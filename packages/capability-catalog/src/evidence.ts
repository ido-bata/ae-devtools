/**
 * FR-05 state mapping and unjustified-promotion detection — CAP013.
 *
 * Mapping (issue #11 comment 6813348033, explicit and non-collapsing):
 *
 *   coverage.inventory  = how the row entered the catalog (discovered / source-reviewed / unverified)
 *   coverage.verification = what has been proven about behavior (not-run / automated-fake / verified-real-host)
 *   FR-05 state         = highest state the row's *claims* assert
 *   earned state        = highest state the row's *evidence artifacts* support
 *
 * `source-reviewed` never implies `verified-real-host`: a reviewed source row
 * maps at most to `documented`. The community guide documenting a symbol makes
 * it `documented` in the FR-05 sense only — the report keeps
 * `source.authority` alongside so Adobe-primary and community-maintained
 * documentation are never merged. A claim above the earned state is an
 * unjustified promotion and a drift-gate violation.
 */

import type { CapabilityRecord, EvidenceKind } from "./schema.ts";

export const FR05_STATES = [
  "documented",
  "reachable",
  "implemented",
  "automated-fake-tested",
  "verified-on-real-host",
  "unsupported-with-reason",
  "unknown",
] as const;
export type Fr05State = (typeof FR05_STATES)[number];

/** Ladder order for promotion comparison; `unsupported-with-reason` is terminal. */
const LADDER_RANK = {
  unknown: 0,
  documented: 1,
  reachable: 2,
  implemented: 3,
  "automated-fake-tested": 4,
  "verified-on-real-host": 5,
} as const;
type LadderRank = keyof typeof LADDER_RANK;
/** FR-05 states that participate in the promotion ladder (not the terminal one). */
type LadderState = Exclude<Fr05State, "unsupported-with-reason">;

const EVIDENCE_EARNS: Record<EvidenceKind, LadderRank> = {
  "source-doc": "documented",
  "source-impl": "implemented",
  "automated-test": "automated-fake-tested",
  "real-host": "verified-on-real-host",
};

function hasReason(record: CapabilityRecord): boolean {
  const reason = record.coverage.unsupportedReason;
  return reason !== undefined && reason.trim().length > 0;
}

/** Highest FR-05 state the record's coverage fields claim. */
export function fr05State(record: CapabilityRecord): Fr05State {
  const c = record.coverage;
  if (c.implementation === "unsupported") {
    return hasReason(record) ? "unsupported-with-reason" : "unknown";
  }
  if (c.verification === "verified-real-host") return "verified-on-real-host";
  if (c.verification === "automated-fake") return "automated-fake-tested";
  if (c.implementation === "implemented" || c.implementation === "adapter-present") {
    return "implemented";
  }
  if (c.reachability === "reachable") return "reachable";
  if (c.inventory === "source-reviewed" || c.inventory === "discovered") return "documented";
  return "unknown";
}

function evidenceCoversPlatform(record: CapabilityRecord, ref: { platform?: "win32" | "darwin" }): boolean {
  const os = record.compatibility.os;
  if (os === undefined || os.length === 0) return true;
  if (ref.platform === undefined) return false;
  return os.includes(ref.platform);
}

/** Highest FR-05 state the record's evidence artifacts actually support. */
export function earnedFr05State(record: CapabilityRecord): LadderState {
  let best: LadderRank = "unknown";
  for (const ref of record.coverage.evidenceRefs) {
    if (ref.kind === "real-host" && !evidenceCoversPlatform(record, ref)) continue;
    const earned = EVIDENCE_EARNS[ref.kind];
    if (LADDER_RANK[earned] > LADDER_RANK[best]) best = earned;
  }
  return best;
}

export type PromotionViolation = {
  code: "unjustified-promotion" | "unsupported-without-reason" | "windows-unverified" | "platform-unverified";
  id: string;
  detail: string;
};

/**
 * Claims may never outrun evidence (capability-catalog §6: fail CI when a test
 * claims a higher evidence level than its artifact supports).
 */
export function promotionViolations(record: CapabilityRecord): PromotionViolation[] {
  const out: PromotionViolation[] = [];
  const c = record.coverage;

  if (c.implementation === "unsupported" && !hasReason(record)) {
    out.push({
      code: "unsupported-without-reason",
      id: record.id,
      detail: "implementation=unsupported requires a non-empty unsupportedReason (FR-13)",
    });
  }

  const claimed = fr05State(record);
  const earned = earnedFr05State(record);
  const onLadder = claimed !== "unsupported-with-reason";
  if (onLadder && LADDER_RANK[claimed as LadderRank] > LADDER_RANK[earned]) {
    out.push({
      code: "unjustified-promotion",
      id: record.id,
      detail: `claims ${claimed} but evidence only earns ${earned}`,
    });
  }

  if (claimed === "verified-on-real-host") {
    for (const platform of record.compatibility.os ?? []) {
      const covered = c.evidenceRefs.some(
        (ref) => ref.kind === "real-host" && ref.platform === platform,
      );
      if (!covered) {
        out.push({
          code: platform === "win32" ? "windows-unverified" : "platform-unverified",
          id: record.id,
          detail: `verified-real-host claimed for ${platform} without ${platform} real-host evidence`,
        });
      }
    }
  }

  return out;
}
