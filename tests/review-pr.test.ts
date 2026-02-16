import { describe, expect, it, vi } from "vitest";

import {
  classifyFollowUpLabel,
  computeFindingFingerprint,
  createReviewFollowUpIssue,
  publishReviewToPullRequest,
} from "../src/core/review-pr";
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

  it("creates follow-up issue with only labels available in repo", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ labels: [{ name: "module:cli" }] }) };
      }
      if (cmd === "gh" && args[0] === "label" && args[1] === "list") {
        return { stdout: JSON.stringify([{ name: "bug" }, { name: "status:backlog" }]) };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") {
        const text = args.join(" ");
        expect(text).toContain("--label bug");
        expect(text).toContain("--label status:backlog");
        expect(text).not.toContain("module:cli");
        expect(text).not.toContain("module:tracker");
        return { stdout: "https://example.test/issues/501\n" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await createReviewFollowUpIssue({
      execaFn: execaMock as never,
      sourceIssueId: 34,
      sourceIssueTitle: "review command",
      findings: [sampleFinding({ kind: "defect", severity: "P1" })],
      reviewSummary: "summary",
      milestoneTitle: null,
      dryRun: false,
      overrideLabel: null,
    });

    expect(result.created).toBe(true);
    expect(result.number).toBe(501);
    expect(result.label).toBe("bug");
  });

  it("retries follow-up issue creation without labels when label add fails", async () => {
    let issueCreateAttempts = 0;
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ labels: [{ name: "module:tracker" }] }) };
      }
      if (cmd === "gh" && args[0] === "label" && args[1] === "list") {
        throw new Error("gh label list unavailable");
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") {
        issueCreateAttempts += 1;
        if (issueCreateAttempts === 1) {
          const error = new Error("could not add label");
          (error as Error & { stderr?: string }).stderr = "could not add label: 'module:tracker' not found";
          throw error;
        }
        expect(args.some((entry) => entry === "--label")).toBe(false);
        return { stdout: "https://example.test/issues/502\n" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await createReviewFollowUpIssue({
      execaFn: execaMock as never,
      sourceIssueId: 34,
      sourceIssueTitle: "review command",
      findings: [sampleFinding({ kind: "defect", severity: "P1" })],
      reviewSummary: "summary",
      milestoneTitle: null,
      dryRun: false,
      overrideLabel: null,
    });

    expect(issueCreateAttempts).toBe(2);
    expect(result.created).toBe(true);
    expect(result.number).toBe(502);
  });

  it("inherits module labels from source issue when available", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ labels: [{ name: "module:ui" }, { name: "status:in-progress" }] }) };
      }
      if (cmd === "gh" && args[0] === "label" && args[1] === "list") {
        return { stdout: JSON.stringify([{ name: "enhancement" }, { name: "status:backlog" }, { name: "module:ui" }]) };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") {
        const text = args.join(" ");
        expect(text).toContain("--label enhancement");
        expect(text).toContain("--label status:backlog");
        expect(text).toContain("--label module:ui");
        return { stdout: "https://example.test/issues/503\n" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await createReviewFollowUpIssue({
      execaFn: execaMock as never,
      sourceIssueId: 34,
      sourceIssueTitle: "review command",
      findings: [sampleFinding({ kind: "improvement", severity: "P3", pass: "quality" })],
      reviewSummary: "summary",
      milestoneTitle: null,
      dryRun: false,
      overrideLabel: null,
    });

    expect(result.created).toBe(true);
    expect(result.number).toBe(503);
    expect(result.label).toBe("enhancement");
  });

  it("continues publishing when one inline comment fails", async () => {
    let inlineAttempts = 0;
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/99/comments"
      ) {
        return { stdout: JSON.stringify({ id: 1 }) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/pulls/99/comments?per_page=100&page=1") {
        return { stdout: "[]" };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/pulls/99/comments"
      ) {
        inlineAttempts += 1;
        if (inlineAttempts === 1) {
          const error = new Error("Validation Failed");
          (error as Error & { stderr?: string }).stderr = "line must be part of pull request diff";
          throw error;
        }
        return { stdout: JSON.stringify({ id: 2 }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await publishReviewToPullRequest({
      execaFn: execaMock as never,
      repo: "acme/demo",
      pr: {
        number: 99,
        url: "https://example.test/pull/99",
        headRefOid: "abc123",
        created: false,
      },
      summaryBody: "summary",
      findings: [
        sampleFinding({
          id: "f-1",
          file: "src/cli-program.ts",
          line: 10,
          title: "first",
        }),
        sampleFinding({
          id: "f-2",
          file: "src/core/review.ts",
          line: 20,
          title: "second",
        }),
      ],
      dryRun: false,
    });

    expect(result.inlinePublished).toBe(1);
    expect(result.inlineSkipped).toBe(1);
  });
});
