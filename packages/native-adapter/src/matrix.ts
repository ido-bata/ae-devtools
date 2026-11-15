/**
 * Coverage-matrix reader — CAP046 (Issue #19).
 *
 * `inventories/sdk/generated/aggregate.coverage-matrix.json` is the
 * canonical record of what the SDK inventory can honestly claim per
 * symbol class. This module is the *only* place the adapter package
 * reads it; templates and negotiation availability are derived from it
 * so "implemented" and "inventory-only" can never be conflated.
 *
 * Nothing here launches AE, loads a plug-in, or asserts real-host
 * behaviour. The matrix itself records `verification: "not-run"`.
 */

import { readFileSync } from "node:fs";

export const MATRIX_SCHEMA = "ae-devtools/sdk-coverage-matrix/1" as const;

export type MatrixClassRow = {
  symbols: number;
  state: string;
  note: string;
  implemented: boolean;
  verifiedOnRealHost: boolean;
};

export type CoverageMatrix = {
  schema: string;
  release: { identifier: string; distribution: string; headersRoot?: string };
  evidenceLevel: {
    inventory: string;
    verification: string;
    realHost: string;
    statement?: string;
  };
  totals: {
    symbols: number;
    unknown: number;
    unknownByReason?: Record<string, number>;
    headerFilesParsed?: number;
  };
  classes: Record<string, MatrixClassRow>;
};

/**
 * Load and minimally validate a coverage matrix. A file that does not
 * carry the expected schema is rejected — a lookalike matrix must never
 * silently feed status labels into templates or negotiation.
 */
export function loadCoverageMatrix(path: string): CoverageMatrix {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`coverage matrix at ${path} is not a JSON object`);
  }
  const matrix = parsed as CoverageMatrix;
  if (matrix.schema !== MATRIX_SCHEMA) {
    throw new Error(
      `coverage matrix schema ${JSON.stringify(matrix.schema)} is not ${MATRIX_SCHEMA}`,
    );
  }
  if (typeof matrix.release?.identifier !== "string" || typeof matrix.classes !== "object") {
    throw new Error(`coverage matrix at ${path} is missing release/classes`);
  }
  return matrix;
}

/**
 * The suite families an adapter may negotiate for. These are exactly
 * the extractor classes projected by the coverage matrix — the matrix
 * is the denominator, so a family outside this list is unknown, not
 * absent-but-supported.
 */
export const SUITE_FAMILIES = [
  "build-test-lifecycle",
  "external-command",
  "host-callback",
  "in-host-plugin-command",
  "unsupported-or-unknown",
] as const;
export type SuiteFamily = (typeof SUITE_FAMILIES)[number];

export function isSuiteFamily(value: string): value is SuiteFamily {
  return (SUITE_FAMILIES as readonly string[]).includes(value);
}

/**
 * Availability states a host may advertise during negotiation.
 *
 * `dispatchable` is the only state negotiation accepts by default and
 * may only be claimed for a matrix row with `implemented === true` AND
 * `verifiedOnRealHost === true`. No row satisfies that today, so an
 * honest host built from the current matrix never emits it — every
 * required-family negotiation refuses. That is the intended
 * fail-closed posture, not a bug.
 */
export const FAMILY_STATES = [
  "dispatchable",
  "build-probe-only",
  "inventory-only",
  "unsupported-or-unknown",
] as const;
export type FamilyState = (typeof FAMILY_STATES)[number];

const MATRIX_STATES: ReadonlySet<string> = new Set(FAMILY_STATES);

/**
 * Derive the negotiable availability of one suite family from its
 * matrix row. Conservative on every axis:
 * - unknown family            → `unsupported-or-unknown`
 * - missing row               → `unsupported-or-unknown`
 * - unrecognised matrix state → `unsupported-or-unknown`
 * - implemented + real-host   → `dispatchable`
 * - otherwise                 → the matrix state verbatim
 */
export function familyAvailability(
  matrix: CoverageMatrix,
  family: string,
): { state: FamilyState; row: MatrixClassRow | null } {
  const row = isSuiteFamily(family) ? (matrix.classes[family] ?? null) : null;
  if (row === null) return { state: "unsupported-or-unknown", row: null };
  if (row.implemented === true && row.verifiedOnRealHost === true) {
    return { state: "dispatchable", row };
  }
  if (MATRIX_STATES.has(row.state) && row.state !== "dispatchable") {
    return { state: row.state as FamilyState, row };
  }
  return { state: "unsupported-or-unknown", row };
}

export type AdvertisedFamily = {
  state: FamilyState;
  symbols: number;
  note: string;
};

/**
 * Build the per-family advertisement a native host/plugin would send
 * during negotiation, derived entirely from the coverage matrix. The
 * matrix release becomes the advertised SDK release so the negotiated
 * `sdkRelease` can never drift from the inventory it describes.
 */
export function advertiseFamiliesFromMatrix(
  matrix: CoverageMatrix,
): Record<SuiteFamily, AdvertisedFamily> {
  const out = {} as Record<SuiteFamily, AdvertisedFamily>;
  for (const family of SUITE_FAMILIES) {
    const { state, row } = familyAvailability(matrix, family);
    out[family] = {
      state,
      symbols: row?.symbols ?? 0,
      note: row?.note ?? "no coverage-matrix row; treated as unsupported-or-unknown",
    };
  }
  return out;
}
