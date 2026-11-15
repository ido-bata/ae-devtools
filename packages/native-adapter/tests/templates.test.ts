/**
 * CAP046 — template coverage and status-label honesty (updated for the
 * class-vs-operation split).
 *
 * Proves: (1) the generated kit set covers every coverage-matrix
 * class, (2) each kit carries the matrix status verbatim AND states
 * the class is reporting-only / never dispatchable, (3) on-disk kits
 * are in sync with the matrix (the same check `bun run verify`
 * enforces).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCoverageMatrix, MATRIX_CLASSES, matrixClassRow } from "../src/matrix.ts";
import { renderAllTemplates, renderKit } from "../src/templates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "..", "..");
const MATRIX = loadCoverageMatrix(
  join(REPO, "inventories", "sdk", "generated", "aggregate.coverage-matrix.json"),
);

describe("renderAllTemplates", () => {
  test("covers every coverage-matrix class", () => {
    const files = renderAllTemplates(MATRIX);
    expect(files.map((f) => f.path).sort()).toEqual(
      MATRIX_CLASSES.map((f) => `templates/${f}/kit.md`).sort(),
    );
    // And the matrix itself has a row for each class.
    for (const cls of MATRIX_CLASSES) {
      expect(MATRIX.classes[cls]).toBeDefined();
    }
  });

  test("every kit carries the matrix status verbatim and denies class dispatch", () => {
    for (const cls of MATRIX_CLASSES) {
      const kit = renderKit(MATRIX, cls);
      const row = matrixClassRow(MATRIX, cls)!;
      expect(kit).toContain(`\`${row.state}\``);
      expect(kit).toContain(`implemented=\`${row.implemented}\``);
      expect(kit).toContain(`verifiedOnRealHost=\`${row.verifiedOnRealHost}\``);
      expect(kit).toContain(`symbols=${row.symbols}`);
      // The kit must state the class is reporting metadata only.
      expect(kit).toContain("reporting metadata only, never dispatchable");
      // No kit may claim real-host verification the matrix does not have.
      expect(kit).not.toContain("verified-real-host`");
    }
  });

  test("inventory-only classes are labelled non-callable at class level", () => {
    for (const cls of ["external-command", "host-callback", "in-host-plugin-command"] as const) {
      const kit = renderKit(MATRIX, cls);
      expect(kit).toContain("**structurally attributed from headers only**");
      expect(kit).toContain("a class row can never be dispatched");
    }
  });

  test("command envelope references per-operation ids, not class names", () => {
    for (const cls of ["external-command", "host-callback", "in-host-plugin-command", "build-test-lifecycle"] as const) {
      const kit = renderKit(MATRIX, cls);
      expect(kit).toContain('"operation"');
      expect(kit).toContain("src/operations.ts");
      expect(kit).not.toContain('"family"');
    }
  });

  test("unsupported-or-unknown gets a refusal/waiver record, not a command contract", () => {
    const kit = renderKit(MATRIX, "unsupported-or-unknown");
    expect(kit).toContain("refusal/waiver record");
    expect(kit).toContain("reevaluationCondition");
    expect(kit).toContain("followUpIssue");
    expect(kit).not.toContain('"commandId"');
  });

  test("build-test-lifecycle kit references the concrete native-sdk probes", () => {
    const kit = renderKit(MATRIX, "build-test-lifecycle");
    expect(kit).toContain("experiments/native-sdk/build-macos.sh");
    expect(kit).toContain("Sweetie");
    expect(kit).toContain("Checkout");
    expect(kit).toContain("NativeProbe");
    expect(kit).toContain("fixture.sweetie-checkout.json");
  });
});

describe("on-disk generated kits", () => {
  test("all rendered files exist and match a fresh render (no drift)", () => {
    for (const file of renderAllTemplates(MATRIX)) {
      const disk = join(PKG, file.path);
      expect(existsSync(disk), `${file.path} missing — run bun run render`).toBe(true);
      expect(readFileSync(disk, "utf8")).toBe(file.content);
    }
  });

  test("concrete build-test fixture exists and stays honest about scope", () => {
    const fixturePath = join(
      PKG,
      "templates",
      "build-test-lifecycle",
      "fixture.sweetie-checkout.json",
    );
    expect(existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(fixture.matrixClass).toBe("build-test-lifecycle");
    expect(fixture.matrixState).toBe("build-probe-only");
    expect(fixture.expected.evidenceLevel).toBe("build-probe-only");
    expect(fixture.explicitlyNotClaimed).toContain("plugin load into AE");
    expect(fixture.explicitlyNotClaimed).toContain("verified-real-host evidence of any kind");
  });
});
