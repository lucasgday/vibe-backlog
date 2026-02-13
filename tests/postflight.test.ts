import { describe, expect, it } from "vitest";

import { buildTrackerCommands, normalizeGitHubIssueId, PostflightSchemaV1 } from "../src/core/postflight";

const BASE_POSTFLIGHT = {
  version: 1,
  meta: {
    timestamp: "2026-02-13T00:00:00.000Z",
    actor: "agent" as const,
    mode: "cli" as const,
  },
  work: {
    issue_id: 2,
    branch: "issue-2-example",
    base_branch: "main",
  },
  checks: {
    tests: {
      ran: true,
      result: "pass" as const,
    },
  },
  next_actions: ["Merge when CI is green."],
  risks: {
    summary: "Low risk.",
    rollback_plan: "Revert commit if needed.",
  },
};

describe("postflight schema and apply commands", () => {
  it("accepts issue_close as a tracker update type", () => {
    const parsed = PostflightSchemaV1.safeParse({
      ...BASE_POSTFLIGHT,
      tracker_updates: [
        {
          type: "issue_close",
          body: "Closed by postflight.",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("builds close commands with and without close comment", () => {
    const cmdsWithComment = buildTrackerCommands("2", [
      { type: "issue_close", body: "Done in PR #3." },
    ]);
    const cmdsWithoutComment = buildTrackerCommands("2", [
      { type: "issue_close", body: "   " },
    ]);

    expect(cmdsWithComment).toEqual([{ cmd: "gh", args: ["issue", "close", "2", "--comment", "Done in PR #3."] }]);
    expect(cmdsWithoutComment).toEqual([{ cmd: "gh", args: ["issue", "close", "2"] }]);
  });

  it("normalizes only numeric GitHub issue ids", () => {
    expect(normalizeGitHubIssueId(2)).toBe("2");
    expect(normalizeGitHubIssueId("002")).toBe("002");
    expect(normalizeGitHubIssueId("2abc")).toBeNull();
    expect(normalizeGitHubIssueId("1e3")).toBeNull();
  });
});
