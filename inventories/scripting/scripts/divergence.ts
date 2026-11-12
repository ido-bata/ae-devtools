/**
 * Tier divergence analysis (CAP008).
 *
 * The central finding this module encodes is structural, and it is not a list of
 * wording differences:
 *
 *   Adobe publishes no symbol-level scripting reference.
 *
 * Adobe's scripting page describes loading, permissions and invocation, then defers
 * "the scripting capabilities available with After Effects" to the community guide by
 * link. So the two tiers are not two descriptions of the same object that can be
 * diffed symbol by symbol — the Adobe tier has **no symbol set to diff against**.
 *
 * That asymmetry is the honest result. Manufacturing a "divergence list" by treating
 * community symbols as if Adobe had blessed them would invert the provenance rule. So
 * the output distinguishes:
 *
 *   - `coverage-asymmetry`  : a whole surface one tier does not cover at all.
 *   - `statement-level`     : both tiers make a statement about the same thing and
 *                             the statements differ (or one is unversioned).
 *   - `single-tier-only`    : a claim only one tier makes.
 *
 * Agreement is never recorded as verification, and no row is scored as a difference
 * merely because the other tier is silent.
 */

export type DivergenceClass =
  | "coverage-asymmetry"
  | "statement-level"
  | "single-tier-only";

export type DivergenceRow = {
  id: string;
  divergenceClass: DivergenceClass;
  topic: string;
  adobePosition: string;
  communityPosition: string;
  /** What a consumer of this inventory must not conclude from the two sides. */
  consequence: string;
  /** True when only a real host run can decide the disagreement. */
  requiresRealHost: boolean;
  /** Inventory ids affected, when the row is about specific symbols. */
  affectedIds: string[];
};

export const DIVERGENCES: readonly DivergenceRow[] = [
  {
    id: "provisional.ae.divergence.symbol-reference-absent-in-adobe-tier",
    divergenceClass: "coverage-asymmetry",
    topic: "Symbol-level scripting reference",
    adobePosition:
      "Publishes script loading, file/network permission, invocation and engine-level statements. Does not enumerate classes, methods, attributes or enums, and links to the community guide for the scripting capabilities themselves.",
    communityPosition:
      "Provides the class/member reference this inventory is built from, at a pinned revision.",
    consequence:
      "There is no Adobe-official symbol set to cross-check against. Every symbol row in this inventory is community-sourced, and 'documented' in this repository means 'documented by the community guide', not 'documented by Adobe'. Adobe-tier agreement cannot be claimed for any symbol.",
    requiresRealHost: false,
    affectedIds: [],
  },
  {
    id: "provisional.ae.divergence.es3-scope-differs-in-subject",
    divergenceClass: "statement-level",
    topic: "ECMAScript level",
    adobePosition:
      "States that the legacy ExtendScript *expression* engine is ECMAScript 3 and that the JavaScript expression engine in AE 16.0 is ECMAScript 2018; identifies ExtendScript as the scripting language.",
    communityPosition:
      "States that the AE scripting engine supports ECMA-262 3rd Edition and also implements E4X.",
    consequence:
      "The two statements are about different engines and only coincide on 'ES3'. Adobe does not state a scripting-engine ECMAScript level on the cited page; the ES3 scripting claim rests on the community tier. Do not present 'Adobe confirms ES3 scripting' as a sourced fact.",
    requiresRealHost: false,
    affectedIds: [
      "provisional.ae.constraint.es3-ecma262-3rd-edition",
      "provisional.ae.constraint.expression-engine-es2018-not-scripting",
    ],
  },
  {
    id: "provisional.ae.divergence.no-versioned-member-list-in-either-tier",
    divergenceClass: "coverage-asymmetry",
    topic: "Per-version member availability",
    adobePosition:
      "Publishes per-release 'what's new' pages, but not a per-version scripting member list.",
    communityPosition:
      "Keeps a changelog of scripting additions/removals per AE release and marks many individual members with an 'added in' note, but the guide describes a rolling current state rather than a frozen per-build API.",
    consequence:
      "A member's availability on AE 26.5.3 or 27.0.0 is inferred from changelog notes, not observed. Members without an 'added in' note have an unknown introduction version; they are counted as 'version unstated' rather than assumed original.",
    requiresRealHost: true,
    affectedIds: [],
  },
  {
    id: "provisional.ae.divergence.enum-integers-not-stable",
    divergenceClass: "statement-level",
    topic: "Enum wire stability",
    adobePosition: "Silent — no enum stability statement on the cited pages.",
    communityPosition:
      "Warns that the integer values behind guide orientationType/positionType differ between AE versions and instructs comparing against named constants.",
    consequence:
      "Serialising an enum as its integer is unsafe across versions, but this rests on one community statement for one enum family. It is not established as a general rule for all enums.",
    requiresRealHost: true,
    affectedIds: ["provisional.ae.constraint.guide-enum-integers-differ-between-versions"],
  },
  {
    id: "provisional.ae.divergence.undocumented-members-community-only",
    divergenceClass: "single-tier-only",
    topic: "Members the community marks as undocumented by Adobe",
    adobePosition: "Silent — these members appear in no Adobe reference.",
    communityPosition:
      "Documents the member but warns it is officially undocumented, discovered by research, and may change or disappear.",
    consequence:
      "These rows carry `undocumented-community-research` status. They must not be counted with documented members, and an adapter targeting them carries unquantified breakage risk.",
    requiresRealHost: false,
    affectedIds: [],
  },
  {
    id: "provisional.ae.divergence.default-permission-state-unversioned",
    divergenceClass: "statement-level",
    topic: "Default file/network permission",
    adobePosition:
      "States scripts may not write files or use the network by default, gated by one Scripting & Expressions preference. No AE version is stated on the page.",
    communityPosition:
      "Describes the permission gate as a runtime concern but does not give a per-version default-state table either.",
    consequence:
      "The 'denied by default' statement is unversioned on both sides. Whether it holds on 26.5.3 and 27.0.0 is a real-host fact, not a documented one.",
    requiresRealHost: true,
    affectedIds: [
      "provisional.ae.constraint.file-write-off-by-default",
      "provisional.ae.constraint.network-off-by-default-same-switch",
    ],
  },
  {
    id: "provisional.ae.divergence.match-names-outside-symbol-scope",
    divergenceClass: "coverage-asymmetry",
    topic: "AE internal match names",
    adobePosition:
      "No published match-name table on the cited pages.",
    communityPosition:
      "Maintains first-party effect and per-layer-type match-name tables (list-shaped, several hundred rows).",
    consequence:
      "Match names are the stable identifiers scripts must use, yet they are only community-documented. They are excluded from this issue's symbol denominators by design and recorded as a gap for a later inventory slice.",
    requiresRealHost: false,
    affectedIds: [],
  },
  {
    id: "provisional.ae.divergence.error-taxonomy-absent-both",
    divergenceClass: "coverage-asymmetry",
    topic: "Error taxonomy",
    adobePosition: "No enumerated scripting error taxonomy on the cited pages.",
    communityPosition:
      "Describes errors per method anecdotally; no enumerated taxonomy.",
    consequence:
      "Failure classification for adapters cannot be derived from documentation. Error handling must be designed to tolerate unknown error shapes rather than map a documented set.",
    requiresRealHost: true,
    affectedIds: [],
  },
  {
    id: "provisional.ae.divergence.variable-font-page-names-symbols-undated",
    divergenceClass: "single-tier-only",
    topic: "Symbols named in Adobe prose",
    adobePosition:
      "Names addVariableFontAxis, fontObject and designAxesData in a worked example, with no version range and no reference-style entry.",
    communityPosition:
      "Documents the same symbols as reference entries; the changelog attributes the variable-font-axis API to AE 26.0.",
    consequence:
      "Adobe's page is evidence that the symbols are Adobe-sanctioned, but not evidence of their version bound or arity. The version claim is community-sourced.",
    requiresRealHost: false,
    affectedIds: [],
  },
];

export type RealHostOnlySummary = {
  total: number;
  byCategory: Record<string, number>;
  note: string;
};
