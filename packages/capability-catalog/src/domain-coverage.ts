/**
 * Domain coverage views — Issue #15/#16 groundwork (CAP029–CAP036, CAP032).
 *
 * A *domain* is a spec-level grouping of catalog scripting symbols (e.g.
 * "project/items/comps/layers" for #15, "animation/effects/render" for
 * #16). Domain definitions live in `specs/ae-capability-coverage/domains/`
 * as data; this module projects the committed manifest onto them so every
 * in-scope symbol stays visible — implemented or not — and uncovered
 * symbols are listed explicitly rather than dropped (CAP032, FR-13).
 *
 * A domain view is metadata only: it never promotes a coverage axis and
 * never implies an adapter exists.
 */

import { fr05State, FR05_STATES, type Fr05State } from "./evidence.ts";
import {
  IMPLEMENTATION_AXES,
  VERIFICATION_AXES,
  type CapabilityRecord,
  type ImplementationAxis,
  type VerificationAxis,
} from "./schema.ts";

export const DOMAIN_SCHEMA = "ae-devtools.domain-coverage/v1" as const;

export type DomainDefinition = {
  schema: typeof DOMAIN_SCHEMA;
  /** Stable slug, e.g. "project-items-comps-layers". */
  domain: string;
  issue: string;
  title: string;
  /** Catalog `category` values whose scripting-symbol rows belong to this domain. */
  categories: string[];
  notes?: string;
};

export type DomainMember = {
  id: string;
  category: string;
  implementation: ImplementationAxis;
  verification: VerificationAxis;
  reachability: CapabilityRecord["coverage"]["reachability"];
  fr05: Fr05State;
};

export type DomainCoverage = {
  schema: typeof DOMAIN_SCHEMA;
  domain: string;
  issue: string;
  title: string;
  categories: string[];
  memberCount: number;
  counts: {
    fr05: Record<Fr05State, number>;
    implementation: Record<ImplementationAxis, number>;
    verification: Record<VerificationAxis, number>;
  };
  members: DomainMember[];
  /** Members without an implemented adapter — the honest uncovered list (CAP032). */
  uncovered: string[];
};

export type DomainCoverageReport = {
  schema: "ae-devtools.domain-coverage-report/v1";
  generatedFrom: { path: string; sha256: string }[];
  domains: DomainCoverage[];
  /**
   * Scripting symbols whose `category` no domain definition claims.
   * Domain coverage must never silently drop symbols: every scripting
   * symbol is either a member of exactly one domain or listed here
   * (CAP032 / FR-13 — the uncovered list is the honest denominator).
   */
  unassigned: { id: string; category: string }[];
};

function zeroAxis<T extends string>(axis: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of axis) counts[value] = 0;
  return counts;
}

export function summarizeDomain(
  definition: DomainDefinition,
  records: CapabilityRecord[],
): DomainCoverage {
  const wanted = new Set(definition.categories);
  const members = records
    .filter((r) => r.kind === "scripting-symbol" && wanted.has(r.category))
    .map((r) => ({
      id: r.id,
      category: r.category,
      implementation: r.coverage.implementation,
      verification: r.coverage.verification,
      reachability: r.coverage.reachability,
      fr05: fr05State(r),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const counts = {
    fr05: zeroAxis(FR05_STATES),
    implementation: zeroAxis(IMPLEMENTATION_AXES),
    verification: zeroAxis(VERIFICATION_AXES),
  };
  for (const m of members) {
    counts.fr05[m.fr05] += 1;
    counts.implementation[m.implementation] += 1;
    counts.verification[m.verification] += 1;
  }

  return {
    schema: DOMAIN_SCHEMA,
    domain: definition.domain,
    issue: definition.issue,
    title: definition.title,
    categories: [...definition.categories].sort(),
    memberCount: members.length,
    counts,
    members,
    uncovered: members.filter((m) => m.implementation !== "implemented").map((m) => m.id),
  };
}

export function buildDomainCoverageReport(input: {
  records: CapabilityRecord[];
  domains: DomainDefinition[];
  generatedFrom: { path: string; sha256: string }[];
}): DomainCoverageReport {
  const seen = new Set<string>();
  const claimedBy = new Map<string, string>();
  const domains = input.domains.map((d) => {
    if (d.schema !== DOMAIN_SCHEMA) {
      throw new Error(`domain ${JSON.stringify(d.domain)} has schema ${JSON.stringify(d.schema)}`);
    }
    if (seen.has(d.domain)) throw new Error(`duplicate domain slug: ${d.domain}`);
    seen.add(d.domain);
    // A category claimed by two domains would double-count its symbols in
    // the coverage denominator — fail closed instead of picking a winner.
    for (const category of d.categories) {
      const owner = claimedBy.get(category);
      if (owner !== undefined) {
        throw new Error(`category ${JSON.stringify(category)} claimed by both ${owner} and ${d.domain}`);
      }
      claimedBy.set(category, d.domain);
    }
    const coverage = summarizeDomain(d, input.records);
    if (coverage.memberCount === 0) {
      throw new Error(`domain ${d.domain} matched no scripting symbols — check its categories`);
    }
    return coverage;
  });
  domains.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  const unassigned = input.records
    .filter((r) => r.kind === "scripting-symbol" && !claimedBy.has(r.category))
    .map((r) => ({ id: r.id, category: r.category }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schema: "ae-devtools.domain-coverage-report/v1",
    generatedFrom: [...input.generatedFrom].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    domains,
    unassigned,
  };
}

/** Byte-stable serialization, same convention as the catalog manifest. */
export function serializeDomainCoverageReport(report: DomainCoverageReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
