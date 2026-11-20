/**
 * github-rulesets.test.mjs — contract tests for the pure decision
 * logic of scripts/github-rulesets.js (Issue #361).
 *
 * The script mutates real repository rulesets; the tests pin the
 * properties that keep it safe:
 *   - matching is by name AND target (a same-named ruleset on a
 *     different ref type must never be selected for update),
 *   - unrelated existing rulesets are never matched,
 *   - the equality check compares the FULL normalized ruleset shape,
 *   - desired rulesets carry the required-check contexts and no
 *     bypass actors.
 *
 * No GitHub API access: only exported pure functions are exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  desiredRulesets,
  matchExisting,
  normalize,
  rulesetKey,
  sameRuleset,
} from "./github-rulesets.js";

test("rulesetKey distinguishes target — same name on tag vs branch never collides", () => {
  const branch = { name: "main-branch-protection", target: "branch" };
  const tag = { name: "main-branch-protection", target: "tag" };
  assert.notEqual(rulesetKey(branch), rulesetKey(tag));
});

test("matchExisting selects only the same name+target ruleset", () => {
  const want = { name: "release-tag-protection", target: "tag" };
  const existing = [
    { id: 1, name: "release-tag-protection", target: "branch" }, // decoy: same name, wrong target
    { id: 2, name: "unrelated-ruleset", target: "tag" },
    { id: 3, name: "release-tag-protection", target: "tag" },
  ];
  const found = matchExisting(existing, want);
  assert.equal(found?.id, 3, "must select the tag-target ruleset, not the branch decoy");
});

test("matchExisting returns null when nothing matches — unrelated rulesets untouched", () => {
  const want = desiredRulesets()[0];
  const existing = [
    { id: 9, name: "someone-elses-ruleset", target: "branch" },
    { id: 10, name: want.name, target: "tag" }, // right name, wrong target
  ];
  assert.equal(matchExisting(existing, want), null);
});

test("sameRuleset detects any drift in rules/conditions/bypass", () => {
  const base = normalize({
    name: "x", target: "branch", enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: "deletion" }],
  });
  assert.ok(sameRuleset(base, { ...base }));
  assert.ok(!sameRuleset(base, { ...base, enforcement: "evaluate" }));
  assert.ok(!sameRuleset(base, {
    ...base,
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  }));
  assert.ok(!sameRuleset(base, {
    ...base,
    bypass_actors: [{ actor_id: 1, bypass_mode: "always" }],
  }));
});

test("normalize fills absent collections so comparison is stable", () => {
  const n = normalize({ name: "x", target: "tag", enforcement: "active" });
  assert.deepEqual(n.bypass_actors, []);
  assert.deepEqual(n.rules, []);
});

test("desired rulesets: three protections, active, no bypass actors", () => {
  const all = desiredRulesets();
  assert.equal(all.length, 3);
  const byKey = new Map(all.map((r) => [rulesetKey(r), r]));
  assert.ok(byKey.has("branch:main-branch-protection"));
  assert.ok(byKey.has("branch:release-branch-protection"));
  assert.ok(byKey.has("tag:release-tag-protection"));
  for (const rs of all) {
    assert.equal(rs.enforcement, "active");
    assert.deepEqual(rs.bypass_actors, []);
  }
});

test("main-branch-protection requires the release-gate checks", () => {
  const main = desiredRulesets().find((r) => r.name === "main-branch-protection");
  const checksRule = main.rules.find((r) => r.type === "required_status_checks");
  const contexts = checksRule.parameters.required_status_checks.map((c) => c.context);
  assert.ok(contexts.includes("Verify head branch shape"));
  assert.ok(contexts.includes("Conformance release gate (CAP056)"));
});
