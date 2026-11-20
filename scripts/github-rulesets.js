#!/usr/bin/env node
/**
 * github-rulesets.js — apply the repository's GitHub rulesets (Issue #349).
 *
 * PR #342 (`341 -> main`) merged into `main` while `Verify head branch
 * shape` was FAILURE and the conformance gate was SKIPPED: legacy branch
 * protection on `main` had no required status checks, zero required
 * approvals, and `enforce_admins: false`, so nothing mechanically
 * stopped the merge. Rulesets close that gap: required status checks
 * must come from GitHub Actions, and `bypass_actors: []` means the
 * rules bind everyone — including repository admins.
 *
 *   node scripts/github-rulesets.js           # dry run: print desired state
 *   node scripts/github-rulesets.js --apply   # create or update, then read back
 *
 * Needs `gh` authenticated as a repository admin. Idempotent: rulesets
 * are matched by name + target, so a second run changes nothing. Other
 * rulesets are left alone. See docs/github-settings.md for the canonical
 * description of what is enforced and why.
 */
import { execFileSync } from "node:child_process";

const REPO = process.env.GH_REPO ?? "ido-bata/ae-devtools";
/** GitHub Actions' app id: required checks must come from it, not any app. */
const GITHUB_ACTIONS_APP_ID = 15368;

/** ci.yml job names — required on every protected ref. */
const CI_CHECKS = [
  "ae-devtools-cli (packaged suites + consumer smoke, fake-level) (22)",
  "ae-devtools-cli (packaged suites + consumer smoke, fake-level) (24)",
  "capability-catalog (bun test / typecheck / verify)",
  "cep-panel-contract",
  "github-config (issue templates + workflow YAML syntax parse)",
  "inventories (bun test / typecheck / verify)",
  "native-adapter (bun test / typecheck / verify)",
  "read-only-probe (node:test, fake responder)",
  "skills-lock (vendored skills vs skills-lock.json)",
];

/** release-source-check.yml jobs — run only on PRs targeting `main`. */
const RELEASE_GATE_CHECKS = [
  "Verify head branch shape",
  "Conformance release gate (CAP056)",
];

function ghApi(args, input) {
  const cmd = ["gh", "api", ...args];
  if (input !== undefined) cmd.push("--input", "-");
  return execFileSync(cmd[0], cmd.slice(1), {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function desiredRulesets() {
  const checksFor = (extra = []) =>
    [...CI_CHECKS, ...extra].map((context) => ({
      context,
      integration_id: GITHUB_ACTIONS_APP_ID,
    }));
  return [
    {
      name: "main-branch-protection",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            do_not_enforce_on_create: false,
            strict_required_status_checks_policy: false,
            required_status_checks: checksFor(RELEASE_GATE_CHECKS),
          },
        },
      ],
    },
    {
      name: "release-branch-protection",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: { include: ["refs/heads/release-*"], exclude: [] },
      },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            do_not_enforce_on_create: false,
            strict_required_status_checks_policy: false,
            required_status_checks: checksFor(),
          },
        },
      ],
    },
    {
      name: "release-tag-protection",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "update" },
      ],
    },
  ];
}

function listRulesets() {
  const out = ghApi([`repos/${REPO}/rulesets?includes_parents=false`, "--paginate"]);
  return JSON.parse(out);
}

function normalize(rs) {
  return {
    name: rs.name,
    target: rs.target,
    enforcement: rs.enforcement,
    conditions: rs.conditions,
    bypass_actors: (rs.bypass_actors ?? []).map((a) => a.actor_id ?? a),
    rules: (rs.rules ?? []).map((r) => ({ type: r.type, parameters: r.parameters ?? null })),
  };
}

function sameRuleset(a, b) {
  return (
    a.name === b.name &&
    a.target === b.target &&
    a.enforcement === b.enforcement &&
    JSON.stringify(a.conditions) === JSON.stringify(b.conditions) &&
    JSON.stringify(a.bypass_actors) === JSON.stringify(b.bypass_actors) &&
    JSON.stringify(a.rules) === JSON.stringify(b.rules)
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const desired = desiredRulesets();
  const existing = listRulesets();
  const byName = new Map(existing.map((rs) => [rs.name, rs]));

  for (const want of desired) {
    const cur = byName.get(want.name);
    const payload = {
      name: want.name,
      target: want.target,
      enforcement: want.enforcement,
      conditions: want.conditions,
      bypass_actors: want.bypass_actors,
      rules: want.rules,
    };
    if (!apply) {
      console.log(`--- ${want.name} (${want.target}) ---`);
      console.log(JSON.stringify(payload, null, 2));
      continue;
    }
    if (cur && sameRuleset(normalize(cur), normalize({ ...want, rules: want.rules.map((r) => ({ ...r, parameters: r.parameters ?? undefined })) }))) {
      console.log(`unchanged: ${want.name}`);
      continue;
    }
    if (cur) {
      ghApi([`repos/${REPO}/rulesets/${cur.id}`, "--method", "PUT"], payload);
      console.log(`updated: ${want.name} (id ${cur.id})`);
    } else {
      ghApi([`repos/${REPO}/rulesets`, "--method", "POST"], payload);
      console.log(`created: ${want.name}`);
    }
  }
  if (apply) {
    const after = listRulesets();
    for (const want of desired) {
      const found = after.find((rs) => rs.name === want.name);
      console.log(`readback: ${want.name} -> ${found ? `id ${found.id}, enforcement ${found.enforcement}` : "MISSING"}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
