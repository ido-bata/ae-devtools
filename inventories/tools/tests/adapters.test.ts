/**
 * Adapter integration tests (skipped when the pinned clones are absent).
 *
 * The ae-a8n test locks the access split derived from reading
 * host/a8n-host.js: misclassification regressions (D1) fail here.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_ROOT } from "../scripts/registry.ts";
import type { OperationRow } from "../scripts/types.ts";

const hasA8n = existsSync(join(REFERENCE_ROOT, "ae-a8n", "host", "a8n-host.js"));
const hasBridge = existsSync(join(REFERENCE_ROOT, "..", "experiments", "runtime-bridge"));

describe.skipIf(!hasA8n)("ae-a8n adapter", () => {
  let rows: OperationRow[] = [];
  test("extracts the 26 host dispatch methods", async () => {
    const { extract } = await import("../scripts/adapters/ae-a8n.ts");
    rows = extract();
    expect(rows.length).toBe(26);
  });

  test("access split matches the source reading: 12 read / 5 write / 9 execute / 0 unknown", async () => {
    if (rows.length === 0) {
      const { extract } = await import("../scripts/adapters/ae-a8n.ts");
      rows = extract();
    }
    const count = (a: string) => rows.filter((r) => r.access === a).length;
    expect(count("read")).toBe(12);
    expect(count("write")).toBe(5);
    expect(count("execute")).toBe(9);
    expect(count("unknown")).toBe(0);
  });

  test("review-critical rows are classified from behaviour", async () => {
    if (rows.length === 0) {
      const { extract } = await import("../scripts/adapters/ae-a8n.ts");
      rows = extract();
    }
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("app.info")?.access).toBe("read");
    expect(byName.get("project.info")?.access).toBe("read");
    expect(byName.get("comp.selectLayers")?.access).toBe("execute");
    expect(byName.get("ui.alert")?.access).toBe("execute");
    expect(byName.get("app.quit")?.access).toBe("execute");
    expect(byName.get("effect.setParameter")?.access).toBe("write");
    expect(byName.get("menu.find")?.access).toBe("read");
    // basis present and behaviour-describing
    for (const row of rows) expect(row.accessBasis.length).toBeGreaterThan(10);
  });

  test("definition and implementation citations resolve in the same file", async () => {
    if (rows.length === 0) {
      const { extract } = await import("../scripts/adapters/ae-a8n.ts");
      rows = extract();
    }
    for (const row of rows) {
      expect(row.definitionFile).toBe(row.implementationFile);
      expect(row.definitionFile).toBe("host/a8n-host.js");
      expect(row.definitionLine).toBeGreaterThan(0);
      expect(row.status).toBe("source-verified");
    }
  });
});

describe.skipIf(!hasBridge)("ae-devtools runtime-bridge adapter", () => {
  test("extracts the probes and server endpoints", async () => {
    const { extract } = await import("../scripts/adapters/ae-devtools.ts");
    const rows = extract();
    expect(rows.length).toBe(10);
    for (const row of rows) {
      expect(row.definitionFile.startsWith("experiments/runtime-bridge/")).toBe(true);
      expect(row.accessBasis.length).toBeGreaterThan(10);
    }
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("probe.version")?.access).toBe("read");
    expect(byName.get("probe.mutate-then-inspect")?.access).toBe("write");
    expect(byName.get("probe.mutate-then-inspect")?.accessBasis).toContain("net project content unchanged");
    expect(byName.get("probe.exception")?.access).toBe("build-test");
    expect(byName.get("bridge.eval")?.access).toBe("execute");
    expect(byName.get("bridge.healthz")?.access).toBe("read");
  });
});
