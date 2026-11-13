/**
 * CAP013 — evidence axes, FR-05 mapping and unjustified-promotion detection.
 *
 * The supervisor handoff (issue #11 comment 6813348033) requires that
 * source-reviewed / documented, automated-fake / verified-real-host, and the
 * three flavours of `unknown` are never collapsed into each other.
 */

import { describe, expect, test } from "bun:test";
import { makeRecord } from "./fixture.ts";
import {
  earnedFr05State,
  fr05State,
  FR05_STATES,
  promotionViolations,
  type Fr05State,
} from "../src/evidence.ts";
import { CONTRACT_VERSION } from "../src/schema.ts";

describe("FR-05 mapping keeps the axes separate", () => {
  test("source-reviewed documents a symbol without verifying anything", () => {
    const r = makeRecord({
      id: "ae.scripting.fixture.value",
      coverage: {
        inventory: "source-reviewed",
        evidenceRefs: [{ kind: "source-doc", ref: "https://example.invalid/doc" }],
      },
    });
    expect(fr05State(r)).toBe("documented");
    expect(r.coverage.verification).toBe("not-run");
    expect(r.coverage.reachability).toBe("unknown");
    expect(r.coverage.implementation).toBe("unknown");
  });

  test("automated-fake never maps to verified-on-real-host", () => {
    const r = makeRecord({
      id: "ae.tool.fixture.op",
      kind: "tool-operation",
      coverage: {
        inventory: "source-reviewed",
        implementation: "implemented",
        verification: "automated-fake",
        evidenceRefs: [
          { kind: "source-impl", ref: "tool@sha:file#L1" },
          { kind: "automated-test", ref: "tests/fixture.test.ts" },
        ],
      },
    });
    expect(fr05State(r)).toBe("automated-fake-tested");
    expect(earnedFr05State(r)).toBe("automated-fake-tested");
  });

  test("verified-on-real-host requires real-host evidence for every claimed OS", () => {
    const darwinOnly = makeRecord({
      id: "ae.scripting.fixture.value",
      compatibility: { os: ["darwin"] },
      coverage: {
        inventory: "source-reviewed",
        implementation: "implemented",
        verification: "verified-real-host",
        evidenceRefs: [
          { kind: "source-impl", ref: "adapter.ts" },
          { kind: "real-host", ref: "evidence/run-1", platform: "darwin" },
        ],
      },
    });
    expect(fr05State(darwinOnly)).toBe("verified-on-real-host");
    expect(promotionViolations(darwinOnly)).toEqual([]);

    const windowsRow = makeRecord({
      id: "ae.scripting.fixture.win-value",
      compatibility: { os: ["win32"] },
      coverage: {
        inventory: "source-reviewed",
        implementation: "implemented",
        verification: "verified-real-host",
        evidenceRefs: [
          { kind: "source-impl", ref: "adapter.ts" },
          { kind: "real-host", ref: "evidence/run-1", platform: "darwin" },
        ],
      },
    });
    const codes = promotionViolations(windowsRow).map((v) => v.code);
    expect(codes).toContain("windows-unverified");
    expect(earnedFr05State(windowsRow)).not.toBe("verified-on-real-host");
  });

  test("the seven FR-05 states are exactly the spec's set", () => {
    const expected: Fr05State[] = [
      "automated-fake-tested",
      "documented",
      "implemented",
      "reachable",
      "unknown",
      "unsupported-with-reason",
      "verified-on-real-host",
    ];
    expect([...FR05_STATES].sort()).toEqual([...expected].sort());
  });

  test("unsupported-with-reason requires the reason; without it the state is unknown", () => {
    const withReason = makeRecord({
      id: "ae.sdk.fixture.host-callback",
      kind: "sdk-symbol",
      persistence: "build-time-supplied",
      coverage: {
        inventory: "source-reviewed",
        implementation: "unsupported",
        unsupportedReason: "host-owned callback; no generic remote invocation (FR-09)",
        evidenceRefs: [{ kind: "source-doc", ref: "header://Fixture.h" }],
      },
    });
    expect(fr05State(withReason)).toBe("unsupported-with-reason");
    expect(promotionViolations(withReason)).toEqual([]);

    const noReason = makeRecord({
      id: "ae.sdk.fixture.host-callback-2",
      kind: "sdk-symbol",
      persistence: "build-time-supplied",
      coverage: {
        inventory: "source-reviewed",
        implementation: "unsupported",
        evidenceRefs: [{ kind: "source-doc", ref: "header://Fixture.h" }],
      },
    });
    expect(fr05State(noReason)).toBe("unknown");
    expect(promotionViolations(noReason).map((v) => v.code)).toContain(
      "unsupported-without-reason",
    );
  });
});

describe("unjustified coverage promotion is detected", () => {
  test("documented claim with no evidence at all is a promotion", () => {
    const r = makeRecord({
      id: "ae.scripting.fixture.bare",
      coverage: { inventory: "source-reviewed" },
    });
    expect(fr05State(r)).toBe("documented");
    expect(earnedFr05State(r)).toBe("unknown");
    expect(promotionViolations(r).map((v) => v.code)).toContain(
      "unjustified-promotion",
    );
  });

  test("verified claim backed only by a fake test is a promotion", () => {
    const r = makeRecord({
      id: "ae.tool.fixture.sneaky",
      kind: "tool-operation",
      coverage: {
        inventory: "source-reviewed",
        implementation: "implemented",
        verification: "verified-real-host",
        evidenceRefs: [
          { kind: "source-impl", ref: "tool.ts#L1" },
          { kind: "automated-test", ref: "tests/tool.test.ts" },
        ],
      },
    });
    expect(promotionViolations(r).map((v) => v.code)).toContain(
      "unjustified-promotion",
    );
  });

  test("fake claim without a test artifact is a promotion", () => {
    const r = makeRecord({
      id: "ae.tool.fixture.no-test",
      kind: "tool-operation",
      coverage: {
        inventory: "source-reviewed",
        implementation: "implemented",
        verification: "automated-fake",
        evidenceRefs: [{ kind: "source-impl", ref: "tool.ts#L1" }],
      },
    });
    expect(promotionViolations(r).map((v) => v.code)).toContain(
      "unjustified-promotion",
    );
  });

  test("reachable claim needs implementation-path evidence, not just documentation", () => {
    const r = makeRecord({
      id: "ae.scripting.fixture.reachable",
      coverage: {
        inventory: "source-reviewed",
        reachability: "reachable",
        evidenceRefs: [{ kind: "source-doc", ref: "https://example.invalid/doc" }],
      },
    });
    expect(fr05State(r)).toBe("reachable");
    expect(promotionViolations(r).map((v) => v.code)).toContain(
      "unjustified-promotion",
    );
  });
});

describe("the three kinds of unknown stay distinct", () => {
  test("unknownKind is a record-level field with exactly the three supervisor kinds", () => {
    const unclassifiable = makeRecord({
      id: "ae.tool.fixture.unclassified",
      kind: "tool-operation",
      coverage: {
        inventory: "source-reviewed",
        unknownKind: "unclassifiable",
        evidenceRefs: [{ kind: "source-impl", ref: "tool.ts#L1" }],
      },
    });
    expect(unclassifiable.coverage.unknownKind).toBe("unclassifiable");

    const undiscovered = makeRecord({
      id: "ae.scripting.fixture.missing",
      coverage: { unknownKind: "undiscovered" },
    });
    expect(undiscovered.coverage.unknownKind).toBe("undiscovered");

    const denominator = makeRecord({
      id: "ae.sdk.fixture.unsupplied",
      kind: "sdk-symbol",
      persistence: "build-time-supplied",
      coverage: { unknownKind: "denominator-unsupplied" },
    });
    expect(denominator.coverage.unknownKind).toBe("denominator-unsupplied");
  });

  test("contract version for the consumer handshake is 1.0", () => {
    expect(CONTRACT_VERSION).toEqual({ major: 1, minor: 0 });
  });
});
