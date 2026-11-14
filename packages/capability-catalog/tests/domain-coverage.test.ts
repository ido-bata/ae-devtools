/**
 * Domain coverage tests — CAP032 groundwork: domain views must project the
 * manifest honestly, keep uncovered symbols listed, and stay deterministic.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoInputs, REPO_ROOT } from "../scripts/inputs.ts";
import { buildCatalog } from "../src/generate.ts";
import {
  DOMAIN_SCHEMA,
  buildDomainCoverageReport,
  serializeDomainCoverageReport,
  type DomainDefinition,
} from "../src/domain-coverage.ts";

const inputs = loadRepoInputs();
const manifest = buildCatalog(inputs);

function loadDomainFiles(): DomainDefinition[] {
  const dir = join(REPO_ROOT, "specs/ae-capability-coverage/domains");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as DomainDefinition);
}

const domains = loadDomainFiles();

test("at least one domain definition exists and is schema-valid", () => {
  assert.ok(domains.length > 0, "no domain definitions found");
  for (const d of domains) assert.equal(d.schema, DOMAIN_SCHEMA);
});

test("every domain projects real manifest members, all scripting symbols", () => {
  const report = buildDomainCoverageReport({
    records: manifest.records,
    domains,
    generatedFrom: [],
  });
  assert.equal(report.domains.length, domains.length);
  for (const d of report.domains) {
    assert.ok(d.memberCount > 0, `${d.domain} matched nothing`);
    for (const m of d.members) {
      assert.ok(m.id.startsWith("ae.scripting."), `${m.id} is not a scripting symbol`);
      assert.ok(d.categories.includes(m.category), `${m.id} category ${m.category} outside domain`);
    }
    // Counts are consistent with the member list.
    const implTotal = Object.values(d.counts.implementation).reduce((a, b) => a + b, 0);
    assert.equal(implTotal, d.memberCount);
    const fr05Total = Object.values(d.counts.fr05).reduce((a, b) => a + b, 0);
    assert.equal(fr05Total, d.memberCount);
    // The uncovered list is exactly the non-implemented members.
    assert.deepEqual(
      d.uncovered,
      d.members.filter((m) => m.implementation !== "implemented").map((m) => m.id),
    );
  }
});

test("project-items domain covers the #15 structural categories", () => {
  const report = buildDomainCoverageReport({
    records: manifest.records,
    domains,
    generatedFrom: [],
  });
  const d = report.domains.find((x) => x.domain === "project-items-comps-layers");
  assert.ok(d, "project-items-comps-layers domain missing");
  for (const cat of ["project", "item", "comp", "layer", "collection", "source"]) {
    assert.ok(d.members.some((m) => m.category === cat), `no ${cat} members`);
  }
  // Nothing is implemented yet — every member must be honestly uncovered.
  assert.equal(d.uncovered.length, d.memberCount);
});

test("domain views never promote coverage axes", () => {
  const report = buildDomainCoverageReport({
    records: manifest.records,
    domains,
    generatedFrom: [],
  });
  for (const d of report.domains) {
    for (const m of d.members) {
      const record = manifest.records.find((r) => r.id === m.id);
      assert.equal(m.implementation, record?.coverage.implementation);
      assert.equal(m.verification, record?.coverage.verification);
    }
  }
});

test("unassigned scripting symbols stay visible — nothing falls outside every domain", () => {
  const report = buildDomainCoverageReport({
    records: manifest.records,
    domains,
    generatedFrom: [],
  });
  const scripting = manifest.records.filter((r) => r.kind === "scripting-symbol");
  const memberIds = new Set(report.domains.flatMap((d) => d.members.map((m) => m.id)));
  const unassignedIds = new Set(report.unassigned.map((u) => u.id));

  // Partition: every scripting symbol is a domain member XOR unassigned.
  for (const r of scripting) {
    const inDomain = memberIds.has(r.id);
    const unassigned = unassignedIds.has(r.id);
    assert.ok(inDomain !== unassigned, `${r.id} must be exactly one of member/unassigned`);
  }
  assert.equal(memberIds.size + unassignedIds.size, scripting.length);

  // Unassigned entries are sorted and carry only real scripting symbols.
  const sorted = [...report.unassigned].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(report.unassigned, sorted);
  for (const u of report.unassigned) {
    assert.ok(u.id.startsWith("ae.scripting."), `${u.id} is not a scripting symbol`);
  }

  // The 'application' (app.*) category is deliberately claimed by no
  // domain today — it must show up here, not vanish.
  const appMembers = scripting.filter((r) => r.category === "application");
  assert.ok(appMembers.length > 0, "expected application-category symbols in inventory");
  for (const m of appMembers) {
    assert.ok(unassignedIds.has(m.id), `${m.id} (application) should be unassigned`);
  }
});

test("a category claimed by two domains fails closed", () => {
  const base = domains[0];
  assert.ok(base !== undefined);
  const overlapping: DomainDefinition = {
    ...base,
    domain: "overlap",
    categories: [base.categories[0] as string],
  };
  assert.throws(
    () => buildDomainCoverageReport({ records: manifest.records, domains: [base, overlapping], generatedFrom: [] }),
    /claimed by both/,
  );
});

test("serialization is deterministic", () => {
  const report = buildDomainCoverageReport({
    records: manifest.records,
    domains,
    generatedFrom: [{ path: "b", sha256: "2" }, { path: "a", sha256: "1" }],
  });
  assert.equal(serializeDomainCoverageReport(report), serializeDomainCoverageReport(report));
  assert.equal(report.generatedFrom[0]?.path, "a");
});

test("empty-match and duplicate domains fail closed", () => {
  const empty: DomainDefinition = {
    schema: DOMAIN_SCHEMA,
    domain: "empty",
    issue: "test",
    title: "t",
    categories: ["no-such-category"],
  };
  assert.throws(() =>
    buildDomainCoverageReport({ records: manifest.records, domains: [empty], generatedFrom: [] }),
    /matched no scripting symbols/,
  );
  const dup = domains[0];
  assert.ok(dup !== undefined);
  assert.throws(() =>
    buildDomainCoverageReport({ records: manifest.records, domains: [dup, dup], generatedFrom: [] }),
    /duplicate domain slug/,
  );
});
