import { describe, expect, it } from "vitest";

import { classifyFollowUpLabel, computeFindingFingerprint } from "../src/core/review-pr";
import type { ReviewFinding } from "../src/core/review-agent";

function sampleFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f-1",
    pass: "security",
    severity: "P2",
    title: "validate input",
    body: "input path misses validation",
    ...overrides,
  };
}

describe("review PR helpers", () => {
  it("classifies follow-up as bug for defect/regression/security kinds", () => {
    const findings = [sampleFinding({ kind: "security" })];
    expect(classifyFollowUpLabel(findings, null)).toBe("bug");
  });

  it("classifies follow-up as bug for high severity fallback", () => {
    const findings = [sampleFinding({ severity: "P1", kind: null })];
    expect(classifyFollowUpLabel(findings, null)).toBe("bug");
  });

  it("classifies follow-up as enhancement for low severity improvements", () => {
    const findings = [sampleFinding({ pass: "quality", severity: "P3", kind: "improvement" })];
    expect(classifyFollowUpLabel(findings, null)).toBe("enhancement");
  });

  it("honors explicit follow-up label override", () => {
    const findings = [sampleFinding({ severity: "P0", kind: "security" })];
    expect(classifyFollowUpLabel(findings, "enhancement")).toBe("enhancement");
  });

  it("computes stable fingerprints from normalized finding content", () => {
    const first = sampleFinding({
      title: " Validate Input ",
      body: "Path  misses   validation",
      file: "src/cli-program.ts",
      line: 10,
    });
    const second = sampleFinding({
      title: "validate input",
      body: "path misses validation",
      file: "src/cli-program.ts",
      line: 10,
    });

    expect(computeFindingFingerprint(first)).toBe(computeFindingFingerprint(second));
  });
});
