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
 *     suppressed AND counted, never silent.
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

function runAudit({ symbols, ops }) {
  const dir = mkdtempSync(join(tmpdir(), "audit-member-kinds-"));
  const symbolsPath = join(dir, "symbols.json");
  writeFileSync(symbolsPath, JSON.stringify({ symbols }));
  const byId = new Map(ops.map((o) => [o.id, o]));
  return auditMemberKinds({
    symbolsPath,
    operations: ops,
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
    // PropertyGroup.property mirrors the real inventory entry that makes
    // `Layer.property` an inventory gap rather than a documentation gap.
    sym("t.PropertyGroup.property", "PropertyGroup", "property", "method"),
  ];
  const op = {
    id: "t.gap",
    members: [],
    args: [],
    _sample: {},
    source: () => `var l = new AVLayer();
var n = l.numProperties;
var p = l.property("ADBE Position");
return n;`,
  };
  const { findings, stats } = runAudit({ symbols, ops: [op] });
  assert.ok(!findings.some((f) => f.issue.includes("numProperties") || f.issue.includes(".property")),
    `gap sites must be suppressed, got: ${JSON.stringify(findings)}`);
  assert.ok(stats.gapSuppressed >= 2, `expected gapSuppressed >= 2, got ${stats.gapSuppressed}`);
});
