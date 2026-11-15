/**
 * Coverage-matrix reader — CAP045/CAP048 groundwork, redesigned for
 * Issue #19 (CAP046 follow-up).
 *
 * `inventories/sdk/generated/aggregate.coverage-matrix.json` is the
 * canonical record of what the SDK inventory can honestly claim per
 * symbol **class**. This module is the *only* place the adapter
 * package reads it.
 *
 * IMPORTANT — classes are classification/reporting metadata ONLY.
 * The five matrix classes (`build-test-lifecycle`, `external-command`,
 * `host-callback`, `in-host-plugin-command`, `unsupported-or-unknown`)
 * describe how the extractor attributed symbols; they are NOT
 * negotiable capability families and can NEVER be dispatched. All
 * dispatchability lives at the per-operation level in
 * `src/operations.ts`. Nothing here launches AE, loads a plug-in, or
 * asserts real-host behaviour. The matrix itself records
 * `verification: "not-run"`.
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
 * The coverage-matrix classes. These are the extractor's reporting
 * buckets — exactly the classes projected by
 * `inventories/sdk/scripts/coverage-matrix.mjs`. They exist so reports
 * and kits can say *where* a symbol was attributed; they carry no
 * dispatch semantics. A class name is never a valid `operation` in a
 * negotiation message.
 */
export const MATRIX_CLASSES = [
  "build-test-lifecycle",
  "external-command",
  "host-callback",
  "in-host-plugin-command",
  "unsupported-or-unknown",
] as const;
export type MatrixClass = (typeof MATRIX_CLASSES)[number];

export function isMatrixClass(value: string): value is MatrixClass {
  return (MATRIX_CLASSES as readonly string[]).includes(value);
}

/**
 * Reporting-only view of one class row. Returns the row's recorded
 * state for display; callers must not treat the result as a
 * negotiable availability. `null` when the matrix has no row.
 */
export function matrixClassRow(
  matrix: CoverageMatrix,
  cls: string,
): MatrixClassRow | null {
  return isMatrixClass(cls) ? (matrix.classes[cls] ?? null) : null;
}
