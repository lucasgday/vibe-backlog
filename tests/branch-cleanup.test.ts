import { describe, expect, it, vi } from "vitest";

import { runBranchCleanup } from "../src/core/branch-cleanup";

function gitResponse(stdout: string, exitCode = 0, stderr = ""): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr, exitCode };
}

describe("branch cleanup core", () => {
  it("deletes merged and patch-equivalent branches and skips non-merged by default", async () => {
    const execaMock = vi.fn(async (cmd: string, args: string[]) => {
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
      if (args[0] === "fetch") return gitResponse("");
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
});
