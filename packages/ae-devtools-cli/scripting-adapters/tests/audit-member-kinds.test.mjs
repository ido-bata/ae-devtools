/*
 * audit-member-kinds counterexample tests — Issue #319.
 *
 * Each test reproduces a FALSE-GREEN class the old name-based audit
 * could not detect, using synthetic ops + a synthetic symbols.json so
 * the fixtures stay small and deterministic:
 *
 *   - owner collision: `.alpha` on a Bar receiver must NOT satisfy a
 *     claim for Foo.alpha, and must surface as an undocumented-member
 *     finding (name-only matching would pass silently).
 *   - string masking: arg values like "layer.reorder: ..." embedded in
 *     generated string literals must not parse as member accesses.
 *   - signature arity: a method claim is checked against the documented
 *     signature's arg count.
 *   - access confusion: read-only attribute writes and attribute/method
 *     confusion are findings.
 *   - discriminating args: members exercised only under non-sample arg
 *     values are found via mechanical variant enumeration.
 *   - helper reachability: members inside helpers never called from the
 *     op's main body do NOT count as exercised.
 *   - known-gap suppression: documented-but-uninventoried members are
 *     suppressed AND counted, never silent (injected via `knownGaps` —
 *     the real KNOWN_GAPS set is empty since Issue #329).
 *   - Issue #329: layer.property() resolves through the documented
 *     Layer -> PropertyGroup inheritance (no gap needed); plain-JS and
 *     enum-object receivers are "resolved non-host", not "untyped";
 *     signature-less method claims are counted as unchecked coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditMemberKinds,
  memberSites,
} from "../scripts/audit-member-kinds.mjs";

const sym = (id, owner, member, kind, extra = {}) => ({
  id, owner, member, kind,
  access: kind === "attribute" ? "read-write" : null,
  signature: kind === "method" ? [] : null,
  ...extra,
});

function runAudit({ symbols, ops, knownGaps, enums }) {
  const dir = mkdtempSync(join(tmpdir(), "audit-member-kinds-"));
  const symbolsPath = join(dir, "symbols.json");
  writeFileSync(symbolsPath, JSON.stringify({ symbols, enums: enums || [] }));
  const byId = new Map(ops.map((o) => [o.id, o]));
  return auditMemberKinds({
    symbolsPath,
    operations: ops,
    knownGaps,
    sampleArgsFn: (op) => op._sample || {},
    buildSourceFn: (id, args) => {
      const op = byId.get(id);
      if (!op) throw new Error(`unknown op ${id}`);
      return op.source(args);
    },
  });
}

test("owner collision: same member name on different owners is not conflated", () => {
  const symbols = [
    sym("t.Foo.alpha", "Foo", "alpha", "attribute"),
    sym("t.Bar.other", "Bar", "other", "attribute"),
  ];
  const op = {
    id: "t.op",
    members: ["t.Foo.alpha"],
    args: [],
    _sample: {},
    source: () => `var f = new Foo();
var b = new Bar();
var ok = f.alpha;
var bad = b.alpha;
return ok;`,
  };
  const { findings } = runAudit({ symbols, ops: [op] });
  // Foo.alpha IS exercised by the `f.alpha` read — no unexercised-claim
  // finding for it.
  assert.ok(!findings.some((f) => f.issue.includes("Foo.alpha") && f.issue.includes("never")),
    "Foo.alpha claim should be satisfied by the Foo-typed site");
  // But `b.alpha` on Bar is undocumented — a name-only audit would miss it.
  assert.ok(findings.some((f) => f.issue.includes("Bar.alpha")),
    "expected an undocumented-member finding for Bar.alpha");
});

test("string literals never produce member-access sites", () => {
  // Regression: probe-generated arg values embed validate() error
  // strings like "layer.reorder: ..." into generated sources; the old
  // scanner matched `.reorder` inside the string and typed the
  // receiver `layer` as AVLayer — a phantom finding.
  const sites = memberSites(`var s = "layer.reorder: to must be 'top'";
var t = "a.b(c).d";
foo.bar();`);
  assert.ok(!sites.some((s) => s.name === "reorder"), "string content must not yield a 'reorder' site");
  assert.ok(!sites.some((s) => s.name === "b" && s.kind === "call"), "string content must not yield call sites");
  assert.ok(sites.some((s) => s.name === "bar" && s.kind === "call"), "real call site still detected");
});

test("signature arity: method calls are checked against documented signatures", () => {
  const symbols = [
    sym("t.Foo.greet", "Foo", "greet", "method", { signature: ["a", "b"] }),
  ];
  const bad = {
    id: "t.bad",
    members: ["t.Foo.greet"],
    args: [],
    _sample: {},
    source: () => `var f = new Foo();
f.greet(1);`,
  };
  const good = {
    id: "t.good",
    members: ["t.Foo.greet"],
    args: [],
    _sample: {},
    source: () => `var f = new Foo();
f.greet(1, 2);`,
  };
  const { findings } = runAudit({ symbols, ops: [bad, good] });
  assert.equal(findings.length, 1, `expected exactly the arity finding, got: ${JSON.stringify(findings)}`);
  assert.ok(findings[0].op === "t.bad");
  assert.ok(findings[0].issue.includes("allows 2..2"), findings[0].issue);
});

test("access confusion: read-only writes and attribute/method swaps are findings", () => {
  const symbols = [
    sym("t.Foo.ro", "Foo", "ro", "attribute", { access: "read" }),
    sym("t.Foo.attr", "Foo", "attr", "attribute"),
  ];
  const ops = [
    {
      id: "t.write",
      members: ["t.Foo.ro"],
      args: [],
      _sample: {},
      source: () => `var f = new Foo();
f.ro = 1;`,
    },
    {
      id: "t.callAttr",
      members: ["t.Foo.attr"],
      args: [],
      _sample: {},
      source: () => `var f = new Foo();
f.attr();`,
    },
  ];
  const { findings } = runAudit({ symbols, ops });
  assert.ok(findings.some((f) => f.op === "t.write" && f.issue.includes("read-only")),
    "expected read-only write finding");
  assert.ok(findings.some((f) => f.op === "t.callAttr"),
    "expected attribute-invoked-as-method finding");
});

test("discriminating args: variant enumeration exercises arg-dependent members", () => {
  const symbols = [
    sym("t.Foo.deepMember", "Foo", "deepMember", "attribute"),
    sym("t.Foo.shallowMember", "Foo", "shallowMember", "attribute"),
  ];
  const op = {
    id: "t.variant",
    members: ["t.Foo.deepMember", "t.Foo.shallowMember"],
    args: ["mode"],
    _sample: { mode: "deep" },
    source: (a) => `var f = new Foo();
${a.mode === "deep" ? "f.deepMember;" : "f.shallowMember;"}
return 1;`,
  };
  const { findings, stats } = runAudit({ symbols, ops: [op] });
  assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings)}`);
  assert.ok(stats.sources >= 2, "expected multiple generated variants");
  assert.ok(stats.discriminatingArgs >= 1, "expected mode to count as discriminating");
});

test("helper reachability: uncalled helpers do not exercise members", () => {
  const symbols = [
    sym("t.Foo.deadMember", "Foo", "deadMember", "attribute"),
    sym("t.Foo.aliveMember", "Foo", "aliveMember", "attribute"),
  ];
  const dead = {
    id: "t.dead",
    members: ["t.Foo.deadMember", "t.Foo.aliveMember"],
    args: [],
    _sample: {},
    source: () => `function __adp_dead() {
  var f = new Foo();
  f.deadMember;
}
var f2 = new Foo();
f2.aliveMember;
return 1;`,
  };
  const live = {
    id: "t.live",
    members: ["t.Foo.deadMember"],
    args: [],
    _sample: {},
    source: () => `function __adp_dead() {
  var f = new Foo();
  f.deadMember;
}
__adp_dead();
return 1;`,
  };
  const { findings } = runAudit({ symbols, ops: [dead, live] });
  // t.dead: deadMember only appears in an uncalled helper -> unexercised.
  assert.ok(findings.some((f) => f.op === "t.dead" && f.issue.includes("Foo.deadMember")),
    "expected unexercised-claim finding for deadMember in t.dead");
  assert.ok(!findings.some((f) => f.op === "t.dead" && f.issue.includes("aliveMember")),
    "aliveMember is read in main and must not be flagged");
  // t.live: the helper IS called -> deadMember counts as exercised.
  assert.ok(!findings.some((f) => f.op === "t.live"),
    `reachable helper should satisfy the claim, got: ${JSON.stringify(findings)}`);
});

test("known-gap suppression is counted, not silent", () => {
  const symbols = [
    // AVLayer must exist as an owner for the receiver to type.
    sym("t.AVLayer.marker", "AVLayer", "marker", "attribute"),
  ];
  const op = {
    id: "t.gap",
    members: [],
    args: [],
    _sample: {},
    source: () => `var l = new AVLayer();
var n = l.runtimeOnlyField;
return n;`,
  };
  // The gap is injected (the real KNOWN_GAPS set is empty since #329);
  // the member is absent from the synthetic inventory on purpose.
  const { findings, stats } = runAudit({
    symbols, ops: [op], knownGaps: ["AVLayer.runtimeOnlyField"],
  });
  assert.ok(!findings.some((f) => f.issue.includes("runtimeOnlyField")),
    `gap sites must be suppressed, got: ${JSON.stringify(findings)}`);
  assert.ok(stats.gapSuppressed >= 1, `expected gapSuppressed >= 1, got ${stats.gapSuppressed}`);
});

test("layer.property() resolves via documented Layer -> PropertyGroup inheritance", () => {
  // Issue #329: `Layer baseClass=PropertyGroup` in symbols.json means a
  // layer IS the root of its property tree. With the corrected INHERITS
  // chain, layer.property()/numProperties() are documented members —
  // no KNOWN_GAPS entry and no finding.
  const symbols = [
    sym("t.PropertyGroup.property", "PropertyGroup", "property", "method"),
    sym("t.PropertyGroup.numProperties", "PropertyGroup", "numProperties", "attribute", { access: "read" }),
    sym("t.AVLayer.marker", "AVLayer", "marker", "attribute"),
  ];
  const op = {
    id: "t.layerprop",
    members: [],
    args: [],
    _sample: {},
    source: () => `var l = new AVLayer();
var n = l.numProperties;
var p = l.property("ADBE Transform Group").property("ADBE Position");
return n;`,
  };
  const { findings } = runAudit({ symbols, ops: [op] });
  assert.equal(findings.length, 0, `layer property access must be documented, got: ${JSON.stringify(findings)}`);
});

test("plain-JS receivers are resolved non-host, not untyped", () => {
  // Issue #329 false-green class: `v.charCodeAt(0).toString(16)` chains
  // through JS values. The receiver type IS resolved ("js") — it must
  // not inflate the untyped bucket, and must not produce findings.
  const op = {
    id: "t.jschain",
    members: [],
    args: [],
    _sample: {},
    source: () => `var v = "abc";
var parts = [];
for (var i = 0; i < v.length; i++) parts.push(v.charCodeAt(i).toString(16));
var n = parts.join(",");
var o = {};
o.count = parts.length;
return n + o.count;`,
  };
  const { findings, stats } = runAudit({ symbols: [], ops: [op] });
  assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings)}`);
  assert.equal(stats.untypedSites, 0, `JS receivers must not count as untyped, got ${stats.untypedSites}`);
  assert.ok(stats.nonHostSites > 0, "expected JS receiver sites in the non-host bucket");
});

test("enum objects type as resolved non-host", () => {
  const op = {
    id: "t.enum",
    members: [],
    args: [],
    _sample: {},
    source: () => `var mode = CloseOptions.DO_NOT_SAVE_CHANGES;
var other = ImportAsType.FOOTAGE;
return mode;`,
  };
  const { findings, stats } = runAudit({
    symbols: [],
    enums: [{ name: "CloseOptions" }, { name: "ImportAsType" }],
    ops: [op],
  });
  assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings)}`);
  assert.equal(stats.untypedSites, 0, `enum member reads must resolve, got ${stats.untypedSites} untyped`);
});

test("signature coverage stats expose unchecked method claims", () => {
  const symbols = [
    sym("t.Foo.sig", "Foo", "sig", "method", { signature: ["a"] }),
    sym("t.Foo.unsig", "Foo", "unsig", "method", { signature: [] }),
  ];
  const op = {
    id: "t.sigcov",
    members: ["t.Foo.sig", "t.Foo.unsig"],
    args: [],
    _sample: {},
    source: () => `var f = new Foo();
f.sig(1);
f.unsig(1, 2, 3);`,
  };
  const { findings, stats } = runAudit({ symbols, ops: [op] });
  assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings)}`);
  assert.equal(stats.sigClaims, 1);
  assert.equal(stats.unsigClaims, 1);
  assert.deepEqual(stats.unsigMembers, ["Foo.unsig"]);
  assert.ok(stats.aritySites >= 1, "expected arity-checked call sites");
});
