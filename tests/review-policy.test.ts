import { describe, expect, it } from "vitest";

import {
  normalizeReviewComputeClass,
  resolveReviewExecutionPolicy,
  reviewAgentInvocationRetryBudgetForClass,
} from "../src/core/review-policy";

describe("review policy", () => {
  it("normalizes compute class values case-insensitively", () => {
    expect(normalizeReviewComputeClass("l2-standard")).toBe("L2-standard");
    expect(normalizeReviewComputeClass("L3-DEEP")).toBe("L3-deep");
    expect(normalizeReviewComputeClass("unknown")).toBeNull();
  });

  it("uses L3 for review flow and L2 for pr-open-gate by default", () => {
    const reviewPolicy = resolveReviewExecutionPolicy({
      flow: "review",
      issueTitle: "feat: hardening",
      issueLabels: ["module:cli"],
    });
    const gatePolicy = resolveReviewExecutionPolicy({
      flow: "pr-open-gate",
      issueTitle: "feat: hardening",
      issueLabels: ["module:cli"],
    });

    expect(reviewPolicy.computeClass).toBe("L3-deep");
    expect(gatePolicy.computeClass).toBe("L2-standard");
  });

  it("maps retry budget by compute class", () => {
    expect(reviewAgentInvocationRetryBudgetForClass("L1-fast")).toBe(1);
    expect(reviewAgentInvocationRetryBudgetForClass("L2-standard")).toBe(2);
    expect(reviewAgentInvocationRetryBudgetForClass("L3-deep")).toBe(3);
    expect(reviewAgentInvocationRetryBudgetForClass("L4-critical")).toBe(4);
  });

  it("uses docs-only pass profile for module:docs-only issues", () => {
    const policy = resolveReviewExecutionPolicy({
      flow: "review",
      computeClassOverride: "L3-deep",
      issueTitle: "docs: add review policy docs",
      issueLabels: ["module:docs", "status:backlog"],
    });

    expect(policy.passProfile).toBe("docs-only");
    expect(policy.skippedPasses).toEqual(["ux", "growth"]);
    expect(policy.activePasses).not.toContain("ux");
    expect(policy.activePasses).not.toContain("growth");
  });

  it("uses docs-only pass profile for docs title signal without ui label", () => {
    const policy = resolveReviewExecutionPolicy({
      flow: "review",
      issueTitle: "docs: refresh README",
      issueLabels: ["enhancement"],
    });

    expect(policy.passProfile).toBe("docs-only");
  });

  it("falls back to full pass profile when signals are weak", () => {
    const policy = resolveReviewExecutionPolicy({
      flow: "review",
      issueTitle: "feat: improve review gate",
      issueLabels: ["module:cli", "module:tracker"],
    });

    expect(policy.passProfile).toBe("full");
    expect(policy.skippedPasses).toEqual([]);
  });
});
