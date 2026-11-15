import test from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, renderMarkdown, CLASS_STATE } from "./coverage-matrix.mjs";

const AGG = {
  release: { identifier: "26.5", distribution: "macos" },
  evidenceLevel: { realHost: "UNVERIFIED" },
  totals: {
    headerFilesParsed: 2,
    symbols: 10,
    unknown: 3,
    unknownByReason: { "pure-data-type": 3 },
    byClass: {
      "build-test-lifecycle": 1,
      "external-command": 4,
      "host-callback": 2,
      "in-host-plugin-command": 0,
      "unsupported-or-unknown": 3,
    },
  },
  perHeader: [
    { path: "A.h", symbols: 6, byClass: { "external-command": 4 } },
    { path: "B.h", symbols: 4, byClass: { "host-callback": 2 } },
  ],
  denominatorCaveats: ["not a full enumeration"],
};

test("buildMatrix carries totals, classes and honest states", () => {
  const m = buildMatrix(AGG);
  assert.equal(m.schema, "ae-devtools/sdk-coverage-matrix/1");
  assert.equal(m.totals.symbols, 10);
  assert.equal(m.totals.unknown, 3);
  assert.equal(m.classes["external-command"].symbols, 4);
  assert.equal(m.classes["external-command"].state, "inventory-only");
  // nothing is claimed implemented or real-host verified
  for (const row of Object.values(m.classes)) {
    assert.equal(row.implemented, false);
    assert.equal(row.verifiedOnRealHost, false);
  }
});

test("unmapped extractor classes surface as unknown, never dropped", () => {
  const agg = JSON.parse(JSON.stringify(AGG));
  agg.totals.byClass["brand-new-class"] = 7;
  const m = buildMatrix(agg);
  assert.equal(m.classes["brand-new-class"].state, "unknown");
  assert.equal(m.classes["brand-new-class"].symbols, 7);
});

test("per-header rows and caveats are preserved", () => {
  const m = buildMatrix(AGG);
  assert.equal(m.headers.length, 2);
  assert.equal(m.headers[0].path, "A.h");
  assert.deepEqual(m.denominatorCaveats, ["not a full enumeration"]);
  const md = renderMarkdown(m);
  assert.match(md, /external-command \| 4/);
  assert.match(md, /not a full enumeration/);
  assert.match(md, /No row in this matrix is verifiedOnRealHost/);
});

test("CLASS_STATE covers every class the extractor emits", () => {
  // keep in sync with CLASSES in extract-sdk-inventory.ts
  for (const cls of [
    "build-test-lifecycle", "external-command", "host-callback",
    "in-host-plugin-command", "unsupported-or-unknown",
  ]) {
    assert.ok(CLASS_STATE[cls], `missing state for ${cls}`);
  }
});
