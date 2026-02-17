import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  REVIEW_GATE_SKIPPED_MARKER,
  REVIEW_SUMMARY_MARKER,
  buildReviewSummaryBody,
  classifyFollowUpLabel,
  computeFindingFingerprint,
  createReviewFollowUpIssue,
  hasReviewForHead,
  postReviewGateSkipComment,
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

  it("builds review summary body with head marker when provided", () => {
    const summary = buildReviewSummaryBody("summary text", "ABC123DEF");
    expect(summary).toContain(REVIEW_SUMMARY_MARKER);
    expect(summary).toContain("<!-- vibe:review-head:abc123def -->");
    expect(summary).toContain("summary text");
  });

  it("detects reviewed head marker from PR comments", async () => {
    const summaryBody = buildReviewSummaryBody("summary", "abc123def");
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return { stdout: JSON.stringify([{ id: 1, body: summaryBody }]) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    expect(await hasReviewForHead(execaMock as never, "acme/demo", 99, "abc123def")).toBe(true);
    expect(await hasReviewForHead(execaMock as never, "acme/demo", 99, "fff999")).toBe(false);
  });

  it("posts review gate skip comment once per head marker", async () => {
    const comments: Array<{ id: number; body: string }> = [];
    let nextId = 1;
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return { stdout: JSON.stringify(comments) };
      }
      if (
        cmd === "gh" &&
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3] === "repos/acme/demo/issues/99/comments"
      ) {
        const bodyArg = args.find((entry) => entry.startsWith("body=")) ?? "body=";
        comments.push({ id: nextId, body: bodyArg.slice("body=".length) });
        const id = nextId;
        nextId += 1;
        return { stdout: JSON.stringify({ id }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await postReviewGateSkipComment({
      execaFn: execaMock as never,
      repo: "acme/demo",
      prNumber: 99,
      issueId: 34,
      headSha: "abc123def",
      dryRun: false,
    });
    await postReviewGateSkipComment({
      execaFn: execaMock as never,
      repo: "acme/demo",
      prNumber: 99,
      issueId: 34,
      headSha: "abc123def",
      dryRun: false,
    });

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(REVIEW_GATE_SKIPPED_MARKER);
    expect(comments[0]?.body).toContain("<!-- vibe:review-gate-head:abc123def -->");
  });

  it("creates follow-up issue with only labels available in repo", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues?state=open&per_page=100&page=1") {
        return { stdout: "[]" };
      }
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
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues?state=open&per_page=100&page=1") {
        return { stdout: "[]" };
      }
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
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues?state=open&per_page=100&page=1") {
        return { stdout: "[]" };
      }
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

  it("updates existing open follow-up issue instead of creating duplicates", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ labels: [{ name: "module:cli" }] }) };
      }
      if (cmd === "gh" && args[0] === "label" && args[1] === "list") {
        return { stdout: JSON.stringify([{ name: "bug" }, { name: "status:backlog" }, { name: "module:cli" }]) };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues?state=open&per_page=100&page=1") {
        return {
          stdout: JSON.stringify([
            {
              number: 700,
              body: "<!-- vibe:review-followup:source-issue:34 -->\nexisting",
              html_url: "https://example.test/issues/700",
            },
          ]),
        };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "edit") {
        const full = args.join(" ");
        expect(full).toContain("700");
        expect(full).toContain("--add-label bug");
        expect(full).toContain("--add-label status:backlog");
        expect(full).toContain("--add-label module:cli");
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "issue" && args[1] === "create") {
        throw new Error("should not create a duplicate follow-up issue");
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

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.number).toBe(700);
    expect(result.url).toBe("https://example.test/issues/700");
  });

  it("continues publishing when one inline comment fails", async () => {
    let inlineAttempts = 0;
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "fresh-sha-123" }) };
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
        expect(args.join(" ")).toContain("commit_id=fresh-sha-123");
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
        body: null,
        created: false,
        rationaleAutofilled: false,
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

  it("converts absolute finding paths to repo-relative for inline comments", async () => {
    const absoluteFile = path.join(process.cwd(), "src/core/review.ts");
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "review") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "fresh-sha-absolute" }) };
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
        return { stdout: JSON.stringify({ id: 3 }) };
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
        expect(args.join(" ")).toContain("path=src/core/review.ts");
        expect(args.join(" ")).not.toContain(`path=${absoluteFile}`);
        return { stdout: JSON.stringify({ id: 4 }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await publishReviewToPullRequest({
      execaFn: execaMock as never,
      repo: "acme/demo",
      pr: {
        number: 99,
        url: "https://example.test/pull/99",
        headRefOid: "stale-sha-should-not-be-used",
        body: null,
        created: false,
        rationaleAutofilled: false,
      },
      summaryBody: "summary",
      findings: [
        sampleFinding({
          id: "f-absolute",
          file: absoluteFile,
          line: 35,
          title: "absolute",
        }),
      ],
      dryRun: false,
    });

    expect(result.inlinePublished).toBe(1);
    expect(result.inlineSkipped).toBe(0);
  });
});
