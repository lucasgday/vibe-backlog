import { describe, expect, it, vi } from "vitest";

import { runBranchCleanup } from "../src/core/branch-cleanup";

function gitResponse(stdout: string, exitCode = 0, stderr = ""): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr, exitCode };
}

function transientGhError(message: string): Error {
  const error = new Error(message);
  (error as Error & { stderr?: string }).stderr = message;
  return error;
}

describe("branch cleanup core", () => {
  it("deletes merged and patch-equivalent branches and skips non-merged by default", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return gitResponse("[]");
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("codex/issue-37-branch-cleanup-automatico\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") {
        return gitResponse(
          [
            "main\torigin/main\t",
            "feature/merged\torigin/feature/merged\t[gone]",
            "feature/patch\torigin/feature/patch\t[gone]",
            "feature/nonmerged\torigin/feature/nonmerged\t[gone]",
            "codex/issue-37-branch-cleanup-automatico\torigin/main\t",
          ].join("\n"),
        );
      }
      if (args[0] === "merge-base" && args[2] === "feature/merged") return gitResponse("", 0);
      if (args[0] === "merge-base" && args[2] === "feature/patch") return gitResponse("", 1);
      if (args[0] === "merge-base" && args[2] === "feature/nonmerged") return gitResponse("", 1);
      if (args[0] === "cherry" && args[2] === "feature/patch") return gitResponse("- deadbeef patch\n");
      if (args[0] === "cherry" && args[2] === "feature/nonmerged") return gitResponse("+ cafebabe change\n");
      if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature/merged") return gitResponse("");
      if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature/patch") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.baseRef).toBe("origin/main");
    expect(result.detected).toBe(3);
    expect(result.deleted).toBe(2);
    expect(result.planned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.nonMergedBlocked).toEqual(["feature/nonmerged"]);
    expect(result.candidates.map((candidate) => `${candidate.branch}:${candidate.status}`)).toEqual([
      "feature/merged:deleted",
      "feature/patch:deleted",
      "feature/nonmerged:skipped",
    ]);
  });

  it("auto-deletes upstream-gone non-merged branch when merged PR head matches local HEAD", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return gitResponse(JSON.stringify([{ number: 71, headRefOid: "feedface1234", mergedAt: "2026-02-19T00:00:00Z" }]));
      }
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/pr-merged\torigin/feature/pr-merged\t[gone]");
      if (args[0] === "merge-base" && args[2] === "feature/pr-merged") return gitResponse("", 1);
      if (args[0] === "cherry" && args[2] === "feature/pr-merged") return gitResponse("+ abcdef change\n");
      if (args[0] === "rev-parse" && args[1] === "feature/pr-merged") return gitResponse("feedface1234\n");
      if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature/pr-merged") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(1);
    expect(result.nonMergedBlocked).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.prMergedOutcomes).toEqual({
      planned: 0,
      deleted: 1,
      skipped: 0,
      error: 0,
    });
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/pr-merged",
      category: "pr-merged",
      status: "deleted",
      deleteFlag: "-D",
      command: "git branch -D feature/pr-merged",
    });
  });

  it("auto-deletes when any merged PR row matches local HEAD, even if first row mismatches", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return gitResponse(
          JSON.stringify([
            { number: 90, headRefOid: "deadcafe9876", mergedAt: "2026-02-19T10:00:00Z" },
            { number: 71, headRefOid: "feedface1234", mergedAt: "2026-02-19T00:00:00Z" },
          ]),
        );
      }
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/multi-pr\torigin/feature/multi-pr\t[gone]");
      if (args[0] === "merge-base" && args[2] === "feature/multi-pr") return gitResponse("", 1);
      if (args[0] === "cherry" && args[2] === "feature/multi-pr") return gitResponse("+ abcdef change\n");
      if (args[0] === "rev-parse" && args[1] === "feature/multi-pr") return gitResponse("feedface1234\n");
      if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature/multi-pr") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(1);
    expect(result.nonMergedBlocked).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/multi-pr",
      category: "pr-merged",
      status: "deleted",
      deleteFlag: "-D",
    });
  });

  it("keeps non-merged branch blocked when merged PR head does not match local HEAD", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return gitResponse(JSON.stringify([{ number: 71, headRefOid: "feedface1234", mergedAt: "2026-02-19T00:00:00Z" }]));
      }
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/mismatch\torigin/feature/mismatch\t[gone]");
      if (args[0] === "merge-base" && args[2] === "feature/mismatch") return gitResponse("", 1);
      if (args[0] === "cherry" && args[2] === "feature/mismatch") return gitResponse("+ abcdef change\n");
      if (args[0] === "rev-parse" && args[1] === "feature/mismatch") return gitResponse("deadcafe9876\n");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(0);
    expect(result.nonMergedBlocked).toEqual(["feature/mismatch"]);
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/mismatch",
      category: "non-merged",
      status: "skipped",
      deleteFlag: null,
    });
    expect(result.candidates[0]?.reason).toContain("merged PR #71 head mismatch");
  });

  it("retries transient gh pr list failures and succeeds with timeout control", async () => {
    let ghAttempts = 0;
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        ghAttempts += 1;
        if (ghAttempts < 3) {
          throw transientGhError("timeout while contacting api.github.com");
        }
        return gitResponse(JSON.stringify([{ number: 71, headRefOid: "feedface1234", mergedAt: "2026-02-19T00:00:00Z" }]));
      }
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/retry\torigin/feature/retry\t[gone]");
      if (args[0] === "merge-base" && args[2] === "feature/retry") return gitResponse("", 1);
      if (args[0] === "cherry" && args[2] === "feature/retry") return gitResponse("+ abcdef change\n");
      if (args[0] === "rev-parse" && args[1] === "feature/retry") return gitResponse("feedface1234\n");
      if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature/retry") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(ghAttempts).toBe(3);
    const ghListCalls = execaMock.mock.calls.filter(
      ([cmd, args]) => cmd === "gh" && Array.isArray(args) && args[0] === "pr" && args[1] === "list",
    );
    expect(ghListCalls).toHaveLength(3);
    for (const [, , options] of ghListCalls) {
      const timeout = typeof options === "object" && options !== null ? (options as Record<string, unknown>).timeout : undefined;
      expect(timeout).toBe(8000);
    }
  });

  it("warns and keeps non-merged branch blocked when merged PR lookup fails", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return gitResponse("", 1, "error connecting to api.github.com");
      }
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/no-gh\torigin/feature/no-gh\t[gone]");
      if (args[0] === "merge-base" && args[2] === "feature/no-gh") return gitResponse("", 1);
      if (args[0] === "cherry" && args[2] === "feature/no-gh") return gitResponse("+ abcdef change\n");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(0);
    expect(result.nonMergedBlocked).toEqual(["feature/no-gh"]);
    expect(result.warnings.some((warning) => warning.includes("unable to inspect merged PR"))).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/no-gh",
      category: "non-merged",
      status: "skipped",
      deleteFlag: null,
      reason: "requires --force-unmerged --yes",
    });
  });

  it("deletes non-merged branches only when force + confirmation are enabled", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/nonmerged\torigin/feature/nonmerged\t[gone]");
      if (args[0] === "merge-base") return gitResponse("", 1);
      if (args[0] === "cherry") return gitResponse("+ feedface change\n");
      if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature/nonmerged") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
        forceUnmerged: true,
        confirmForce: true,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(1);
    expect(result.nonMergedBlocked).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/nonmerged",
      category: "non-merged",
      status: "deleted",
      deleteFlag: "-D",
    });
  });

  it("plans deletions in dry-run mode without deleting branches", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "for-each-ref") return gitResponse("feature/merged\torigin/feature/merged\t[gone]");
      if (args[0] === "merge-base") return gitResponse("", 0);

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: true,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(0);
    expect(result.planned).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/merged",
      status: "planned",
      deleteFlag: "-d",
    });
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "fetch" && args[1] === "--prune",
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[0] === "branch" && (args[1] === "-d" || args[1] === "-D"),
      ),
    ).toBe(false);
  });

  it("continues when fetch --prune fails and reports a warning", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("main\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("", 1, "fatal: network unavailable");
      if (args[0] === "for-each-ref") return gitResponse("feature/merged\torigin/feature/merged\t[gone]");
      if (args[0] === "merge-base") return gitResponse("", 0);
      if (args[0] === "branch" && args[1] === "-d") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.deleted).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("git fetch --prune origin"))).toBe(true);
  });

  it("falls back to force delete when merged branch fails -d due to HEAD-dependent check", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return gitResponse("feature/active\n");
      if (args[0] === "symbolic-ref") return gitResponse("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return gitResponse("abc123\n");
      if (args[0] === "fetch") return gitResponse("");
      if (args[0] === "for-each-ref") return gitResponse("feature/merged\torigin/feature/merged\t[gone]\nfeature/active\torigin/feature/active\t");
      if (args[0] === "merge-base" && args[2] === "feature/merged") return gitResponse("", 0);
      if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature/merged") {
        return gitResponse("", 1, "error: The branch 'feature/merged' is not fully merged.");
      }
      if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature/merged") return gitResponse("");

      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await runBranchCleanup(
      {
        dryRun: false,
      },
      execaMock as never,
    );

    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      branch: "feature/merged",
      category: "merged",
      status: "deleted",
      deleteFlag: "-D",
      command: "git branch -D feature/merged",
    });
    expect(
      execaMock.mock.calls.some(
        ([git, args]) => git === "git" && Array.isArray(args) && args[0] === "branch" && args[1] === "-d",
      ),
    ).toBe(true);
    expect(
      execaMock.mock.calls.some(
        ([git, args]) => git === "git" && Array.isArray(args) && args[0] === "branch" && args[1] === "-D",
      ),
    ).toBe(true);
  });
});
