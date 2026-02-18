import { describe, expect, it, vi } from "vitest";

import { PR_READY_FREEZE_GUIDANCE, runPrReadyCommand } from "../src/core/pr-ready";
import { PR_OPEN_REVIEW_GATE_POLICY_KEY, REVIEW_SUMMARY_MARKER } from "../src/core/review-pr";

function buildReviewSummaryBody(headSha: string): string {
  return [
    REVIEW_SUMMARY_MARKER,
    `<!-- vibe:review-head:${headSha.toLowerCase()} -->`,
    `<!-- vibe:review-policy:${PR_OPEN_REVIEW_GATE_POLICY_KEY} -->`,
    "summary",
  ].join("\n");
}

describe("pr ready command", () => {
  it("returns READY when PR is open, clean, synced, and reviewed for head", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: 99,
        branchOverride: null,
        refresh: false,
        waitSeconds: 0,
      },
      execaMock as never,
    );

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.remediationCommand).toBeNull();
    expect(result.freezeGuidance).toBe(PR_READY_FREEZE_GUIDANCE);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("returns NOT READY when target branch has no open PR", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "codex/issue-56-pr-ready-merge-readiness\n" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: null,
        branchOverride: null,
        refresh: false,
        waitSeconds: 0,
      },
      execaMock as never,
    );

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.prNumber).toBeNull();
    expect(result.checks[0]?.id).toBe("target-pr");
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks.some((check) => check.status === "skip")).toBe(true);
    expect(result.remediationCommand).toBeNull();
  });

  it("returns remediation when mergeStateStatus is not CLEAN", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: 99,
        branchOverride: null,
        refresh: false,
        waitSeconds: 0,
      },
      execaMock as never,
    );

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "merge-state-clean")?.status).toBe("fail");
    expect(result.remediationCommand).toBe("node dist/cli.cjs pr ready --pr 99 --refresh --wait-seconds 30");
  });

  it("returns remediation when remote branch head does not match PR head", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const remoteSha = "999123def456abc123def456abc123def456abcd";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${remoteSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: 99,
        branchOverride: null,
        refresh: false,
        waitSeconds: 0,
      },
      execaMock as never,
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "head-sync")?.status).toBe("fail");
    expect(result.remediationCommand).toBe("node dist/cli.cjs pr ready --pr 99 --refresh --wait-seconds 30");
  });

  it("blocks readiness when review marker is missing for current head", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: "[]",
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: 99,
        branchOverride: null,
        refresh: false,
        waitSeconds: 0,
      },
      execaMock as never,
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "review-marker")?.status).toBe("fail");
    expect(result.remediationCommand).toBeNull();
  });

  it("waits UNKNOWN merge state and passes when it transitions to CLEAN", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    let prViewCalls = 0;
    let now = 0;

    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        prViewCalls += 1;
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: prViewCalls === 1 ? "UNKNOWN" : "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: 99,
        branchOverride: null,
        refresh: false,
        waitSeconds: 4,
      },
      execaMock as never,
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        pollIntervalMs: 2000,
      },
    );

    expect(prViewCalls).toBe(2);
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.id === "merge-state-clean")?.status).toBe("pass");
  });

  it("runs git fetch origin when --refresh is enabled", async () => {
    const headSha = "abc123def456abc123def456abc123def456abcd";
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "fetch") {
        return { stdout: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 99,
            url: "https://example.test/pull/99",
            state: "OPEN",
            isDraft: false,
            headRefName: "codex/issue-56-pr-ready-merge-readiness",
            headRefOid: headSha,
            baseRefName: "main",
            mergeStateStatus: "CLEAN",
          }),
        };
      }
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: `${headSha}\trefs/heads/codex/issue-56-pr-ready-merge-readiness\n`,
        };
      }
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "acme/demo\n" };
      }
      if (cmd === "gh" && args[0] === "api" && args[1] === "repos/acme/demo/issues/99/comments?per_page=100&page=1") {
        return {
          stdout: JSON.stringify([{ id: 1, body: buildReviewSummaryBody(headSha) }]),
        };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runPrReadyCommand(
      {
        prNumber: 99,
        branchOverride: null,
        refresh: true,
        waitSeconds: 0,
      },
      execaMock as never,
    );

    expect(result.ready).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "fetch" && args[1] === "origin",
      ),
    ).toBe(true);
  });
});
